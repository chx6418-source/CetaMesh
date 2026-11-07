import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { agentProviderError } from './agent-provider.js';
import { probeCodexHostBoot } from './codex-process-supervisor.js';

const MAX_SESSIONS = 4096;
const STATES = new Set(['idle', 'running', 'stopped', 'closed', 'unknown']);
const PROOFS = new Set(['never-started', 'process-tree-exit', 'supervisor-close']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\r\n\0]/.test(value);
const nullableText = value => value === null || text(value);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validBoot = row => row?.kind === 'windows-kernel-boot-v1' && /^[a-f0-9]{64}$/.test(row.hostId)
  && Number.isSafeInteger(row.bootedAt) && row.bootedAt > 0
  && Number.isSafeInteger(row.eventRecordId) && row.eventRecordId > 0 && row.bootMode === 0 && row.bootType === 0;
const laterBoot = (before, after) => validBoot(before) && validBoot(after) && before.hostId === after.hostId
  && after.bootedAt > before.bootedAt && after.eventRecordId > before.eventRecordId;
const validWitness = row => row && ['id', 'taskId', 'workspaceId', 'sessionId'].every(key => text(row[key]))
  && Number.isSafeInteger(row.attachedAt) && row.attachedAt >= 0
  && /^[a-f0-9]{64}$/.test(row.scopeSha256) && validBoot(row.beforeBoot)
  && Number.isSafeInteger(row.observedAt) && row.observedAt >= 0
  && (row.afterBoot === null || laterBoot(row.beforeBoot, row.afterBoot));

function validRow(row) {
  return row && ['sessionId','taskId','workspaceId','snapshotId'].every(key => text(row[key]))
    && ['exec','app-server','dsh-sdk'].includes(row.transport) && nullableText(row.attemptId)
    && Number.isSafeInteger(row.generation) && row.generation >= 0 && nullableText(row.runId)
    && nullableText(row.turnId) && STATES.has(row.state) && ['retained','clean'].includes(row.staging)
    && Number.isSafeInteger(row.updatedAt) && row.updatedAt >= 0
    && (row.receipt === null || (['idle','stopped','closed'].includes(row.state)
      && text(row.receipt.id) && PROOFS.has(row.receipt.evidence)
      && row.receipt.generation === row.generation && row.receipt.runId === row.runId
      && Number.isSafeInteger(row.receipt.at) && row.receipt.at >= 0
      && (row.receipt.evidence !== 'never-started' || (row.transport === 'exec' && row.generation === 0 && row.runId === null))));
}

