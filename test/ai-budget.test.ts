import { mongooseAdapter } from '@payloadcms/db-mongodb'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { inspect } from 'node:util'

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

// Added by the 2026-11-26 audit. Everything below uses made-up keys, prompts and accounts.
const mongoOf = (p: Payload, slug: string) => (p.db as unknown as { collections: Record<string, { collection: { deleteMany: (q: object) => Promise<unknown>; find: (q: object) => { toArray: () => Promise<Doc[]> } } }> }).collections[slug]!.collection
const SECRET = 'sk-made-up-key-0000'
const PROMPT = 'a made-up private prompt'
/** Everything a logger spy was given, error messages and stacks included. */
const logged = (...spies: { mock: { calls: unknown[][] } }[]) => inspect(spies.map((s) => s.mock.calls), { depth: 8 })

describe('who can read and change it', () => {
  const as = (role: string) => ({ overrideAccess: false, user: { id: 'u', role, collection: 'users' } as never })
  const signedOut = { overrideAccess: false }

  it('refuses a signed-out visitor the ledger and the state', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer())
    const [r] = await ledger()
    await expect(payload.find({ collection: 'ai-usage' as never, ...signedOut })).rejects.toThrow()
    await expect(payload.findByID({ collection: 'ai-usage' as never, id: r!.id, ...signedOut })).rejects.toThrow()
    await expect(payload.count({ collection: 'ai-usage' as never, ...signedOut })).rejects.toThrow()
    await expect(payload.find({ collection: 'ai-budget-state' as never, ...signedOut })).rejects.toThrow()
  })

  it('lets nobody change or delete a ledger record through the API, a manager included', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer())
    const [r] = await ledger()
    for (const who of [as('staff'), as('member'), signedOut]) {
      await expect(payload.update({ collection: 'ai-usage' as never, id: r!.id, data: { costMicros: 0 } as never, ...who })).rejects.toThrow()
      await expect(payload.delete({ collection: 'ai-usage' as never, id: r!.id, ...who })).rejects.toThrow()
    }
    expect(await ledger()).toMatchObject([{ id: r!.id, costMicros: r!.costMicros }])
  })

  it('shows the state to a manager, and lets nobody make, change or delete it through the API', async () => {
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    const { docs } = await payload.find({ collection: 'ai-budget-state' as never, ...as('staff') })
    expect(docs).toMatchObject([{ key: 'state', creditsOut: true }])
    const id = (docs[0] as Doc).id
    for (const who of [as('staff'), as('member'), signedOut]) {
      await expect(payload.create({ collection: 'ai-budget-state' as never, data: { key: 'other' } as never, ...who })).rejects.toThrow()
      await expect(payload.update({ collection: 'ai-budget-state' as never, id, data: { creditsOut: false } as never, ...who })).rejects.toThrow()
      await expect(payload.delete({ collection: 'ai-budget-state' as never, id, ...who })).rejects.toThrow()
    }
    expect((await spendSummary(payload)).creditsOut).toBe(true) // still paused: nobody switched it back on
  })
})

describe('what is kept and logged', () => {
  it('has no field that could hold a prompt, an answer or a person', async () => {
    const fields = (payload.collections['ai-usage' as never] as { config: { fields: Doc[] } }).config.fields
    expect(fields.map((f) => f.name).sort()).toEqual(['at', 'batch', 'cacheReadTokens', 'cacheWriteTokens', 'costMicros', 'inputTokens', 'job', 'model', 'outputTokens', 'prices', 'provider', 'refusal', 'run', 'seeded', 'settled', 'unknownModel', 'unpriced'])
    expect(fields.filter((f) => !['checkbox', 'date', 'number', 'select', 'text'].includes(f.type))).toEqual([])
    // What is stored, read straight from the database: a paid call, and a call that failed with a key in its error.
    await withAiBudget(payload, { job: 'watch', run: run() }, async () => ({ model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: PROMPT }] }))
    await withAiBudget(payload, { job: 'watch', run: run() }, async () => { throw new Error(`401 for ${SECRET}: ${PROMPT}`) }).catch(() => undefined)
    const stored = await mongoOf(payload, 'ai-usage').find({}).toArray()
    expect(stored).toHaveLength(2)
    expect(JSON.stringify(stored)).not.toContain(SECRET)
    expect(JSON.stringify(stored)).not.toContain(PROMPT)
    expect(stored.flatMap((d) => Object.keys(d)).filter((k) => !['_id', '__v', ...fields.map((f) => f.name)].includes(k))).toEqual([])
  })

  it('never logs a key, a prompt or an answer: not for a failed call, an unpriced answer or a ledger write that fails', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer()) // makes the state, so the only create below is the ledger's
    const spies = (['info', 'warn', 'error'] as const).map((k) => vi.spyOn(payload.logger, k))
    try {
      await expect(withAiBudget(payload, { job: 'watch', run: run() }, async () => { throw new Error(`401 for ${SECRET}: ${PROMPT}`) })).rejects.toThrow(SECRET) // the caller still gets its own error
      await withAiBudget(payload, { job: 'watch', run: run() }, async () => ({ id: 'made-up-stream', text: PROMPT }))
      expect(logged(spies[1]!)).toContain('recorded as unpriced')
      const create = vi.spyOn(payload, 'create').mockRejectedValueOnce(new Error(`made-up write failure near ${SECRET}`))
      const out = await withAiBudget(payload, { job: 'watch', run: run() }, async () => ({ model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 10 }, text: PROMPT }))
      create.mockRestore()
      expect(out.text).toBe(PROMPT) // the call was paid for, so its answer comes back
      expect(logged(spies[2]!)).toContain('could not be recorded')
      expect(logged(...spies)).not.toContain(SECRET)
      expect(logged(...spies)).not.toContain(PROMPT)
    } finally {
      spies.forEach((s) => s.mockRestore())
    }
  })
})

