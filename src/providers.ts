import type { AiProvider } from './types.js'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * Anthropic's Messages API answers, and batch result entries, read by shape (`usage` and `model`), so no SDK is needed.
 * A batch create or a stream object has no usage yet: record the results with `recordUsage` when they arrive.
 * Running out of credit is a billing error: an HTTP 400 whose message says the credit balance is too low.
 */
export const anthropicProvider: AiProvider = {
  name: 'anthropic',
  usageOf: (answer) => {
    // A batch result entry carries its message inside: { result: { type: 'succeeded', message } }.
    const entry = answer as { result?: { message?: unknown } } | null
    const a = (entry && typeof entry === 'object' && entry.result?.message ? entry.result.message : answer) as { model?: unknown; usage?: Record<string, unknown> } | null
    if (!a || typeof a !== 'object' || !a.usage || typeof a.model !== 'string') return null
    // Counts that aren't there aren't zero: an answer without input and output counts is unpriced.
    if (typeof a.usage.input_tokens !== 'number' || typeof a.usage.output_tokens !== 'number') return null
    return {
      model: a.model,
      inputTokens: num(a.usage.input_tokens),
      outputTokens: num(a.usage.output_tokens),
      cacheWriteTokens: num(a.usage.cache_creation_input_tokens),
      cacheReadTokens: num(a.usage.cache_read_input_tokens),
    }
  },
  isNoCredit: (error) => {
    const e = error as { status?: unknown; error?: { error?: { type?: unknown; message?: unknown }; type?: unknown; message?: unknown }; message?: unknown } | null
    const text = [e?.message, e?.error?.message, e?.error?.error?.message].filter((x) => typeof x === 'string').join(' ')
    return /credit balance is too low|insufficient.{0,20}credit|billing.{0,40}(credit|balance|payment)/i.test(text)
  },
}
