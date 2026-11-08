import crypto from 'node:crypto';
import { validateTestInvocation } from '../workspace/isolated-runner.js';
import { capabilityError } from '../capability/types.js';

const CONFIG_KEYS = ['enabled', 'tool', 'args', 'includeExtensions', 'timeoutMs', 'maxRunsPerTurn'];
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Owner settings only; no discovery, permission changes or execution. */
export function normalizePostWriteVerification(value) {
  if (value === null || value === undefined) return null;
  const invalid = () => { throw capabilityError('POST_WRITE_CONFIG_INVALID', 'Post-write verification requires an explicit bounded invocation and extension list'); };
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !CONFIG_KEYS.includes(key))
    || CONFIG_KEYS.some(key => !Object.hasOwn(value, key)) || typeof value.enabled !== 'boolean'
    || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600000
    || !Number.isSafeInteger(value.maxRunsPerTurn) || value.maxRunsPerTurn < 0 || value.maxRunsPerTurn > 2
    || !Array.isArray(value.includeExtensions) || value.includeExtensions.length > 20
    || value.includeExtensions.some(ext => typeof ext !== 'string' || !/^\.[a-zA-Z0-9]{1,16}$/.test(ext))) invalid();
  const invocation = validateTestInvocation(value);
  return { enabled: value.enabled, ...invocation,
    includeExtensions: [...new Set(value.includeExtensions.map(ext => ext.toLowerCase()))].sort(), maxRunsPerTurn: value.maxRunsPerTurn };
}

/** Canonical digest is independent of Owner field/extension ordering. */
export function postWriteVerificationSnapshot(value) {
  const config = normalizePostWriteVerification(value);
  return config ? { ...config, configDigest: digest(config) } : null;
}

/** A deterministic trigger plan; only already settled Core receipts enter here. */
export function planPostWriteVerification({ config, writeReceipts = [], knownWriteReceipts = writeReceipts, priorChecks = [], remainingCalls = 0 } = {}) {
  const sourceWriteIds = [...new Set(writeReceipts.map(row => row.eventId).filter(id => typeof id === 'string'))].slice(0, 24);
  const skipped = code => ({ kind: 'post-write-verification', state: 'not-run', code, sourceWriteIds,
    configDigest: config?.configDigest ?? null, operationRef: null });
  if (!config) return skipped('POST_WRITE_NOT_CONFIGURED');
  if (config.enabled !== true) return skipped('POST_WRITE_DISABLED');
  const matching = writeReceipts.filter(row => typeof row.path === 'string'
    && config.includeExtensions.some(ext => row.path.toLowerCase().endsWith(ext)));
  if (!matching.length) return skipped('POST_WRITE_NO_MATCH');
  if (priorChecks.length >= config.maxRunsPerTurn) return skipped('VERIFICATION_BUDGET_EXHAUSTED');
  if (!Number.isSafeInteger(remainingCalls) || remainingCalls < 1) return skipped('TOOL_CALL_LIMIT');
  const pathKey = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value.replaceAll('\\', '/');
  const previouslyChecked = new Set(priorChecks.filter(row => ['passed', 'failed'].includes(row.state))
    .flatMap(row => Array.isArray(row.writes) ? row.writes : []).map(row => pathKey(row.path)));
  const paths = new Map();
  // Keep every already checked path and every currently matching actual write,
  // replacing the previous postimage when the same file is legitimately repaired.
  for (const row of [...knownWriteReceipts, ...writeReceipts]) {
    if (typeof row.path !== 'string' || !row.path) continue;
    const key = pathKey(row.path);
    if (previouslyChecked.has(key) || config.includeExtensions.some(ext => row.path.toLowerCase().endsWith(ext))) {
      paths.set(key, { eventId: row.eventId, requestId: row.requestId, path: row.path, sha256: row.sha256,
        ...(row.capability === 'workspace.apply' ? {capability:row.capability,operationId:row.operationId,action:row.action} : {}) });
    }
  }
  if (!isDigest(config.configDigest) || !isDigest(config.sourceDigest) || paths.size > 24
    || [...paths.values()].some(row => !(row.capability === 'workspace.apply' && row.action === 'delete' && row.sha256 === null) && !isDigest(row.sha256)
      || typeof row.requestId !== 'string' || !row.requestId || !row.eventId)) {
    return skipped('POST_WRITE_SOURCE_UNAVAILABLE');
  }
  return { kind: 'post-write-verification', state: 'requested',
    input: { tool: config.tool, args: [...config.args], timeoutMs: config.timeoutMs },
    binding: { configDigest: config.configDigest, sourceDigest: config.sourceDigest,
      sourceWriteIds: [...new Set([...paths.values()].map(row => row.eventId))], writes: [...paths.values()] } };
}

/** Bounded model feedback, separate from Broker transport and semantic acceptance. */
export function postWriteVerificationFeedback(binding, result, operationRef) {
  return { kind: 'post-write-verification', state: result?.status === 'completed'
    ? result.result?.exitCode === 0 && result.result?.timedOut !== true ? 'passed' : 'failed'
    : result?.status === 'pending' ? 'pending' : result?.status === 'outcome-unknown' ? 'unknown' : 'not-run',
    sourceWriteIds: binding.sourceWriteIds, configDigest: binding.configDigest, operationRef,
    ...(result?.error?.code ? { code: result.error.code } : {}) };
}
