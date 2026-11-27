# payload-plugin-ai-budget

AI Budget for Payload: a ledger of every AI API call's tokens and cost, budgets per job, day and month that stop a job cleanly, and a clear pause when prepaid credits run out.

**Status:** 0.1.0 is on npm (2026-11-13). 37 tests pass against Payload 3.92 with an in-memory MongoDB replica set, using fake answers shaped like Anthropic's (no real API is called) and a stand-in for the Notifications plugin. They cover the prices, the ledger and what it leaves out, every cap, fail-closed reads, the credits-out pause and probe, the notice and its fallbacks, the auto-reload suggestion, the summary and access, signed-out visitors included. No site uses it yet.

## What it does

- **`withAiBudget(payload, { job, run }, call)`** wraps each AI call.
  - **Before the call,** it refuses when:
    - the job isn't in your caps (`UnknownJob`), so nothing spends outside the budget by accident;
    - any cap is reached (`BudgetSpent`, with which cap): this run, this job today, everything today, everything this month. The tightest wins;
    - the prepaid credits are out (`CreditsOut`).
  - **After the call,** it records the call: the job, run, model and tokens (input, output, cache write, cache read), and the cost in micro-dollars from your dated price table.
  - It never records the prompt, the answer or who asked.
  - A failed call is recorded with zero tokens, and the error passes on.
  - **An answer with no token counts** (a batch create, a stream object) is recorded as **unpriced**: flagged, logged and counted in the summary, never as a silent $0. Record the real usage when it arrives with `recordUsage(payload, { job, run, batch }, results)`. Batch result entries (`{ result: { message } }`) are read as they come. For a stream, record its final message.
  - Wrap only the API call. An error thrown later, while you read the answer, isn't the call's.
  - If the ledger can't be read, it refuses without calling.
- **Your job catches `BudgetSpent`,** saves what it has done, and stops. Don't retry.
- **Prices** come from a dated table you pass. `anthropicPrices` (2026-11-10) ships as data.
  - A model the table doesn't know is priced at its most expensive row and flagged, so a new model can't hide spend.
  - Batch calls are half price, and Haiku prompts over 100,000 tokens use the long-prompt price.
  - Costs round up.
  - `costOf` is exported, so another tool can recompute and compare.
- **Providers are adapters:** `usageOf(answer)` and `isNoCredit(error)`. `anthropicProvider` reads answers by shape, with no SDK. Another provider is a few lines.
- **When the credits run out:**
  - the provider's billing error pauses every call (`CreditsOut`);
  - one call an hour from your `probeJob` (any job, if you don't name one) is let through to see if they're back, and only one worker probes at a time;
  - a successful probe resumes everything;
  - one notice goes out per run-out, never one per refused call. It goes through the Notifications plugin when it's there (to the accounts in `notify`), else your `onCreditsOut`.
  - The notice lists what's paused and last month's spend.
  - After a run-out in each of three months in a row, it also suggests a capped monthly auto-reload: the highest of those months, rounded up to the next $5, and never above `maxSuggestionUSD`. The plugin never sets anything up.
- **`spendSummary(payload)`**, for a spend card:
  - month to date, a projection to month end, and today;
  - the top jobs;
  - each cap's use;
  - the 50%, 75% and 90% marks;
  - whether the credits are out.
- **If nobody can be told:** with no Notifications recipients and no `onCreditsOut`, the run-out is logged as an error and the plugin warns at start-up. Give one of them.
- **Made-up test data** marked `seeded: true` shows in the summary and never counts toward a cap, so a seeded month can't refuse a real run on a test site.
- **Access:** managers read the ledger (`access.manage`, required; only an answer of exactly `true` counts). Nobody writes it through the API.

## On its own, and with others

**On its own:** wrap each AI call in `withAiBudget`, and give it caps, a price table, a provider and `access.manage`. Without Notifications, the credits-out notice goes to your `onCreditsOut`. It doesn't depend on any other plugin.

**Works with:**
- **Notifications:** when it's installed, AI Budget registers its `ai-budget:credits-out` kind through `config.custom.notificationKinds` and sends the notice to the accounts in `notify` through `config.custom.notifications.notify`.

**Family:** none yet. The plugin families are a working draft, and AI Budget isn't in it.

## Install

```sh
npm install @extantape/payload-plugin-ai-budget
```

```ts
import { aiBudgetPlugin, anthropicPrices, anthropicProvider, withAiBudget, BudgetSpent } from '@extantape/payload-plugin-ai-budget'

aiBudgetPlugin({
  caps: { month: 15, day: 1.5, jobs: { translate: { run: 1, label: 'Translation' }, watch: { day: 0.25 } } }, // USD
  prices: anthropicPrices,
  provider: anthropicProvider,
  access: { manage: ({ req }) => req.user?.role === 'admin' }, // required
  probeJob: 'watch',
  notify: [ownerAccountId],
})

try {
  const answer = await withAiBudget(payload, { job: 'translate', run: runId }, () => anthropic.messages.create({ … }))
} catch (e) {
  if (e instanceof BudgetSpent) { await saveProgress(); return }
  throw e
}
```

Caps, the price table and the suggestion ceiling are checked at start-up: no negatives, missing prices or job caps above the month. Job names are matched exactly, so `constructor` isn't a job.

## Limits

- **Overshoot:** two calls at the same moment can both pass the check, so a cap can be overshot by one call per worker running at once. On small models that's cents.
- **Batches overshoot by the whole batch.** A batch is checked at its create, when its cost is unknown, and priced when its results arrive. A batch can go past a cap by everything in it, so size each batch under its job's run cap (translation: well under $1). `recordUsage` settles the create's unpriced record and skips results that errored, expired or were canceled.
- **Summing:** each check reads the month's records. That's fine at thousands a month; at millions, it would need a running total.
- **The credits-out error** is recognised by its message. If a provider changes the wording, the call fails as an ordinary error and is recorded as one, so check the ledger's `error` records after a provider change.
- MongoDB only for now (conditional updates).

## Commands

```sh
npm test          # integration tests, in-memory MongoDB
npm run typecheck
npm run build
```

## License

MIT. See [LICENSE](LICENSE).
