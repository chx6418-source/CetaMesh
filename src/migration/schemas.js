import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const conversations = value => object(value) && Object.entries(value).every(([key, row]) => /^(group|private):[1-9]\d*$/.test(key) && object(row));
export const SOCIAL_FILES = new Set(['social-v2.json', 'sessions.json', 'current-role.json', 'slang.json', 'slang-session.json', 'stickers.json', 'social-v2-cards.json']);

// Metadata only. Values, IDs, conversation names and prompt text never leave as plaintext.
export function inspectSchema(relative, value) {
  const name = relative.split('/').at(-1);
  const rawVersion = value?.schemaVersion ?? value?.version;
  const version = rawVersion === undefined ? 'UNVERSIONED' : Number.isSafeInteger(rawVersion) ? rawVersion : 'UNVERIFIED';
  let valid = object(value) || Array.isArray(value), count = Array.isArray(value) ? value.length : object(value) ? 1 : 0;
  let pending = 0;
  if (['social-v2.json', 'social-v2-cards.json'].includes(name)) {
    valid = object(value) && conversations(value.conversations) && version === 'UNVERSIONED';
    count = object(value?.conversations) ? Object.keys(value.conversations).length : 0;
  } else if (name === 'sessions.json' && relative === 'state/sessions.json') {
    valid = object(value) && object(value.sessions) && Object.entries(value.sessions).every(([key, id]) => /^(group|private):[1-9]\d*$/.test(key) && typeof id === 'string' && id.length > 0);
    count = object(value?.sessions) ? Object.keys(value.sessions).length : 0;
  } else if (['slang.json', 'stickers.json'].includes(name)) {
    valid = Array.isArray(value) && value.every(row => object(row) && typeof row.id === 'string' && row.id.length > 0) && new Set(value.map(row => row.id)).size === value.length;
  } else if (name === 'current-role.json') {
    valid = object(value) && (value.role === null || typeof value.role === 'string') && ['active', 'silent'].includes(value.mode);
  } else if (name === 'slang-session.json') {
    valid = object(value) && (value.sessionId === null || typeof value.sessionId === 'string');
  } else if (name === 'qq-message-receipts.json') {
    valid = value?.version === 1 && Array.isArray(value.ids) && (value.pending === undefined || Array.isArray(value.pending));
    if (valid) { const ids = [...value.ids, ...(value.pending ?? [])]; valid = ids.every(id => /^[1-9]\d{0,19}:(group|private):[1-9]\d{0,19}:-?\d{1,30}$/.test(id)) && new Set(ids).size === ids.length; }
    count = (value?.ids?.length ?? 0) + (value?.pending?.length ?? 0); pending = value?.pending?.length ?? 0;
  } else if (name === 'qq-send-ledger.json') {
    valid = value?.version === 1 && Array.isArray(value.records) && value.records.every(row => object(row) && ['outcome-unknown', 'sent', 'acknowledged'].includes(row.status) && typeof row.accountId === 'string');
    count = value?.records?.length ?? 0; pending = value?.records?.filter(row => row.status === 'outcome-unknown').length ?? 0;
  } else if (relative === 'state/channel/delivery.json') {
    valid = value?.version === 1 && Array.isArray(value.events) && object(value.consumers);
    count = value?.events?.length ?? 0;
    pending = Object.values(value?.consumers ?? {}).reduce((n, row) => n + Object.values(row?.deliveries ?? {}).filter(status => ['in-flight', 'outcome-unknown'].includes(status)).length, 0);
  } else if (relative === 'state/tasks/tasks.json' || relative === 'state/memory/memories.json') {
    const records = relative.includes('/tasks/') ? value?.tasks : value?.memories;
    valid = value?.schemaVersion === 1 && Number.isSafeInteger(value?.revision) && value.revision > 0 && Array.isArray(records) && records.every(row => object(row) && typeof row.id === 'string') && new Set(records?.map(row => row.id)).size === records?.length;
    count = records?.length ?? 0;
  } else if (relative === 'state/workspaces.json') {
    valid = value?.version === 1 && Array.isArray(value.workspaces); count = value?.workspaces?.length ?? 0;
  } else if (relative === 'state/capability/dispatches.json') {
    valid = object(value); pending = Object.values(value ?? {}).filter(row => ['started', 'outcome-unknown'].includes(row?.status)).length;
  } else if (relative === 'state/desktop-chat/sessions.json') {
    valid = value?.schemaVersion === 1 && Array.isArray(value.sessions); count = value?.sessions?.length ?? 0;
  }
  if (SOCIAL_FILES.has(name) && (relative === `state/${name}` || relative.includes('/bionic/state/')) && version !== 'UNVERSIONED') valid = false;
  // Full bytes are preserved in fixtures; this additional fingerprint checks IDs/scopes/references.
  const identities = [];
  const walk = (node, location = '') => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node).sort()) {
      const item = node[key];
      if (/^(id|scope|scopeKey|origin|ref|rev|revision|sessionId|messageId|message_id|accountId)$/.test(key) || /^(group|private):/.test(key)) identities.push([`${location}/${key}`, item]);
      walk(item, `${location}/${key}`);
    }
  };
  walk(value);
  return { valid: Boolean(valid), version, records: count, pending, identityHash: digest(identities) };
}
