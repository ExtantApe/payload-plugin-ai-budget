import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { buildConfig, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { aiBudgetPlugin, anthropicPrices, anthropicProvider, BudgetSpent, costOf, CreditsOut, recordUsage, spendSummary, UnknownJob, withAiBudget } from '../src/index.js'

// A made-up site's AI jobs, with fake answers shaped like Anthropic's. No real API is called.
type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

let payload: Payload
let mongo: MongoMemoryReplSet
const told: Doc[] = []
const answer = (model = 'claude-haiku-5-5-20261101', input = 1000, output = 500, extra: Doc = {}) => async () => ({ model, usage: { input_tokens: input, output_tokens: output, ...extra }, content: [{ type: 'text', text: 'a private answer' }] })
const noCredit = async () => {
  throw Object.assign(new Error('Your credit balance is too low to access the Anthropic API.'), { status: 400 })
}
const ledger = async () => (await payload.find({ collection: 'ai-usage' as never, sort: 'at', pagination: false, depth: 0, overrideAccess: true })).docs as Doc[]
const raw = () => (payload.db as unknown as { collections: Record<string, { collection: { deleteMany: (q: object) => Promise<unknown>; insertMany: (d: object[]) => Promise<unknown> } }> }).collections
let n = 0
const run = () => `run-${++n}`

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  payload = await getPayload({
    config: await buildConfig({
      secret: 'test-secret-not-for-production',
      telemetry: false,
      typescript: { autoGenerate: false },
      db: mongooseAdapter({ url: mongo.getUri('aibudget'), ensureIndexes: true }),
      collections: [{ slug: 'users', auth: true, fields: [{ name: 'role', type: 'text' }] }],
      plugins: [
        aiBudgetPlugin({
          caps: { month: 15, day: 1.5, jobs: { translate: { run: 1, label: 'Translation' }, watch: { day: 0.25, label: 'Watch' }, seed: { run: 10 } } },
          prices: anthropicPrices,
          provider: anthropicProvider,
          access: { manage: ({ req }) => ((req.user as { role?: string } | null)?.role === 'staff' ? true : (req.user as { role?: string } | null)?.role === 'query' ? ({ job: { equals: 'watch' } } as never) : false) },
          probeJob: 'watch',
          maxSuggestionUSD: 15,
          onCreditsOut: async (args) => void told.push(args),
        }),
      ],
    }),
  })
}, 120_000)

afterAll(async () => {
  await payload?.destroy()
  await mongo?.stop()
})

beforeEach(async () => {
  told.length = 0
  for (const slug of ['ai-usage', 'ai-budget-state']) await raw()[slug]?.collection.deleteMany({})
})

describe('prices', () => {
  it('prices every token kind, halves batch, switches for long prompts, and puts an unknown model at the top row', () => {
    const t = anthropicPrices
    // 100,000 tokens: at the long-prompt line, so the normal price.
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 100_000, outputTokens: 0 }, t).costMicros).toBe(10_000)
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 100_000 }, t).costMicros).toBe(50_000)
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 40_000, cacheReadTokens: 40_000 }, t).costMicros).toBe(5_400)
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 0, outputTokens: 100_000 }, t, { batch: true }).costMicros).toBe(25_000)
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 200_000, outputTokens: 1000 }, t).costMicros).toBe(102_500) // over 100K: $0.50 in, $2.50 out
    expect(costOf({ model: 'claude-haiku-5-5', inputTokens: 1, outputTokens: 0 }, t).costMicros).toBe(1) // a fraction rounds up, never down
    expect(costOf({ model: 'claude-haiku-5-5-20261101', inputTokens: 100_000, outputTokens: 0 }, t)).toEqual({ costMicros: 10_000, unknownModel: false })
    expect(costOf({ model: 'some-new-model', inputTokens: 100_000, outputTokens: 0 }, t)).toEqual({ costMicros: 400_000, unknownModel: true })
  })
})

