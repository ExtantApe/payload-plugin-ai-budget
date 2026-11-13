# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

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
