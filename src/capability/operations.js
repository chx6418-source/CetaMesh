import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from '../storage/json-file.js';
import { capabilityError } from './types.js';

// Capability-domain operation journal; no new execution authority or transport.
export function createApprovalOperations({ stateDir, execute, getApproval, cancelApproval = () => {}, notify = () => {} }) {
  const file = stateDir ? path.join(stateDir, 'capability', 'operations.json') : null;
  const rows = file ? readJsonFile(file, { missing: {} }) : {};
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw capabilityError('OPERATION_STORE_CORRUPT', 'Invalid operation journal');
  const active = new Map();
  const save = () => { if (file) writeJsonAtomic(file, rows); };
  let recovered = false;
  for (const row of Object.values(rows)) if (['accepted', 'running', 'waiting'].includes(row.status)) {
    row.status = 'unknown'; row.code = 'CORE_RESTART_RECONCILIATION_REQUIRED'; recovered = true;
  }
  if (recovered) save();
  const view = row => ({ operationId: row.operationId, approvalId: row.approvalId, status: row.status,
    decision: row.approve ? 'approved' : 'rejected', code: row.code ?? null,
    turnResumed: row.result?.turnResumed === true, resumePending: row.result?.resumePending === true,
    ...(row.result?.resumeError ? { resumeError: row.result.resumeError } : {}) });
  function reconcileContinuations() {
    // Only a trusted resume's exact successor approval in the same Task/Session/turn
    // can settle a waiting predecessor. Restart-unknown or unrelated work stays fenced.
    for (let pass = 0; pass < Object.keys(rows).length; pass++) {
      let changed = false;
      for (const row of Object.values(rows)) {
        if (row.status !== 'waiting' || !row.resumeApprovalId || !row.turnId || !row.sessionId || !row.taskId) continue;
        const next = rows[`approval:${row.resumeApprovalId}`];
        if (!next || next.status !== 'completed' || next.result?.resumePending || next.result?.turnResumed !== true
          || next.taskId !== row.taskId || next.sessionId !== row.sessionId || next.turnId !== row.turnId) continue;
        row.status = 'completed'; row.result.resumePending = false; changed = true;
      }
      if (!changed) break;
    }
  }
  function changed(row) { reconcileContinuations(); save(); notify(view(row)); }
  function get(id) {
    const row = Object.hasOwn(rows, id) ? rows[id] : null;
    if (!row) throw capabilityError('OPERATION_NOT_FOUND', 'Operation not found');
    return view(row);
  }
  function submit({ id, approve }) {
    const operationId = `approval:${id}`;
    if (Object.hasOwn(rows, operationId)) {
      if (rows[operationId].approve !== approve) throw capabilityError('REQUEST_ID_CONFLICT', 'Approval decision changed');
      return get(operationId);
    }
    const approval = getApproval(id);
    if (approval.status !== 'pending') throw capabilityError('APPROVAL_ALREADY_DECIDED', id);
    if (Object.keys(rows).length >= 1000) throw capabilityError('OPERATION_CAPACITY', 'Review operation history before accepting more work');
    const row = { operationId, approvalId: id, approve, status: 'accepted', createdAt: Date.now(),
      taskId: approval.request?.taskId ?? null, sessionId: approval.request?.origin?.sessionId ?? null,
      turnId: approval.request?.origin?.turnId ?? null };
    rows[operationId] = row;
    try { save(); } catch (error) { delete rows[operationId]; throw error; }
    const controller = new AbortController();
    const work = { controller, promise: null };
    active.set(operationId, work);
    work.promise = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw capabilityError('INVOKE_CANCELLED', 'Cancelled before dispatch');
      row.status = 'running'; changed(row);
      const result = await execute({ id, approve }, { signal: controller.signal });
      row.result = { status: result.status, turnResumed: result.turnResumed === true,
        resumePending: result.resumePending === true, taskResumed: result.taskResumed === true,
        ...(result.resumeError ? { resumeError: String(result.resumeError).slice(0,160) } : {}) };
      row.resumeApprovalId = typeof result.resumeApprovalId === 'string' ? result.resumeApprovalId.slice(0,240) : null;
      row.status = result.resumePending ? 'waiting' : result.resumeError ? 'failed' : 'completed';
    }).catch(error => {
      row.status = error.effectStatus === 'unknown' || error.code === 'INVOKE_CANCEL_UNCONFIRMED' ? 'unknown'
        : error.code === 'INVOKE_CANCELLED' ? 'cancelled' : 'failed';
      row.code = error.code ?? 'PROVIDER_ERROR';
    }).finally(() => {
      try { changed(row); } finally { active.delete(operationId); }
    });
    // A persistence failure cannot become an unhandled rejection or success.
    work.promise.catch(error => { row.status = 'unknown'; row.code = error.code ?? 'OPERATION_PERSIST_FAILED'; });
    return { ...get(operationId), status: 'accepted' };
  }
  return { submit, get, list: () => Object.values(rows).map(view),
    cancel(id) { const work = active.get(id); if (work) { if (rows[id].status === 'accepted') cancelApproval(rows[id].approvalId); work.controller.abort(); } return { ...get(id), cancelRequested: Boolean(work) }; },
    async cancelScope({ taskId, sessionId }) {
      const matches = [...active.entries()].filter(([id]) => (taskId && rows[id].taskId === taskId) || (sessionId && rows[id].sessionId === sessionId));
      for (const [id] of matches) this.cancel(id);
      await Promise.allSettled(matches.map(([,work]) => work.promise));
      return matches.map(([id]) => get(id));
    },
    async close() { for (const work of active.values()) work.controller.abort(); await Promise.allSettled([...active.values()].map(w => w.promise)); }
  };
}
