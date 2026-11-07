// Bounded metadata on the existing Memory row. Advice is reference data, never
// an executable Skill, a semantic fact certification, or a permission grant.
import { memoryError, normalizeContent, normalizeScope } from './types.js';

export const EXPERIENCE_LIMITS = Object.freeze({ perTurn: 1, perTask: 3, candidates: 200, recall: 3, trials: 1, history: 4, outcomes: 8 });
export const EXPERIENCE_STATES = Object.freeze(['trial', 'active', 'retired']);
export const EXPERIENCE_SIGNALS = Object.freeze(['owner-remember', 'owner-correction', 'repeated-failure', 'failure-recovery']);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value, max = 240) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const entity = value => typeof value === 'string' && /^[A-Za-z0-9._:@-]{1,128}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw memoryError('INVALID_EXPERIENCE', 'Experience requires bounded source identities, receipts and exact scoped conditions'); };
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid(); }

/** Refuse rather than save a redacted fragment as a lesson. No full-chat autosave. */
export function isSafeExperienceText(text) {
  return typeof text === 'string' && text.length >= 6 && text.length <= 4000
    && !/(?:密码|口令|验证码|身份证|银行卡|私钥|密钥|住址|电话|病史|诊断|疾病|宗教|政治立场|性取向|收入|工资|过敏|药物|token|api[_ -]?key|secret|password|bearer\s|sk-[A-Za-z0-9_-]{8}|\[redacted\]|\b\d{11}\b|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/i.test(text);
}

export function normalizeExperienceConditions(value, workspaceId) {
  keys(value, ['workspaceId', 'platform', 'tool', 'configDigest', 'sourceDigest']);
  if (!entity(value.workspaceId) || value.workspaceId !== workspaceId || !id(value.platform, 40)
    || !/^[a-z0-9._-]+$/.test(value.platform)
    || (value.tool !== null && !['npm', 'cargo'].includes(value.tool))
    || (value.configDigest !== null && !hash(value.configDigest))
    || (value.sourceDigest !== null && !hash(value.sourceDigest))
    || (value.tool === null && (value.configDigest !== null || value.sourceDigest !== null))
    || (value.tool !== null && (!hash(value.configDigest) || !hash(value.sourceDigest)))) invalid();
  return { workspaceId: value.workspaceId, platform: value.platform, tool: value.tool, configDigest: value.configDigest, sourceDigest: value.sourceDigest };
}

export function normalizeExperienceReceipt(value) {
  keys(value, ['eventId', 'taskId', 'workspaceId', 'provider', 'sessionId', 'runId', 'operationId', 'status', 'resultSha256', 'at']);
  if (!id(value.eventId) || !value.eventId.startsWith('core-test:') || !entity(value.taskId) || !entity(value.workspaceId)
    || !id(value.provider, 80) || !id(value.sessionId, 128) || !id(value.runId) || !id(value.operationId, 160)
    || !['pass', 'fail'].includes(value.status) || !hash(value.resultSha256) || !Number.isSafeInteger(value.at) || value.at < 0) invalid();
  return { eventId: value.eventId, taskId: value.taskId, workspaceId: value.workspaceId, provider: value.provider,
    sessionId: value.sessionId, runId: value.runId, operationId: value.operationId, status: value.status, resultSha256: value.resultSha256, at: value.at };
}

export function normalizeExperienceProposal(value, scope) {
  keys(value, ['schemaVersion', 'trigger', 'conditions', 'evidence']);
  const scoped = normalizeScope(scope);
  if (value.schemaVersion !== 1 || scoped.kind !== 'workspace') invalid();
  const trigger = value.trigger;
  keys(trigger, ['id', 'kind', 'taskId', 'workspaceId', 'turnId', 'provider', 'sessionId', 'runId', 'ownerMessageId']);
  if (!hash(trigger.id) || !EXPERIENCE_SIGNALS.includes(trigger.kind) || !entity(trigger.taskId) || trigger.workspaceId !== scoped.id
    || !id(trigger.turnId) || !id(trigger.provider, 80) || !id(trigger.sessionId, 128) || !id(trigger.runId)
    || (trigger.ownerMessageId !== null && !entity(trigger.ownerMessageId))) invalid();
  const conditions = normalizeExperienceConditions(value.conditions, scoped.id);
  if (!Array.isArray(value.evidence) || value.evidence.length > EXPERIENCE_LIMITS.outcomes) invalid();
  const evidence = value.evidence.map(normalizeExperienceReceipt);
  if (evidence.some(row => row.taskId !== trigger.taskId || row.workspaceId !== scoped.id)
    || new Set(evidence.map(row => row.eventId)).size !== evidence.length
    || new Set(evidence.map(row => row.operationId)).size !== evidence.length) invalid();
  if (trigger.kind.startsWith('owner-')) {
    if (!trigger.ownerMessageId || evidence.length) invalid();
  } else if (!conditions.tool || trigger.ownerMessageId !== null || evidence.length < 2
    || (trigger.kind === 'repeated-failure' && evidence.some(row => row.status !== 'fail'))
    || (trigger.kind === 'failure-recovery' && (!evidence.some(row => row.status === 'fail') || !evidence.some(row => row.status === 'pass')))) invalid();
  return { schemaVersion: 1, trigger: { ...trigger }, conditions, evidence };
}

export function normalizeExperience(value, { scope, revision } = {}) {
  keys(value, ['schemaVersion', 'trigger', 'conditions', 'evidence', 'state', 'outcomes', 'history', 'omittedHistory', 'omittedOutcomes', 'meaning']);
  const proposal = normalizeExperienceProposal({ schemaVersion: value.schemaVersion, trigger: value.trigger, conditions: value.conditions, evidence: value.evidence }, scope);
  if (!EXPERIENCE_STATES.includes(value.state) || value.meaning !== 'conditional-reference'
    || !Array.isArray(value.outcomes) || value.outcomes.length > EXPERIENCE_LIMITS.outcomes
    || !Array.isArray(value.history) || value.history.length > EXPERIENCE_LIMITS.history
    || !Number.isSafeInteger(value.omittedHistory) || value.omittedHistory < 0
    || !Number.isSafeInteger(value.omittedOutcomes) || value.omittedOutcomes < 0) invalid();
  const outcomes = value.outcomes.map(normalizeExperienceReceipt);
  if (outcomes.some(row => row.workspaceId !== proposal.conditions.workspaceId) || new Set(outcomes.map(row => row.eventId)).size !== outcomes.length) invalid();
  const history = value.history.map(row => {
    keys(row, ['revision', 'content', 'state', 'conditions', 'at', 'by']);
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || (revision && row.revision >= revision)
      || !EXPERIENCE_STATES.includes(row.state) || !Number.isSafeInteger(row.at) || row.at < 0 || !id(row.by, 160) || !row.by.startsWith('user:')) invalid();
    return { revision: row.revision, content: normalizeContent(row.content), state: row.state,
      conditions: normalizeExperienceConditions(row.conditions, proposal.conditions.workspaceId), at: row.at, by: row.by };
  });
  if (new Set(history.map(row => row.revision)).size !== history.length) invalid();
  return { ...proposal, state: value.state, meaning: 'conditional-reference', outcomes, history,
    omittedHistory: value.omittedHistory, omittedOutcomes: value.omittedOutcomes };
}

