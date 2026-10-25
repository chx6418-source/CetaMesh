import { aggregateModelUsage, normalizeModelUsage, safeRawUsage } from './usage.js';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\x00-\x1f]/.test(value);
// An explicit unknown belongs to that request; only old receipts with no field
// may use the turn's fallback identity. Later responses must not rewrite history.
const identity = (receipt, key, fallback) => Object.hasOwn(receipt, key)
  ? (label(receipt[key]) ? receipt[key] : null) : (label(fallback) ? fallback : null);
const error = code => Object.assign(new Error(code), { code });
const unknownCost = () => ({ status: 'unknown', amount: null, currency: null, source: null, version: null });

/** Price estimates are explicitly declared tariffs, never inferred live invoices.
 * Input contains cache reads/writes; reasoning is already part of output. */
export function estimateUsageCost(usage, price, { providerId, model } = {}) {
  if (!price || price.providerId !== providerId || price.model !== model || !/^[A-Z]{3}$/.test(price.currency ?? '')
    || !label(price.source) || !label(price.version) || !finite(price.inputPerMillion) || !finite(price.outputPerMillion)) return unknownCost();
  const u = normalizeModelUsage(usage);
  if (!finite(u.inputTokens) || !finite(u.outputTokens)) return unknownCost();
  let read = u.cacheReadTokens;
  let write = u.cacheWriteTokens;
  // Missing cache subdivisions are safe only when that tariff is explicitly uniform.
  if (read === null && price.cacheReadPerMillion === price.inputPerMillion) read = 0;
  if (write === null && price.cacheWritePerMillion === price.inputPerMillion) write = 0;
  if (read === null || write === null || read + write > u.inputTokens
    || (read > 0 && !finite(price.cacheReadPerMillion)) || (write > 0 && !finite(price.cacheWritePerMillion))) return unknownCost();
  const amount = ((u.inputTokens - read - write) * price.inputPerMillion + read * (price.cacheReadPerMillion ?? 0)
    + write * (price.cacheWritePerMillion ?? 0) + u.outputTokens * price.outputPerMillion) / 1_000_000;
  if (!finite(amount)) return unknownCost();
  return { status: 'estimated', amount, currency: price.currency, source: price.source, version: price.version,
    tariff: Object.fromEntries(['inputPerMillion', 'outputPerMillion', 'cacheReadPerMillion', 'cacheWritePerMillion'].map(key => [key, finite(price[key]) ? price[key] : null])) };
}

export function aggregateUsageCosts(costs, complete = true) {
  const known = costs.filter(c => c && ['actual', 'estimated'].includes(c.status) && finite(c.amount) && /^[A-Z]{3}$/.test(c.currency ?? ''));
  const currencies = [...new Set(known.map(c => c.currency))];
  const currency = currencies.length === 1 ? currencies[0] : null;
  const knownAmount = currency ? known.reduce((sum, c) => sum + c.amount, 0) : null;
  const allKnown = costs.length > 0 && known.length === costs.length && currency && complete;
  return { status: allKnown ? (known.every(c => c.status === 'actual') ? 'actual' : 'estimated') : 'unknown',
    amount: allKnown ? knownAmount : null, knownAmount, currency,
    complete: Boolean(allKnown), sources: [...new Set(known.map(c => c.source).filter(label))], versions: [...new Set(known.map(c => c.version).filter(label))] };
}

function receiptCost(receipt, pricingResolver) {
  // Only an adapter's explicit billingReceipt is an actual charge; a token rate
  // calculation, arbitrary raw cost field or text answer is never an invoice.
  const billed = receipt.billingReceipt;
  if (billed?.kind === 'actual' && finite(billed.amount) && /^[A-Z]{3}$/.test(billed.currency ?? '')
    && label(billed.source) && label(billed.receiptId)) {
    return { status: 'actual', amount: billed.amount, currency: billed.currency, source: billed.source, version: billed.receiptId };
  }
  const price = typeof pricingResolver === 'function' ? pricingResolver({ providerId: receipt.providerId, model: receipt.model }) : null;
  return estimateUsageCost(receipt, price, receipt);
}

/** Single Core process owns this bounded atomic JSON ledger. It contains usage
 * numbers and attribution only, never prompts, tool bodies or credentials.
 * Historical rows are not migrated or attributed using mutable session config. */