describe('failing closed', () => {
  const realFind = (p: Payload) => p.find.bind(p) as unknown as (a: Doc) => Promise<Doc>

  it('refuses without calling when the state reads but the ledger’s spend can’t', async () => {
    await withAiBudget(payload, { job: 'watch', run: run() }, answer())
    const find = realFind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation(((a: Doc) => (a.collection === 'ai-usage' ? Promise.reject(new Error('made-up ledger outage')) : find(a))) as never)
    const call = vi.fn(answer())
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).rejects.toThrow('made-up ledger outage')
    spy.mockRestore()
    expect(call).not.toHaveBeenCalled()
    expect(await ledger()).toHaveLength(1)
  })

  it('refuses without calling when the state can be neither read nor made', async () => {
    const find = realFind(payload)
    const spy = vi.spyOn(payload, 'find').mockImplementation(((a: Doc) => (a.collection === 'ai-budget-state' ? Promise.resolve({ docs: [] }) : find(a))) as never)
    const create = vi.spyOn(payload, 'create').mockRejectedValue(new Error('made-up write outage'))
    const call = vi.fn(answer())
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).rejects.toThrow(/state could not be read/)
    spy.mockRestore()
    create.mockRestore()
    expect(call).not.toHaveBeenCalled()
  })

  it('adds up every record toward a cap, however many there are', async () => {
    const r = run()
    // Twenty calls of 5 cents reach the $1 run cap. The first ten alone would not.
    await mongoOf(payload, 'ai-usage').deleteMany({})
    await (raw()['ai-usage']!.collection.insertMany(Array.from({ length: 20 }, () => ({ at: new Date(), job: 'translate', run: r, costMicros: 50_000 }))))
    const call = vi.fn(answer())
    const refused = await withAiBudget(payload, { job: 'translate', run: r }, call).catch((e) => e)
    expect(refused).toBeInstanceOf(BudgetSpent)
    expect(refused.cap).toBe('run')
    expect(call).not.toHaveBeenCalled()
  })

  it('never calls for a refused job: unknown, over its cap, or while the credits are out', async () => {
    const call = vi.fn(answer())
    await expect(withAiBudget(payload, { job: 'made-up', run: run() }, call)).rejects.toBeInstanceOf(UnknownJob)
    await raw()['ai-usage']!.collection.insertMany([{ at: new Date(), job: 'watch', run: 'earlier', costMicros: 250_000 }])
    await expect(withAiBudget(payload, { job: 'watch', run: run() }, call)).rejects.toBeInstanceOf(BudgetSpent)
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    await expect(withAiBudget(payload, { job: 'translate', run: run() }, call)).rejects.toBeInstanceOf(CreditsOut)
    expect(call).not.toHaveBeenCalled()
    expect((await ledger()).filter((d) => d.run !== 'earlier' && !d.refusal)).toHaveLength(0) // refusals only: nothing was spent
  })
})

describe('the summary’s marks', () => {
  it('reports the 75% and 90% marks, and none under 50%', async () => {
    const now = new Date()
    const add = (usd: number) => raw()['ai-usage']!.collection.insertMany([{ at: now, job: 'seed', run: 'x', costMicros: usd * 1_000_000 }])
    await add(7.35)
    expect((await spendSummary(payload, { now })).level).toBe(0) // 49%
    await add(3.9)
    expect((await spendSummary(payload, { now })).level).toBe(75) // $11.25 of $15
    await add(2.25)
    expect((await spendSummary(payload, { now })).level).toBe(90) // $13.50 of $15
  })
})

