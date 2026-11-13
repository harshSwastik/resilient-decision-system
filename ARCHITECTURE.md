# Architecture and Design Decisions

## Scope and assumptions

This is a synchronous demonstration API for a small team. The sample approval thresholds are illustrative business assumptions. The simulated dependency stands in for a read-only identity or registry service; a request header chooses success, temporary failure, or permanent failure for demonstration. Express provides the required REST interface. SQLite keeps setup small and supports transactional state and audit writes. Node.js 24+ provides SQLite through `node:sqlite`.

## Components and data flow

```text
HTTP JSON + Idempotency-Key
          |
          v
    Express routes
          |
          v
  DecisionService transaction
    |          |          |
    v          v          v
  schema    simulated    JSON rule evaluator
  check     dependency         |
    +----------+---------------+
               |
               v
       state + result + audit
               |
               v
             SQLite
```

The service stores a request with a unique idempotency key and SHA-256 hash of canonical JSON input. It records `RECEIVED`, validates input, checks the simulated dependency, then evaluates rules in order. The successful path is `RECEIVED -> VALIDATED -> EXTERNAL_CHECKED -> APPROVED / REJECTED / MANUAL_REVIEW`. Invalid input ends at `INVALID`. A temporary dependency failure ends at `RETRY_PENDING`; an explicit retry returns to `VALIDATED`. Permanent failure or exhausted attempts ends at `FAILED`. A reviewer can move only `MANUAL_REVIEW` to `APPROVED` or `REJECTED` and must supply a reason.

## Data and audit model

`requests` stores current state, input, result, attempt count, payload hash, config version, and the exact workflow configuration used. `audit_events` records event, old/new state, timestamp, and details. A decision event includes the ordered rule trace, actual/expected values, reason, and reference to the stored input. `GET /requests/:id` returns current state and ordered audit history.

State changes and audit inserts use one `BEGIN IMMEDIATE` SQLite transaction. The simulated save-failure test hook raises before commit; the transaction rolls back both state and audit writes. This protects local consistency.

## Duplicate requests and retries

The idempotency key has a database unique constraint. A repeated key with the same workflow and payload returns the original record without adding events. The same key with different input returns HTTP 409. Retries are allowed only from `RETRY_PENDING`, stop at the configured maximum attempts, and use the original config snapshot. A policy change does not silently change an in-flight request.

## Configurability and change handling

Workflow schemas, rule conditions, outcomes, thresholds, dependency name, and retry limit are in JSON. The server loads all valid config files from `configs/` on startup and exposes their IDs and versions. `application_v1.json` and `application_v2.json` show a threshold change; `vendor_approval.json` shows a separate use case with the same engine. The evaluator supports nested `all`/`any` groups and fixed safe operators.

The first matching rule wins. Rule order is therefore part of policy: rejection rules are placed before manual review where appropriate. This keeps the trace deterministic and easy to explain. More complex policies may need explicit priorities and conflict resolution.

## Tradeoffs and scaling

The dependency is simulated inside the SQLite transaction so the demo can show state and audit together. A real network call should move outside a long database transaction, paired with an outbox or durable queue and idempotent external calls. That avoids holding a lock during slow calls and handles a crash between external and local commits.

For higher throughput, use PostgreSQL, background workers, a queue with backoff and dead-letter handling, metrics, and indexes for workflow/status/date queries. For sensitive data, add authentication, reviewer identity, authorization, encryption, redaction, and audit access controls. A production policy lifecycle also needs config review, approval, and migration tooling.

## Known limits

- The external service is simulated, not integrated with a real API.
- Retries require an explicit API call; there is no scheduler.
- There is no authentication or reviewer identity.
- Audit entries are append-only through the service, not protected from direct database edits.
- Config files load at startup and need a restart after changes.
