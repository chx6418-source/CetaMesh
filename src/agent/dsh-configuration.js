import path from 'node:path';
import os from 'node:os';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { agentProviderError } from './agent-provider.js';
import { inspectDshPreset, validDshPresetId } from './dsh-preset-policy.js';

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw agentProviderError('INVALID_PARAMS', 'DSH configuration must be an object');
  const result = {};
  for (const key of ['codingPreset', 'socialPreset']) {
    const id = value[key];
    if (id !== null && id !== undefined && id !== '' && !validDshPresetId(id)) throw agentProviderError('INVALID_PARAMS', `Invalid ${key}`);
    result[key] = id || null;
  }
  if (value.homeDir && (typeof value.homeDir !== 'string' || !path.isAbsolute(value.homeDir) || value.homeDir.length > 4096)) throw agentProviderError('INVALID_PARAMS', 'DSH homeDir must be an absolute local path');
  result.homeDir = value.homeDir || null;
  try {
    const url = new URL(value.baseUrl || 'http://127.0.0.1:3080');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('unsupported');
    result.baseUrl = url.href.replace(/\/$/, '');
  } catch (error) { throw agentProviderError('INVALID_PARAMS', 'Invalid DSH baseUrl'); }
  return result;
}

// One versioned source overrides the read-only legacy config.dsh. Saving never
// swaps a live transport: every Session in this Core generation stays pinned.
export function createDshConfiguration({ legacy = {}, stateDir, configFile = null, dataRoot = null, env = process.env, legacyLoadError = null } = {}) {
  const file = stateDir ? path.join(stateDir, 'dsh-connector.json') : null;
  let source = 'legacy-config';
  let loadError = legacyLoadError;
  let revision = 0;
  let selected = legacy;
  if (file) {
    try {
      const stored = readJsonFile(file, { maxBytes: 64 * 1024 });
      if (stored.version !== 1 || !Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('schema');
      selected = normalize(stored); revision = stored.revision; source = 'connector-v1'; loadError = null;
    } catch (error) {
      if (error?.code !== 'MISSING') { source = 'connector-invalid'; selected = {}; loadError = 'DSH_CONFIG_INVALID'; }
    }
  }
  let active;
  try { active = normalize(selected); }
  catch (error) { active = normalize({}); loadError = 'DSH_CONFIG_INVALID'; }
  if (loadError) { active.codingPreset = null; active.socialPreset = null; }
  const activeRevision = revision;
  const activeSource = source;
  let pending = null;
  const home = active.homeDir || env?.DSH_HOME || path.join(os.homedir(), '.dsh');
  return {
    active: Object.freeze({ ...active, homeDir: home, authCookie: legacy.authCookie || null }),
    describe() {
      return { version: 1, revision, activeRevision, pendingRevision: pending ? revision : null,
        restartRequired: Boolean(pending), source: activeSource, loadError,
        configFile: activeSource === 'legacy-config' ? configFile : file, dataRoot,
        pendingConfigFile: pending ? file : null,
        homeSource: active.homeDir ? 'connector' : env?.DSH_HOME ? 'environment' : 'user-default',
        active: { ...active, homeDir: home }, pending: pending ? { ...pending } : null };
    },
    configure(input) {
      if (!file) throw agentProviderError('CONFIGURATION_UNSUPPORTED', 'Connector persistence is unavailable');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw agentProviderError('INVALID_PARAMS', 'DSH configuration must be an object');
      const candidate = normalize({ ...(pending ?? active), ...input });
      if (legacy.authCookie && (candidate.baseUrl !== active.baseUrl
        || (candidate.homeDir || env?.DSH_HOME || path.join(os.homedir(), '.dsh')) !== home)) {
        throw agentProviderError('DSH_AUTH_SCOPE_CHANGE_REQUIRES_REVIEW', 'Explicit authentication is pinned to its existing endpoint and home; review credential scope before changing either');
      }
      const checks = ['coding', 'social'].map(purpose => ({ purpose, ...inspectDshPreset({ id: candidate[`${purpose}Preset`], dshHome: candidate.homeDir || env?.DSH_HOME }) }));
      // Missing selections may be saved deliberately, but selected files must be
      // verified. Native loading is checked after an explicit Core restart.
      if (checks.some(check => candidate[`${check.purpose}Preset`] && !check.compatible)) {
        throw agentProviderError('DSH_PRESET_INCOMPATIBLE', `DSH preset preflight failed: ${checks.filter(c => !c.compatible && candidate[`${c.purpose}Preset`]).map(c => `${c.purpose}:${c.reason}`).join(', ')}`);
      }
      const next = Math.max(revision, activeRevision) + 1;
      try { writeJsonAtomic(file, { version: 1, revision: next, ...candidate }); }
      catch (error) { throw agentProviderError('DSH_CONFIG_WRITE_FAILED', 'Could not save DSH connector configuration', { cause: error }); }
      revision = next; pending = candidate;
      return { provider: 'dsh', supported: true, applied: false, restartRequired: true, configuration: this.describe(), preflight: checks };
    }
  };
}