describe('with the Notifications plugin', () => {
  let site: Payload
  const sent = vi.fn(async (_p: unknown, _notice: Doc): Promise<void> => undefined)
  const fallback = vi.fn(async (_args: Doc): Promise<void> => undefined)

  beforeAll(async () => {
    site = await getPayload({
      key: 'with-notifications',
      config: await buildConfig({
        secret: 'test-secret-not-for-production',
        telemetry: false,
        typescript: { autoGenerate: false },
        db: mongooseAdapter({ url: mongo.getUri('aibudget-notifications'), ensureIndexes: true }),
        collections: [{ slug: 'users', auth: true, fields: [] }],
        // A stand-in for the Notifications plugin: the one function AI Budget looks for.
        custom: { notifications: { notify: (p: unknown, notice: Doc) => sent(p, notice) } },
        plugins: [
          aiBudgetPlugin({
            caps: { month: 15, day: 1.5, jobs: { a: { label: 'Job A' }, off: { run: 0 } } },
            prices: anthropicPrices,
            provider: anthropicProvider,
            access: { manage: () => true },
            notify: ['account-1', 'account-2'],
            onCreditsOut: (args) => fallback(args),
          }),
        ],
      }),
    } as never)
  }, 120_000)

  afterAll(async () => {
    await site?.destroy()
  })

  beforeEach(async () => {
    sent.mockReset()
    fallback.mockReset()
    for (const slug of ['ai-usage', 'ai-budget-state']) await mongoOf(site, slug).deleteMany({})
  })

  it('registers its kind, and sends the notice to each account in notify and not to onCreditsOut', async () => {
    const kinds = (site.config.custom!.notificationKinds as Doc[]).find((k) => k.owner === 'ai-budget')!.kinds['ai-budget:credits-out']
    expect(kinds.email({ paused: 'Job A', lastMonth: '$3.00', suggest: '$10' }).text).toContain('auto-reload of $10 would cover it; nothing is set up until you choose to')
    expect(kinds.email({ paused: 'Job A', lastMonth: '$3.00', suggest: '' }).text).not.toContain('auto-reload')
    await expect(withAiBudget(site, { job: 'a', run: 'r1' }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
    expect(sent.mock.calls.map((c) => c[1])).toEqual(['account-1', 'account-2'].map((recipient) => ({ recipient, kind: 'ai-budget:credits-out', params: { paused: 'Job A, off', lastMonth: '$0.00', suggest: '' } })))
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to onCreditsOut when Notifications fails, and logs it without the error’s text', async () => {
    sent.mockRejectedValue(new Error(`made-up mail failure with ${SECRET}`))
    const error = vi.spyOn(site.logger, 'error')
    try {
      await expect(withAiBudget(site, { job: 'a', run: 'r1' }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
      expect(sent).toHaveBeenCalledTimes(2)
      expect(fallback).toHaveBeenCalledTimes(1)
      expect(fallback.mock.calls[0]![0]).toMatchObject({ paused: ['Job A', 'off'], lastMonthUSD: 0, suggestMonthlyUSD: null })
      expect(logged(error)).toContain('a credits-out notice was not sent')
      expect(logged(error)).not.toContain('nobody could be told')
      expect(logged(error)).not.toContain(SECRET)
    } finally {
      error.mockRestore()
    }
  })

  it('logs an error when nobody could be told, still pauses, and keeps the error’s text out of the log', async () => {
    sent.mockRejectedValue(new Error(`made-up mail failure with ${SECRET}`))
    fallback.mockRejectedValue(new Error(`made-up hook failure with ${SECRET}`))
    const error = vi.spyOn(site.logger, 'error')
    try {
      await expect(withAiBudget(site, { job: 'a', run: 'r1' }, noCredit)).rejects.toBeInstanceOf(CreditsOut)
      expect(logged(error)).toContain('nobody could be told')
      expect(logged(error)).not.toContain(SECRET)
      expect((await spendSummary(site)).creditsOut).toBe(true)
    } finally {
      error.mockRestore()
    }
  })

  it('refuses every call of a job whose cap is $0', async () => {
    const call = vi.fn(answer())
    const refused = await withAiBudget(site, { job: 'off', run: 'r1' }, call).catch((e) => e)
    expect(refused).toBeInstanceOf(BudgetSpent)
    expect(refused.cap).toBe('run')
    expect(call).not.toHaveBeenCalled()
  })

  it('warns at start-up when nobody would be told about a run-out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const base = { caps: { month: 10, day: 1, jobs: { a: {} } }, prices: anthropicPrices, provider: anthropicProvider, access: { manage: () => true } }
      aiBudgetPlugin({ ...base, onCreditsOut: () => undefined })({ collections: [] } as never)
      aiBudgetPlugin({ ...base, notify: ['account-1'] })({ collections: [] } as never)
      expect(warn).not.toHaveBeenCalled()
      aiBudgetPlugin(base)({ collections: [] } as never)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toMatch(/nobody will be told/)
    } finally {
      warn.mockRestore()
    }
  })
})