describe('the ledger', () => {
  it('records each call’s tokens and cost, and never the prompt or the answer', async () => {
    const out = await withAiBudget(payload, { job: 'translate', run: run() }, answer('claude-haiku-5-5', 1000, 500, { cache_read_input_tokens: 2000 }))
    expect(out.content[0]!.text).toBe('a private answer')
    const [r] = await ledger()
    expect(r).toMatchObject({ job: 'translate', provider: 'anthropic', model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000, costMicros: 370, prices: '2026-11-10' })
    expect(JSON.stringify(r)).not.toContain('a private answer')
  })

  it('records a failed call with no tokens, and passes the error on', async () => {
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, async () => { throw new Error('made-up outage') })).rejects.toThrow('made-up outage')
    expect((await ledger())[0]).toMatchObject({ refusal: 'error', costMicros: 0 })
  })

  it('flags an unknown model', async () => {
    await withAiBudget(payload, { job: 'seed', run: run() }, answer('claude-new-9', 1000, 0))
    expect((await ledger())[0]).toMatchObject({ unknownModel: true, costMicros: 4000 })
  })
})

describe('caps', () => {
  const spend = async (job: string, usd: number, r = 'earlier', at = new Date()) =>
    raw()['ai-usage']!.collection.insertMany([{ at, job, run: r, costMicros: Math.round(usd * 1_000_000), prices: '2026-11-10' }])

  it('stops a run at its cap, records the refusal, and lets the next run start', async () => {
    const r = run()
    await spend('translate', 1, r)
    const refused = await withAiBudget(payload, { job: 'translate', run: r }, answer()).catch((e) => e)
    expect(refused).toBeInstanceOf(BudgetSpent)
    expect(refused.cap).toBe('run')
    expect((await ledger()).at(-1)).toMatchObject({ refusal: 'budget' })
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, answer())).resolves.toBeTruthy()
  })

  it('stops a job at its daily cap, everything at the day cap and at the month cap; the tightest wins', async () => {
    await spend('watch', 0.25)
    expect((await withAiBudget(payload, { job: 'watch', run: run() }, answer()).catch((e) => e)).cap).toBe('job-day')
    await raw()['ai-usage']!.collection.deleteMany({})
    await spend('seed', 1.5)
    expect((await withAiBudget(payload, { job: 'seed', run: run() }, answer()).catch((e) => e)).cap).toBe('day')
    await raw()['ai-usage']!.collection.deleteMany({})
    const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1, 0, 0, 1))
    await spend('seed', 15, 'old', monthStart)
    const r = await withAiBudget(payload, { job: 'seed', run: run() }, answer()).catch((e) => e)
    expect(r.cap).toBe(new Date().getUTCDate() === 1 ? 'day' : 'month')
  })

  it('never counts seeded test data toward a cap, but shows it in the summary', async () => {
    await raw()['ai-usage']!.collection.insertMany([{ at: new Date(), job: 'watch', run: 'seed-data', costMicros: 5_000_000, seeded: true }])
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, answer())).resolves.toBeTruthy()
    expect((await spendSummary(payload)).monthUSD).toBeGreaterThanOrEqual(5)
  })

  it('refuses a job that isn’t in the caps, and a call with no run id', async () => {
    await expect(withAiBudget(payload, { job: 'made-up', run: run() }, answer())).rejects.toBeInstanceOf(UnknownJob)
    await expect(withAiBudget(payload, { job: 'watch', run: '' }, answer())).rejects.toThrow(/run/)
  })

  it('refuses when the ledger can’t be read, without calling', async () => {
    const spy = vi.spyOn(payload, 'find').mockRejectedValueOnce(new Error('made-up database outage'))
    const call = vi.fn(answer())
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).rejects.toThrow()
    spy.mockRestore()
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses at start-up caps that make no sense', async () => {
    const base = { prices: anthropicPrices, provider: anthropicProvider, access: { manage: () => true } }
    const cfg = (caps: Doc, extra: Doc = {}) => aiBudgetPlugin({ ...base, caps, ...extra } as never)({ collections: [] } as never)
    expect(() => cfg({ month: -1, day: 1, jobs: { a: {} } })).toThrow(/caps.month/)
    expect(() => cfg({ month: 10, day: 1, jobs: {} })).toThrow(/at least one job/)
    expect(() => cfg({ month: 10, day: 1, jobs: { a: { run: 20 } } })).toThrow(/no higher than the monthly cap/)
    expect(() => cfg({ month: 10, day: 1, jobs: { a: {} } }, { probeJob: 'b' })).toThrow(/probeJob/)
    expect(() => cfg({ month: 10, day: 1, jobs: { a: {} } }, { access: undefined })).toThrow(/access.manage/)
  })
})

