import type { CollectionSlug, Payload, Where } from 'payload'

import { costOf, validUsage } from './prices.js'
import type { AiProvider, Resolved } from './types.js'

type Doc = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const sys = { overrideAccess: true, depth: 0 } as const
const HOUR = 60 * 60 * 1000
const USD = 1_000_000

/** A budget is spent: the job should save what it has and stop. Never retry. */
export class BudgetSpent extends Error {
  constructor(readonly cap: 'run' | 'job-day' | 'day' | 'month', readonly job: string) {
    super(`AI budget spent (${cap} cap for ${job}). The job should save its progress and stop.`)
    this.name = 'BudgetSpent'
  }
}
/** The account's prepaid credits are out: every AI call is paused until they're topped up. */
export class CreditsOut extends Error {
  constructor() {
    super('AI credits are out: AI services are paused until a prepaid amount is added.')
    this.name = 'CreditsOut'
  }
}
/** A job that isn't in the caps: refused, so nothing spends outside the budget by accident. */
export class UnknownJob extends Error {
  constructor(readonly job: string) {
    super(`AI Budget: "${job}" isn't a job in the caps, so the call was refused.`)
    this.name = 'UnknownJob'
  }
}

const configOf = (payload: Payload): Resolved => {
  const o = payload.config.custom?.aiBudget as Resolved | undefined
  if (!o) throw new Error('AI Budget: the plugin is not configured on this site.')
  return o
}

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
const monthKey = (d: Date) => d.toISOString().slice(0, 7)

/** Real spend for a cap: made-up records (seeded test data) never count, so they can't refuse a real run. */
async function spent(payload: Payload, where: Where): Promise<number> {
  const o = configOf(payload)
  where = { and: [where, { seeded: { not_equals: true } }] }
  // A month of calls is a few thousand small records at most: summed here, so no aggregation is needed.
  const docs = (await payload.find({ collection: o.usage as CollectionSlug, where, pagination: false, select: { costMicros: true } as never, ...sys })).docs as Doc[]
  return docs.reduce((s, d) => s + (Number(d.costMicros) || 0), 0)
}

async function record(payload: Payload, data: Doc) {
  const o = configOf(payload)
  await payload.create({ collection: o.usage as CollectionSlug, data: { at: new Date().toISOString(), prices: o.prices.date, ...data } as never, ...sys })
}

// ---------------------------------------------------------------------------------------------
// The state: whether credits are out, and the months they ran out

const KEY = 'state'

/** The one state document, made on first use (a unique key stops two being made). */
async function loadState(payload: Payload): Promise<Doc> {
  const o = configOf(payload)
  const find = async () => ((await payload.find({ collection: o.state as CollectionSlug, where: { key: { equals: KEY } }, limit: 1, pagination: false, ...sys })).docs as Doc[])[0]
  const found = await find()
  if (found) return found
  await payload.create({ collection: o.state as CollectionSlug, data: { key: KEY, creditsOut: false } as never, ...sys }).catch(() => undefined)
  const made = await find()
  if (!made) throw new Error('AI Budget: the state could not be read.')
  return made
}
async function saveState(payload: Payload, data: Doc) {
  const o = configOf(payload)
  const state = await loadState(payload)
  await payload.db.updateOne({ collection: o.state, where: { id: { equals: state.id } }, data } as never)
}

/** Takes the hourly probe slot with a conditional write, so only one worker probes. */
async function claimProbe(payload: Payload, now: Date): Promise<boolean> {
  const o = configOf(payload)
  const state = await loadState(payload)
  const prev = state.lastProbeAt ?? null
  if (prev && now.getTime() - new Date(prev).getTime() < HOUR) return false
  const done = await payload.db.updateOne({
    collection: o.state,
    where: { and: [{ id: { equals: state.id } }, prev === null ? { lastProbeAt: { exists: false } } : { lastProbeAt: { equals: prev } }] },
    data: { lastProbeAt: now.toISOString() },
  } as never)
  return Boolean(done)
}

