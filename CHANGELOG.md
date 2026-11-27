# Changelog

## Unreleased

- `anthropicProvider.isNoCredit` now reads the HTTP status and the error type before the message. Out of credit is a 402, a 4xx whose type is `billing_error`, or a 400 `invalid_request_error` whose message says the credit balance is too low. A 5xx, a network error, an error with no status and a thrown value that isn't an Error take the ordinary error path, so a message that only mentions credit or billing no longer pauses every job. An error thrown by your own code needs the status and the response body on it, as the provider's SDK gives them, to count as a run-out. Tested: 29 integration tests with fake errors shaped like the SDK's, 7 of them new, and 6 of those failed on the old code. Not tested: a real API call, a real out-of-credit answer from the provider, a real site.

## 0.1.0 (2026-11-13)

First version, from the platform's API cost ledger design and the owner's decision to make it a plugin: the ledger, caps that stop jobs cleanly and fail closed, dated prices with an Anthropic adapter, the credits-out pause with an hourly probe and one notice per run-out, the three-month auto-reload suggestion, the spend summary, and seeded test data that never counts toward a cap.

After the security read of 950abe1: answers with no usage are recorded as unpriced (with `recordUsage` for batch results), any job probes when no probe job is named, token counts and price tables are checked, job names match exactly, and run-outs flip the state atomically with a notice that survives failures.

Tested: 22 integration tests with fake answers, and a mutation check on 21 guards. Not tested: a real API call, a real site.
