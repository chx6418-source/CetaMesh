import { readJsonFile, writeJsonAtomic } from '../../storage/json-file.js';

const MAX_RECEIPTS = 5000;

export function createQqReceipts(file) {
  let receipts = null;
  function load() {
    if (receipts) return receipts;
    let saved;
    try { saved = readJsonFile(file, { missing: { version: 1, ids: [] }, maxBytes: 1024 * 1024 }); }
    catch (error) {
      throw Object.assign(new Error('QQ message receipts cannot be read; original file preserved'), { code: 'QQ_RECEIPTS_UNAVAILABLE', cause: error });
    }
    if (saved?.version !== 1 || !Array.isArray(saved.ids) || saved.ids.some(id => typeof id !== 'string')) {
      throw Object.assign(new Error('QQ message receipts are incompatible; manual recovery required'), { code: 'QQ_RECEIPTS_INVALID' });
    }
    receipts = new Set(saved.ids);
    return receipts;
  }
  return {
    validate: load,
    claim(kind, event) {
      const id = event?.message_id ?? event?.msg_id;
      if (id === undefined || id === null || id === '') return false;
      const key = [String(event.self_id ?? ''), kind, String(kind === 'group' ? event.group_id : event.user_id), String(id)].join(':');
      const current = load();
      if (current.has(key)) return false;
      const next = new Set(current);
      next.add(key);
      while (next.size > MAX_RECEIPTS) next.delete(next.values().next().value);
      writeJsonAtomic(file, { version: 1, ids: [...next] });
      receipts = next;
      return true;
    }
  };
}
