# Test audit

Kept by this repo's maintainers: after each feature or fix, and at least every 14 days while it changes. Newest first.

## 2026-11-26: sweep after 0.1.0

Every promise in the README and `docs/decisions.md` was listed and matched to a test in `test/ai-budget.test.ts`. The suite went from 22 tests to 37. Nothing in `src/` changed.

- **Promises:**
  - Refusals before the call: a job that isn't in the caps, a call with no run id, each of the four caps with the tightest winning, credits out, and a ledger or state that can't be read.
  - The ledger: the job, run, model, tokens and cost of every call, a failed call with zero tokens, an unpriced answer flagged and logged, and never the prompt, the answer or who asked.
  - Prices: a dated table, an unknown model at the most expensive row, batch and long-prompt prices, rounding up, and a table checked at start-up.
  - Credits out: the pause, one probe an hour by one worker, the resume, one notice per run-out through Notifications or `onCreditsOut`, an error in the log when nobody can be told, a warning at start-up, and the auto-reload suggestion after three months.
  - The summary: month, projection, today, top jobs, each cap's use, the 50%, 75% and 90% marks, credits out, and seeded data shown but never counted.
  - Access: managers read the ledger, only an answer of exactly `true` counts, and nobody writes through the API.
  - Decisions: auto-reload is only ever suggested, and an unknown job is refused.
- **Covered:**
  - Unknown job, missing run id, prototype job names: `caps > refuses a job that isn’t in the caps…`, `what the security read found > refuses prototype names as jobs`.
  - The four caps, the tightest winning, the next run starting: `caps > stops a run at its cap…`, `caps > stops a job at its daily cap…`.
  - An unreadable state refuses without calling: `caps > refuses when the ledger can’t be read, without calling`.
  - Tokens and cost recorded, a failed call with zero tokens, an unknown model flagged: `the ledger` (3).
  - Unpriced answers and batch results priced later: `what the security read found` (2).
  - Prices: `prices`, and `what the security read found > checks prices and the suggestion ceiling at start-up`.
  - The pause, the hourly probe, one prober, one notice, the resume, any job probing when none is named: `when the credits run out` (2), `what the security read found > lets any job probe…`.
  - The suggestion after three months, rounded and capped: `when the credits run out > suggests…`, `what the security read found > caps the auto-reload suggestion…`.
  - The summary's numbers and the 50% mark: `reading it > summarises the month for a spend card`.
  - Seeded data: `caps > never counts seeded test data…`.
  - Members and query answers refused, managers reading, no create through the API: `reading it > shows the ledger to managers only…`, `what the security read found > counts only an answer of exactly true…`.
  - Nonsense caps refused at start-up: `caps > refuses at start-up caps that make no sense`.
- **Gaps added** (15 tests, each shown to fail under a one-line change to `src/` and to pass again once the line was restored):
  - A signed-out visitor is refused the ledger (find, find by id, count) and the state: `who can read and change it > refuses a signed-out visitor…`.
  - Nobody updates or deletes a ledger record through the API, a manager included: `who can read and change it > lets nobody change or delete a ledger record…`.
  - A manager reads the state, and nobody creates, updates or deletes it through the API: `who can read and change it > shows the state to a manager…`.
  - The ledger's fields are pinned to a list with nowhere to put a prompt, an answer or a person, and the stored records carry no key or prompt from a failed call: `what is kept and logged > has no field…`.
  - No log line carries a key, a prompt or an answer, for a failed call, an unpriced answer or a failed ledger write: `what is kept and logged > never logs a key…`.
  - The state reads but the spend can't be read: refused without calling: `failing closed > refuses without calling when the state reads…`.
  - The state can be neither read nor made: refused without calling: `failing closed > refuses without calling when the state can be neither read nor made`.
  - A cap adds up every record, here twenty: `failing closed > adds up every record toward a cap…`.
  - A refused job's call never runs (unknown job, over a cap, credits out): `failing closed > never calls for a refused job…`.
  - A job with a $0 cap is always refused: `with the Notifications plugin > refuses every call of a job whose cap is $0`.
  - The 75% and 90% marks, and no mark under 50%: `the summary’s marks`.
  - The notice kind is registered and goes to each account in `notify`, with `onCreditsOut` left alone: `with the Notifications plugin > registers its kind…`.
  - A failed notice falls back to `onCreditsOut`, and the log keeps the error's text out: `with the Notifications plugin > falls back to onCreditsOut…`.
  - When nobody could be told, an error is logged and the pause still holds: `with the Notifications plugin > logs an error when nobody could be told…`.
  - The start-up warning when neither `notify` nor `onCreditsOut` is given: `with the Notifications plugin > warns at start-up…`.
- **Mutation check:** 22 one-line changes to `src/` (access rules opened or closed, a prompt field added, whole errors and answers logged, unreadable spend or state treated as fine, a sum cut to ten records, a $0 cap ignored, notices and warnings dropped). Each made its new test fail, and each test passed again on the restored source.
- **Gaps skipped:**
  - A real API call. The adapter reads answers by shape, and a live call costs money and needs a key.
  - The real Notifications plugin. The tests use a stand-in for the one function AI Budget looks for, so that plugin's own delivery is its own suite's job.
  - REST and GraphQL requests. The Local API with `overrideAccess: false` runs the same access functions, and the transport is Payload's.
  - Two calls passing a cap at the same moment. The README lists that overshoot as a limit, so there is no promise to prove.
  - Day and month boundaries at UTC midnight. They need a fake clock through the whole stack for a one-line date calculation that the cap tests already run.
  - The projection's exact value. It depends on the day of the month, and the existing test checks its floor.
  - The admin dashboard view, which still isn't built.

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
