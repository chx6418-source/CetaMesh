import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentProviderError } from './agent-provider.js';

// Read-only check against the installed DSH 0.1.5 persona requirement:
// @deepseek-ai/dsh-persona config.prefix is required. No user file is repaired here.
export function inspectDshPreset({ id, dshHome } = {}) {
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    return { compatible: false, reason: 'preset-not-configured' };
  }
  const root = dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const file = path.join(root, '.agent-presets', id, 'agent.cordis.yml');
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    return { compatible: false, reason: error?.code === 'ENOENT' ? 'preset-file-not-found' : 'preset-file-unreadable', file };
  }
  // Validate the persona stanza only. Full DSH validation remains with the native
  // session/create endpoint, which can reject additional package-specific fields.
  const lines = source.split(/\r?\n/);
  const personaAt = lines.findIndex(line => /^\s*-\s*id:\s*persona\s*(?:#.*)?$/.test(line));
  if (personaAt < 0) return { compatible: false, reason: 'persona-missing', file };
  const next = lines.findIndex((line, index) => index > personaAt && /^\s*-\s*id:/.test(line));
  const section = lines.slice(personaAt, next < 0 ? undefined : next).join('\n');
  const prefix = section.match(/^ {4,}prefix:[ \t]*(.*)$/m)?.[1]?.trim();
  const compatible = Boolean(prefix && prefix !== "''" && prefix !== '""' && prefix !== 'null' && prefix !== '~');
  return { compatible, reason: compatible ? null : 'persona-prefix-required', file };
}

export function createDshPresetPolicy(config = {}) {
  const coding = config.coding ?? null;
  const social = config.social ?? null;
  const dshHome = config.dshHome ?? null;
  return {
    inspect(purpose = 'coding') {
      if (purpose !== 'coding' && purpose !== 'social') {
        throw agentProviderError('INVALID_PARAMS', `Unsupported DSH Session purpose: ${purpose}`);
      }
      const id = purpose === 'coding' ? coding : social;
      return { purpose, id, ...inspectDshPreset({ id, dshHome }) };
    },
    require(purpose = 'coding') {
      const result = this.inspect(purpose);
      if (!result.compatible) {
        throw agentProviderError('DSH_PRESET_INCOMPATIBLE', `DSH ${purpose} preset is not verified: ${result.reason}`);
      }
      return result.id;
    }
  };
}
