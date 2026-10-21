import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { APP_PATHS, createAppPaths } from '../app-paths.js';
import { readJsonFile } from '../storage/json-file.js';
import { digest, inspectSchema, SOCIAL_FILES } from './schemas.js';
import { inspectDshPreset } from '../agent/dsh-preset-policy.js';

const privatePlans = new WeakMap();
export const migrationError = code => Object.assign(new Error(code), { code });
export function assertNoLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw migrationError('UNSAFE_LINK'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function discoverMigrationRoots({ paths = APP_PATHS, extraRoots = [], executables = [], env = process.env } = {}) {
  const roots = new Map();
  const add = (root, provenance) => {
    const dataRoot = path.resolve(root), key = process.platform === 'win32' ? dataRoot.toLowerCase() : dataRoot;
    if (!roots.has(key)) roots.set(key, { dataRoot, provenance: [] });
    roots.get(key).provenance.push(provenance);
  };
  add(paths.dataRoot, 'createAppPaths:CLI>WHALEBRIDGE_DATA_DIR>portable>LOCALAPPDATA/source');
  for (const root of extraRoots) add(root, 'explicit-inventory-root');
  for (const execPath of executables) add(createAppPaths(env, { packaged: true, execPath, argv: [], cwd: process.cwd() }).dataRoot, 'installed-executable-candidate;process-env-unverified');
  return [...roots.values()].sort((a, b) => a.dataRoot.localeCompare(b.dataRoot));
}
function classification(relative) {
  const name = relative.split('/').at(-1);
  if (relative.startsWith('roles/') || relative.startsWith('state/') && relative.split('/').length === 2 && SOCIAL_FILES.has(name)) return { type: 'bionic-legacy', currentWriter: 'Legacy-exclusive', targetWriter: 'Bionic', action: 'ACCOUNT_SCOPED_COPY_PROPOSAL' };
  if (relative.includes('/bionic/')) return { type: 'bionic-owned', currentWriter: 'Bionic', targetWriter: 'Bionic', action: 'KEEP_IN_PLACE' };
  if (['qq-message-receipts.json', 'qq-send-ledger.json'].includes(name)) return { type: 'qq-receipts', currentWriter: 'QQ Runtime (Legacy or Connector, exclusive)', targetWriter: 'QQ Connector', action: 'KEEP_IN_PLACE' };
  if (relative === 'config.json') return { type: 'config-references', currentWriter: 'Core/User', targetWriter: 'Core/User;Connector references only', action: 'KEEP_IN_PLACE' };
  if (/token|secret|credential|cookie|provider-keys/i.test(relative)) return { type: 'secret-reference-only', currentWriter: 'User/Core', targetWriter: 'User/Core', action: 'NEVER_IMPORT' };
  if (['tasks', 'memory', 'capability', 'channel', 'continuity', 'desktop-chat', 'settings', 'integrations', 'extensions'].some(domain => relative.startsWith(`state/${domain}/`)) || relative === 'state/workspaces.json') return { type: 'core-authoritative', currentWriter: 'Core', targetWriter: 'Core', action: 'KEEP_IN_PLACE' };
  return { type: 'compatibility-or-unknown', currentWriter: 'UNVERIFIED', targetWriter: 'UNVERIFIED', action: 'PRESERVE_REVIEW_REQUIRED' };
}
const publicSegments = new Set(['state', 'roles', 'channel', 'qq', 'bionic', 'config.json', 'tasks', 'tasks.json', 'memory', 'memories.json',
  'workspaces.json', 'capability', 'approval', 'approvals.json', 'dispatches.json', 'delivery.json', 'continuity', 'integrations', 'plugins.json',
  'settings.json', 'mode.json', 'qq-message-receipts.json', 'qq-send-ledger.json', ...SOCIAL_FILES]);
const safeRelative = relative => relative.split('/').map(segment => publicSegments.has(segment) ? segment : `[entry-${digest(segment).slice(0, 12)}]`).join('/');
const locationRef = root => `${path.parse(path.resolve(root)).root}[root-${digest(path.resolve(root)).slice(0, 16)}]`;
export function dryRunMigration({ roots = discoverMigrationRoots(), bindings = {}, dshHomes, ownershipDir = path.join(os.tmpdir(), 'cetamesh-qq-ownership') } = {}) {
  const files = [], entries = [], blockers = [], references = [], homes = new Set(dshHomes ?? []);
  const block = (code, sourceId) => blockers.push({ code, sourceId });
  let totalBytes = 0;
  const rootReports = [];
  for (const input of roots) {
    const root = path.resolve(input.dataRoot), rootId = digest(root).slice(0, 16), accountId = bindings[root];
    const rootReport = { rootId, location: locationRef(root), provenance: input.provenance ?? 'explicit', exists: fs.existsSync(root), accountMapping: accountId ? `account-${digest(accountId).slice(0, 12)}` : 'UNVERIFIED' };
    rootReports.push(rootReport);
    if (!rootReport.exists) continue;
    try { assertNoLinks(root); }
    catch (error) { block(error.code, rootId); continue; }
    for (const name of ['.core-owner.lock', '.core-owner.lock.reclaim', 'bridge.lock']) if (fs.existsSync(path.join(root, 'state', name))) block('WRITER_STOP_UNCONFIRMED', rootId);
    const inspect = (file, relative) => {
      const fileId = digest(`${root}/${relative}`), type = classification(relative);
      if (relative.startsWith('roles/') && fs.existsSync(path.join(root, '.git'))) {
        Object.assign(type, { type: 'source-role-asset', currentWriter: 'Repository/User (shared source layout)', targetWriter: 'User', action: 'PRESERVE_ASSET_REVIEW_REQUIRED' });
      }
      try {
        assertNoLinks(file);
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw migrationError('UNSUPPORTED_FILE_TYPE');
        if (/\.(log|jsonl)$/i.test(relative)) {
          entries.push({ fileId, rootId, source: safeRelative(relative), bytes: stat.size, hash: 'NOT_READ_DIAGNOSTIC',
            type: 'diagnostic-retain', action: 'KEEP_IN_PLACE', currentWriter: 'Originating runtime', targetWriter: 'Originating runtime',
            version: 'OPAQUE_BYTES', records: null });
          return;
        }
        if (stat.size > 128 * 1024 * 1024 || (totalBytes += stat.size) > 512 * 1024 * 1024) throw migrationError('INVENTORY_LIMIT');
        const bytes = fs.readFileSync(file), hash = digest(bytes);
        const after = fs.statSync(file);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) throw migrationError('SOURCE_CHANGED_DURING_SCAN');
        let schema = { valid: true, version: 'OPAQUE_BYTES', records: 1, pending: 0, identityHash: hash };
        let value;
        if (relative.endsWith('.json') && type.type !== 'secret-reference-only') {
          try { value = readJsonFile(file); schema = inspectSchema(relative, value); }
          catch (error) { void error; schema = { valid: false, version: 'UNVERIFIED', records: null, pending: null, identityHash: null }; }
          if (digest(fs.readFileSync(file)) !== hash) throw migrationError('SOURCE_CHANGED_DURING_SCAN');
        }
        const metadata = { mode: stat.mode & 0o777, readonly: (stat.mode & 0o200) === 0, uid: stat.uid, gid: stat.gid, nativeAcl: process.platform === 'win32' ? 'REQUIRED_BEFORE_REAL_APPLY' : 'POSIX_MODE' };
        const row = { fileId, rootId, source: safeRelative(relative), bytes: bytes.length, hash, ...type, ...schema, permissions: metadata, target: null };
        if (!schema.valid) block('SCHEMA_INCOMPATIBLE', fileId);
        if (type.type === 'bionic-legacy' && metadata.readonly) block('READ_ONLY_SOURCE_REQUIRES_REVIEW', fileId);
        if (schema.pending > 0) block('OUTCOME_UNKNOWN', fileId);
        if (accountId && value?.records?.some(row => row.accountId && String(row.accountId) !== accountId)) block('ACCOUNT_MAPPING_CONFLICT', fileId);
        if (accountId && relative.endsWith('qq-message-receipts.json') && [...(value?.ids ?? []), ...(value?.pending ?? [])].some(key => String(key).split(':')[0] !== accountId)) block('ACCOUNT_MAPPING_CONFLICT', fileId);
        if (type.type === 'bionic-legacy') {
          if (!/^[1-9]\d{0,19}$/.test(String(accountId ?? ''))) block('ACCOUNT_ATTRIBUTION_REQUIRED', fileId);
          else {
            row.target = `channel/qq/account-${digest(accountId).slice(0, 12)}/bionic/${relative}`;
            const destination = path.join(root, 'channel', 'qq', accountId, 'bionic', relative);
            assertNoLinks(destination);
            if (fs.existsSync(destination)) block('TARGET_EXISTS_REQUIRES_REVIEW', fileId);
          }
        }
        if (relative === 'config.json' && value) {
          const home = value.dsh?.homeDir;
          if (typeof home === 'string' && path.isAbsolute(home)) homes.add(home);
          references.push({ rootId, qqAccountReferencePresent: Boolean(value.snowluma?.accountId || value.qq?.accountId),
            ownerReferencePresent: Boolean(value.ownerQQ), gatewayConfigured: Boolean(value.snowluma?.wsUrl || value.snowluma?.httpUrl),
            gatewayHash: digest({ ws: value.snowluma?.wsUrl ?? null, http: value.snowluma?.httpUrl ?? null }),
            codingPresetReference: value.dsh?.codingPreset ? digest(value.dsh.codingPreset) : null,
            socialPresetReference: value.dsh?.socialPreset ? digest(value.dsh.socialPreset) : null });
        }
        files.push({ file, root, relative, accountId, row }); entries.push(row);
      } catch (error) { block(['UNSAFE_LINK', 'INVENTORY_LIMIT', 'SOURCE_CHANGED_DURING_SCAN'].includes(error.code) ? error.code : 'UNREADABLE_SOURCE', fileId); }
    };
    let visited = 0;
    const walk = (directory, relative, depth = 0) => {
      try {
        if (depth > 32 || ++visited > 20000) throw migrationError('INVENTORY_LIMIT');
        assertNoLinks(directory);
        for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= 10000) { block('INVENTORY_LIMIT', rootId); return; }
          const rel = `${relative}/${item.name}`, file = path.join(directory, item.name);
          if (item.isSymbolicLink()) { block('UNSAFE_LINK', digest(file)); continue; }
          if (item.isDirectory()) walk(file, rel, depth + 1);
          else inspect(file, rel);
        }
      } catch (error) { block(['UNSAFE_LINK', 'INVENTORY_LIMIT'].includes(error.code) ? error.code : 'UNREADABLE_DIRECTORY', rootId); }
    };
    if (fs.existsSync(path.join(root, 'config.json'))) inspect(path.join(root, 'config.json'), 'config.json');
    for (const dir of ['state', 'roles', 'channel']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir), dir);
    if (files.some(item => item.root === root && item.row.type === 'bionic-legacy') && !fs.existsSync(path.join(root, 'state', 'qq-message-receipts.json'))) block('CURSOR_MISSING', rootId);
  }
  // External DSH remains user owned. Hash files only; no repair, merge, or preset install.
  const presetReports = [];
  for (const home of [...homes].sort()) {
    try {
      assertNoLinks(home);
      const presetRoot = path.join(home, '.agent-presets');
      if (!fs.existsSync(presetRoot)) { presetReports.push({ location: locationRef(home), status: 'NOT_INSTALLED' }); continue; }
      assertNoLinks(presetRoot);
      const manifestFile = path.join(home, '.whalebridge-integration.json');
      assertNoLinks(manifestFile);
      const ownership = readJsonFile(manifestFile, { missing: null });
      for (const item of fs.readdirSync(presetRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(presetRoot, item.name, 'agent.cordis.yml'); assertNoLinks(file);
        if (!fs.existsSync(file)) continue;
        const tree = crypto.createHash('sha256'); let fileCount = 0;
        const walkPreset = (directory, base = '') => {
          assertNoLinks(directory);
          for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const entry = path.join(directory, child.name), relative = base ? `${base}/${child.name}` : child.name;
            assertNoLinks(entry);
            if (++fileCount > 1000) throw migrationError('INVENTORY_LIMIT');
            if (child.isDirectory()) walkPreset(entry, relative);
            else {
              if (fs.statSync(entry).size > 8 * 1024 * 1024) throw migrationError('INVENTORY_LIMIT');
              tree.update(relative); tree.update('\0'); tree.update(fs.readFileSync(entry)); tree.update('\0');
            }
          }
        };
        walkPreset(path.dirname(file)); const treeHash = tree.digest('hex');
        const bytes = fs.readFileSync(file);
        const compatibility = inspectDshPreset({ id: item.name, dshHome: home });
        const installed = ownership?.presets?.[item.name];
        presetReports.push({ location: locationRef(presetRoot), presetIdHash: digest(item.name), hash: digest(bytes), treeHash, fileCount, bytes: bytes.length,
          owner: 'USER', action: 'NEVER_OVERWRITE', protocolCompatible: 'UNVERIFIED', personaPrefixCompatible: compatibility.compatible,
          attribution: installed?.owned === true ? installed.hash === treeHash ? 'APP_OWNED_UNCHANGED' : 'USER_MODIFIED' : 'UNVERIFIED',
          compatibilityReason: compatibility.reason, ownershipManifest: fs.existsSync(path.join(home, '.whalebridge-integration.json')) ? 'PRESENT_NOT_A_WRITE_GRANT' : 'MISSING' });
      }
    } catch (error) { block(error.code === 'UNSAFE_LINK' ? error.code : 'DSH_READ_UNAVAILABLE', digest(home)); }
  }
  // Do not reclaim even a dead or malformed lease during a read-only inventory.
  try {
    if (fs.existsSync(ownershipDir)) {
      assertNoLinks(ownershipDir);
      const leases = fs.readdirSync(ownershipDir).filter(name => /\.lock(?:\.recovering)?$/.test(name));
      if (leases.length) block('ACCOUNT_LEASE_REVIEW_REQUIRED', digest(ownershipDir));
    }
  } catch (error) { void error; block('ACCOUNT_LEASE_UNREADABLE', digest(ownershipDir)); }
  entries.sort((a, b) => a.fileId.localeCompare(b.fileId)); blockers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const assigned = Object.values(bindings);
  if (new Set(assigned).size !== assigned.length) block('MULTIPLE_SOURCES_SAME_ACCOUNT', 'mapping');
  const report = { schemaVersion: 1, mode: 'READ_ONLY', realDataExecution: 'REAL_DATA_NOT_AUTHORIZED',
    status: blockers.length ? 'BLOCKED' : 'DRY_RUN_PASS', roots: rootReports, entries, references, presets: presetReports,
    blockers, backup: { estimatedBytes: entries.filter(row => row.type === 'bionic-legacy').reduce((n, row) => n + row.bytes * 3, 0),
      writableDestination: 'NOT_PROBED_READ_ONLY', nativePermissions: 'MUST_CAPTURE_BEFORE_REAL_APPLY', productionPointerResolver: 'NOT_INSTALLED' } };
  const result = { report: { ...report, planId: digest(report) } };
  const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  freeze(result.report);
  privatePlans.set(result, { files, options: { roots, bindings, dshHomes: [...homes], ownershipDir } });
  return result;
}
export function migrationInputs(plan) {
  const input = privatePlans.get(plan); if (!input) throw migrationError('UNTRUSTED_PLAN'); return input;
}
