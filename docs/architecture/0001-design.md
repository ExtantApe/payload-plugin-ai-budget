# 0001: AI Budget design record

Status: **draft** (2026-11-10). Nothing is built yet.

## Context

The platform's API cost ledger decision (2026-11-10) set out how Captive Origins records Claude API spend and stops jobs before they eat the month:
- a ledger, one record per call;
- caps per run, per job per day, per day and per month, checked before each call;
- a dated price table;
- a clear pause when the prepaid credits run out.

The owner decided on 2026-11-10 to build it as its own plugin, AI Budget, `@extantape/payload-plugin-ai-budget`, agnostic of provider. The site that uses it wires it in on top of it.

On running out, the owner chose: auto-reload off, and a notice that Claude services can't run until a prepaid amount is added. After the first time, keep the notice, and if it happens 3 months in a row, suggest a capped monthly amount.

MIT. Agnostic: it imports no AI SDK and none of our other plugins. A provider is an adapter of a few lines; Anthropic's ships with it as an export.

## Decision

AI Budget owns:
- recording each AI call's tokens and cost;
- deciding before each call whether a budget allows it;
- knowing when the credits are out;
- telling the owner once.

The site owns its jobs, its caps and its price table's numbers.

## 1. The ledger

Collection `ai-usage` (slug configurable). One record per call:

| Field | From |
| --- | --- |
| `at` | when the answer arrived (or the call failed) |
| `job` | the caller, from the site's list of jobs |
| `run` | one id per job run |
| `provider`, `model` | the adapter, and the answer's model |
| `batch` | batch pricing or not |
| `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens` | the answer's usage, through the adapter |
| `costMicros` | USD × 1,000,000, from the dated price table |
| `prices` | the table's date |
| `refusal` | `budget`, `no-credit` or `error`, when the call didn't happen or failed |
| `unknownModel` | true when the model wasn't in the table (priced at its most expensive row) |

No prompt text, no answer text, no user ids. Managers read it (`access.manage`, required). Nobody writes it through the API; the plugin writes it with the Local API.

## 2. `withAiBudget(payload, { job, run, batch? }, call)`

```ts
const answer = await withAiBudget(payload, { job: 'translate-content', run: runId }, () => anthropic.messages.create({ … }))
```

1. **Credits out?** If the plugin knows the credits are out, refuse with `CreditsOut`, except for one probe call an hour (below).
2. **Budgets:** sum `costMicros` for this run, for this job today (UTC), for every job today, and for every job this month. If any total has reached its cap, refuse with `BudgetSpent` and record the refusal. The job catches it, saves its progress and stops: never a crash, never a retry loop.
3. **Call.**
4. **Record:**
   - on success, the usage and cost through the provider adapter;
   - on the provider's "no credit" error, a `no-credit` record. Credits are now out. Throw `CreditsOut`.
   - on any other error, an `error` record with zero tokens. Rethrow.
5. **If the ledger can't be read, refuse** (fail closed), as the cost ledger design says.

**Overshoot:** two calls at the same moment can both pass the check, so a cap can be overshot by one call per concurrent worker. The cost ledger design accepts this, and the README says so.

## 3. Caps, from the site

```ts
caps: {
  month: 15, day: 1.5,                                   // USD, all jobs
  jobs: {
    'translate-interface': { run: 1 }, 'translate-content': { run: 1 },
    consensus: { day: 0.25 }, watch: { day: 0.25 }, paper: { day: 0.25 }, formats: { day: 0.25 },
    seed: { run: 10 },
  },
}
```

- Every cap applies, so the tightest wins.
- A job that isn't listed is refused (`unknownJob`), so a new caller can't spend outside the budget by accident.
- Caps are read once at start-up and checked for sense: no negatives, and a run cap no higher than the month.

## 4. Prices

- The site passes a dated table: `{ date: '2026-11-10', models: { 'claude-haiku-5-5': { input, output, cacheWrite, cacheRead, batchFactor, longContext?: { over, input, output } } } }`.
- The plugin exports `anthropicPrices` with the 2026-11-10 numbers from the cost ledger design, for sites that want them. It's data, dated, and never fetched.
- An unknown model is priced at the table's most expensive row and flagged (`unknownModel`), so a new model can't hide spend.
- `costOf(usage, model, table)` is exported, so the Console can recompute with its own copy of the table and compare.

## 5. Providers (adapters)

```ts
type AiProvider = {
  name: string
  usageOf: (answer: unknown) => { model: string; inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number } | null
  isNoCredit: (error: unknown) => boolean
}
```

- `anthropicProvider` ships with the plugin. It reads `usage`, the model and the billing error by shape, with no SDK import.
- Another provider is a few lines. The site passes `provider` per call or once in the options.

## 6. When the credits run out

- **The state is kept in an `ai-budget-state` document:** `creditsOut`, since when, the last probe, and the run-out months.
- **While out:** every call is refused with `CreditsOut`, except at most one probe an hour, from the job the site names as cheapest (`probeJob`). A probe that succeeds clears the state.
- **One notice per run-out, not per refused call:**
  - It goes through the Notifications plugin when it's there (kind `ai-budget:credits-out`, high priority, required), else the site's `onCreditsOut`.
  - It says Claude services are paused until a prepaid amount is added, lists the paused jobs (the site's labels), and gives last month's spend as a guide.
- **Three months in a row:** after a run-out in each of 3 consecutive months, the notice also suggests a capped monthly auto-reload. The amount is the highest of those months' spend, rounded up to the next $5, and never above `maxSuggestion` (the agreed API share) without the owner's yes. The plugin only suggests; it never sets anything up.

## 7. Reading it

- **`spendSummary(payload, { now })`:**
  - month to date;
  - a projection to month end;
  - the top jobs;
  - today;
  - whether the credits are out;
  - each cap's use as a percentage, with the 50%, 75% and 90% marks.

  The Console's Spend card and the site's admin can both use it.
- **An admin view** (a small dashboard component) shows the same, for managers. It has a keyboard path, words with every colour, and a 375px width.

## Tests (planned)

- Caps:
  - each cap refuses at its limit (run, job per day, day, month);
  - the tightest wins;
  - an unknown job is refused;
  - an unreadable ledger refuses.
- Ledger:
  - a success records tokens and cost;
  - a failure records zero tokens and `error`;
  - nothing of the prompt or the answer is stored.
- Prices:
  - each token kind is priced;
  - batch costs half;
  - long context changes the price;
  - an unknown model is priced at the top row and flagged.
- Credits out:
  - detected from the provider's error;
  - every later call is refused;
  - one probe an hour;
  - a successful probe clears it;
  - one notice per run-out;
  - the suggestion appears only after 3 consecutive months, rounded and capped.
- The summary's numbers, against a made-up month.
- Access:
  - managers only;
  - API writes refused.

## Captive Origins

- The site's own change wraps its five callers (translate, consensus, watch, paper with formats, and Seed) in `withAiBudget`, with the caps from its cost ledger decision.
- Seed's own `capUSD` stays, and both checks apply.
- The team that keeps the site's seed data hears about `ai-usage` and `ai-budget-state` before the build. Test data needs a month of made-up usage for the tour's Spend card.

## Open

- **The Admin API cost report** stays the Console's job, since it needs the owner's Admin key.
- **Whether the Console's Claude Code calls count:** they're on the Claude plan, not the API, so not here.

## Rough time

These are guesses of session days, not promises: the ledger, prices and adapter, 0.5; withAiBudget and the caps, 0.5; credits out, the probe and notices, 0.5; the summary and the admin view, 0.5; tests, the security read and docs, 1. About 3 in all.