export function initialExperience(proposal) {
  return { ...structuredClone(proposal), state: 'trial', meaning: 'conditional-reference', outcomes: [], history: [], omittedHistory: 0, omittedOutcomes: 0 };
}

/** The caller supplies a trusted observation; matching cannot expand policy scopes. */
export function matchesExperienceConditions(conditions, context) {
  return Boolean(context && conditions.workspaceId === context.workspaceId && conditions.platform === context.platform
    && ['tool', 'configDigest', 'sourceDigest'].every(key => conditions[key] === null || conditions[key] === context[key]));
}

export function experienceReferenceMetadata(experience) {
  if (!experience) return undefined;
  // Retrieval already checked the complete canonical conditions. The shared
  // context budget keeps advice useful; full digests/history remain in Memory.
  const result = { state: experience.state, meaning: 'conditional-reference', platform: experience.conditions.platform, tool: experience.conditions.tool,
    source: { taskId: experience.trigger.taskId, runId: experience.trigger.runId, kind: experience.trigger.kind },
    evidence: experience.evidence.map(row => ({ eventId: row.eventId, runId: row.runId, status: row.status })),
    observedOutcomes: experience.outcomes.length, omittedEvidence: 0 };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 800 && result.evidence.length) { result.evidence.shift(); result.omittedEvidence++; }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 800) {
    // Omit an over-budget opaque identity explicitly; never truncate one into
    // a fabricated source ID. Memory id/revision still names the complete row.
    result.source = { taskId: experience.trigger.taskId, runId: null, kind: experience.trigger.kind, runReferenceOmitted: true };
  }
  return result;
}

/** Allowlisted context DTO, without turning a reference into a source proof. */
export function projectExperienceReferenceMetadata(value) {
  if (!object(value) || value.meaning !== 'conditional-reference' || !EXPERIENCE_STATES.includes(value.state)
    || !id(value.platform, 40) || !/^[a-z0-9._-]+$/.test(value.platform) || (value.tool !== null && !['npm', 'cargo'].includes(value.tool))
    || !object(value.source) || !entity(value.source.taskId) || !EXPERIENCE_SIGNALS.includes(value.source.kind)
    || (value.source.runId !== null && !id(value.source.runId)) || !Array.isArray(value.evidence)
    || !Number.isSafeInteger(value.observedOutcomes) || value.observedOutcomes < 0 || value.observedOutcomes > EXPERIENCE_LIMITS.outcomes
    || !Number.isSafeInteger(value.omittedEvidence) || value.omittedEvidence < 0) return undefined;
  const evidence = value.evidence.slice(0, EXPERIENCE_LIMITS.outcomes).filter(row => object(row) && id(row.eventId)
    && row.eventId.startsWith('core-test:') && id(row.runId) && ['pass', 'fail'].includes(row.status))
    .map(row => ({ eventId: row.eventId, runId: row.runId, status: row.status }));
  const result = { state: value.state, meaning: 'conditional-reference', platform: value.platform, tool: value.tool,
    source: { taskId: value.source.taskId, runId: value.source.runId, kind: value.source.kind,
      ...(value.source.runReferenceOmitted === true || value.source.runId === null ? { runReferenceOmitted: true } : {}) },
    evidence, observedOutcomes: value.observedOutcomes, omittedEvidence: value.omittedEvidence + value.evidence.length - evidence.length };
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > 800 && result.evidence.length) { result.evidence.shift(); result.omittedEvidence++; }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 800) result.source = { taskId: result.source.taskId, runId: null, kind: result.source.kind, runReferenceOmitted: true };
  return result;
}

export function appendExperienceSnapshot(record, actor, at) {
  const experience = structuredClone(record.experience);
  experience.history.push({ revision: record.rev, content: record.content, state: experience.state,
    conditions: structuredClone(experience.conditions), at, by: actor });
  while (experience.history.length > EXPERIENCE_LIMITS.history) { experience.history.shift(); experience.omittedHistory++; }
  return experience;
}
