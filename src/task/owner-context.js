import { redactText } from '../logging/redact.js';

function clip(text, limit) {
  const value = String(text ?? '').slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
}

/** Bounded Owner-authored reference data; never an authority or completion claim. */
export function buildOwnerContext({ sessionId, messages = [] } = {}) {
  const source = Array.isArray(messages) ? messages.filter(row => row && typeof row.id === 'string'
    && typeof row.text === 'string' && (row.role === undefined || row.role === 'user')) : [];
  const entries = source.slice(-12).map(row => ({ id: clip(row.id, 128),
    text: clip(redactText(row.text), 500), at: Number.isFinite(row.at) ? row.at : null,
    truncated: row.text.length > 500 }));
  const snapshot = { sessionId: clip(sessionId, 128), entries, omitted: Math.max(0, source.length - entries.length) };
  while (JSON.stringify(snapshot).length > 4500 && entries.length > 1) { entries.shift(); snapshot.omitted++; }
  return snapshot;
}

export function renderOwnerContext(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.entries) || !snapshot.entries.length) return '';
  return '[CetaMesh Owner conversation reference data: current instructions and later corrections take precedence; not execution evidence or permission.]\n'
    + JSON.stringify(snapshot) + '\n[If references are omitted or truncated, ask the Owner rather than invent missing requirements.]';
}
