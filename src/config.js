const fs = require('node:fs');

class ConfigError extends Error {}

const TYPES = new Set(['string', 'integer', 'number', 'boolean']);
const OPERATORS = new Set(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'in', 'not_in']);
const OUTCOMES = new Set(['APPROVED', 'REJECTED', 'MANUAL_REVIEW']);

function loadWorkflow(path) {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  validateWorkflow(config);
  return config;
}

function validateCondition(condition, fields) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    throw new ConfigError('A rule condition must be an object');
  }
  if ('all' in condition || 'any' in condition) {
    if (Object.keys(condition).length !== 1) throw new ConfigError('A group must contain only all or any');
    const group = 'all' in condition ? 'all' : 'any';
    if (!Array.isArray(condition[group]) || !condition[group].length) {
      throw new ConfigError(`${group} must contain conditions`);
    }
    condition[group].forEach(child => validateCondition(child, fields));
    return;
  }
  if (Object.keys(condition).sort().join(',') !== 'field,op,value' ||
      !Object.hasOwn(fields, condition.field) || !OPERATORS.has(condition.op)) {
    throw new ConfigError('Invalid field, operator, or shape in rule condition');
  }
  if (['in', 'not_in'].includes(condition.op) && !Array.isArray(condition.value)) {
    throw new ConfigError('in/not_in requires an array value');
  }
  const type = fields[condition.field].type;
  const compatible = value => type === 'string' ? typeof value === 'string' :
    type === 'boolean' ? typeof value === 'boolean' :
    type === 'integer' ? Number.isInteger(value) :
    typeof value === 'number' && Number.isFinite(value);
  if (['lt', 'lte', 'gt', 'gte'].includes(condition.op) && !['integer', 'number'].includes(type)) {
    throw new ConfigError('Ordering operators require a numeric field');
  }
  const values = ['in', 'not_in'].includes(condition.op) ? condition.value : [condition.value];
  if (values.some(value => !compatible(value))) {
    throw new ConfigError(`Condition value type does not match field ${condition.field}`);
  }
}

function validateWorkflow(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError('Workflow must be an object');
  }
  for (const key of ['workflow_id', 'version', 'request_schema', 'external_check', 'rules', 'default_outcome']) {
    if (!(key in config)) throw new ConfigError(`Missing configuration field: ${key}`);
  }
  if (![config.workflow_id, config.version].every(value => typeof value === 'string' && value.length)) {
    throw new ConfigError('workflow_id and version must be nonempty strings');
  }
  const schema = config.request_schema;
  if (!schema || typeof schema !== 'object' || !schema.fields || !Array.isArray(schema.required)) {
    throw new ConfigError('request_schema needs fields and required');
  }
  if (Object.keys(schema.fields).length === 0 || schema.required.some(field => !Object.hasOwn(schema.fields, field))) {
    throw new ConfigError('Every required field must have a definition');
  }
  for (const [field, spec] of Object.entries(schema.fields)) {
    if (!spec || !TYPES.has(spec.type)) throw new ConfigError(`Invalid type for ${field}`);
    if ('minimum' in spec && !['integer', 'number'].includes(spec.type)) {
      throw new ConfigError(`Minimum is only valid for numeric field ${field}`);
    }
    if ('minimum' in spec && (typeof spec.minimum !== 'number' || !Number.isFinite(spec.minimum))) {
      throw new ConfigError(`Invalid minimum for ${field}`);
    }
    if ('min_length' in spec && (!Number.isInteger(spec.min_length) || spec.min_length < 0)) {
      throw new ConfigError(`Invalid min_length for ${field}`);
    }
  }
  if (!config.external_check || typeof config.external_check.name !== 'string' ||
      !Number.isInteger(config.external_check.max_attempts) || config.external_check.max_attempts < 1) {
    throw new ConfigError('external_check needs a name and positive max_attempts');
  }
  if (!OUTCOMES.has(config.default_outcome) || !Array.isArray(config.rules)) {
    throw new ConfigError('Invalid default outcome or rules');
  }
  const ids = new Set();
  for (const rule of config.rules) {
    if (!rule || typeof rule.id !== 'string' || !rule.id || ids.has(rule.id) ||
        !OUTCOMES.has(rule.outcome) || typeof rule.reason !== 'string') {
      throw new ConfigError('Rules need unique IDs, valid outcomes, and reasons');
    }
    ids.add(rule.id);
    validateCondition(rule.when, schema.fields);
  }
}

function validateInput(payload, schema) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Request must be a JSON object'];
  }
  const errors = [];
  for (const field of schema.required) {
    if (!Object.hasOwn(payload, field)) errors.push(`Missing required field: ${field}`);
  }
  for (const [field, value] of Object.entries(payload)) {
    const spec = schema.fields[field];
    if (!spec) {
      if (!schema.allow_extra) errors.push(`Unknown field: ${field}`);
      continue;
    }
    const valid = spec.type === 'string' ? typeof value === 'string' :
      spec.type === 'boolean' ? typeof value === 'boolean' :
      spec.type === 'integer' ? Number.isInteger(value) :
      typeof value === 'number' && Number.isFinite(value);
    if (!valid) {
      errors.push(`${field} must be ${spec.type}`);
      continue;
    }
    if (spec.type === 'string' && spec.min_length != null && value.length < spec.min_length) {
      errors.push(`${field} is too short`);
    }
    if (['integer', 'number'].includes(spec.type) && spec.minimum != null && value < spec.minimum) {
      errors.push(`${field} must be at least ${spec.minimum}`);
    }
  }
  return errors;
}

function evaluateCondition(condition, input) {
  if ('all' in condition || 'any' in condition) {
    const group = 'all' in condition ? 'all' : 'any';
    const results = condition[group].map(child => evaluateCondition(child, input));
    return {
      matched: group === 'all' ? results.every(result => result.matched) : results.some(result => result.matched),
      evidence: results.flatMap(result => result.evidence)
    };
  }
  const { field, op, value: expected } = condition;
  const present = Object.hasOwn(input, field);
  const actual = present ? input[field] : null;
  let matched = false;
  if (present) {
    switch (op) {
      case 'eq': matched = actual === expected; break;
      case 'ne': matched = actual !== expected; break;
      case 'in': matched = expected.includes(actual); break;
      case 'not_in': matched = !expected.includes(actual); break;
      case 'lt': matched = typeof actual === 'number' && actual < expected; break;
      case 'lte': matched = typeof actual === 'number' && actual <= expected; break;
      case 'gt': matched = typeof actual === 'number' && actual > expected; break;
      case 'gte': matched = typeof actual === 'number' && actual >= expected; break;
    }
  }
  return { matched, evidence: [{ field, actual, operator: op, expected, matched }] };
}

function evaluateRules(config, input) {
  const trace = [];
  for (const rule of config.rules) {
    const { matched, evidence } = evaluateCondition(rule.when, input);
    trace.push({ rule_id: rule.id, matched, evidence });
    if (matched) return { decision: rule.outcome, reason: rule.reason, rule_trace: trace };
  }
  return { decision: config.default_outcome, reason: 'No configured rule matched', rule_trace: trace };
}

module.exports = { ConfigError, loadWorkflow, validateWorkflow, validateInput, evaluateRules };
