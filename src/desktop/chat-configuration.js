// Bounded projections for the existing Chat JSON configuration transaction.
// This module has no storage, executor, Task state or authorization authority.
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
const identifier = value => text(value) && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]*$/.test(value)
  && !/https?:|bearer|api[_-]?key|password|secret|^sk-/i.test(value) ? value : null;
const revision = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const pick = (value, choices, fallback = null) => choices.includes(value) ? value : fallback;
const efforts = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function projectNativeDesiredConfiguration(value) {
  if(!value || !identifier(value.provider) || !/^[a-f0-9]{64}$/.test(value.connectionIdentity??'')
    || !text(value.source,80) || !text(value.runtimeVersion,80) || !text(value.selection?.model))return null;
  const selection=value.selection;
  if(selection.reasoningEffort!==null&&!text(selection.reasoningEffort) || selection.modelProvider!==null&&!text(selection.modelProvider))return null;
  return {provider:value.provider,connectionIdentity:value.connectionIdentity,source:value.source,runtimeVersion:value.runtimeVersion,
    selection:{model:selection.model,reasoningEffort:selection.reasoningEffort,modelProvider:selection.modelProvider}};
}

export function projectChatConfiguration(record) {
  const pending = record?.pendingConfiguration;
  const saved = record?.configuration;
  return { revision: revision(record?.configurationRevision), changeId: text(pending?.changeId ?? saved?.changeId, 128),
    state: pending ? pick(pending.phase, ['prepared', 'runtime-confirmed', 'needs-reconciliation'], 'needs-reconciliation') : 'saved',
    application: pick(pending?.application ?? saved?.application, ['next-turn', 'runtime-confirmed', 'requires-new-session']),
    durable: !pending, runtime: pending ? pending.phase === 'runtime-confirmed' ? pending.application === 'next-turn' ? 'not-required' : 'confirmed' : Number.isFinite(pending.attemptedAt) ? 'unknown' : 'not-applied'
      : pick(saved?.runtime, ['not-required', 'not-applied', 'confirmed', 'unknown'], 'not-required'),
    at: Number.isFinite(pending?.confirmedAt ?? saved?.at) ? pending?.confirmedAt ?? saved?.at : null,
    errorCode: text(pending?.errorCode, 100),...(projectNativeDesiredConfiguration(record?.nativeDesiredConfiguration)?{desired:projectNativeDesiredConfiguration(record.nativeDesiredConfiguration)}:{}) };
}

export function projectChatConfigurationObservation(value, binding = {}) {
  if (value?.schemaVersion !== 1 || !text(value.requestId, 128) || !identifier(value.providerId)
    || value.application !== 'current-request') return null;
  return { schemaVersion: 1, requestId: text(value.requestId, 128), providerId: identifier(value.providerId),
    connectionRevision: Number.isSafeInteger(value.connectionRevision) && value.connectionRevision >= 0 ? value.connectionRevision : null,
    requested: { model: identifier(value.requested?.model), reasoning: pick(value.requested?.reasoning, efforts) },
    effective: { model: identifier(value.effective?.model), reasoning: pick(value.effective?.reasoning, efforts) },
    response: { model: identifier(value.response?.model) },
    source: { model: pick(value.source?.model, ['request', 'configuration', 'provider-default']),
      reasoning: pick(value.source?.reasoning, ['request', 'configuration', 'model-preference']),
      effective: pick(value.source?.effective, ['wire-projection']) },
    application: 'current-request', stage: pick(value.stage, ['serialized', 'response', 'aborted'], 'serialized'),
    overrideReason: pick(value.overrideReason, ['reasoning-unavailable', 'adapter-reasoning-map']),
    at: Number.isFinite(value.at) && value.at >= 0 ? value.at : null,
    chatRequestId: text(binding.chatRequestId ?? value.chatRequestId, 200), turnId: text(binding.turnId ?? value.turnId, 128),
    configurationRevision: revision(binding.configurationRevision ?? value.configurationRevision) };
}

export function chatConfigurationObservations(value) {
  const list = Array.isArray(value?.configurationObservations) ? value.configurationObservations : value?.configurationObservation ? [value.configurationObservation] : [];
  const observations = list.slice(-16).map(item => projectChatConfigurationObservation(item)).filter(Boolean);
  return observations.length ? { configurationObservation: observations.at(-1), configurationObservations: observations } : {};
}
