const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { validateWorkflow, validateInput, evaluateRules } = require('./config');

class ConflictError extends Error {}
class InvalidTransition extends Error {}
class NotFoundError extends Error {}

const now = () => new Date().toISOString();
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}
const serialize = value => JSON.stringify(stable(value));

class DecisionService {
  constructor(dbPath = 'decisions.sqlite3') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        payload_hash TEXT NOT NULL, workflow_id TEXT NOT NULL,
        config_version TEXT NOT NULL, config_json TEXT NOT NULL,
        payload_json TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES requests(id),
        event TEXT NOT NULL, from_status TEXT,
        to_status TEXT NOT NULL, details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_by_request ON audit_events(request_id, id);
    `);
  }

  close() { this.db.close(); }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  transition(id, event, toStatus, details) {
    const fromStatus = this.db.prepare('SELECT status FROM requests WHERE id = ?').get(id).status;
    const timestamp = now();
    this.db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(toStatus, timestamp, id);
    this.db.prepare(`INSERT INTO audit_events
      (request_id,event,from_status,to_status,details_json,occurred_at) VALUES (?,?,?,?,?,?)`)
      .run(id, event, fromStatus, toStatus, serialize(details), timestamp);
  }

  saveResult(id, result) {
    this.db.prepare('UPDATE requests SET result_json = ?, updated_at = ? WHERE id = ?')
      .run(serialize(result), now(), id);
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
    if (!row) throw new NotFoundError(`Unknown request ID: ${id}`);
    const { config_json, payload_json, result_json, ...record } = row;
    record.input = JSON.parse(payload_json);
    record.result = result_json ? JSON.parse(result_json) : null;
    record.audit = this.db.prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY id').all(id)
      .map(({ details_json, ...event }) => ({ ...event, details: JSON.parse(details_json) }));
    return record;
  }

  static checkDependencyOutcome(outcome) {
    if (!['success', 'transient', 'permanent'].includes(outcome)) {
      throw new TypeError('dependencyOutcome must be success, transient, or permanent');
    }
  }

  submit(config, input, idempotencyKey, dependencyOutcome = 'success', simulateSaveFailure = false) {
    validateWorkflow(config);
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
      throw new TypeError('Idempotency-Key must be a nonempty string');
    }
    DecisionService.checkDependencyOutcome(dependencyOutcome);
    const payloadJson = serialize(input);
    const hash = createHash('sha256').update(payloadJson).digest('hex');
    return this.transaction(() => {
      const duplicate = this.db.prepare('SELECT id,payload_hash,workflow_id FROM requests WHERE idempotency_key = ?').get(idempotencyKey);
      if (duplicate) {
        if (duplicate.payload_hash !== hash || duplicate.workflow_id !== config.workflow_id) {
          throw new ConflictError('Idempotency key already belongs to a different request');
        }
        return this.get(duplicate.id);
      }
      const id = randomUUID();
      const timestamp = now();
      this.db.prepare(`INSERT INTO requests
        (id,idempotency_key,payload_hash,workflow_id,config_version,config_json,payload_json,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(id, idempotencyKey, hash, config.workflow_id, config.version,
          serialize(config), payloadJson, 'RECEIVED', timestamp, timestamp);
      this.db.prepare(`INSERT INTO audit_events
        (request_id,event,from_status,to_status,details_json,occurred_at) VALUES (?,?,?,?,?,?)`)
        .run(id, 'RECEIVED', null, 'RECEIVED', serialize({ workflow_id: config.workflow_id,
          config_version: config.version, payload_sha256: hash }), timestamp);
      const errors = validateInput(input, config.request_schema);
      if (errors.length) {
        this.saveResult(id, { decision: 'INVALID', reason: 'Input validation failed', errors });
        this.transition(id, 'VALIDATION_FAILED', 'INVALID', { errors });
      } else {
        this.transition(id, 'VALIDATED', 'VALIDATED', { schema: 'passed' });
        this.process(id, config, input, dependencyOutcome);
      }
      if (simulateSaveFailure) throw new Error('Simulated database save failure; transaction rolled back');
      return this.get(id);
    });
  }

  process(id, config, input, dependencyOutcome) {
    this.db.prepare('UPDATE requests SET attempts = attempts + 1 WHERE id = ?').run(id);
    const attempts = this.db.prepare('SELECT attempts FROM requests WHERE id = ?').get(id).attempts;
    const dependency = { name: config.external_check.name, attempt: attempts, outcome: dependencyOutcome };
    if (dependencyOutcome !== 'success') {
      const maxAttempts = config.external_check.max_attempts;
      const retryable = dependencyOutcome === 'transient' && attempts < maxAttempts;
      const status = retryable ? 'RETRY_PENDING' : 'FAILED';
      const reason = retryable ? 'External dependency temporarily unavailable' : 'External dependency failed';
      this.saveResult(id, { decision: status, reason, dependency });
      this.transition(id, 'DEPENDENCY_FAILED', status,
        { ...dependency, retryable, max_attempts: maxAttempts });
      return;
    }
    this.transition(id, 'DEPENDENCY_SUCCEEDED', 'EXTERNAL_CHECKED', dependency);
    const outcome = evaluateRules(config, input);
    this.saveResult(id, { ...outcome, dependency, config_version: config.version });
    this.transition(id, 'DECISION_RECORDED', outcome.decision,
      { reason: outcome.reason, rule_trace: outcome.rule_trace,
        input_reference: `request:${id}:input`, config_version: config.version });
  }

  retry(id, dependencyOutcome = 'success', simulateSaveFailure = false) {
    DecisionService.checkDependencyOutcome(dependencyOutcome);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
      if (!row) throw new NotFoundError(`Unknown request ID: ${id}`);
      if (row.status !== 'RETRY_PENDING') throw new InvalidTransition(`Cannot retry a request in ${row.status} state`);
      this.transition(id, 'RETRY_STARTED', 'VALIDATED', { next_attempt: row.attempts + 1 });
      this.process(id, JSON.parse(row.config_json), JSON.parse(row.payload_json), dependencyOutcome);
      if (simulateSaveFailure) throw new Error('Simulated database save failure; transaction rolled back');
      return this.get(id);
    });
  }

  resolve(id, decision, reason) {
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw new TypeError('Manual decision must be APPROVED or REJECTED');
    if (typeof reason !== 'string' || !reason.trim()) throw new TypeError('Manual resolution needs a reason');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT status,result_json FROM requests WHERE id = ?').get(id);
      if (!row) throw new NotFoundError(`Unknown request ID: ${id}`);
      if (row.status !== 'MANUAL_REVIEW') throw new InvalidTransition(`Cannot resolve a request in ${row.status} state`);
      const result = JSON.parse(row.result_json);
      Object.assign(result, { decision, reason, manual_resolution: { decision, reason } });
      this.saveResult(id, result);
      this.transition(id, 'MANUAL_RESOLUTION', decision, { decision, reason });
      return this.get(id);
    });
  }

  list() {
    return this.db.prepare('SELECT id,workflow_id,status,attempts,created_at FROM requests ORDER BY created_at DESC').all();
  }
}

module.exports = { DecisionService, ConflictError, InvalidTransition, NotFoundError };
