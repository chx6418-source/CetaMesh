import crypto from 'node:crypto';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { agentProviderError as fault } from './agent-provider.js';

const MAX_SESSIONS = 4096;
const STATES = new Set(['idle', 'running', 'stopped', 'closed', 'unknown']);
const PROOFS = new Set(['never-started', 'process-tree-exit', 'supervisor-close']);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\r\n\0]/.test(value);
const nullableText = value => value === null || text(value);

function validRow(row) {
  return row && ['sessionId','taskId','workspaceId','snapshotId'].every(key => text(row[key]))
    && ['exec','app-server'].includes(row.transport) && nullableText(row.attemptId)
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
export function createCodexSessionLifecycle({ stateDir, now = Date.now } = {}) {
  const file = stateDir ? path.join(stateDir, 'agent', 'codex-session-lifecycle.json') : null;
  let memory = {version:1,sessions:[]};
  function load() {
    let data;
    try { data = file ? readJsonFile(file,{missing:{version:1,sessions:[]},maxBytes:8*1024*1024}) : memory; }
    catch { throw fault('CODEX_LIFECYCLE_STORE_INVALID','Codex lifecycle evidence is unavailable; execution remains blocked'); }
    if (!data || data.version !== 1 || !Array.isArray(data.sessions) || data.sessions.length > MAX_SESSIONS
      || !data.sessions.every(validRow) || new Set(data.sessions.map(row=>row.sessionId)).size !== data.sessions.length) {
      throw fault('CODEX_LIFECYCLE_STORE_INVALID','Codex lifecycle evidence is invalid; original records retained');
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
    if (!validRow(row)) throw fault('CODEX_LIFECYCLE_CONFLICT','Codex lifecycle transition is invalid');
    save(data); return structuredClone(row);
  }
  return Object.freeze({
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
      if(!validRow(row))throw fault('CODEX_LIFECYCLE_CONFLICT','Invalid Codex lifecycle binding');
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
