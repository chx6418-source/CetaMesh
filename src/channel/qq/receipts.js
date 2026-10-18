import { readJsonFile, writeJsonAtomic } from '../../storage/json-file.js';

const MAX_RECEIPTS = 5000;

export function createQqReceipts(file) {
  let receipts = null;
  function load() {
    if (receipts) return receipts;
    let saved;
    try { saved = readJsonFile(file, { missing: { version: 1, ids: [], pending: [] }, maxBytes: 1024 * 1024 }); }
    catch (error) {
      throw Object.assign(new Error('QQ message receipts cannot be read; original file preserved'), { code: 'QQ_RECEIPTS_UNAVAILABLE', cause: error });
    }
    if (saved?.version !== 1 || !Array.isArray(saved.ids) || saved.ids.some(id => typeof id !== 'string') ||
        (saved.pending !== undefined && (!Array.isArray(saved.pending) || saved.pending.some(id => typeof id !== 'string')))) {
      throw Object.assign(new Error('QQ message receipts are incompatible; manual recovery required'), { code: 'QQ_RECEIPTS_INVALID' });
    }
    receipts = { ids: new Set(saved.ids), pending: new Set(saved.pending ?? []) };
    return receipts;
  }
  return {
    validate: load,
    begin(kind, event) {
      const id = event?.message_id ?? event?.msg_id;
      if (id === undefined || id === null || id === '') return null;
      const key = [String(event.self_id ?? ''), kind, String(kind === 'group' ? event.group_id : event.user_id), String(id)].join(':');
      const current = load();
      if (current.ids.has(key) || current.pending.has(key)) return null;
      if (current.pending.size >= MAX_RECEIPTS) {
        throw Object.assign(new Error('QQ inbound reconciliation queue is full'), { code: 'QQ_RECEIPTS_FULL' });
      }
      const pending = new Set(current.pending);
      pending.add(key);
      writeJsonAtomic(file, { version: 1, ids: [...current.ids], pending: [...pending] });
      receipts = { ids: current.ids, pending };
      return key;
    },
    ack(key) {
      const current = load();
      if (!current.pending.has(key)) return false;
      const next = new Set(current.ids);
      next.add(key);
      while (next.size > MAX_RECEIPTS) next.delete(next.values().next().value);
      const pending = new Set(current.pending);
      pending.delete(key);
      writeJsonAtomic(file, { version: 1, ids: [...next], pending: [...pending] });
      receipts = { ids: next, pending };
      return true;
    },
    unresolved() {
      return [...load().pending];
    }
  };
}