describe('when the credits run out', () => {
  it('pauses every call after the provider says so, tells the owner once, and lets one probe an hour through', async () => {
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    expect(told).toHaveLength(1)
    expect(told[0]!.paused).toEqual(['Translation', 'Watch', 'seed'])
    const call = vi.fn(answer())
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, call)).rejects.toBeInstanceOf(CreditsOut)
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).rejects.toBeInstanceOf(CreditsOut) // the run-out itself counts as this hour's probe
    expect(call).not.toHaveBeenCalled()
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    expect(told).toHaveLength(1) // one notice per run-out
    // An hour later, one probe from the cheapest job goes through; it succeeds, so calls resume.
    await payload.db.updateOne({ collection: 'ai-budget-state', where: { key: { equals: 'state' } }, data: { lastProbeAt: new Date(Date.now() - 2 * 3600_000).toISOString() } } as never)
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, call)).rejects.toBeInstanceOf(CreditsOut) // not the probe job
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).resolves.toBeTruthy()
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, call)).resolves.toBeTruthy()
    expect((await spendSummary(payload)).creditsOut).toBe(false)
  })

  it('lets only one worker probe at a time', async () => {
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    await payload.db.updateOne({ collection: 'ai-budget-state', where: { key: { equals: 'state' } }, data: { lastProbeAt: new Date(Date.now() - 2 * 3600_000).toISOString() } } as never)
    const call = vi.fn(async () => noCredit())
    const results = await Promise.allSettled([1, 2, 3].map(() => withAiBudget(payload, { job: 'watch', run: run() }, call)))
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(call).toHaveBeenCalledTimes(1)
    expect(told).toHaveLength(1) // the probe found them still out: no second notice
  })

  it('suggests a capped monthly amount only after three run-out months in a row', async () => {
    const months = [2, 1].map((back) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 10)) })
    await raw()['ai-usage']!.collection.insertMany([{ at: months[0], job: 'seed', run: 'a', costMicros: 7_200_000 }, { at: months[1], job: 'seed', run: 'b', costMicros: 3_000_000 }])
    const key = (d: Date) => d.toISOString().slice(0, 7)
    await payload.create({ collection: 'ai-budget-state' as never, data: { key: 'state', creditsOut: false, runOutMonths: [key(months[1]!)] } as never, overrideAccess: true })
    await withAiBudget(payload, { job: 'watch', run: run() }, noCredit).catch(() => undefined)
    expect(told[0]!.suggestMonthlyUSD).toBeNull() // two months in a row so far
    await raw()['ai-budget-state']!.collection.deleteMany({})
    await payload.create({ collection: 'ai-budget-state' as never, data: { key: 'state', creditsOut: false, runOutMonths: months.map(key) } as never, overrideAccess: true })
    told.length = 0
    await withAiBudget(payload, { job: 'watch', run: run() }, noCredit).catch(() => undefined)
    expect(told[0]!.suggestMonthlyUSD).toBe(10) // $7.20 rounded up to the next $5
    expect(told[0]!.lastMonthUSD).toBeCloseTo(3)
  })
})

