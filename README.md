# Resilient Decision System

A configurable workflow decision API built with **Node.js, Express, and SQLite**. It validates requests, applies JSON-defined rules, tracks workflow state, records an explainable audit trail, and handles duplicates and simulated external-service failures. The sample thresholds are illustrative, not real lending or compliance rules.

## Requirements and setup

- Node.js 24 or newer (`node:sqlite` is built in)
- npm

From the `hack_project` folder:

```bash
npm install
npm start
```

The API starts at `http://localhost:3000` and creates `decisions.sqlite3` in the project folder. Set `PORT` or `DB_PATH` to change these defaults. Check `GET /health` or `GET /workflows` after starting it.

## Quick request

In another terminal, from the project folder:

```bash
curl -sS -X POST 'http://localhost:3000/workflows/application_approval/requests?version=1.0' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: application-001' \
  --data-binary @examples/application_approved.json
```

The JSON response includes an `id`, `status`, `result`, and `audit` array. Retrieve it later with `curl -sS 'http://localhost:3000/requests/YOUR_REQUEST_ID'`.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health check |
| `GET` | `/workflows` | List workflows and versions |
| `POST` | `/workflows/:workflowId/requests?version=1.0` | Submit JSON; requires `Idempotency-Key` header |
| `GET` | `/requests` | List request summaries |
| `GET` | `/requests/:id` | Get decision and full audit |
| `POST` | `/requests/:id/retry` | Retry a `RETRY_PENDING` request |
| `POST` | `/requests/:id/resolve` | Resolve a `MANUAL_REVIEW` request |

If `version` is omitted, the highest configured version is selected. Configurations load at server startup; restart after adding or editing one. Repeating the same idempotency key and input returns the original request. Reusing the key with different input returns HTTP 409.

## Demonstrate assignment scenarios

**Transient external failure:** Submit a new request with header `X-Simulated-Dependency-Outcome: transient`. It ends in `RETRY_PENDING`. Then call:

```bash
curl -sS -X POST 'http://localhost:3000/requests/YOUR_REQUEST_ID/retry' \
  -H 'Content-Type: application/json' \
  -d '{"dependencyOutcome":"success"}'
```

Use `permanent` for a nonretryable failure. Each workflow config sets its maximum attempt count.

**Manual review:** Submit `examples/application_review.json` with a new key, then:

```bash
curl -sS -X POST 'http://localhost:3000/requests/YOUR_REQUEST_ID/resolve' \
  -H 'Content-Type: application/json' \
  -d '{"decision":"APPROVED","reason":"Documents verified by reviewer"}'
```

**Invalid input:** Submit `examples/application_invalid.json`. The API returns HTTP 422 and stores the request as `INVALID` with validation errors and an audit event.

**Rule change:** Submit `application_approved.json` with `version=1.0` and a new key; it is approved. Submit the same input with `version=2.0` and another key; it is rejected because the income threshold changes from 20,000 to 35,000. The earlier decision stays tied to version 1.0.

**Second workflow:** Submit `examples/vendor_approved.json` to `/workflows/vendor_approval/requests?version=1.0`. The engine code is unchanged.

**Partial save failure:** The service's `simulateSaveFailure` test hook raises before commit. An automated test verifies that request state and audit events roll back together.

## Tests

```bash
npm test
```

## Configuration

Each JSON file in `configs/` declares a workflow ID, version, request schema, simulated external dependency, maximum attempts, ordered rules, and default outcome. A rule condition can be a leaf (`field`, `op`, `value`) or nested `all`/`any` group. Supported operators are `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, and `not_in`. The first matching rule wins. The evaluator uses a fixed operator set; configuration never executes code.

## Project files

- `src/config.js` — config and request validation, rule evaluation
- `src/service.js` — SQLite state, idempotency, audit, retries, manual resolution
- `src/app.js` — Express routes and HTTP errors
- `src/server.js` — server startup
- `configs/` — application versions and vendor workflow
- `examples/` — sample JSON requests
- `tests/` — Node test runner tests, including API integration
- `ARCHITECTURE.md` — design, tradeoffs, scaling
- `DECISION_EXAMPLES.md` — explanations of sample outcomes