/** Last full month's spend in USD, and the auto-reload suggestion after three run-out months in a row. */
async function guide(payload: Payload, now: Date, runOutMonths: string[]) {
  const o = configOf(payload)
  const thisMonth = startOfMonth(now)
  const lastMonth = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - 1, 1))
  const lastMonthUSD = (await spent(payload, { and: [{ at: { greater_than_equal: lastMonth.toISOString() } }, { at: { less_than: thisMonth.toISOString() } }] })) / USD
  const months = [0, 1, 2].map((i) => monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))))
  if (!months.every((m) => runOutMonths.includes(m))) return { lastMonthUSD, suggestMonthlyUSD: null }
  let top = 0
  for (const m of months) {
    const from = new Date(`${m}-01T00:00:00Z`)
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1))
    top = Math.max(top, (await spent(payload, { and: [{ at: { greater_than_equal: from.toISOString() } }, { at: { less_than: to.toISOString() } }] })) / USD)
  }
  const rounded = Math.ceil(top / 5) * 5 || 5
  return { lastMonthUSD, suggestMonthlyUSD: Math.min(rounded, o.maxSuggestionUSD) }
}

async function creditsRanOut(payload: Payload, now: Date) {
  const o = configOf(payload)
  const state = await loadState(payload)
  const months = [...new Set([...((state.runOutMonths as string[] | undefined) ?? []), monthKey(now)])].slice(-12)
  // One notice per run-out, even with several workers at once: only the write that flips the flag sends it.
  const flipped = await payload.db.updateOne({
    collection: o.state,
    where: { and: [{ id: { equals: state.id } }, { creditsOut: { not_equals: true } }] },
    data: { creditsOut: true, creditsOutSince: now.toISOString(), runOutMonths: months, lastProbeAt: now.toISOString() },
  } as never)
  if (!flipped) return
  const paused = Object.entries(o.caps.jobs).map(([k, v]) => v.label ?? k)
  let g = { lastMonthUSD: 0, suggestMonthlyUSD: null as number | null }
  try {
    g = await guide(payload, now, months)
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'ai-budget: last month’s spend could not be read for the notice' })
  }
  const notify = payload.config.custom?.notifications?.notify as ((p: Payload, i: unknown) => Promise<unknown>) | undefined
  let sent = false
  if (notify && o.notify.length) {
    for (const to of o.notify) {
      try {
        await notify(payload, { recipient: to, kind: 'ai-budget:credits-out', params: { paused: paused.join(', '), lastMonth: `$${g.lastMonthUSD.toFixed(2)}`, suggest: g.suggestMonthlyUSD ? `$${g.suggestMonthlyUSD}` : '' } })
        sent = true
      } catch (error) {
        payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'ai-budget: a credits-out notice was not sent' })
      }
    }
  }
  if (!sent && o.onCreditsOut) {
    try {
      await o.onCreditsOut({ paused, lastMonthUSD: g.lastMonthUSD, suggestMonthlyUSD: g.suggestMonthlyUSD, payload })
      sent = true
    } catch (error) {
      payload.logger.error({ err: { name: (error as Error)?.name }, msg: 'ai-budget: onCreditsOut failed' })
    }
  }
  if (!sent) payload.logger.error({ msg: 'ai-budget: AI credits ran out and AI services are paused, but nobody could be told (no Notifications recipients and no onCreditsOut)' })
}

// ---------------------------------------------------------------------------------------------

/**
 * Runs one AI call inside the budget. Refuses before calling when credits are out (`CreditsOut`, except one probe
 * an hour from `probeJob`), when the job isn't in the caps (`UnknownJob`), or when any cap is reached
 * (`BudgetSpent`). Records every call, failures included, with tokens and cost and never the prompt or answer.
 * If the ledger can't be read, it refuses: it fails closed.
 */
