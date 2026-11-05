import { redactText } from '../logging/redact.js';

const TOOL_STATES = new Set(['pending', 'running', 'retrying', 'waiting-approval', 'completed', 'failed', 'cancelled', 'outcome-unknown', 'unknown']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'outcome-unknown']);
const text = (value, max) => typeof value === 'string' ? redactText(value).slice(0, max) : '';
const id = value => text(value, 200) || null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const time = value => Number.isFinite(value) && value >= 0 ? value : null;

// These are display observations, never Capability receipts or Task authority.
// Whitelisting precedes persistence as well as IPC: raw tool input/output and
// private reasoning cannot enter an activity checkpoint through extra fields.
export function projectChatToolActivity(value) {
  if (!value || typeof value !== 'object' || !id(value.id)) return null;
  return { id: id(value.id), capability: id(value.capability), label: text(value.label ?? value.name ?? value.capability, 200),
    status: TOOL_STATES.has(value.status) ? value.status : 'unknown', summary: text(value.summary, 1000),
    durationMs: time(value.durationMs), filePath: text(value.filePath, 500) || null,
    exitCode: Number.isSafeInteger(value.exitCode) ? value.exitCode : null };
}

export function projectChatActivityTimeline(value) {
  if (value?.schemaVersion !== 1 || !id(value.turnId) || !Array.isArray(value.entries)) return null;
  const entries = value.entries.slice(-128).filter(row => row && id(row.id) && Number.isSafeInteger(row.sequence) && row.sequence > 0).map(row => ({
    id: id(row.id), sequence: row.sequence, at: time(row.at),
    source: ['chat', 'agent-follow', 'model-coordinator', 'model-runtime', 'recovery'].includes(row.source) ? row.source : 'chat',
    sourceSequence: Number.isSafeInteger(row.sourceSequence) && row.sourceSequence >= 0 ? row.sourceSequence : null,
    kind: ['tool', 'lifecycle', 'gap'].includes(row.kind) ? row.kind : 'lifecycle',
    status: text(row.status, 40), toolId: id(row.toolId), capability: id(row.capability), missingCount: count(row.missingCount)
  }));
  return { schemaVersion: 1, turnId: id(value.turnId), requestId: id(value.requestId), taskId: id(value.taskId),
    runId: id(value.runId), attemptId: id(value.attemptId), providerId: id(value.providerId), sessionId: id(value.sessionId),
    state: text(value.state, 40), nextSequence: Math.max(count(value.nextSequence), (entries.at(-1)?.sequence ?? 0) + 1),
    omittedCount: count(value.omittedCount) + Math.max(0, value.entries.length - 128), gapCount: count(value.gapCount), entries };
}

export function appendChatActivity(turn, { kind = 'lifecycle', status = turn.state, tool = null, event = null, source = 'chat', at, taskId, providerId, sessionId, missingCount = 0 } = {}) {
  const data = event?.data ?? {};
  const timeline = turn.activityTimeline ??= { schemaVersion: 1, turnId: turn.id, requestId: turn.requestId ?? null,
    taskId: taskId ?? null, runId: null, attemptId: null, providerId: providerId ?? null, sessionId: sessionId ?? null,
    state: turn.state, nextSequence: 1, omittedCount: 0, gapCount: 0, entries: [] };
  if (!timeline.runId && id(data.runId)) timeline.runId = id(data.runId);
  if (!timeline.attemptId && id(data.attemptId)) timeline.attemptId = id(data.attemptId);
  if (!timeline.providerId && providerId) timeline.providerId = id(providerId);
  if (!timeline.sessionId && sessionId) timeline.sessionId = id(sessionId);
  if (!timeline.taskId && taskId) timeline.taskId = id(taskId);
  timeline.state = turn.state;
  const entry = { id: `${turn.id}:${timeline.nextSequence}`, sequence: timeline.nextSequence++,
    at: time(event?.timestamp) ?? (typeof event?.timestamp === 'string' ? time(Date.parse(event.timestamp)) : null) ?? at,
    source, sourceSequence: Number.isSafeInteger(event?.seq) ? event.seq : null,
    kind, status, toolId: tool?.id ?? null, capability: tool?.capability ?? null, missingCount: count(missingCount) };
  timeline.entries.push(entry);
  if (kind === 'gap') timeline.gapCount += count(missingCount);
  if (timeline.entries.length > 128) { timeline.omittedCount += timeline.entries.length - 128; timeline.entries = timeline.entries.slice(-128); }
  return entry;
}

export function updateChatToolActivity(turn, value) {
  const tool = projectChatToolActivity(value);
  if (!tool) return null;
  const rows = turn.toolActivity ?? [];
  const previous = rows.find(row => row.id === tool.id);
  if (previous && TERMINAL.has(previous.status) && !TERMINAL.has(tool.status)) return null;
  if (previous && JSON.stringify(previous) === JSON.stringify(tool)) return null;
  const next = previous ? rows.map(row => row.id === tool.id ? tool : row) : [...rows, tool];
  turn.activityOmitted = count(turn.activityOmitted) + Math.max(0, next.length - 32);
  turn.toolActivity = next.slice(-32);
  return tool;
}

export function interruptedChatActivity(message, at) {
  const turn = { ...message, id: message.turnId, state: 'interrupted',
    activityTimeline: projectChatActivityTimeline(message.activityTimeline),
    toolActivity: (message.toolActivity ?? []).map(projectChatToolActivity).filter(Boolean).map(tool =>
      TERMINAL.has(tool.status) ? tool : { ...tool, status: 'outcome-unknown' }) };
  appendChatActivity(turn, { status: 'interrupted', source: 'recovery', at });
  return { ...message, interrupted: true, activityState: 'interrupted', activityTimeline: turn.activityTimeline,
    toolActivity: turn.toolActivity, ...(message.agentActivity ? { agentActivity: { ...message.agentActivity, status: 'unknown' } } : {}) };
}
