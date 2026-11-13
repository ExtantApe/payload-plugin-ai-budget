import type { Access, Config, Plugin } from 'payload'

import { stateCollection, usageCollection } from './collections.js'
import { checkPrices } from './prices.js'
import type { AiBudgetOptions, Resolved } from './types.js'

const KINDS = {
  'ai-budget:credits-out': {
    text: (p: Record<string, string>) => `AI services are paused: the prepaid credits ran out. Paused: ${p.paused}.`,
    email: (p: Record<string, string>) => ({
      subject: 'AI services are paused until credits are added',
      text: [
        'The prepaid AI credits ran out, so AI services are paused until a prepaid amount is added.',
        `Paused: ${p.paused}.`,
        `Last month's AI spend, as a guide: ${p.lastMonth}.`,
        p.suggest ? `This is the third month in a row. A capped monthly auto-reload of ${p.suggest} would cover it; nothing is set up until you choose to.` : '',
      ].filter(Boolean).join('\n\n'),
    }),
    priority: 'high' as const,
    required: true,
  },
}

/** Checks caps for sense, so a typo can't turn a budget off. */
function checkCaps(o: Resolved) {
  const { month, day, jobs } = o.caps
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  if (!ok(month) || !ok(day)) throw new Error('AI Budget: caps.month and caps.day must be numbers of dollars, 0 or more.')
  if (!Object.keys(jobs ?? {}).length) throw new Error('AI Budget: list at least one job in caps.jobs.')
  for (const [job, c] of Object.entries(jobs)) {
    for (const k of ['run', 'day'] as const) if (c[k] !== undefined && (!ok(c[k]) || c[k]! > month)) throw new Error(`AI Budget: caps.jobs["${job}"].${k} must be 0 or more and no higher than the monthly cap.`)
  }
  if (o.probeJob && !Object.hasOwn(jobs, o.probeJob)) throw new Error(`AI Budget: probeJob "${o.probeJob}" isn't in caps.jobs.`)
  if (!ok(o.maxSuggestionUSD)) throw new Error('AI Budget: maxSuggestionUSD must be a number of dollars, 0 or more.')
  checkPrices(o.prices)
}

/** AI Budget: a ledger of AI calls, caps that stop jobs cleanly, and a clear pause when credits run out. */
export const aiBudgetPlugin =
  (options: AiBudgetOptions): Plugin =>
  (config: Config): Config => {
    const o: Resolved = {
      caps: options.caps,
      prices: options.prices,
      provider: options.provider,
      usage: options.slugs?.usage ?? 'ai-usage',
      state: options.slugs?.state ?? 'ai-budget-state',
      manage: options?.access?.manage as Access,
      probeJob: options.probeJob,
      onCreditsOut: options.onCreditsOut,
      notify: options.notify ?? [],
      maxSuggestionUSD: options.maxSuggestionUSD ?? options.caps?.month ?? 0,
      adminGroup: options.adminGroup ?? 'AI Budget',
    }
    if (typeof o.manage !== 'function') throw new Error('AI Budget: give `access.manage`, saying who may read the ledger.')
    if (!o.provider || typeof o.provider.usageOf !== 'function' || typeof o.provider.isNoCredit !== 'function') throw new Error('AI Budget: give a `provider` (for example anthropicProvider).')
    checkCaps(o)
    if (!o.notify.length && !o.onCreditsOut) console.warn('AI Budget: nobody will be told when the AI credits run out. Give `notify` (with the Notifications plugin) or `onCreditsOut`.')
    const custom = config.custom ?? {}
    return {
      ...config,
      custom: { ...custom, aiBudget: o, notificationKinds: [...((custom.notificationKinds as unknown[]) ?? []), { owner: 'ai-budget', kinds: KINDS }] },
      collections: [...(config.collections ?? []), usageCollection(o), stateCollection(o)],
    }
  }