export function createUsageLedger({ file, pricingResolver = null, now = () => Date.now(), maxReceipts = 100000, maxBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof file !== 'string' || !file || !Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw error('USAGE_LEDGER_CONFIG_INVALID');
  function load() {
    let store;
    try { store = readJsonFile(file, { missing: { version: 1, receipts: [] }, maxBytes }); }
    catch { throw error('USAGE_STORE_UNAVAILABLE'); }
    if (store?.version !== 1 || !Array.isArray(store.receipts) || store.receipts.length > maxReceipts
      || store.receipts.some(row => !label(row.sessionId) || !label(row.requestId) || !label(row.turnId)
        || (row.taskId !== null && !label(row.taskId)) || !row.usage || typeof row.usage !== 'object')) throw error('USAGE_STORE_UNAVAILABLE');
    return store;
  }
  function summary({ sessionId = null, sessionIds = null, taskId = null } = {}) {
    if (sessionIds !== null && (!Array.isArray(sessionIds) || !sessionIds.length || sessionIds.length > maxReceipts || !sessionIds.every(label))) throw error('USAGE_SCOPE_REQUIRED');
    if ((!label(sessionId) && !label(taskId) && sessionIds === null) || (sessionId !== null && !label(sessionId)) || (taskId !== null && !label(taskId))) throw error('USAGE_SCOPE_REQUIRED');
    const sessions = sessionIds === null ? null : new Set(sessionIds);
    const rows = load().receipts.filter(row => (!sessionId || row.sessionId === sessionId) && (!sessions || sessions.has(row.sessionId)) && (!taskId || row.taskId === taskId));
    const usages = rows.map(row => row.usage);
    const knownUsage = Object.fromEntries(TOKEN_FIELDS.map(key => [key, usages.some(u => finite(u[key])) ? usages.reduce((sum, u) => sum + (finite(u[key]) ? u[key] : 0), 0) : null]));
    const accountingComplete = rows.length > 0 && rows.every(row => row.accountingComplete && finite(row.usage.inputTokens) && finite(row.usage.outputTokens));
    return { ...aggregateModelUsage(usages), knownUsage, accountingComplete, requestCount: rows.length,
      cost: aggregateUsageCosts(rows.map(row => row.cost), accountingComplete) };
  }
  function record({ usage, sessionId, taskId = null, turnId, providerId = null, model = null } = {}) {
    if (!label(sessionId) || !label(turnId) || (taskId !== null && !label(taskId))) throw error('USAGE_ATTRIBUTION_INVALID');
    const store = load();
    const source = Array.isArray(usage?.requests) && usage.requests.length ? usage.requests
      : [{ ...(usage ?? {}), requestId: `snapshot:${turnId}`, providerId, model }];
    if (source.length > maxReceipts) throw error('USAGE_LEDGER_FULL');
    let changed = false;
    for (const receipt of source) {
      if (!label(receipt?.requestId)) throw error('USAGE_RECEIPT_INVALID');
      const existing = store.receipts.find(row => row.sessionId === sessionId && row.requestId === receipt.requestId);
      if (existing) {
        if (existing.taskId !== taskId || existing.turnId !== turnId) throw error('USAGE_ATTRIBUTION_CONFLICT');
        if (existing.providerId !== identity(receipt, 'providerId', providerId)
          || existing.model !== identity(receipt, 'model', model)) throw error('USAGE_RECEIPT_CONFLICT');
        // The same provider request must not change after it has been recorded.
        if (JSON.stringify(existing.usage) !== JSON.stringify(normalizeModelUsage(receipt))) throw error('USAGE_RECEIPT_CONFLICT');
        if (usage?.accountingComplete === false && existing.accountingComplete) { existing.accountingComplete = false; changed = true; }
        continue;
      }
      if (store.receipts.length >= maxReceipts) throw error('USAGE_LEDGER_FULL');
      const normalized = normalizeModelUsage(receipt);
      const safeReceipt = { ...receipt, providerId: identity(receipt, 'providerId', providerId),
        model: identity(receipt, 'model', model) };
      const raw = receipt.rawUsage && typeof receipt.rawUsage === 'object' ? receipt.rawUsage : receipt;
      const rawUsage = safeRawUsage(raw);
      store.receipts.push({ sessionId, taskId, turnId, requestId: receipt.requestId,
        providerId: label(safeReceipt.providerId) ? safeReceipt.providerId : null, model: label(safeReceipt.model) ? safeReceipt.model : null,
        at: now(), usage: normalized, rawUsage, cost: receiptCost(safeReceipt, pricingResolver),
        accountingComplete: usage?.accountingComplete !== false && finite(normalized.inputTokens) && finite(normalized.outputTokens) });
      changed = true;
    }
    if (changed) {
      // Match writeJsonAtomic's UTF-8, two-space indentation and final newline.
      // Reject before replacement so every successfully written file is readable.
      if (Buffer.byteLength(JSON.stringify(store, null, 2) + '\n', 'utf8') > maxBytes) throw error('USAGE_LEDGER_FULL');
      try { writeJsonAtomic(file, store); } catch { throw error('USAGE_STORE_UNAVAILABLE'); }
    }
    return summary({ sessionId });
  }
  return Object.freeze({ record, summary });
}
