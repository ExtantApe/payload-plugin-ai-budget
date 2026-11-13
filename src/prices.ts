import type { ModelPrice, PriceTable, Usage } from './types.js'

/**
 * Anthropic's prices on 2026-11-10, USD per million tokens, from https://platform.claude.com/docs/en/about-claude/pricing
 * (captive-origins-console ADR 0006). Data with a date: check it when prices change, and pass your own table if
 * you'd rather.
 */
export const anthropicPrices: PriceTable = {
  date: '2026-11-10',
  models: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01, batchFactor: 0.5, longContext: { over: 100_000, input: 0.5, output: 2.5 } },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1, batchFactor: 0.5 },
    'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, batchFactor: 0.5 },
  },
}

/** A model's row: an exact match, else the longest key it starts with (dated model ids), else none. */
function rowFor(model: string, table: PriceTable): ModelPrice | null {
  if (table.models[model]) return table.models[model]!
  const key = Object.keys(table.models)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return key ? table.models[key]! : null
}

/** The most expensive row, for a model the table doesn't know: a new model can't hide spend. */
function dearest(table: PriceTable): ModelPrice {
  const rows = Object.values(table.models)
  if (!rows.length) throw new Error('AI Budget: the price table has no models.')
  return rows.reduce((a, b) => (b.output + b.input > a.output + a.input ? b : a))
}

/** Cost in micro-dollars (USD × 1,000,000), rounded up so the ledger never under-counts. */
const okCount = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0)

/** A price table that can price every call: finite, non-negative numbers. Throws with what's wrong. */
export function checkPrices(table: PriceTable) {
  if (!table?.date || !Object.keys(table.models ?? {}).length) throw new Error('AI Budget: give a dated price table with at least one model.')
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
  for (const [m, p] of Object.entries(table.models)) {
    if (!ok(p.input) || !ok(p.output)) throw new Error(`AI Budget: "${m}" needs input and output prices.`)
    for (const k of ['cacheWrite', 'cacheRead', 'batchFactor'] as const) if (p[k] !== undefined && !ok(p[k])) throw new Error(`AI Budget: "${m}".${k} must be a number, 0 or more.`)
    if (p.longContext && (!ok(p.longContext.over) || !ok(p.longContext.input) || !ok(p.longContext.output))) throw new Error(`AI Budget: "${m}".longContext needs over, input and output.`)
  }
}

/** True when every token count is a finite number, 0 or more. */
export const validUsage = (u: Usage) => typeof u?.model === 'string' && [u.inputTokens, u.outputTokens].every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0) && okCount(u.cacheWriteTokens) && okCount(u.cacheReadTokens)

export function costOf(usage: Usage, table: PriceTable, opts: { batch?: boolean } = {}): { costMicros: number; unknownModel: boolean } {
  if (!validUsage(usage)) throw new Error('AI Budget: token counts must be finite numbers, 0 or more.')
  const row = rowFor(usage.model, table)
  const p = row ?? dearest(table)
  const long = p.longContext && usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > p.longContext.over ? p.longContext : null
  const input = long ? long.input : p.input
  const output = long ? long.output : p.output
  // Per million tokens, in dollars, is the same number as micro-dollars per token.
  let micros = usage.inputTokens * input + usage.outputTokens * output + (usage.cacheWriteTokens ?? 0) * (p.cacheWrite ?? input) + (usage.cacheReadTokens ?? 0) * (p.cacheRead ?? input)
  if (opts.batch) micros *= p.batchFactor ?? 1
  // Rounded up, after trimming floating-point dust, so the ledger never under-counts and never adds a phantom micro-dollar.
  return { costMicros: Math.ceil(Math.round(micros * 1000) / 1000), unknownModel: !row }
}
