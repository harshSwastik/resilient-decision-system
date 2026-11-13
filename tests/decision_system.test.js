const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DecisionService, ConflictError, InvalidTransition } = require('../src/service');
const { loadWorkflow, validateWorkflow, ConfigError } = require('../src/config');
const { createApp } = require('../src/app');

const root = path.resolve(__dirname, '..');
const v1 = loadWorkflow(path.join(root, 'configs/application_v1.json'));
const v2 = loadWorkflow(path.join(root, 'configs/application_v2.json'));
const input = JSON.parse(fs.readFileSync(path.join(root, 'examples/application_approved.json'), 'utf8'));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-test-'));
  const service = new DecisionService(path.join(dir, 'test.sqlite3'));
  t.after(() => { service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return service;
}

test('happy path, rejection, manual review, and explanation', t => {
  const service = fixture(t);
  const approved = service.submit(v1, input, 'happy');
  assert.equal(approved.status, 'APPROVED');
  assert.deepEqual(approved.audit.map(event => event.event),
    ['RECEIVED', 'VALIDATED', 'DEPENDENCY_SUCCEEDED', 'DECISION_RECORDED']);
  assert.equal(approved.result.rule_trace.length, 5);
  assert.equal(approved.audit.at(-1).details.input_reference, `request:${approved.id}:input`);
  const rejected = service.submit(v1, { ...input, age: 17 }, 'rejected');
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.result.rule_trace[0].rule_id, 'underage');
  const review = service.submit(v1, { ...input, documents_complete: false }, 'review');
  assert.equal(review.status, 'MANUAL_REVIEW');
  const conditional = service.submit(v1,
    { ...input, employment_type: 'self_employed', annual_income: 25000 }, 'conditional');
  assert.equal(conditional.status, 'MANUAL_REVIEW');
  assert.equal(conditional.result.rule_trace.at(-1).rule_id, 'self_employed_low_income');
  const resolved = service.resolve(review.id, 'APPROVED', 'Documents checked by reviewer');
  assert.equal(resolved.status, 'APPROVED');
  assert.equal(resolved.audit.at(-1).event, 'MANUAL_RESOLUTION');
  assert.throws(() => service.resolve(review.id, 'REJECTED', 'Again'), InvalidTransition);
});

test('invalid input is persisted and does not call dependency', t => {
  const service = fixture(t);
  const record = service.submit(v1, { ...input, age: 'twenty' }, 'invalid');
  assert.equal(record.status, 'INVALID');
  assert.equal(record.attempts, 0);
  assert.ok(record.result.errors.includes('age must be integer'));
  assert.equal(record.audit.at(-1).event, 'VALIDATION_FAILED');
});

test('same idempotency key returns original; different payload conflicts', t => {
  const service = fixture(t);
  const first = service.submit(v1, input, 'same');
  const second = service.submit(v1, { ...input }, 'same', 'permanent');
  assert.deepEqual(second, first);
  assert.equal(service.list().length, 1);
  assert.throws(() => service.submit(v1, { ...input, age: 35 }, 'same'), ConflictError);
});

test('transient failure retries and stops at configured max attempts', t => {
  const service = fixture(t);
  const pending = service.submit(v1, input, 'retry', 'transient');
  assert.equal(pending.status, 'RETRY_PENDING');
  const retried = service.retry(pending.id, 'success');
  assert.equal(retried.status, 'APPROVED');
  assert.equal(retried.attempts, 2);
  assert.ok(retried.audit.some(event => event.event === 'RETRY_STARTED'));
  assert.throws(() => service.retry(pending.id), InvalidTransition);
  const failure = service.submit(v1, input, 'exhaust', 'transient');
  service.retry(failure.id, 'transient');
  const exhausted = service.retry(failure.id, 'transient');
  assert.equal(exhausted.status, 'FAILED');
  assert.equal(exhausted.attempts, 3);
  assert.throws(() => service.retry(failure.id), InvalidTransition);
  const permanent = service.submit(v1, input, 'permanent', 'permanent');
  assert.equal(permanent.status, 'FAILED');
  assert.throws(() => service.retry(permanent.id), InvalidTransition);
});

test('partial save failure rolls back request, state, and audit', t => {
  const service = fixture(t);
  assert.throws(() => service.submit(v1, input, 'save', 'success', true), /rolled back/);
  assert.equal(service.list().length, 0);
  const pending = service.submit(v1, input, 'retry-save', 'transient');
  assert.throws(() => service.retry(pending.id, 'success', true), /rolled back/);
  assert.deepEqual(service.get(pending.id), pending);
});

test('config version changes decision, and second workflow uses same engine', t => {
  const service = fixture(t);
  const first = service.submit(v1, input, 'v1');
  const second = service.submit(v2, input, 'v2');
  assert.equal(first.status, 'APPROVED');
  assert.equal(second.status, 'REJECTED');
  assert.equal(service.get(first.id).config_version, '1.0');
  const vendor = loadWorkflow(path.join(root, 'configs/vendor_approval.json'));
  const vendorInput = JSON.parse(fs.readFileSync(path.join(root, 'examples/vendor_approved.json')));
  assert.equal(service.submit(vendor, vendorInput, 'vendor').status, 'APPROVED');
});

test('unknown operator in configuration is rejected', () => {
  const broken = structuredClone(v1);
  broken.rules[0].when.op = 'execute_code';
  assert.throws(() => validateWorkflow(broken), ConfigError);
});

test('Express API accepts requests and exposes audit, duplicate, retry, and errors', async t => {
  const service = fixture(t);
  const server = createApp(service).listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, headers = {}) => fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  });
  const headers = { 'Idempotency-Key': 'api-001' };
  const submitted = await post('/workflows/application_approval/requests?version=1.0', input, headers);
  assert.equal(submitted.status, 200);
  const record = await submitted.json();
  assert.equal(record.status, 'APPROVED');
  const duplicate = await post('/workflows/application_approval/requests?version=1.0', input, headers);
  assert.equal((await duplicate.json()).id, record.id);
  const conflict = await post('/workflows/application_approval/requests?version=1.0',
    { ...input, age: 30 }, headers);
  assert.equal(conflict.status, 409);
  const fetched = await fetch(`${base}/requests/${record.id}`);
  assert.equal((await fetched.json()).audit.length, 4);
  const pendingResponse = await post('/workflows/application_approval/requests?version=1.0',
    input, { 'Idempotency-Key': 'api-002', 'X-Simulated-Dependency-Outcome': 'transient' });
  const pending = await pendingResponse.json();
  assert.equal(pending.status, 'RETRY_PENDING');
  const retried = await post(`/requests/${pending.id}/retry`, { dependencyOutcome: 'success' });
  assert.equal((await retried.json()).status, 'APPROVED');
  const missing = await fetch(`${base}/requests/does-not-exist`);
  assert.equal(missing.status, 404);
});
