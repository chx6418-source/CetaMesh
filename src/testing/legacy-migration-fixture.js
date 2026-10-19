// M5-A test prototype only. No production entrypoint, resolver or real apply API.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from '../storage/json-file.js';
import { dryRunMigration, migrationInputs, migrationError, assertNoLinks } from '../migration/inventory.js';
import { digest, inspectSchema } from '../migration/schemas.js';
import { acquireStateOwner } from '../app/state-owner.js';
import { acquireQqOwnership } from '../channel/qq/ownership.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const prefix = 'cetamesh-m5-fixture-';
const allocatedRoots = new Map();
const aclEnvironment = file => ({ ...process.env, PSModulePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'), CETAMESH_M5_ACL_FILE: file });
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw migrationError('REAL_DATA_NOT_AUTHORIZED');
  assertNoLinks(file);
  return path.resolve(file);
}
function permission(file) {
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform !== 'win32') return { mode, sddl: null };
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; (Get-Acl -LiteralPath $env:CETAMESH_M5_ACL_FILE).Sddl"],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, env: aclEnvironment(file) });
  if (result.status !== 0 || !result.stdout.trim()) throw migrationError('PERMISSION_METADATA_UNAVAILABLE');
  return { mode, sddl: result.stdout.trim() };
}
function restorePermission(file, saved) {
  fs.chmodSync(file, saved.mode);
  if (saved.sddl) {
    const script = "$ErrorActionPreference='Stop'; $acl=Get-Acl -LiteralPath $env:CETAMESH_M5_ACL_FILE; $acl.SetSecurityDescriptorSddlForm($env:CETAMESH_M5_SDDL); Set-Acl -LiteralPath $env:CETAMESH_M5_ACL_FILE -AclObject $acl";
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: { ...aclEnvironment(file), CETAMESH_M5_SDDL: saved.sddl } });
    if (result.status !== 0) throw migrationError('PERMISSION_RESTORE_FAILED');
  }
}
export function createMigrationFixture({ accounts, volume = 'temporary' } = {}) {
  if (!Array.isArray(accounts) || !accounts.length || accounts.some(item => !/^[1-9]\d{0,19}$/.test(item.accountId)) || new Set(accounts.map(item => item.accountId)).size !== accounts.length) throw migrationError('FIXTURE_INPUT_INVALID');
  const parent = volume === 'workspace' ? repository : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, prefix));
  const nonce = crypto.randomBytes(32).toString('hex');
  allocatedRoots.set(root, nonce);
  const manifest = { version: 1, purpose: 'SYNTHETIC_FIXTURE_ONLY', nonce, root, accounts: accounts.map((item, index) => ({ accountId: item.accountId, relative: `sources/account-${index}` })) };
  writeJsonAtomic(path.join(root, '.m5-fixture.json'), manifest);
  writeTextAtomic(path.join(root, 'runtime', 'connector-installed'), 'synthetic-component');
  accounts.forEach((account, index) => {
    for (const [relative, value] of Object.entries(account.files)) {
      const file = inside(root, path.join(root, manifest.accounts[index].relative, relative));
      if (typeof value === 'string') writeTextAtomic(file, value); else writeJsonAtomic(file, value);
    }
  });
  return openFixtureForChild({ root, nonce });
}
export function openFixtureForChild({ root, nonce }) {
  // Even a caller who guesses the permit cannot point this test helper at a real StateDir.
  const absolute = path.resolve(root);
  const childScript = path.join(repository, 'scripts', 'migration-fixture-child.mjs');
  const childPermit = process.argv[1] && path.resolve(process.argv[1]) === childScript && process.env.CETAMESH_M5_FIXTURE_PERMIT === digest(`${absolute}:${nonce}`);
  if (allocatedRoots.get(absolute) !== nonce && !childPermit) throw migrationError('REAL_DATA_NOT_AUTHORIZED');
  if (!/^cetamesh-m5-fixture-[A-Za-z0-9]+$/.test(path.basename(absolute)) || ![path.resolve(os.tmpdir()), repository].includes(path.dirname(absolute))) throw migrationError('REAL_DATA_NOT_AUTHORIZED');
  assertNoLinks(absolute);
  assertNoLinks(path.join(absolute, '.m5-fixture.json'));
  const manifest = readJsonFile(path.join(absolute, '.m5-fixture.json'));
  if (manifest.purpose !== 'SYNTHETIC_FIXTURE_ONLY' || manifest.root !== absolute || manifest.nonce !== nonce || !/^[a-f0-9]{64}$/.test(nonce)) throw migrationError('REAL_DATA_NOT_AUTHORIZED');
  const rootIdentity = fs.statSync(absolute);
  const safe = file => {
    assertNoLinks(absolute);
    const current = fs.statSync(absolute);
    if (current.ino !== rootIdentity.ino || current.dev !== rootIdentity.dev) throw migrationError('FIXTURE_ROOT_CHANGED');
    return inside(absolute, file);
  };
  const sources = manifest.accounts.map(item => safe(path.join(absolute, item.relative)));
  const bindings = Object.fromEntries(sources.map((source, index) => [source, manifest.accounts[index].accountId]));
  const leasesDir = safe(path.join(absolute, 'leases'));
  const journalFile = safe(path.join(absolute, 'migration-journal.json'));
  const pointerFile = safe(path.join(absolute, 'active-version.json'));
  let stopped = false, foreignLease = false;
  const plan = () => dryRunMigration({ roots: sources.map(dataRoot => ({ dataRoot, provenance: 'isolated-fixture' })), bindings, ownershipDir: leasesDir, dshHomes: [] });
  const approve = p => ({ actor: 'owner', planId: p.report.planId, proof: digest(`${nonce}:${p.report.planId}`) });
  const requireApproval = (p, approval) => {
    if (!approval || approval.actor !== 'owner' || approval.planId !== p || approval.proof !== digest(`${nonce}:${p}`)) throw migrationError('OWNER_APPROVAL_REQUIRED');
  };
  const authority = () => readJsonFile(safe(pointerFile), { missing: null });
  const expectedPointer = journal => ({ version: 1, planId: journal.planId, directory: journal.versionDirectory, legacyMode: 'READ_ONLY' });
  const requirePointer = journal => { if (digest(authority()) !== digest(expectedPointer(journal))) throw migrationError('AUTHORITY_UNCERTAIN'); };
  const selected = p => migrationInputs(p).files.filter(file => file.row.type === 'bionic-legacy');
  const verifyInventory = p => {
    const ownFiles = new Set(sources.map(source => digest(`${source}/state/.core-owner.lock`)));
    const refreshed = plan().report;
    if (digest(refreshed.entries.filter(row => !ownFiles.has(row.fileId))) !== digest(p.report.entries) || digest(refreshed.presets) !== digest(p.report.presets)) throw migrationError('STALE_PLAN');
  };
  const verifyOriginals = p => migrationInputs(p).files.every(item => digest(fs.readFileSync(safe(item.file))) === item.row.hash);
  const withLeases = callback => {
    if (!stopped) throw migrationError('WRITER_STOP_UNCONFIRMED');
    if (sources.some(source => fs.existsSync(safe(path.join(source, 'state', 'bridge.lock'))))) throw migrationError('WRITER_STOP_UNCONFIRMED');
    if (foreignLease) throw migrationError('ACCOUNT_LEASE_BUSY');
    const acquired = [];
    try {
      acquired.push(acquireStateOwner(safe(path.join(absolute, 'coordinator'))));
      for (const source of sources) acquired.push(acquireStateOwner(safe(path.join(source, 'state'))));
      for (const item of manifest.accounts) acquired.push(acquireQqOwnership('account', item.accountId, leasesDir));
      const owners = acquired.filter(lease => !lease.valid).map(lease => ({ file: lease.file, hash: digest(fs.readFileSync(lease.file)) }));
      return callback(() => {
        if (acquired.some(lease => lease.valid && !lease.valid())) throw migrationError('ACCOUNT_LEASE_BUSY');
        if (owners.some(owner => digest(fs.readFileSync(safe(owner.file))) !== owner.hash)) throw migrationError('DATA_LEASE_BUSY');
      });
    } finally { for (const lease of acquired.reverse()) lease.release(); }
  };
  const validateStored = journal => {
    if (journal?.version !== 1 || !/^[a-f0-9]{64}$/.test(journal.planId) || journal.versionDirectory !== `versions/${journal.planId}` ||
        !Array.isArray(journal.expectedTargets) || !journal.expectedTargets.length || !Array.isArray(journal.files) || !Array.isArray(journal.protectedFiles)) throw migrationError('JOURNAL_UNVERIFIED');
    const full = authority()?.planId === journal.planId || ['BACKED_UP', 'STAGED', 'VERIFIED', 'COMMITTED', 'ROLLING_BACK'].includes(journal.state);
    if (full && journal.files.length !== journal.expectedTargets.length || new Set(journal.files.map(row => row.target)).size !== journal.files.length) throw migrationError('JOURNAL_UNVERIFIED');
    for (const row of journal.files ?? []) {
      if (!journal.expectedTargets.some(expected => expected.source === row.source && expected.hash === row.hash && expected.target === row.target && expected.records === row.records && expected.identityHash === row.identityHash)) throw migrationError('JOURNAL_UNVERIFIED');
      const backup = safe(path.join(absolute, row.backup));
      const backupHash = digest(fs.readFileSync(backup));
      const observed = permission(backup);
      const expected = row.backupPermissions;
      if (backupHash !== row.hash || digest(observed) !== digest(expected)) {
        // Only report booleans and hashes: never echo Windows SDDL, paths or content.
        const mismatch = {
          content: backupHash !== row.hash,
          mode: observed.mode !== expected?.mode,
          acl: observed.sddl !== expected?.sddl,
          observedAclDigest: observed.sddl ? digest(observed.sddl).slice(0, 12) : null,
          expectedAclDigest: expected?.sddl ? digest(expected.sddl).slice(0, 12) : null
        };
        throw Object.assign(migrationError('BACKUP_UNVERIFIED'), { message: 'BACKUP_UNVERIFIED: ' + JSON.stringify(mismatch) });
      }
    }
  };
  const verifyTarget = journal => {
    for (const row of journal.files) {
      const file = safe(path.join(absolute, journal.versionDirectory, row.target));
      const expected = row.targetPermissions ?? row.permissions; // Legacy journal: retain fail-closed verification.
      if (digest(fs.readFileSync(file)) !== row.hash || digest(permission(file)) !== digest(expected)) {
        throw migrationError('TARGET_UNVERIFIED');
      }
      if (row.target.endsWith('.json')) {
        const schema = inspectSchema(row.target.replace(/^accounts\/[1-9]\d*\//, ''), readJsonFile(file));
        if (!schema.valid || schema.records !== row.records || schema.identityHash !== row.identityHash) throw migrationError('TARGET_IDENTITIES_UNVERIFIED');
      }
    }
  };
  function apply(p, { approval, failure, crashAt, beforeVerify, onCrash = () => { throw migrationError('SIMULATED_CRASH'); } } = {}) {
    requireApproval(p.report.planId, approval);
    return withLeases(checkLease => {
      const saved = readJsonFile(safe(journalFile), { missing: null });
      if (saved?.state === 'COMMITTED' && saved.planId === p.report.planId) {
        if (!verifyOriginals(p)) throw migrationError('STALE_PLAN');
        verifyInventory(p);
        requirePointer(saved); verifyTarget(saved); validateStored(saved); checkLease();
        return { status: 'FIXTURE_MIGRATION_PASS', duplicate: true };
      }
      if (saved && saved.state !== 'ROLLED_BACK') throw migrationError('RECOVERY_REQUIRED');
      // Exclude only leases this fixture transaction just acquired, never foreign data.
      verifyInventory(p);
      if (p.report.status !== 'DRY_RUN_PASS') throw migrationError('PLAN_BLOCKED');
      const rows = selected(p);
      if (!rows.length) throw migrationError('NOTHING_TO_MIGRATE');
      for (const row of migrationInputs(p).files) safe(row.file);
      const versionDirectory = `versions/${p.report.planId}`;
      const versionRoot = safe(path.join(absolute, versionDirectory));
      if (authority() || fs.existsSync(versionRoot)) throw migrationError('TARGET_CONFLICT');
      const free = fs.statfsSync(absolute); const required = Math.max(1024 * 1024, p.report.backup.estimatedBytes);
      if (failure === 'ENOSPC' || BigInt(free.bavail) * BigInt(free.bsize) < BigInt(required)) throw migrationError('ENOSPC');
      const journal = { version: 1, planId: p.report.planId, state: 'PLANNED', versionDirectory, before: authority(), files: [], evidence: [],
        expectedTargets: rows.map(row => ({ source: path.relative(absolute, row.file), hash: row.row.hash, target: `accounts/${row.accountId}/${row.relative}`, records: row.row.records, identityHash: row.row.identityHash })),
        protectedFiles: migrationInputs(p).files.map(row => ({ source: path.relative(absolute, row.file), hash: row.row.hash })) };
      const phase = state => {
        checkLease(); journal.state = state; journal.evidence.push(state); writeJsonAtomic(safe(journalFile), journal);
        if (crashAt === state) onCrash();
      };
      phase('PLANNED');
      try {
        for (const [index, row] of rows.entries()) {
          const original = safe(row.file), permissions = permission(original);
          const backup = `backups/${p.report.planId}/${index}.snapshot`;
          const destination = safe(path.join(absolute, backup));
          if (fs.existsSync(destination)) throw migrationError('BACKUP_EXISTS');
          writeTextAtomic(destination, fs.readFileSync(original, 'utf8')); restorePermission(destination, permissions);
          fs.chmodSync(destination, permissions.mode & ~0o222);
          // Record the observed backup ACL after the read-only transition, not
          // the source SDDL: Windows can normalize inherited ACE metadata.
          // Original source permissions remain separately recorded for recovery.
          const backupPermissions = permission(destination);
          if ((backupPermissions.mode & 0o222) !== 0) throw migrationError('PERMISSION_RESTORE_FAILED');
          journal.files.push({ source: path.relative(absolute, original), backup, hash: row.row.hash, records: row.row.records,
            identityHash: row.row.identityHash, permissions, backupPermissions, target: `accounts/${row.accountId}/${row.relative}` });
          writeJsonAtomic(safe(journalFile), journal);
        }
        validateStored(journal); phase('BACKED_UP');
        if (failure === 'EACCES') throw migrationError('EACCES');
        for (const row of journal.files) {
          const target = safe(path.join(absolute, versionDirectory, row.target));
          writeTextAtomic(target, fs.readFileSync(safe(path.join(absolute, row.backup)), 'utf8'));
          restorePermission(target, row.permissions);
          // Capture the observed target ACL after restoration. Keep the original
          // source ACL separately; Windows normalizes inherited ACE metadata.
          row.targetPermissions = permission(target);
          if (row.targetPermissions.mode !== row.permissions.mode) throw migrationError('PERMISSION_RESTORE_FAILED');
          if (failure === 'WRITE_FAILED') throw migrationError('WRITE_FAILED');
        }
        phase('STAGED'); beforeVerify?.(); verifyTarget(journal); validateStored(journal);
        if (!verifyOriginals(p)) throw migrationError('STALE_PLAN');
        for (const row of journal.files) if (digest(permission(safe(path.join(absolute, row.source)))) !== digest(row.permissions)) throw migrationError('SOURCE_PERMISSION_CHANGED');
        verifyInventory(p);
        phase('VERIFIED');
        checkLease();
        writeJsonAtomic(safe(pointerFile), expectedPointer(journal));
        if (crashAt === 'AFTER_POINTER') onCrash();
        phase('COMMITTED');
        return { status: 'FIXTURE_MIGRATION_PASS', records: journal.files.reduce((n, row) => n + row.records, 0) };
      } catch (error) {
        if (error.code === 'SIMULATED_CRASH') throw error;
        checkLease();
        journal.state = 'NEEDS_REVIEW'; journal.failure = error.code ?? 'WRITE_FAILED'; writeJsonAtomic(safe(journalFile), journal);
        throw error;
      }
    });
  }
  function recover({ approval, beforeSwitch } = {}) {
    requireApproval(approval?.planId, approval);
    return withLeases(checkLease => {
      const journal = readJsonFile(safe(journalFile), { missing: null });
      requireApproval(journal?.planId ?? approval?.planId, approval);
      if (!journal) return { state: 'ROLLED_BACK', reason: 'NOT_STARTED' };
      validateStored(journal);
      for (const row of journal.protectedFiles) if (digest(fs.readFileSync(safe(path.join(absolute, row.source)))) !== row.hash) throw migrationError('SOURCE_CHANGED_RECOVERY_BLOCKED');
      const active = authority();
      if (active?.planId === journal.planId) {
        requirePointer(journal); verifyTarget(journal); journal.state = 'COMMITTED';
      } else if ((journal.state !== 'COMMITTED' && !active) || journal.state === 'ROLLING_BACK' && digest(active) === digest(journal.before)) journal.state = 'ROLLED_BACK';
      else throw migrationError('AUTHORITY_UNCERTAIN');
      beforeSwitch?.(); checkLease();
      writeJsonAtomic(safe(journalFile), journal);
      return { state: journal.state };
    });
  }
  function rollback({ approval, beforeSwitch } = {}) {
    requireApproval(approval?.planId, approval);
    return withLeases(checkLease => {
      const journal = readJsonFile(safe(journalFile)); requireApproval(journal.planId, approval);
      validateStored(journal);
      if (journal.state !== 'COMMITTED') throw migrationError('ROLLBACK_STATE_INVALID');
      requirePointer(journal);
      verifyTarget(journal);
      for (const row of journal.protectedFiles) if (digest(fs.readFileSync(safe(path.join(absolute, row.source)))) !== row.hash) throw migrationError('SOURCE_CHANGED_ROLLBACK_BLOCKED');
      beforeSwitch?.(); checkLease();
      journal.state = 'ROLLING_BACK'; writeJsonAtomic(safe(journalFile), journal);
      checkLease(); writeJsonAtomic(safe(pointerFile), journal.before);
      journal.state = 'ROLLED_BACK'; checkLease(); writeJsonAtomic(safe(journalFile), journal);
      return { status: 'ROLLBACK_PASS' };
    });
  }
  return { root: absolute, sources, plan, approve, apply, recover, rollback, authority, verifyOriginals,
    stopWriters() { stopped = true; }, setForeignLease(value) { foreignLease = value; },
    verifyBackups() { validateStored(readJsonFile(safe(journalFile))); return true; },
    createTargetConflict(p) { writeJsonAtomic(safe(path.join(absolute, 'versions', p.report.planId, 'conflict.json')), { conflict: true }); },
    legacyWrite(relative, value) { if (authority()?.legacyMode === 'READ_ONLY') throw migrationError('LEGACY_READ_ONLY'); if (stopped) throw migrationError('WRITER_STOPPED'); writeJsonAtomic(safe(path.join(sources[0], relative)), value); },
    readCommittedSocial() {
      const active = authority(); return Object.fromEntries(manifest.accounts.map(item => [item.accountId, readJsonFile(safe(path.join(absolute, active.directory, 'accounts', item.accountId, 'state', 'social-v2.json')))]));
    },
    uninstallConnector() { fs.unlinkSync(safe(path.join(absolute, 'runtime', 'connector-installed'))); return { dataRetained: fs.existsSync(safe(path.join(absolute, 'versions'))), syntheticComponentRemoved: true }; },
    crashInChild(p, crashAt) {
      const script = path.join(repository, 'scripts', 'migration-fixture-child.mjs');
      return spawnSync(process.execPath, [script, absolute, nonce, crashAt, p.report.planId], { encoding: 'utf8', windowsHide: true, timeout: 120000,
        env: { ...process.env, CETAMESH_M5_FIXTURE_PERMIT: digest(`${absolute}:${nonce}`) } });
    },
    dispose() {
      if (allocatedRoots.get(absolute) !== nonce) throw migrationError('REAL_DATA_NOT_AUTHORIZED');
      safe(absolute);
      // Only this allocated synthetic root is removed. Real sources cannot enter this helper.
      fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      allocatedRoots.delete(absolute);
    }
  };
}