export async function withAiBudget<T>(payload: Payload, args: { job: string; run: string; batch?: boolean; provider?: AiProvider }, call: () => Promise<T>): Promise<T> {
  const o = configOf(payload)
  const provider = args.provider ?? o.provider
  const now = new Date()
  const jobCap = typeof args.job === 'string' && Object.hasOwn(o.caps.jobs, args.job) ? o.caps.jobs[args.job] : undefined
  if (!jobCap) throw new UnknownJob(String(args.job))
  if (typeof args.run !== 'string' || !args.run) throw new Error('AI Budget: give each job run an id (`run`).')

  // Fail closed: anything below that can't be read refuses the call.
  const state = await loadState(payload)
  let probing = false
  if (state.creditsOut) {
    // With no probeJob named, any job may take the hourly probe, so a run-out can never pause things for good.
    if ((o.probeJob && args.job !== o.probeJob) || !(await claimProbe(payload, now))) {
      await record(payload, { job: args.job, run: args.run, provider: provider.name, refusal: 'no-credit', costMicros: 0 })
      throw new CreditsOut()
    }
    probing = true
  }
  const caps: [BudgetSpent['cap'], number | undefined, Where][] = [
    ['run', jobCap.run, { and: [{ job: { equals: args.job } }, { run: { equals: args.run } }] }],
    ['job-day', jobCap.day, { and: [{ job: { equals: args.job } }, { at: { greater_than_equal: startOfDay(now).toISOString() } }] }],
    ['day', o.caps.day, { at: { greater_than_equal: startOfDay(now).toISOString() } }],
    ['month', o.caps.month, { at: { greater_than_equal: startOfMonth(now).toISOString() } }],
  ]
  for (const [cap, usd, where] of caps) {
    if (usd === undefined) continue
    if ((await spent(payload, where)) >= usd * USD) {
      await record(payload, { job: args.job, run: args.run, provider: provider.name, refusal: 'budget', costMicros: 0 })
      throw new BudgetSpent(cap, args.job)
    }
  }

  let answer: T
  try {
    answer = await call()
  } catch (error) {
    let noCredit = false
    try {
      noCredit = provider.isNoCredit(error) === true
    } catch {
      noCredit = false
    }
    if (noCredit) {
      await record(payload, { job: args.job, run: args.run, provider: provider.name, refusal: 'no-credit', costMicros: 0 })
      await creditsRanOut(payload, now)
      throw new CreditsOut()
    }
    await record(payload, { job: args.job, run: args.run, provider: provider.name, refusal: 'error', costMicros: 0 })
    throw error
  }
  await recordAnswer(payload, { job: args.job, run: args.run, batch: args.batch, provider }, answer)
  if (probing) await saveState(payload, { creditsOut: false, creditsOutSince: null })
  return answer
}

/**
 * Records an answer's tokens and cost. An answer with no usage (a batch create, a stream object) or with counts
 * that make no sense is recorded as unpriced, flagged and logged, never as a silent $0. Never throws: the call
 * already happened, so its answer is returned even if the ledger write fails (that's logged).
 */
async function recordAnswer(payload: Payload, args: { job: string; run: string; batch?: boolean; provider: AiProvider }, answer: unknown): Promise<boolean> {
  const o = configOf(payload)
  let usage = null as ReturnType<AiProvider['usageOf']>
  try {
    usage = args.provider.usageOf(answer)
  } catch {
    usage = null
  }
  const valid = usage !== null && validUsage(usage)
  const priced = valid ? costOf(usage!, o.prices, { batch: args.batch }) : { costMicros: 0, unknownModel: false }
  if (!valid) payload.logger.warn({ job: args.job, msg: 'ai-budget: an AI answer had no usable token counts, so it was recorded as unpriced. Record its usage with recordUsage when it arrives.' })
  try {
    await record(payload, {
      job: args.job,
      run: args.run,
      provider: args.provider.name,
      model: valid ? usage!.model : null,
      batch: Boolean(args.batch),
      inputTokens: valid ? usage!.inputTokens : 0,
      outputTokens: valid ? usage!.outputTokens : 0,
      cacheWriteTokens: valid ? (usage!.cacheWriteTokens ?? 0) : 0,
      cacheReadTokens: valid ? (usage!.cacheReadTokens ?? 0) : 0,
      costMicros: priced.costMicros,
      unknownModel: priced.unknownModel,
      unpriced: !valid,
    })
  } catch (error) {
    payload.logger.error({ err: { name: (error as Error)?.name }, job: args.job, msg: 'ai-budget: a paid AI call could not be recorded; its cost is missing from the ledger' })
    return false
  }
  return valid
}

