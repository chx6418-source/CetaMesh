import crypto from 'node:crypto';
import {verifyDelegationContract} from '../task/delegation-verification.js';
import { memoryError } from './types.js';
import { redactText } from '../logging/redact.js';

const TAG = 'core-task-working-v1';
const NOTE = 'Core Task working state v1';
function clip(value, max) {
  const text = redactText(String(value ?? '')).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

/** Core-only projection into the existing Memory Runtime. No new agent capability is granted. */
export function createTaskWorkingMemoryRecorder({ memoryRuntime, taskRuntime, enabled, resolveWorkspace=()=>null, onChanged = () => {} }) {
  function principal(taskId) {
    return { kind: 'agent', id: 'task:' + taskId, grants: { scopes: ['task:' + taskId], types: ['working'] } };
  }
  function contentOf(task) {
    const value = { schemaVersion: 1, taskId: task.id, taskRevision: task.rev, scope: 'task:' + task.id,
      goal: clip(task.goal, 600),
      ownerReference: (task.ownerContext?.entries ?? []).slice(-4).map(row => ({messageId:row.id,text:clip(row.text,220)})),
      checkpoint: { summary: clip(task.checkpoint?.summary, 700), nextAction: clip(task.checkpoint?.nextAction, 500),
        verification: 'Checkpoint reference; model-authored reports are not independently verified.' },
      evidence: (task.executionEvidence ?? []).slice(-8).map(row => ({ eventId: clip(row.eventId,160),
        provider: clip(row.provider,80), sessionId:clip(row.sessionId,128),
        runId:row.runId ? clip(row.runId,240) : null, phase:clip(row.phase ?? 'unknown',40), capability:clip(row.capability,100),
        status:clip(row.status,40), exitCode:row.exitCode ?? null })),
      omittedEvidence: Math.max(0,(task.executionEvidence?.length ?? 0)-8) };
    while(JSON.stringify(value).length>3900 && value.evidence.length) {value.evidence.shift();value.omittedEvidence++;}
    while(JSON.stringify(value).length>3900 && value.ownerReference.length) value.ownerReference.shift();
    return JSON.stringify(value);
  }
  function record(taskId) {
    if(enabled() !== true) return {skipped:true};
    const task = taskRuntime.get({id:taskId}).task;
    if(!task || !['queued','running','paused','waiting','blocked'].includes(task.status)) return {skipped:true};
    const actor=principal(task.id), scope='task:'+task.id;
    const linked=(task.memoryRefs ?? []).find(ref=>ref.note===NOTE && ref.scope===scope && ref.type==='working');
    let existing=null;
    if(linked) {
      try {existing=memoryRuntime.get({principal:actor,id:linked.memoryId}).memory;}
      catch(error) { if(error?.code==='MEMORY_NOT_FOUND') return {deleted:true}; throw error; }
    } else {
      // Recover a create-before-link crash without duplicating the projection.
      const rows=memoryRuntime.list({principal:actor,scope,types:['working'],query:TAG,limit:200}).memories;
      existing=rows.find(row=>row.source==='system' && row.tags?.includes(TAG)) ?? null;
    }
    const content=contentOf(task);
    let memory=existing;
    if(!memory) memory=memoryRuntime.create({principal:actor,type:'working',scope,source:'system',tags:[TAG],content});
    else if(memory.content!==content) memory=memoryRuntime.update({principal:actor,id:memory.id,expectedRev:memory.rev,content});
    memory=memory.memory ?? memory;
    if(!linked) {
      const current=taskRuntime.get({id:task.id}).task;
      taskRuntime.linkMemory({id:task.id,expectedRev:current.rev,memoryId:memory.id,scope,type:'working',note:NOTE});
    }
    if(!existing || existing.content!==content || !linked) onChanged({taskId:task.id,memoryId:memory.id});
    return {memoryId:memory.id};
  }
  function references(taskId) {
    if (enabled() !== true) return [];
    const task = taskRuntime.get({ id: taskId }).task;
    const taskScope = 'task:' + taskId;
    const refs = (task.memoryRefs ?? []).filter(ref => ref.memoryId && ref.scope && ref.type
      && ((ref.scope === taskScope && ref.type === 'working') || ref.authorizedBy === 'user:desktop'));
    const readOnlyRefs = {};
    for (const ref of refs) {
      if (ref.scope !== taskScope) (readOnlyRefs[ref.scope] ??= []).push(ref.memoryId);
    }
    const actor = { kind: 'agent', id: taskScope, grants: {
      scopes: [taskScope, ...Object.keys(readOnlyRefs)],
      types: [...new Set(['working', ...refs.map(ref => ref.type)])], readOnlyRefs
    } };
    const excerpts = [];
    for (const ref of refs) {
      if (excerpts.some(row => row.memoryId === ref.memoryId)) continue;
      let memory;
      try { memory = memoryRuntime.get({ principal: actor, id: ref.memoryId }).memory; }
      catch (error) {
        if (error?.code === 'MEMORY_NOT_FOUND') continue; // Deleted references stay deleted.
        throw error;
      }
      if (memory.scope !== ref.scope || memory.type !== ref.type) {
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED', 'Linked Memory metadata changed; review authorization before Handoff');
      }
      if(memoryRuntime.assess({principal:actor,id:memory.id}).status!=='current'){
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED','Linked Memory fact is expired or conflicted; review it before transferring execution');
      }
      // The packet contract retains at most 4000 characters per record. Reject
      // larger linked facts before source stop rather than silently truncating.
      if (memory.content.length > 4000) {
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED', 'Linked Memory exceeds the per-record Handoff budget; review before switching Agents');
      }
      excerpts.push({ memoryId: memory.id, scope: memory.scope, type: memory.type,
        revision: memory.rev, source: memory.source, content: memory.content, provenance: memory.provenance,
        createdAt: memory.createdAt, updatedAt: memory.updatedAt, sourceRefs: (memory.sourceRefs ?? []).slice(0, 4) });
      if (excerpts.length > 4 || JSON.stringify(excerpts).length > 12000) {
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED', 'Linked Memory exceeds the Handoff context budget; review and reduce linked references before switching Agents');
      }
    }
    return excerpts;
  }
  async function recordVerifiedOutcome(taskId){
    if(enabled()!==true)return {skipped:true};
    const task=taskRuntime.get({id:taskId}).task;
    if(task.status!=='completed'||task.delegationProposal?.state!=='verified'||task.delegationProposal.verification?.status!=='VERIFIED'||!task.delegationPolicy?.verification)return {skipped:true};
    const workspace=await resolveWorkspace(task.workspaceId);
    // Completion detaches the live Agent; use only the persisted, already verified return identity for this historical read-only check.
    const verifierSession=task.delegationProposal.returnSessionId;
    if(!verifierSession||task.executionObservation?.sessionId!==verifierSession||task.executionObservation?.runId!==task.delegationProposal.verificationRunId)return {skipped:true};
    const verification=await verifyDelegationContract({...task,currentAgent:{provider:'cetamesh',sessionId:verifierSession}},{workspaceRoot:workspace?.id===task.workspaceId?workspace.root:null});
    if(verification.status!=='VERIFIED')return {skipped:true,code:'OUTCOME_EVIDENCE_CHANGED'};
    const scope='workspace:'+task.workspaceId;
    const actor={kind:'agent',id:'core-verified-task',grants:{scopes:[scope],types:['workspace']}};
    const prior=memoryRuntime.listCandidates({principal:actor}).candidates.find(row=>row.proposedBy==='agent:core-verified-task'
      &&row.sourceRefs.some(ref=>ref.kind==='task'&&ref.id===task.id&&ref.scope===scope));
    // A user's rejection or correction remains authoritative on repeated delivery/restart.
    if(prior)return {candidate:prior,duplicate:true};
    const proof={schemaVersion:1,kind:'historical-machine-result',taskId:task.id,workspaceId:task.workspaceId,
      ownerGoal:clip(task.goal,600),verifiedAt:task.updatedAt,verification:{kind:'code-tests',status:'VERIFIED',
        evidenceCount:verification.evidenceEventIds.length,evidenceSha256:crypto.createHash('sha256').update(JSON.stringify(verification.evidenceEventIds)).digest('hex'),
        evidenceEventIds:verification.evidenceEventIds.slice(0,8)},
      meaning:'这是此任务完成时的机器验收记录，不代表项目当前状态或模型推断已被用户确认为事实；完整证据保留在原 Task。'};
    const result=memoryRuntime.proposeCandidate({principal:actor,type:'workspace',scope,content:JSON.stringify(proof),
      reason:'Core 独立验收通过后的项目历史候选；由用户决定是否保存。',sourceRefs:[{kind:'task',id:task.id,scope},{kind:'workspace',id:task.workspaceId,scope}]});
    onChanged({taskId:task.id,candidateId:result.candidate?.id});return result;
  }
  return {record,references,recordVerifiedOutcome};
}

