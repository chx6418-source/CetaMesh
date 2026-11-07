import crypto from 'node:crypto';
import {verifyDelegationContract} from '../task/delegation-verification.js';
import { memoryError } from './types.js';
import { redactText } from '../logging/redact.js';
import { verifyPostWriteCurrentSource } from '../task/outcome-verification.js';
import { detectExperienceSignals } from './experience-signals.js';
import { EXPERIENCE_LIMITS, experienceReferenceMetadata, matchesExperienceConditions } from './experience.js';

const TAG = 'core-task-working-v1';
const NOTE = 'Core Task working state v1';
function clip(value, max) {
  const text = redactText(String(value ?? '')).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

/** Core-only projection into the existing Memory Runtime. No new agent capability is granted. */
export function createTaskWorkingMemoryRecorder({ memoryRuntime, taskRuntime, enabled, resolveWorkspace=()=>null,
  resolveExperienceConditions = () => null, onChanged = () => {} }) {
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
  function references(taskId, { experienceContext } = {}) {
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
      const assessment=memoryRuntime.assess({principal:actor,id:memory.id,experienceContext});
      if(!memory.experience&&assessment.status!=='current'){
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED','Linked Memory fact is expired or conflicted; review it before transferring execution');
      }
      const content=memory.experience&&assessment.status!=='current'
        ? '条件参考正文未载入（'+assessment.status+'）；保留来源标识供核对，这不是当前工作区结论或执行指令。'
        : memory.content;
      // The packet contract retains at most 4000 characters per record. Reject
      // larger linked facts before source stop rather than silently truncating.
      if (content.length > 4000) {
        throw memoryError('HANDOFF_MEMORY_CONTEXT_REVIEW_REQUIRED', 'Linked Memory exceeds the per-record Handoff budget; review before switching Agents');
      }
      excerpts.push({ memoryId: memory.id, scope: memory.scope, type: memory.type,
        revision: memory.rev, source: memory.source, content, provenance: memory.provenance,
        createdAt: memory.createdAt, updatedAt: memory.updatedAt, sourceRefs: (memory.sourceRefs ?? []).slice(0, 4),
        ...(memory.experience ? { experience: experienceReferenceMetadata(memory.experience) } : {}) });
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
    const actor={kind:'agent',id:'core-verified-task',grants:{scopes:[scope],types:['workspace','skill']}};
    const prior=memoryRuntime.listCandidates({principal:actor}).candidates.find(row=>(row.proposedBy==='agent:core-verified-task'
      &&row.sourceRefs.some(ref=>ref.kind==='task'&&ref.id===task.id&&ref.scope===scope))
      ||(row.experience?.trigger.taskId===task.id&&row.experience.evidence.some(receipt=>receipt.status==='pass'&&verification.evidenceEventIds.includes(receipt.eventId))));
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

  function currentIdentity(task, trigger) {
    const observed = task.executionObservation;
    return Boolean(trigger && typeof trigger.turnId === 'string' && trigger.turnId.length > 0 && trigger.turnId.length <= 240
      && observed && ['awaiting-review', 'failed'].includes(observed.state)
      && observed.provider === trigger.provider && observed.sessionId === trigger.sessionId && observed.runId === trigger.runId
      && task.currentAgent?.provider === trigger.provider && task.currentAgent?.sessionId === trigger.sessionId && task.status === 'running');
  }

  function verifyExperiencePass(task, config, workspace, { allowFailure = false } = {}) {
    const review = code => ({ status: 'NEEDS_REVIEW', evidenceEventIds: [], code });
    const observed = task.executionObservation;
    if (observed?.state !== 'awaiting-review' || config?.enabled !== true || config.maxRunsPerTurn === 0
      || task.executionEvidence?.some(row => ['unknown', 'outcome-unknown', 'cancel-unconfirmed'].includes(row.status))) return review('EXPERIENCE_SOURCE_UNVERIFIED');
    const sameRun = row => row.provider === observed.provider && row.sessionId === observed.sessionId && row.runId === observed.runId && row.phase === 'user';
    const evidence = task.executionEvidence ?? [];
    const index = evidence.findLastIndex(row => row.source === 'core-test' && row.capability === 'test.run');
    const test = evidence[index];
    if (!test || !sameRun(test) || test.status !== 'completed' || !Number.isSafeInteger(test.exitCode) || (!allowFailure && test.exitCode !== 0) || !test.operationId
      || !/^[a-f0-9]{64}$/.test(test.resultSha256 ?? '')) return review('EXPERIENCE_SOURCE_UNVERIFIED');
    if (!test.postWriteVerification) return review('EXPERIENCE_SOURCE_UNVERIFIED');
    if (test.postWriteVerification.configDigest !== config.configDigest || test.tool !== config.tool) return review('EXPERIENCE_CONFIG_CHANGED');
    if (evidence.slice(index + 1).some(row => (row.status === 'completed' && ['filesystem.write', 'git.commit', 'workspace.apply', 'git.apply', 'git.stage'].includes(row.capability))
      || (row.capability === 'test.run' && (!sameRun(row) || row.status !== 'completed' || row.exitCode !== test.exitCode)))) return review('EXPERIENCE_SOURCE_CHANGED');
    // Task owns the machine-only source verifier. It aggregates retained legacy
    // per-check and current cumulative bindings, including earlier ignored
    // writes; this cannot be weaker than Task's independent source proof.
    const sourceProof = verifyPostWriteCurrentSource(task, test, { workspaceRoot: workspace.root, postWriteVerification: config });
    if (sourceProof.status !== 'VERIFIED') return review(sourceProof.reasons[0] ?? 'EXPERIENCE_SOURCE_UNVERIFIED');
    return { status: 'VERIFIED', evidenceEventIds: [test.eventId], receipt: { eventId: test.eventId, taskId: task.id,
      workspaceId: task.workspaceId, provider: test.provider, sessionId: test.sessionId, runId: test.runId,
      operationId: test.operationId, status: test.exitCode === 0 ? 'pass' : 'fail', resultSha256: test.resultSha256, at: test.at } };
  }

  /** Trusted settled-turn callback. The caller supplies identities, never prose,
   * receipt bodies, source labels or permissions. All evidence is read from Task. */
  async function recordExperienceCandidate({ taskId, trigger } = {}) {
    if (enabled() !== true) return { skipped: true, code: 'MEMORY_DISABLED' };
    const task = taskRuntime.get({ id: taskId }).task;
    if (!task?.workspaceId || !currentIdentity(task, trigger)) return { skipped: true, code: 'EXPERIENCE_SOURCE_STALE' };
    const workspace = await resolveWorkspace(task.workspaceId);
    if (!workspace || workspace.id !== task.workspaceId || typeof workspace.root !== 'string') return { skipped: true, code: 'EXPERIENCE_WORKSPACE_UNAVAILABLE' };
    let config = null;
    try { config = await resolveExperienceConditions({ workspaceId: task.workspaceId }); }
    catch { /* Explicit Owner statements remain usable when a verifier is unavailable. */ }
    if (taskRuntime.get({ id: taskId }).task.rev !== task.rev || enabled() !== true) return { skipped: true, code: 'EXPERIENCE_SOURCE_STALE' };
    const plainConditions = { workspaceId: task.workspaceId, platform: process.platform, tool: null, configDigest: null, sourceDigest: null };
    const conditions = config?.enabled === true && config.maxRunsPerTurn > 0 && /^[a-f0-9]{64}$/.test(config.configDigest ?? '') && /^[a-f0-9]{64}$/.test(config.sourceDigest ?? '')
      ? { ...plainConditions, tool: config.tool, configDigest: config.configDigest, sourceDigest: config.sourceDigest } : plainConditions;
    const currentRunEvidence = (task.executionEvidence ?? []).filter(row => row.provider === trigger.provider && row.sessionId === trigger.sessionId && row.runId === trigger.runId);
    const priorRunEvidence = (task.executionEvidence ?? []).filter(row => !currentRunEvidence.includes(row));
    const ownerTexts = task.ownerContext?.sessionId === (trigger.ownerContextSessionId ?? trigger.sessionId) && trigger.ownerMessageId
      ? (task.ownerContext.entries ?? []).filter(row => row.id === trigger.ownerMessageId) : [];
    const currentVerification = verifyExperiencePass(task, config, workspace, { allowFailure: true });
    const signals = detectExperienceSignals({ taskId: task.id, workspaceId: task.workspaceId, turnId: trigger.turnId,
      ownerTexts, currentRunEvidence, priorRunEvidence, conditions: currentVerification.status === 'VERIFIED' ? conditions : plainConditions, currentVerification });
    if (!signals.length) return { skipped: true, code: currentVerification.code ?? 'NO_EXPERIENCE_SIGNAL' };
    const signal = signals[0];
    const scope = 'workspace:' + task.workspaceId;
    if (signal.kind === 'failure-recovery') {
      const actor = { kind: 'agent', id: 'core-task-experience', grants: { scopes: [scope], types: ['workspace', 'skill'] } };
      const prior = memoryRuntime.listCandidates({ principal: actor }).candidates.find(row => {
        if (row.proposedBy !== 'agent:core-verified-task' || !row.sourceRefs.some(ref => ref.kind === 'task' && ref.id === task.id && ref.scope === scope)) return false;
        try { return JSON.parse(row.content).verification?.evidenceEventIds?.some(id => signal.evidence.some(receipt => receipt.status === 'pass' && receipt.eventId === id)); }
        catch { return false; }
      });
      if (prior) return { candidate: prior, duplicate: true };
    }
    if (enabled() !== true || taskRuntime.get({ id: taskId }).task.rev !== task.rev) return { skipped: true, code: 'EXPERIENCE_SOURCE_STALE' };
    const result = memoryRuntime.proposeExperienceCandidate({ type: 'skill', scope, content: signal.content,
      experience: { schemaVersion: 1, trigger: { id: signal.triggerId, kind: signal.kind, taskId: task.id, workspaceId: task.workspaceId,
        turnId: trigger.turnId, provider: trigger.provider, sessionId: trigger.sessionId, runId: trigger.runId, ownerMessageId: signal.ownerMessageId },
        conditions: signal.kind.startsWith('owner-') ? plainConditions : conditions, evidence: signal.evidence } });
    if (result.candidate && !result.duplicate) onChanged({ taskId: task.id, candidateId: result.candidate.id, status: 'experience-pending' });
    return result;
  }

  /** A bounded list of references actually recalled by Core, not model-supplied
   * IDs. Later machine observations are recorded without causal attribution. */
  async function recordExperienceOutcomes({ taskId, trigger, memoryIds = [] } = {}) {
    if (enabled() !== true) return { skipped: true, code: 'MEMORY_DISABLED' };
    if (!Array.isArray(memoryIds) || memoryIds.length > EXPERIENCE_LIMITS.recall || memoryIds.some(id => typeof id !== 'string' || !id || id.length > 128)) {
      throw memoryError('INVALID_PARAMS', 'Experience observations require at most three bounded recalled Memory references');
    }
    if (!memoryIds.length) return { results: [] };
    const task = taskRuntime.get({ id: taskId }).task;
    if (!task?.workspaceId || !currentIdentity(task, trigger)) return { skipped: true, code: 'EXPERIENCE_SOURCE_STALE' };
    const workspace = await resolveWorkspace(task.workspaceId);
    if (!workspace || workspace.id !== task.workspaceId || typeof workspace.root !== 'string') return { skipped: true, code: 'EXPERIENCE_WORKSPACE_UNAVAILABLE' };
    let config;
    try { config = await resolveExperienceConditions({ workspaceId: task.workspaceId }); }
    catch { return { skipped: true, code: 'EXPERIENCE_SOURCE_UNVERIFIED' }; }
    if (enabled() !== true || taskRuntime.get({ id: taskId }).task.rev !== task.rev) return { skipped: true, code: 'EXPERIENCE_SOURCE_STALE' };
    const verification = verifyExperiencePass(task, config, workspace, { allowFailure: true });
    if (verification.status !== 'VERIFIED') return { skipped: true, code: verification.code };
    const context = { workspaceId: task.workspaceId, platform: process.platform, tool: config.tool, configDigest: config.configDigest, sourceDigest: config.sourceDigest };
    const actor = { kind: 'agent', id: 'core-task-experience', grants: { scopes: ['workspace:' + task.workspaceId], types: ['skill'] } };
    const results = [];
    for (const id of new Set(memoryIds)) {
      try {
        const row = memoryRuntime.get({ principal: actor, id }).memory;
        if (!row.experience || !matchesExperienceConditions(row.experience.conditions, context)) {
          results.push({ id, recorded: false, code: 'EXPERIENCE_CONDITIONS_CHANGED' }); continue;
        }
        const updated = memoryRuntime.recordExperienceOutcome({ id: row.id, expectedRev: row.rev, evidence: verification.receipt, experienceContext: context });
        const recorded = updated.observation?.recorded === true;
        results.push({ id, recorded, ...(updated.observation?.code ? { code: updated.observation.code } : {}) });
        if (recorded) onChanged({ taskId: task.id, memoryId: id, status: 'experience-observed' });
      } catch (error) { results.push({ id, recorded: false, code: error?.code ?? 'STORE_WRITE_FAILED' }); }
    }
    return { results };
  }
  return {record,references,recordVerifiedOutcome,recordExperienceCandidate,recordExperienceOutcomes};
}

