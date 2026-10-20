import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDocument, isAlias, isCollection, isPair } from 'yaml';
import { agentProviderError } from './agent-provider.js';

const MAX_PRESET_BYTES = 256 * 1024;
export const validDshPresetId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id);

// This verifies only the supported local persona schema. Native loading, model,
// tools and Workspace authorization remain independent execution gates.
export function inspectDshPreset({ id, dshHome } = {}) {
  if (!validDshPresetId(id)) return { compatible: false, reason: 'preset-not-configured' };
  const root = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const presetRoot = path.join(root, '.agent-presets');
  const file = path.join(presetRoot, id, 'agent.cordis.yml');
  let source;
  let fd;
  try {
    const canonicalHome = fs.realpathSync(root);
    const canonicalRoot = fs.realpathSync(presetRoot);
    if (!canonicalRoot.startsWith(canonicalHome + path.sep)) return { compatible: false, reason: 'preset-path-outside-root' };
    const canonical = fs.realpathSync(file);
    if (!canonical.startsWith(canonicalRoot + path.sep)) return { compatible: false, reason: 'preset-path-outside-root' };
    fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PRESET_BYTES) return { compatible: false, reason: 'preset-file-too-large' };
    const bytes = Buffer.alloc(MAX_PRESET_BYTES + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > MAX_PRESET_BYTES) return { compatible: false, reason: 'preset-file-too-large' };
    source = bytes.subarray(0, size).toString('utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    return { compatible: false, reason: error?.code === 'ENOENT' ? 'preset-file-not-found' : 'preset-file-unreadable' };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  try {
    const doc = parseDocument(source, { schema: 'core', uniqueKeys: true, strict: true });
    if (doc.errors.length) return { compatible: false, reason: 'preset-yaml-invalid' };
    let nodes = 0;
    const inspect = (node, depth = 0) => {
      if (!node) return;
      if (++nodes > 10000 || depth > 32 || isAlias(node)) throw new Error('bounded-schema');
      if (isPair(node)) { inspect(node.key, depth + 1); inspect(node.value, depth + 1); }
      else if (isCollection(node)) for (const item of node.items) inspect(item, depth + 1);
    };
    inspect(doc.contents);
    const plugins = doc.toJS({ maxAliasCount: 0 });
    if (!Array.isArray(plugins) || plugins.some(p => !p || typeof p !== 'object' || Array.isArray(p))) {
      return { compatible: false, reason: 'preset-schema-unverified' };
    }
    const persona = plugins.filter(p => p.id === 'persona');
    if (!persona.length) return { compatible: false, reason: 'persona-missing' };
    if (persona.length !== 1 || persona[0].name !== '@deepseek-ai/dsh-persona') return { compatible: false, reason: 'preset-schema-unverified' };
    const prefix = persona[0].config?.prefix;
    const compatible = typeof prefix === 'string' && prefix.trim().length > 0;
    return { compatible, reason: compatible ? null : 'persona-prefix-required', verification: 'local-persona-only' };
  } catch (error) {
    return { compatible: false, reason: 'preset-yaml-limits-exceeded' };
  }
}

export function listDshPresets({ dshHome } = {}) {
  const home = path.resolve(dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const root = path.join(home, '.agent-presets');
  let directory;
  try {
    const canonicalHome = fs.realpathSync(home), canonicalRoot = fs.realpathSync(root);
    if (!canonicalRoot.startsWith(canonicalHome + path.sep)) return { state: 'outside-root', presets: [], truncated: false };
    directory = fs.opendirSync(canonicalRoot);
    const ids = []; let inspected = 0, truncated = false;
    for (let entry; (entry = directory.readSync()) !== null;) {
      if (++inspected > 1000 || ids.length >= 200) { truncated = true; break; }
      if (entry.isDirectory() && !entry.isSymbolicLink() && validDshPresetId(entry.name)) ids.push(entry.name);
    }
    ids.sort();
    return { state: 'ready', truncated, presets: ids.map(id => ({ id, ...inspectDshPreset({ id, dshHome: home }) })) };
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'missing' : 'unreadable', presets: [], truncated: false };
  } finally { if (directory) directory.closeSync(); }
}

export function createDshPresetPolicy(config = {}) {
  const coding = config.coding ?? null;
  const social = config.social ?? null;
  const dshHome = config.dshHome ?? null;
  return {
    inspect(purpose = 'coding') {
      if (purpose !== 'coding' && purpose !== 'social') throw agentProviderError('INVALID_PARAMS', `Unsupported DSH Session purpose: ${purpose}`);
      const id = purpose === 'coding' ? coding : social;
      return { purpose, id, ...inspectDshPreset({ id, dshHome }) };
    },
    require(purpose = 'coding') {
      const result = this.inspect(purpose);
      if (!result.compatible) throw agentProviderError('DSH_PRESET_INCOMPATIBLE', `DSH ${purpose} preset is not verified: ${result.reason}`);
      return result.id;
    }
  };
}
