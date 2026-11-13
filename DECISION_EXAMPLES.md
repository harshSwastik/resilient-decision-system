# Decision Explanation Examples

These examples use the included JSON files and configuration. The exact request ID and timestamps are generated at runtime.

## Application approved under version 1.0

Input: `application_approved.json` (age 28, annual income 32,000, complete documents, risk score 25, salaried). The simulated identity check succeeds. `underage`, `high_risk`, `missing_documents`, `self_employed_low_income`, and `low_income` each evaluate to false. The default outcome is `APPROVED`, with reason `No configured rule matched`. Audit events are `RECEIVED`, `VALIDATED`, `DEPENDENCY_SUCCEEDED`, `DECISION_RECORDED`.

## Same input rejected under version 2.0

Version 2.0 changes the `low_income` threshold to 35,000. The same annual income of 32,000 now matches that rule. The outcome is `REJECTED`, with reason `Income is below the minimum threshold`. The rule trace shows `actual: 32000`, `operator: lt`, and `expected: 35000`. The version 1.0 decision remains unchanged in storage.

## Manual review

Input: `application_review.json` has `documents_complete: false`. The `missing_documents` rule matches and returns `MANUAL_REVIEW` with reason `Documents need human verification`. A reviewer can POST an approval or rejection and reason to `/requests/:id/resolve`; that adds a `MANUAL_RESOLUTION` audit event.

## Dependency failure and retry

Submit the approved example with header `X-Simulated-Dependency-Outcome: transient`. The first attempt ends at `RETRY_PENDING` with `DEPENDENCY_FAILED` in the audit. POST `{"dependencyOutcome":"success"}` to `/requests/:id/retry`; attempt 2 records `RETRY_STARTED`, `DEPENDENCY_SUCCEEDED`, and `DECISION_RECORDED`, ending at `APPROVED`. Repeating a transient failure until the configured maximum ends at `FAILED`.
