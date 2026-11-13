import type { Access, CollectionConfig } from 'payload'

import type { Resolved } from './types.js'

const nobody: Access = () => false
const managers = (o: Resolved): Access => async (args) => (await o.manage(args)) === true

/** One record per AI call. Managers read it; nobody writes it through the API. No prompts, answers or people. */
export const usageCollection = (o: Resolved): CollectionConfig => ({
  slug: o.usage,
  labels: { singular: 'AI usage', plural: 'AI usage' },
  admin: { group: o.adminGroup, defaultColumns: ['at', 'job', 'model', 'costMicros', 'refusal'] },
  access: { read: managers(o), create: nobody, update: nobody, delete: nobody },
  timestamps: false,
  indexes: [{ fields: ['job', 'at'] }, { fields: ['job', 'run'] }],
  fields: [
    { name: 'at', type: 'date', required: true, index: true },
    { name: 'job', type: 'text', required: true },
    { name: 'run', type: 'text' },
    { name: 'provider', type: 'text' },
    { name: 'model', type: 'text' },
    { name: 'batch', type: 'checkbox' },
    { name: 'inputTokens', type: 'number' },
    { name: 'outputTokens', type: 'number' },
    { name: 'cacheWriteTokens', type: 'number' },
    { name: 'cacheReadTokens', type: 'number' },
    { name: 'costMicros', type: 'number', required: true, admin: { description: 'USD × 1,000,000' } },
    { name: 'prices', type: 'text', admin: { description: 'The price table’s date' } },
    { name: 'refusal', type: 'select', options: ['budget', 'no-credit', 'error'] },
    { name: 'unknownModel', type: 'checkbox', admin: { description: 'Priced at the table’s most expensive row' } },
    { name: 'unpriced', type: 'checkbox', admin: { description: 'The answer had no token counts (a batch create or a stream): record its usage when it arrives' } },
    { name: 'settled', type: 'checkbox', admin: { description: 'An unpriced record (a batch create) whose usage was recorded later' } },
    { name: 'seeded', type: 'checkbox', admin: { description: 'Made-up test data: shown in the summary, never counted toward a cap' } },
  ],
})

/** Whether the credits are out, the last probe, and the months they ran out. One document. */
export const stateCollection = (o: Resolved): CollectionConfig => ({
  slug: o.state,
  admin: { group: o.adminGroup, hidden: true },
  access: { read: managers(o), create: nobody, update: nobody, delete: nobody },
  fields: [
    { name: 'key', type: 'text', required: true, unique: true },
    { name: 'creditsOut', type: 'checkbox' },
    { name: 'creditsOutSince', type: 'date' },
    { name: 'lastProbeAt', type: 'date' },
    { name: 'runOutMonths', type: 'json' },
  ],
})
