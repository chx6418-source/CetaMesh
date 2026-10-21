// Optional DSH transport for the authoritative Core. This module never starts
// a DSH process, a Legacy Bridge, an IPC listener or a second data writer.
import { NodeApiClient } from '../dsh-client.js';
import { createDshConfiguration } from './dsh-configuration.js';

export function createDshCoreConnector({ config = {}, env = process.env, stateDir, configFile, dataRoot, configLoadError } = {}) {
  const configuration = createDshConfiguration({ legacy: config?.dsh && typeof config.dsh === 'object' ? config.dsh : {}, env, stateDir, configFile, dataRoot, legacyLoadError: configLoadError });
  const dsh = configuration.active;
  const api = new NodeApiClient(dsh.baseUrl || 'http://127.0.0.1:3080', {
    authCookie: () => dsh.authCookie || null,
    dshHome: () => dsh.homeDir || env?.DSH_HOME || null,
    timeoutMs: 120_000
  });
  return { api, configuration, presetConfig: { coding: typeof dsh.codingPreset === 'string' ? dsh.codingPreset : null,
    social: typeof dsh.socialPreset === 'string' ? dsh.socialPreset : null,
    dshHome: dsh.homeDir || env?.DSH_HOME || null } };
}

