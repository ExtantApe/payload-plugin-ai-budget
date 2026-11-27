# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-26: which errors count as a run-out

A wrong read here pauses every job for up to an hour, tells the owner and counts the month as a run-out, so each refusal has its own test.

| Promise | Test |
| --- | --- |
| A 402 is out of credit, whatever its message | `telling a run-out from any other error > reads a 402…` |
| A 4xx with the `billing_error` type is out of credit, wrapped or unwrapped | `… > reads the provider's billing error type…` |
| The credit-balance 400 `invalid_request_error` is still out of credit | `… > still reads the credit-balance 400…`, and every `when the credits run out` test through its fixture |
| A 5xx is an ordinary error whatever it says: nothing pauses, nobody is told, the ledger records `error`, the next call runs | `… > reads a 500 that mentions billing…` |
| A 4xx with matching text and another type, or no type, is an ordinary error | `… > reads a 400 of another type…` |
| A network error, or any error with no status, is an ordinary error | `… > reads a network error…` |
| A thrown string, plain object or other value is an ordinary error | `… > reads a thrown value that is not an Error…` |

Six of the seven failed on the old code, which matched on the message alone. The credit-balance 400 test passed before and after: it keeps the shape the plugin already handled.

Mutation check: 6 guards in `isNoCredit` (the 5xx bound, the 4xx floor, the 402, the billing type, the 400's status and type, the missing status). Five were caught at once; the 4xx floor was caught after an assertion was added (a 302 with the billing type).

Gaps skipped: a real out-of-credit answer from the provider (it needs an account with no credit). The shapes come from the provider's published error types and the 400 the code already handled, so check the ledger's `error` records after a provider change.

## 2026-11-10: 0.1.0

| Promise | Test |
| --- | --- |
| Every token kind priced; batch; long prompts; rounding up; dated model ids; unknown model at the top row, flagged | `prices` |
| Tokens and cost recorded, never the prompt or answer; failures recorded with zero tokens; unknown models flagged | `the ledger` (3) |
| Run, job-day, day and month caps; the tightest wins; the next run starts | `caps` (2) |
| Unknown job and missing run refused; an unreadable ledger refuses without calling | `caps` (2) |
| Seeded data never counts toward a cap, but shows in the summary | `caps > never counts seeded…` |
| Nonsense caps refused at start-up | `caps > refuses at start-up…` |
| Credits out: paused, one notice, one probe an hour from the probe job, resume on success, one prober at a time, no second notice | `when the credits run out` (2) |
| The suggestion only after three run-out months in a row, rounded and capped | `when the credits run out > suggests…` |
| The summary's numbers | `reading it > summarises…` |
| Managers only; no API writes | `reading it > shows the ledger…` |

| Unpriced answers (batch create, impossible counts, a throwing provider); batch results priced later | `what the security read found` (2) |
| Prototype job names refused; prices and the suggestion ceiling checked at start-up; the ceiling caps the suggestion | `what the security read found` (3) |
| Only exactly-true managers read; members can't read the state | `what the security read found > counts only…` |
| Any job probes with no probe job named | `what the security read found > lets any job probe…` |

Mutation check: 12 guards at 950abe1, then 9 more after the security read's fixes, all caught (one only after an assertion was added: no second notice after a failed probe).

Gaps skipped: a real API call (the adapter reads answers by shape; a live call costs money and needs a key), and the admin dashboard view, which isn't built in 0.1 (the summary function is).
