import type { Access, Payload, PayloadRequest } from 'payload'

export type Req = Partial<PayloadRequest>

export type Usage = { model: string; inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number }

/** How to read one provider's answers and errors. A few lines per provider; no SDK needed. */
export type AiProvider = {
  name: string
  /** The answer's model and token counts, or null when the answer has none. */
  usageOf: (answer: unknown) => Usage | null
  /** True when an error means the account's credits are out (not a budget of ours). */
  isNoCredit: (error: unknown) => boolean
}

/** USD per million tokens. */
export type ModelPrice = { input: number; output: number; cacheWrite?: number; cacheRead?: number; batchFactor?: number; longContext?: { over: number; input: number; output: number } }
export type PriceTable = { date: string; models: Record<string, ModelPrice> }

export type JobCap = { run?: number; day?: number; label?: string }
/** USD. Every cap applies to every call; the tightest wins. */
export type Caps = { month: number; day: number; jobs: Record<string, JobCap> }

export type AiBudgetOptions = {
  caps: Caps
  prices: PriceTable
  /** The default provider. Calls can name another. */
  provider: AiProvider
  /** Who reads the ledger. Required; only an answer of exactly true counts. */
  access: { manage: Access }
  /** The cheapest job: while credits are out, one call an hour from it is let through to see if they're back. */
  probeJob?: string
  /** When credits run out, without the Notifications plugin: tell the owner. */
  onCreditsOut?: (args: { paused: string[]; lastMonthUSD: number; suggestMonthlyUSD: number | null; payload: Payload }) => void | Promise<void>
  /** Who's told through Notifications when credits run out (account ids). */
  notify?: (string | number)[]
  /** The most an auto-reload suggestion may be without the owner's yes. Default: the monthly cap. */
  maxSuggestionUSD?: number
  slugs?: { usage?: string; state?: string }
  adminGroup?: string
}

export type Resolved = Required<Pick<AiBudgetOptions, 'caps' | 'prices' | 'provider'>> & {
  usage: string
  state: string
  manage: Access
  probeJob?: string
  onCreditsOut?: AiBudgetOptions['onCreditsOut']
  notify: (string | number)[]
  maxSuggestionUSD: number
  adminGroup: string
}
