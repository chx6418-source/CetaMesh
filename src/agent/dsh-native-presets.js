import { inspectDshPresetContent, validDshPresetId } from './dsh-preset-policy.js';
import { agentProviderError } from './agent-provider.js';

// Observed on the installed Host and upstream dsh-v0.2.2-rc.1. The roster is
// discovery, not authority; every native document is independently parsed.
export function createDshNativePresets({ api } = {}) {
  async function roster() {
    const value = await api.callEndpoint('agentPresets/list', {}, AbortSignal.timeout(2500));
    if (!Array.isArray(value?.presets) || value.presets.length > 200
      || !value.presets.every(row => validDshPresetId(row?.id) && (row.broken === undefined || typeof row.broken === 'string'))
      || new Set(value.presets.map(row => row.id)).size !== value.presets.length) {
      throw agentProviderError('DSH_PRESET_LIST_UNVERIFIED', 'DSH preset roster is invalid');
    }
    return value.presets;
  }
  async function inspect(id, rows) {
    if (!validDshPresetId(id)) return { compatible: false, reason: 'preset-not-configured' };
    try {
      const row = (rows ?? await roster()).find(item => item.id === id);
      if (!row) return { compatible: false, reason: 'preset-not-loaded' };
      if (row.broken !== undefined) return { compatible: false, reason: 'native-preset-broken' };
      const document = await api.callEndpoint('agentPresets/read', { agentPreset: id }, AbortSignal.timeout(2500));
      if (document?.agentPreset !== id || typeof document.content !== 'string') {
        return { compatible: false, reason: 'native-preset-document-unverified' };
      }
      return { ...inspectDshPresetContent(document.content, 'native-persona-only'), loaded: true };
    } catch {
      return { compatible: false, reason: 'native-preset-discovery-unavailable' };
    }
  }
  async function list(local) {
    try {
      const rows = await roster();
      const extra = rows.filter(row => !local.presets.some(item => item.id === row.id));
      const found = [];
      for (let offset = 0; offset < Math.min(extra.length, 32); offset += 4) {
        found.push(...await Promise.all(extra.slice(offset, Math.min(offset + 4, 32))
          .map(async row => ({ id: row.id, ...await inspect(row.id, rows) }))));
      }
      return { ...local, state: local.state === 'ready' || found.length ? 'ready' : local.state,
        truncated: local.truncated || extra.length > 32, presets: [...local.presets, ...found] };
    } catch { return local; } // Offline native discovery cannot hide valid local selections.
  }
  return Object.freeze({ inspect, list });
}