describe('reading it', () => {
  it('summarises the month for a spend card', async () => {
    const now = new Date()
    await raw()['ai-usage']!.collection.insertMany([
      { at: now, job: 'translate', run: 'x', costMicros: 6_000_000 },
      { at: now, job: 'watch', run: 'y', costMicros: 2_000_000 },
    ])
    const s = await spendSummary(payload, { now })
    expect([s.monthUSD, s.todayUSD, s.topJobs[0]!.job, s.caps.month.pct, s.level]).toEqual([8, 8, 'translate', 53, 50])
    expect(s.projectedUSD).toBeGreaterThanOrEqual(8)
  })

  it('shows the ledger to managers only; nobody writes it through the API', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer())
    const as = (role: string) => ({ overrideAccess: false, user: { id: 'u', role, collection: 'users' } as never })
    await expect(payload.find({ collection: 'ai-usage' as never, ...as('member') })).rejects.toThrow()
    expect((await payload.find({ collection: 'ai-usage' as never, ...as('staff') })).docs).toHaveLength(1)
    await expect(payload.create({ collection: 'ai-usage' as never, data: { at: new Date().toISOString(), job: 'watch', costMicros: 0 } as never, ...as('staff') })).rejects.toThrow()
  })
})

describe('what the security read found', () => {
  it('records an answer with no usage (a batch create, a stream) as unpriced, never a silent $0, and prices batch results later', async () => {
    const r = run()
    await withAiBudget(payload, { job: 'translate', run: r, batch: true }, async () => ({ id: 'msgbatch_1', type: 'message_batch', processing_status: 'in_progress' }))
    expect((await ledger())[0]).toMatchObject({ unpriced: true, costMicros: 0 })
    expect((await spendSummary(payload)).unpriced).toBe(1)
    await recordUsage(payload, { job: 'translate', run: r, batch: true }, [
      { custom_id: 'a', result: { type: 'succeeded', message: { model: 'claude-haiku-5-5', usage: { input_tokens: 10_000, output_tokens: 10_000 } } } },
    ])
    expect((await ledger())[1]).toMatchObject({ costMicros: 3_000, batch: true, unpriced: false })
    expect((await ledger())[0]).toMatchObject({ unpriced: false, settled: true })
    await recordUsage(payload, { job: 'translate', run: r, batch: true }, [{ custom_id: 'b', result: { type: 'errored', error: {} } }, { custom_id: 'c', result: { type: 'expired' } }])
    expect((await ledger())).toHaveLength(2)
    expect((await spendSummary(payload)).unpriced).toBe(0)
    // A succeeded result with no usage stays unpriced, and an empty results list settles nothing.
    const r2 = run()
    await withAiBudget(payload, { job: 'translate', run: r2, batch: true }, async () => ({ id: 'msgbatch_2', type: 'message_batch' }))
    await recordUsage(payload, { job: 'translate', run: r2, batch: true }, [])
    await recordUsage(payload, { job: 'translate', run: r2, batch: true }, [{ custom_id: 'z', result: { type: 'succeeded', message: { model: 'claude-haiku-5-5' } } }])
    expect((await spendSummary(payload)).unpriced).toBe(2)
    // An answer whose usage has no counts is unpriced, not a valid $0.
    await withAiBudget(payload, { job: 'watch', run: run() }, async () => ({ model: 'claude-haiku-5-5', usage: {} }))
    expect((await ledger()).at(-1)).toMatchObject({ unpriced: true })
    await expect(recordUsage(payload, { job: 'made-up', run: r }, [])).rejects.toBeInstanceOf(UnknownJob)
  })

  it('treats negative or impossible token counts as unpriced, and a provider that throws as unpriced', async () => {
    const odd = { ...anthropicProvider, usageOf: () => ({ model: 'claude-haiku-5-5', inputTokens: -5_000_000, outputTokens: 0 }) }
    await withAiBudget(payload, { job: 'watch', run: run(), provider: odd }, answer())
    const broken = { ...anthropicProvider, usageOf: () => { throw new Error('made-up') } }
    await withAiBudget(payload, { job: 'watch', run: run(), provider: broken }, answer())
    expect((await ledger()).map((r) => [r.unpriced, r.costMicros])).toEqual([[true, 0], [true, 0]])
    expect(() => costOf({ model: 'claude-haiku-5-5', inputTokens: Number.NaN, outputTokens: 0 }, anthropicPrices)).toThrow()
  })

  it('refuses prototype names as jobs', async () => {
    await expect(withAiBudget(payload, { job: 'constructor', run: run() }, answer())).rejects.toBeInstanceOf(UnknownJob)
    await expect(withAiBudget(payload, { job: 'toString', run: run() }, answer())).rejects.toBeInstanceOf(UnknownJob)
  })

  it('checks prices and the suggestion ceiling at start-up', () => {
    const base = { caps: { month: 10, day: 1, jobs: { a: {} } }, provider: anthropicProvider, access: { manage: () => true }, onCreditsOut: () => undefined }
    const cfg = (extra: Doc) => aiBudgetPlugin({ ...base, prices: anthropicPrices, ...extra } as never)({ collections: [] } as never)
    expect(() => cfg({ prices: { date: 'x', models: { m: { input: 1 } } } })).toThrow(/input and output/)
    expect(() => cfg({ prices: { date: 'x', models: { m: { input: 1, output: -1 } } } })).toThrow(/input and output/)
    expect(() => cfg({ maxSuggestionUSD: -1 })).toThrow(/maxSuggestionUSD/)
    expect(() => cfg({ caps: { month: 10, day: -1, jobs: { a: {} } } })).toThrow(/caps.day/)
  })

  it('caps the auto-reload suggestion at the ceiling', async () => {
    const months = [2, 1].map((back) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 10)) })
    await raw()['ai-usage']!.collection.insertMany([{ at: months[0], job: 'seed', run: 'a', costMicros: 40_000_000 }])
    const key = (d: Date) => d.toISOString().slice(0, 7)
    await payload.create({ collection: 'ai-budget-state' as never, data: { key: 'state', creditsOut: false, runOutMonths: months.map(key) } as never, overrideAccess: true })
    await withAiBudget(payload, { job: 'watch', run: run() }, noCredit).catch(() => undefined)
    expect(told[0]!.suggestMonthlyUSD).toBe(15)
  })

  it('counts only an answer of exactly true as a manager, and keeps the state from members', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer())
    const as = (role: string) => ({ overrideAccess: false, user: { id: 'u', role, collection: 'users' } as never })
    await expect(payload.find({ collection: 'ai-usage' as never, ...as('query') })).rejects.toThrow()
    await expect(payload.find({ collection: 'ai-budget-state' as never, ...as('member') })).rejects.toThrow()
  })

  it('lets any job probe when no probe job is named, so a run-out never pauses things for good', async () => {
    const other = await getPayload({
      key: 'no-probe-job',
      config: await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url: mongo.getUri('aibudget-noprobe'), ensureIndexes: true }),
        collections: [{ slug: 'users', auth: true, fields: [] }],
        plugins: [aiBudgetPlugin({ caps: { month: 15, day: 1.5, jobs: { a: {} } }, prices: anthropicPrices, provider: anthropicProvider, access: { manage: () => true }, onCreditsOut: () => undefined })],
      }),
    } as never)
    await expect(withAiBudget(other, { job: 'a', run: 'r1' }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    await other.db.updateOne({ collection: 'ai-budget-state', where: { key: { equals: 'state' } }, data: { lastProbeAt: new Date(Date.now() - 2 * 3600_000).toISOString() } } as never)
    await expect(withAiBudget(other, { job: 'a', run: 'r2' }, answer())).resolves.toBeTruthy()
    await other.destroy()
  })
})
