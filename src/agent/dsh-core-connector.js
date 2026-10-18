// Optional DSH transport for the authoritative Core. This module never starts
// a DSH process, a Legacy Bridge, an IPC listener or a second data writer.
import { NodeApiClient } from '../dsh-client.js';

export function createDshCoreConnector({ config = {}, env = process.env } = {}) {
  const dsh = config?.dsh && typeof config.dsh === 'object' ? config.dsh : {};
  const api = new NodeApiClient(dsh.baseUrl || 'http://127.0.0.1:3080', {
    authCookie: () => dsh.authCookie || null,
    dshHome: () => dsh.homeDir || env?.DSH_HOME || null,
    timeoutMs: 120_000
  });
  return { api, presetConfig: { coding: dsh.codingPreset || null, social: dsh.socialPreset || null,
    dshHome: dsh.homeDir || env?.DSH_HOME || null } };
}