/**
 * Records usage that arrives later, without a call: each result of a batch, or a stream's final message. Counts
 * toward the caps like any other call. Batch prices apply when `batch` is true.
 */
export async function recordUsage(payload: Payload, args: { job: string; run: string; batch?: boolean; provider?: AiProvider }, answers: unknown[]) {
  const o = configOf(payload)
  if (!(typeof args.job === 'string' && Object.hasOwn(o.caps.jobs, args.job))) throw new UnknownJob(String(args.job))
  // Results that errored, expired or were canceled cost nothing: they're skipped, not recorded as unpriced.
  const billable = answers.filter((a) => {
    const t = (a as { result?: { type?: unknown } } | null)?.result?.type
    return t === undefined || t === 'succeeded'
  })
  const before = new Date().toISOString()
  let priced = 0
  for (const a of billable) if (await recordAnswer(payload, { ...args, provider: args.provider ?? o.provider }, a)) priced++
  // The batch create's unpriced record is settled now that real usage is in: only records from before this call,
  // and only if at least one result was priced. Unpriced results written just now stay unpriced.
  if (priced > 0)
    await payload.db.updateMany({ collection: o.usage, where: { and: [{ job: { equals: args.job } }, { run: { equals: args.run } }, { unpriced: { equals: true } }, { batch: { equals: true } }, { at: { less_than: before } }] }, data: { unpriced: false, settled: true } } as never)
}

/** For a spend card: month to date, a projection, today, the top jobs, each cap's use, and whether credits are out. */
export async function spendSummary(payload: Payload, { now = new Date() }: { now?: Date } = {}) {
  const o = configOf(payload)
  const month = startOfMonth(now)
  const docs = (await payload.find({ collection: o.usage as CollectionSlug, where: { at: { greater_than_equal: month.toISOString() } }, pagination: false, select: { costMicros: true, job: true, at: true, unpriced: true } as never, ...sys })).docs as Doc[]
  const today = startOfDay(now).getTime()
  const monthUSD = docs.reduce((s, d) => s + (Number(d.costMicros) || 0), 0) / USD
  const todayUSD = docs.filter((d) => new Date(d.at).getTime() >= today).reduce((s, d) => s + (Number(d.costMicros) || 0), 0) / USD
  const byJob = new Map<string, number>()
  for (const d of docs) byJob.set(d.job, (byJob.get(d.job) ?? 0) + (Number(d.costMicros) || 0) / USD)
  const elapsedDays = Math.max(1, (now.getTime() - month.getTime()) / (24 * HOUR))
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
  const state = await loadState(payload)
  const pct = (used: number, cap: number) => (cap > 0 ? Math.round((used / cap) * 100) : 0)
  return {
    monthUSD,
    projectedUSD: (monthUSD / elapsedDays) * daysInMonth,
    todayUSD,
    topJobs: [...byJob.entries()].sort((a, b) => b[1] - a[1]).map(([job, usd]) => ({ job, usd })),
    caps: { month: { usd: o.caps.month, pct: pct(monthUSD, o.caps.month) }, day: { usd: o.caps.day, pct: pct(todayUSD, o.caps.day) } },
    level: pct(monthUSD, o.caps.month) >= 90 ? 90 : pct(monthUSD, o.caps.month) >= 75 ? 75 : pct(monthUSD, o.caps.month) >= 50 ? 50 : 0,
    creditsOut: Boolean(state.creditsOut),
    /** Calls this month with no token counts yet: their cost isn't in these totals. */
    unpriced: docs.filter((d) => d.unpriced).length,
    prices: o.prices.date,
  }
}