/** Core-only lifecycle evidence. Neither Task prose nor a missing process is a receipt. */
export function createCodexSessionLifecycle({ stateDir, now = Date.now, probeHostBoot = probeCodexHostBoot, provider = 'codex' } = {}) {
  const fault = (code, message) => agentProviderError(provider === 'dsh' ? code.replace(/^CODEX_/, 'DSH_') : code,
    provider === 'dsh' ? message.replace(/Codex/g, 'DSH') : message);
  // The owned DSH SDK adapter reuses these transitions and receipts in its own
  // namespace. Codex's file, row schema, defaults and transport checks are stable.
  if (!['codex', 'dsh'].includes(provider)) throw fault('AGENT_LIFECYCLE_PROVIDER_INVALID', 'Unsupported native lifecycle owner');
  const validOwnedRow = row => validRow(row) && (provider === 'dsh' ? row.transport === 'dsh-sdk' : row.transport !== 'dsh-sdk');
  const file = stateDir ? path.join(stateDir, 'agent', provider + '-session-lifecycle.json') : null;
  const creating = new Map();
  const stateIdentity = stateDir ? path.resolve(stateDir) : null;
  const scopeHash = binding => hash([stateIdentity, binding.taskId, binding.workspaceId, binding.sessionId, binding.attachedAt]);
  let failedBootProbeAt = null;
  function currentBoot() {
    // Optional OS evidence may be unavailable. A whole legacy Task list shares
    // one failed probe; later explicit checks can retry without blocking startup
    // once per historical Task.
    if (failedBootProbeAt !== null && now() - failedBootProbeAt < 30_000) return null;
    let value;
    try { value = probeHostBoot(); } catch { value = null; }
    if (!validBoot(value)) { failedBootProbeAt = now(); return null; }
    failedBootProbeAt = null;
    return value;
  }
  let memory = {version:1,sessions:[]};
  function load() {
    let data;
    try { data = file ? readJsonFile(file,{missing:{version:1,sessions:[]},maxBytes:8*1024*1024}) : memory; }
    catch { throw fault('CODEX_LIFECYCLE_STORE_INVALID','Codex lifecycle evidence is unavailable; execution remains blocked'); }
    if (!data || data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS
      || !data.sessions.every(validOwnedRow) || new Set(data.sessions.map(row=>row.sessionId)).size !== data.sessions.length) {
      throw fault('CODEX_LIFECYCLE_STORE_INVALID','Codex lifecycle evidence is invalid; original records retained');
    }
    if (data.legacyBootWitnesses !== undefined && (!Array.isArray(data.legacyBootWitnesses)
      || data.legacyBootWitnesses.length > MAX_SESSIONS || !data.legacyBootWitnesses.every(validWitness)
      || new Set(data.legacyBootWitnesses.map(row => row.sessionId)).size !== data.legacyBootWitnesses.length)) {
      throw fault('CODEX_LIFECYCLE_STORE_INVALID', 'Historical process recovery evidence is invalid; original records retained');
    }
    return structuredClone(data);
  }
  function save(data) {
    try { if (file) writeJsonAtomic(file,data); else memory = structuredClone(data); }
    catch { throw fault('CODEX_LIFECYCLE_WRITE_FAILED','Codex lifecycle evidence could not be persisted'); }
  }
  function receipt(row,evidence) { return {id:crypto.randomUUID(),evidence,generation:row.generation,runId:row.runId,at:now()}; }
  function mutate(binding,update) {
    const data=load(), row=data.sessions.find(item=>item.sessionId===binding.sessionId);
    if (!row) throw fault('CODEX_LIFECYCLE_MISSING','Codex session has no owned lifecycle evidence');
    for (const key of ['taskId','workspaceId','snapshotId','attemptId','transport']) {
      if (binding[key] !== undefined && binding[key] !== row[key]) throw fault('TASK_WORKSPACE_MISMATCH','Codex lifecycle binding mismatch');
    }
    if ((binding.generation !== undefined && binding.generation !== row.generation)
      || (binding.runId !== undefined && binding.runId !== row.runId)) throw fault('CODEX_LIFECYCLE_CONFLICT','Codex execution generation changed');
    update(row); row.updatedAt=now();
    if (!validOwnedRow(row)) throw fault('CODEX_LIFECYCLE_CONFLICT','Native lifecycle transition is invalid');
    save(data); return structuredClone(row);
  }
  return Object.freeze({
    // Creation fences cover awaits before a native lifecycle row can be written.
    // A pending witness is re-anchored before admission of any new execution.
    beginCreation({ taskId } = {}) {
      if (!text(taskId)) return () => {};
      const data = load(), pending = (data.legacyBootWitnesses ?? []).filter(row => row.taskId === taskId && !row.afterBoot);
      if (pending.length) {
        const boot = currentBoot();
        if (!validBoot(boot)) throw fault('CODEX_HOST_RESTART_UNVERIFIED', 'Cannot verify the host boundary for historical execution');
        for (const row of pending) { row.beforeBoot = boot; row.observedAt = now(); }
        save(data);
      }
      creating.set(taskId, (creating.get(taskId) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = creating.get(taskId) - 1;
        if (count) creating.set(taskId, count); else creating.delete(taskId);
      };
    },
    hasPendingCreation: taskId => (creating.get(taskId) ?? 0) > 0,
    observeLegacy(binding) {
      if (!file || !['taskId', 'workspaceId', 'sessionId'].every(key => text(binding?.[key]))
        || !Number.isSafeInteger(binding.attachedAt) || binding.attachedAt < 0 || creating.has(binding.taskId)) return null;
      const data = load();
      if (data.sessions.some(row => row.sessionId === binding.sessionId)) return null;
      const previous = data.legacyBootWitnesses?.find(row => row.sessionId === binding.sessionId);
      if (previous) return previous.scopeSha256 === scopeHash(binding) ? structuredClone(previous) : null;
      const boot = currentBoot();
      if (!validBoot(boot)) return null;
      const rows = data.legacyBootWitnesses ??= [];
      if (rows.length >= MAX_SESSIONS) return null; // Never evict pending ownership.
      const row = { ...binding, id: crypto.randomUUID(), scopeSha256: scopeHash(binding),
        beforeBoot: boot, afterBoot: null, observedAt: now() };
      rows.push(row); save(data);
      return structuredClone(row);
    },
    inspectLegacy(binding) {
      const unknown = code => ({ stopped: false, code: code ?? 'CODEX_HOST_RESTART_REQUIRED' });
      if (!file || creating.has(binding?.taskId)) return unknown('SESSION_EXECUTION_UNCONFIRMED');
      const data = load(), row = data.legacyBootWitnesses?.find(item => item.sessionId === binding?.sessionId);
      if (!row || row.scopeSha256 !== scopeHash(binding)) return unknown('CODEX_LEGACY_STOP_EVIDENCE_MISSING');
      const boot = currentBoot();
      if (!validBoot(boot) || boot.hostId !== row.beforeBoot.hostId) return unknown('CODEX_HOST_RESTART_UNVERIFIED');
      if (!row.afterBoot) {
        if (!laterBoot(row.beforeBoot, boot)) return unknown();
        row.afterBoot = boot; save(data);
      } else if (boot.bootedAt < row.afterBoot.bootedAt || boot.eventRecordId < row.afterBoot.eventRecordId) {
        return unknown('CODEX_HOST_RESTART_UNVERIFIED');
      }
      return { stopped: true, provider, taskId: row.taskId, workspaceId: row.workspaceId,
        sessionId: row.sessionId, evidence: 'process-tree-exit', source: 'windows-restart-witness',
        legacyExecutionIdentity: 'unknown', receiptId: row.id,
        // v1 reader compatibility only; this is NOT a native generation claim.
        // Native generation/run/transport/snapshot evidence was never retained.
        generation: 0, runId: null, transport: null, snapshotId: null, attemptId: null,
        witness: { id: row.id, taskId: row.taskId, workspaceId: row.workspaceId, sessionId: row.sessionId,
          scopeSha256: row.scopeSha256, attachedAt: row.attachedAt,
          beforeBoot: row.beforeBoot, afterBoot: row.afterBoot, observedAt: row.observedAt } };
    },
    legacyForTask: taskId => load().legacyBootWitnesses?.filter(row => row.taskId === taskId) ?? [],
    create(binding) {
      const data=load();
      if (data.sessions.some(row=>row.sessionId===binding.sessionId)) throw fault('SESSION_ID_COLLISION','Codex lifecycle already owns this session');
      // Eviction only forgets old stopped proof. It never releases active ownership.
      while (data.sessions.length >= MAX_SESSIONS) {
        const index=data.sessions.findIndex(row=>row.state==='closed');
        if(index<0)throw fault('AGENT_SESSION_LIMIT','Codex lifecycle capacity exhausted');
        data.sessions.splice(index,1);
      }
      const row={sessionId:binding.sessionId,taskId:binding.taskId,workspaceId:binding.workspaceId,
        transport:binding.transport,snapshotId:binding.snapshotId,attemptId:binding.attemptId??null,
        generation:0,runId:null,turnId:null,state:'idle',staging:'retained',receipt:null,updatedAt:now()};
      if(row.transport==='exec')row.receipt=receipt(row,'never-started');
      if(!validOwnedRow(row))throw fault('CODEX_LIFECYCLE_CONFLICT','Invalid native lifecycle binding');
      data.sessions.push(row);save(data);return structuredClone(row);
    },
    read(sessionId) { return load().sessions.find(row=>row.sessionId===sessionId)??null; },
    forTask(taskId) { return load().sessions.filter(row=>row.taskId===taskId); },
    begin(binding) {
      if(!text(binding.runId)||!text(binding.turnId))throw fault('CODEX_LIFECYCLE_CONFLICT','A fresh Core run identity is required');
      const {runId,turnId,...expected}=binding;
      return mutate(expected,row=>{
        if(!['idle','stopped'].includes(row.state))throw fault('CODEX_LIFECYCLE_CONFLICT','Previous native execution remains active or unknown');
        row.generation++;row.runId=runId;row.turnId=turnId;row.state='running';row.receipt=null;row.staging='retained';
      });
    },
    settle(binding) {
      if(!['process-tree-exit','supervisor-close'].includes(binding.proof))throw fault('CODEX_STOP_PROOF_INVALID','A trusted owned-process exit observation is required');
      return mutate(binding,row=>{row.state='stopped';row.staging=binding.staging??'retained';row.receipt=receipt(row,binding.proof);});
    },
    observeIdle(binding) { return mutate(binding,row=>{row.state='idle';row.receipt=null;}); },
    unknown(binding) { return mutate(binding,row=>{row.state='unknown';row.receipt=null;}); },
    close(binding) {
      return mutate(binding,row=>{
        if(!row.receipt)throw fault('CODEX_STOP_PROOF_INVALID','Session close requires a confirmed stop receipt');
        row.state='closed';row.staging=binding.staging??row.staging;
      });
    }
  });
}
