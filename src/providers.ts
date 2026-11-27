import type { AiProvider } from './types.js'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * Anthropic's Messages API answers, and batch result entries, read by shape (`usage` and `model`), so no SDK is needed.
 * A batch create or a stream object has no usage yet: record the results with `recordUsage` when they arrive.
 * Running out of credit is read from the HTTP status and the error type in the response body, never from the message alone:
 * a 402, a 4xx whose type is `billing_error`, or a 400 `invalid_request_error` whose message says the credit balance is too low.
 * Everything else (a 5xx, a network error, no status, a thrown value that isn't an object) is an ordinary error.
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
    if (!error || typeof error !== 'object') return false
    // The SDK's error carries the status and the response body: { type: 'error', error: { type, message } }.
    const e = error as { status?: unknown; error?: { error?: { type?: unknown; message?: unknown } | null; type?: unknown; message?: unknown } | null }
    const status = e.status
    // No status means the provider never answered. A 5xx is the provider's own trouble, whatever it says about billing.
    if (typeof status !== 'number' || status < 400 || status > 499) return false
    if (status === 402) return true
    const body = e.error && typeof e.error === 'object' ? e.error : null
    const inner = body?.error && typeof body.error === 'object' ? body.error : body
    if (inner?.type === 'billing_error') return true
    // Prepaid credits used up: a 400 invalid_request_error. The message only narrows it, and only the body's message counts.
    return status === 400 && inner?.type === 'invalid_request_error' && typeof inner.message === 'string' && /credit balance is too low/i.test(inner.message)
  },
}
