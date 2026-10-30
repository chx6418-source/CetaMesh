import crypto from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from '../../storage/json-file.js';

function ledgerError(code, message, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function identity(accountId, requestId) {
  const account = String(accountId ?? '').trim();
  const request = String(requestId ?? '').trim();
  if (!/^\d{1,20}$/.test(account) || !/^[A-Za-z0-9:._/-]{1,160}$/.test(request)) {
    throw ledgerError('QQ_SEND_ID_INVALID', 'QQ send requires a verified account and stable requestId');
  }
  return `${account}:${request}`;
}

function validate(saved) {
  if (saved?.version !== 1 || !Array.isArray(saved.records) || saved.records.some(record =>
    !record || typeof record !== 'object' || !['outcome-unknown', 'sent', 'acknowledged'].includes(record.status) ||
    typeof record.key !== 'string' || typeof record.fingerprint !== 'string')) {
    throw ledgerError('QQ_SEND_LEDGER_INVALID', 'QQ send ledger schema is incompatible; original file preserved');
  }
  if (new Set(saved.records.map(record => record.key)).size !== saved.records.length) {
    throw ledgerError('QQ_SEND_LEDGER_INVALID', 'QQ send ledger contains duplicate identities; original file preserved');
  }
  return saved;
}

export function createQqSendLedger(file, { maxRecords = 20000 } = {}) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new TypeError('maxRecords must be positive');
  function load() {
    try { return validate(readJsonFile(file, { missing: { version: 1, records: [] }, maxBytes: 32 * 1024 * 1024 })); }
    catch (error) {
      if (error?.code === 'QQ_SEND_LEDGER_INVALID') throw error;
      throw ledgerError('QQ_SEND_LEDGER_UNAVAILABLE', 'QQ send ledger cannot be read; original file preserved', error);
    }
  }
  function save(next) {
    try { writeJsonAtomic(file, next); }
    catch (error) { throw ledgerError('QQ_SEND_LEDGER_UNAVAILABLE', 'QQ send ledger cannot be persisted; no new send may occur', error); }
  }
  function get(accountId, requestId) {
    const key = identity(accountId, requestId);
    return load().records.find(record => record.key === key) ?? null;
  }
  function claim({ requestId, accountId, kind, target, action, payload }) {
    const key = identity(accountId, requestId);
    if (!['text', 'file', 'audio', 'card', 'sticker', 'music', 'poke', 'custom-face'].includes(kind) ||
        typeof target !== 'string' || !/^(group|private):\d+$/.test(target) || !action) {
      throw ledgerError('QQ_SEND_REQUEST_INVALID', 'QQ send intent has invalid type, target or action');
    }
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ accountId: String(accountId), kind, target, action, payload })).digest('hex');
    const saved = load();
    const existing = saved.records.find(record => record.key === key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw ledgerError('QQ_REQUEST_ID_CONFLICT', 'requestId already belongs to another QQ send');
      return { duplicate: true, record: existing };
    }
    if (saved.records.length >= maxRecords) throw ledgerError('QQ_SEND_LEDGER_FULL', 'QQ send ledger full; preserve evidence and archive under Owner control before new sends');
    const now = new Date().toISOString();
    // Persist uncertainty before the transport is called. A crash can never
    // turn an attempted send into an apparently unsent retry candidate.
    const record = { key, requestId: String(requestId), accountId: String(accountId), kind, target,
      action: String(action), fingerprint, createdAt: now, updatedAt: now, status: 'outcome-unknown', receipt: null };
    save({ version: 1, records: [...saved.records, record] });
    return { duplicate: false, record };
  }
  function ack(accountId, requestId, receipt) {
    const key = identity(accountId, requestId);
    const receiptId = receipt?.message_id ?? receipt?.file_id;
    const gatewayAck = receipt?.status === 'ok' && receipt?.retcode === 0;
    if ((receiptId === undefined || receiptId === null || receiptId === '') && !gatewayAck) {
      throw ledgerError('QQ_RECEIPT_UNVERIFIED', 'gateway response lacks a stable receipt identity');
    }
    const normalized = receipt?.message_id !== undefined
      ? { message_id: String(receiptId) } : receipt?.file_id !== undefined
        ? { file_id: String(receiptId) } : { gatewayStatus: 'ok', retcode: 0 };
    const saved = load();
    const index = saved.records.findIndex(record => record.key === key);
    if (index < 0) throw ledgerError('QQ_SEND_NOT_FOUND', 'send intent does not exist');
    const current = saved.records[index];
    if (current.status === 'sent' || current.status === 'acknowledged') {
      if (JSON.stringify(current.receipt) !== JSON.stringify(normalized)) throw ledgerError('QQ_RECEIPT_CONFLICT', 'duplicate receipt differs from persisted receipt');
      return current;
    }
    const record = { ...current, status: receiptId === undefined || receiptId === null || receiptId === ''
      ? 'acknowledged' : 'sent', receipt: normalized, updatedAt: new Date().toISOString() };
    saved.records[index] = record;
    save(saved);
    return record;
  }
  return { claim, ack, get, snapshot: () => structuredClone(load()) };
}
