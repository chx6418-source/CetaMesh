// Read-only observations, never an authorization or writer-stop protocol.
// Do not construct Domain stores here: their constructors may perform recovery writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile } from '../storage/json-file.js';
import { assertNoLinks } from './inventory.js';
import { digest } from './schemas.js';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function pidPresence(pid) {
  try { process.kill(pid, 0); return 'EXISTS'; }
  catch (error) { return error.code === 'ESRCH' ? 'ABSENT' : 'UNVERIFIED'; }
}
function lockObservation(file, probePid) {
  try {
    assertNoLinks(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024) return { state: 'INVALID_LOCK' };
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8').trim();
    const match = (path.basename(file) === 'bridge.lock' ? /^([1-9]\d*)$/ : /^([1-9]\d*):[a-f0-9]{32}$/).exec(text);
    const pid = match ? Number(match[1]) : null;
    return { state: pid && Number.isSafeInteger(pid) ? 'PRESENT' : 'INVALID_LOCK',
      hash: digest(bytes), pidAlias: pid ? digest(String(pid)) : null,
      pidStatus: pid && Number.isSafeInteger(pid) ? probePid(pid) : 'UNVERIFIED',
      processStartIdentity: 'UNVERIFIED', stopAcknowledged: false };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'NOT_FOUND_NOT_STOP_PROOF' : error.code === 'UNSAFE_LINK' ? 'UNSAFE_LINK' : 'UNREADABLE' };
  }
}
export function inspectRuntimePreflight({ dataRoot, ownershipDir = path.join(os.tmpdir(), 'cetamesh-qq-ownership'), probePid = pidPresence } = {}) {
  const root = path.resolve(dataRoot);
  const report = { version: 1, mode: 'READ_ONLY', rootId: digest(root).slice(0, 16),
    status: 'MIGRATION_BLOCKED', realDataExecution: 'REAL_DATA_NOT_AUTHORIZED', stopConfirmed: false,
    effectiveProcessStateDir: 'UNVERIFIED_CANDIDATE_ROOT_ONLY',
    ipc: 'NOT_RUN_ENVIRONMENT_AUTHENTICATED_READ_ONLY_PROBE_REQUIRED',
    activeQqConsumers: 'UNVERIFIED_NOT_INFERRED_FROM_PID', authoritativeWriter: 'UNVERIFIED',
    inMemoryApprovalsAndExternalImports: 'UNVERIFIED', locks: [], stores: {}, leases: [] };
  const observe = (relative, inspect) => {
    const file = path.join(root, 'state', relative);
    try {
      assertNoLinks(file);
      if (fs.statSync(file).size > 32 * 1024 * 1024) return { state: 'UNREADABLE_OR_TOO_LARGE' };
      const before = fs.readFileSync(file);
      const value = readJsonFile(file, { maxBytes: 32 * 1024 * 1024 });
      if (digest(before) !== digest(fs.readFileSync(file))) return { state: 'SOURCE_CHANGED' };
      const unresolved = inspect(value);
      return { state: unresolved === null ? 'SCHEMA_UNVERIFIED' : 'OBSERVED_NOT_COMPLETENESS_PROOF', hash: digest(before), unresolved };
    } catch (error) {
      return { state: ['ENOENT', 'MISSING'].includes(error.code) ? 'NOT_FOUND_NOT_PROOF_OF_EMPTY' :
        ['CORRUPT', 'UNSAFE_LINK'].includes(error.code) ? error.code : 'UNREADABLE_OR_TOO_LARGE' };
    }
  };
  report.locks = ['.core-owner.lock', '.core-owner.lock.reclaim', 'bridge.lock'].map(name => ({ name, ...lockObservation(path.join(root, 'state', name), probePid) }));
  report.stores.send = observe('qq-send-ledger.json', v => v?.version === 1 && Array.isArray(v.records) && v.records.every(r => object(r) && ['sent', 'acknowledged', 'outcome-unknown'].includes(r.status))
    ? v.records.filter(r => r.status === 'outcome-unknown').length : null);
  report.stores.delivery = observe('channel/delivery.json', v => {
    if (v?.version !== 1 || !Array.isArray(v.events) || !object(v.consumers)) return null;
    let count = 0;
    for (const row of Object.values(v.consumers)) {
      if (!object(row) || !Number.isSafeInteger(row.cursor) || !object(row.deliveries)) return null;
      for (const status of Object.values(row.deliveries)) {
        if (!['in-flight', 'outcome-unknown', 'acknowledged', 'denied', 'retry-authorized'].includes(status)) return null;
        if (['in-flight', 'outcome-unknown', 'retry-authorized'].includes(status)) count++;
      }
    }
    return count;
  });
  report.stores.approval = observe('capability/approvals.json', v => Array.isArray(v) && v.every(r => object(r) && ['pending', 'approved', 'consumed', 'rejected', 'cancelled', 'revoked', 'expired'].includes(r.status))
    ? v.filter(r => ['pending', 'approved'].includes(r.status)).length : null);
  report.stores.requests = observe('capability/requests.json', v => object(v) && Object.values(v).every(r => object(r) && ['in-flight', 'completed', 'failed'].includes(r.status))
    ? Object.values(v).filter(r => r.status === 'in-flight').length : null);
  report.stores.migration = observe('../migration-journal.json', v => object(v) && typeof v.state === 'string'
    ? ['COMMITTED', 'ROLLED_BACK'].includes(v.state) ? 0 : 1 : null);
  try {
    assertNoLinks(ownershipDir);
    const names = fs.readdirSync(ownershipDir);
    report.leaseScope = 'CURRENT_TEMP_OR_EXPLICIT_DIRECTORY_ONLY';
    if (names.length > 1000) report.leaseScope = 'LIMIT_EXCEEDED';
    else report.leases = names.filter(name => /\.lock(?:\.recovering)?$/.test(name)).map(name => ({ fileAlias: digest(name), ...lockObservation(path.join(ownershipDir, name), probePid) }));
  } catch (error) {
    report.leaseScope = error.code === 'ENOENT' ? 'NOT_FOUND_IN_THIS_TEMP_ONLY' : 'UNVERIFIED';
  }
  return report;
}
