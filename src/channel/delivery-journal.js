import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

export const channelError = (code, message) => Object.assign(new Error(message), { code });
export function createChannelDeliveryJournal({ stateDir, now = () => Date.now() } = {}) {
  const file = stateDir ? path.join(stateDir, 'channel', 'delivery.json') : null;
  let saved = file ? readJsonFile(file, { missing: { version: 1, events: [], consumers: {} }, maxBytes: 32 * 1024 * 1024 })
    : { version: 1, events: [], consumers: {} };
  if (saved?.version !== 1 || !Array.isArray(saved.events) || !saved.consumers ||
      typeof saved.consumers !== 'object' || Array.isArray(saved.consumers) ||
      saved.events.some((row, index) => row?.sequence !== index + 1 || typeof row.eventId !== 'string')) {
    throw channelError('CHANNEL_JOURNAL_CORRUPT', 'Channel delivery journal is invalid; original preserved');
  }
  function commit(next) {
    if (Buffer.byteLength(JSON.stringify(next)) > 24 * 1024 * 1024) throw channelError('CHANNEL_JOURNAL_FULL', 'Channel journal capacity requires Owner archival');
    if (file) writeJsonAtomic(file, next); saved = next;
  }
  // A process disappeared after claiming an effect. Never automatically replay it.
  const recovered = structuredClone(saved);
  for (const consumer of Object.values(recovered.consumers)) {
    if (!consumer || !Number.isSafeInteger(consumer.cursor) || !consumer.deliveries || typeof consumer.deliveries !== 'object') {
      throw channelError('CHANNEL_JOURNAL_CORRUPT', 'Channel consumer state is invalid');
    }
    for (const [id, status] of Object.entries(consumer.deliveries)) {
      if (!['in-flight', 'acknowledged', 'outcome-unknown', 'denied', 'retry-authorized'].includes(status)) throw channelError('CHANNEL_JOURNAL_CORRUPT', 'Unknown delivery state');
      if (status === 'in-flight') consumer.deliveries[id] = 'outcome-unknown';
    }
  }
  if (JSON.stringify(saved) !== JSON.stringify(recovered)) commit(recovered);
  return {
    append(message) {
      const key = `${message.accountId}:${message.target}:${message.messageId}`;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex');
      const existing = saved.events.find(row => row.key === key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw channelError('CHANNEL_MESSAGE_CONFLICT', 'External message identity reused with different payload');
        return { accepted: true, duplicate: true, eventId: existing.eventId, sequence: existing.sequence };
      }
      if (saved.events.length >= 5000) throw channelError('CHANNEL_JOURNAL_FULL', 'Channel journal requires Owner archival; no messages discarded');
      const event = { ...structuredClone(message), key, fingerprint, eventId: crypto.randomUUID(),
        sequence: saved.events.length + 1, createdAt: now() };
      commit({ ...saved, events: [...saved.events, event] });
      return { accepted: true, duplicate: false, eventId: event.eventId, sequence: event.sequence };
    },
    state(id, event, status) {
      const next = structuredClone(saved);
      const consumer = next.consumers[id] ??= { cursor: 0, deliveries: {} };
      consumer.deliveries[event.eventId] = status;
      while (next.events[consumer.cursor] && ['acknowledged', 'denied'].includes(consumer.deliveries[next.events[consumer.cursor].eventId])) consumer.cursor++;
      commit(next);
    },
    resolve({ consumerId, eventId, decision, evidence, actor }) {
      if (!['verified-completed', 'verified-no-effect'].includes(decision) || typeof evidence !== 'string' || evidence.trim().length < 10 || evidence.length > 2000) throw channelError('CHANNEL_RECONCILIATION_INVALID', 'Verified outcome and bounded evidence required');
      if (saved.consumers[consumerId]?.deliveries[eventId] !== 'outcome-unknown') throw channelError('CHANNEL_RECONCILIATION_INVALID', 'Only unknown deliveries require reconciliation');
      const event = saved.events.find(row => row.eventId === eventId);
      const next = structuredClone(saved);
      const consumer = next.consumers[consumerId];
      consumer.deliveries[eventId] = decision === 'verified-completed' ? 'acknowledged' : 'retry-authorized';
      while (next.events[consumer.cursor] && ['acknowledged', 'denied'].includes(consumer.deliveries[next.events[consumer.cursor].eventId])) consumer.cursor++;
      next.resolutions ??= [];
      if (next.resolutions.length >= 5000) throw channelError('CHANNEL_JOURNAL_FULL', 'Reconciliation evidence requires Owner archival');
      next.resolutions.push({ consumerId, eventId: event.eventId, decision, evidence, owner: actor.id, at: now() });
      commit(next);
      return { resolved: true, decision };
    },
    snapshot: () => structuredClone(saved)
  };
}
