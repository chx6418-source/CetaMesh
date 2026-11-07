import { agentProviderError as fault } from '../agent-provider.js';

// This is a model-control protocol profile, not native execution permission.
// It follows the schema emitted by this exact local CLI version.
export const CODEX_MODEL_CONTROL_SCHEMA_VERSION = '0.167.0-alpha.3.2';
const MODEL_CONTROL_BYTES = 128 * 1024;
const value = (raw, max = 256) => typeof raw === 'string' && raw.length > 0 && raw.length <= max
  && raw === raw.trim() && !/[\x00-\x1f\x7f]/.test(raw);
const invalid = () => fault('CODEX_MODEL_CATALOG_INVALID', 'Codex did not return a bounded native model catalog');

export async function readCodexModelCatalog(request) {
  const rows = [], models = new Set(), cursors = new Set();
  let cursor, bytes=0;
  for (let page = 0; page < 4; page++) {
    const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.length > 100) throw invalid();
    for (const row of result.data) {
      if (!value(row?.model) || !value(row.displayName) || models.has(row.model)
        || !Array.isArray(row.supportedReasoningEfforts) || row.supportedReasoningEfforts.length > 32) throw invalid();
      const efforts = row.supportedReasoningEfforts.map(entry => {
        if (!value(entry?.reasoningEffort, 64)) throw invalid();
        return { value: entry.reasoningEffort, label: value(entry.description) ? entry.description : entry.reasoningEffort };
      });
      if (new Set(efforts.map(entry => entry.value)).size !== efforts.length || rows.length >= 256) throw invalid();
      if(Object.hasOwn(row,'defaultReasoningEffort')&&(!value(row.defaultReasoningEffort,64)||!efforts.some(entry=>entry.value===row.defaultReasoningEffort)))throw invalid();
      const clean={ value: row.model, label: row.displayName, efforts,
        ...(Object.hasOwn(row,'defaultReasoningEffort')?{defaultReasoningEffort:row.defaultReasoningEffort}:{}) };
      bytes+=Buffer.byteLength(JSON.stringify(clean));
      if(bytes>MODEL_CONTROL_BYTES)throw invalid();
      models.add(row.model); rows.push(clean);
    }
    if (result.nextCursor === null || result.nextCursor === undefined) return rows;
    if (!value(result.nextCursor, 1024) || cursors.has(result.nextCursor)) throw invalid();
    cursor = result.nextCursor; cursors.add(cursor);
  }
  throw invalid();
}

export function codexSelectionReceipt(result, { threadId, expected = {}, policy } = {}) {
  if (!value(result?.thread?.id, 1024) || (threadId && result.thread.id !== threadId)
    || !value(result.model) || !value(result.modelProvider, 80)
    || (result.reasoningEffort != null && !value(result.reasoningEffort, 64))
    || ['model', 'modelProvider', 'reasoningEffort'].some(key => expected[key] != null && result[key] !== expected[key])) {
    throw fault('AGENT_CONFIGURATION_UNCONFIRMED', 'Codex did not acknowledge the complete requested native selection');
  }
  if (policy && (result.cwd !== policy.cwd || result.approvalPolicy !== policy.approvalPolicy
    || result.approvalsReviewer !== policy.approvalsReviewer || result.sandbox?.type !== 'readOnly')) {
    throw fault('CODEX_NATIVE_POLICY_UNCONFIRMED', 'Codex did not retain the existing native policy');
  }
  return { model: result.model, reasoningEffort: result.reasoningEffort ?? null, modelProvider: result.modelProvider };
}

export function codexRequestedSelection(catalog, current, requested = {}) {
  const next = { ...current };
  for (const key of ['model', 'reasoningEffort', 'modelProvider']) {
    if (requested[key] === undefined || requested[key] === null) continue;
    if (!value(requested[key], key === 'modelProvider' ? 80 : key === 'reasoningEffort' ? 64 : 256)) {
      throw fault('INVALID_PARAMS', 'Invalid bounded native Codex selection');
    }
    next[key] = requested[key];
  }
  const advertised = catalog?.find(row => row.value === next.model);
  if (!advertised || next.modelProvider !== current.modelProvider
    || next.reasoningEffort != null && !advertised.efforts.some(entry => entry.value === next.reasoningEffort)) {
    throw fault('AGENT_CONFIGURATION_UNSUPPORTED', 'Codex did not advertise this model and reasoning tuple for the current native provider');
  }
  return next;
}

export function codexInitialSelection(catalog, requested = {}) {
  const expected = {};
  for (const key of ['model', 'reasoningEffort', 'modelProvider']) if (requested[key] != null) {
    if (!value(requested[key], key === 'modelProvider' ? 80 : key === 'reasoningEffort' ? 64 : 256)) throw fault('INVALID_PARAMS', 'Invalid native Codex initial selection');
    expected[key] = requested[key];
  }
  const advertised = expected.model ? catalog?.filter(row => row.value === expected.model) : catalog;
  if ((expected.model || expected.reasoningEffort) && (!advertised?.length
    || expected.reasoningEffort && !advertised.some(row => row.efforts.some(entry => entry.value === expected.reasoningEffort)))) {
    throw fault('AGENT_CONFIGURATION_UNSUPPORTED', 'Codex did not advertise the initial model and reasoning request');
  }
  return { expected, parameters: { ...(expected.model ? { model: expected.model } : {}),
    ...(expected.reasoningEffort ? { config: { model_reasoning_effort: expected.reasoningEffort } } : {}) } };
}

export function projectCodexModelControl({ version, catalog, selection, unknown = false } = {}) {
  const selected = catalog?.find(row => row.value === selection?.model);
  const control = { status: unknown ? 'unknown' : selection ? 'available' : 'unsupported', source: 'codex-app-server', runtimeVersion: version,
    application: 'runtime-confirmed', changeApplication: 'requires-new-session', selection: selection ? { ...selection } : null,
    model: catalog ? { options: catalog.map(({ value, label, efforts, defaultReasoningEffort }) => ({ value, label,
      reasoningOptions:efforts.map(entry=>({...entry})),...(defaultReasoningEffort!==undefined?{defaultReasoningEffort}:{}) })) } : null,
    reasoning: selected ? { options: selected.efforts.map(entry => ({ ...entry })) } : null };
  if (Buffer.byteLength(JSON.stringify(control)) > MODEL_CONTROL_BYTES) throw invalid();
  return control;
}
