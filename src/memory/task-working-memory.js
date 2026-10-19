import { redactText } from '../logging/redact.js';

const TAG = 'core-task-working-v1';
const NOTE = 'Core Task working state v1';
function clip(value, max) {
  const text = redactText(String(value ?? '')).slice(0, max);
  return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
}

/** Core-only projection into the existing Memory Runtime. No new agent capability is granted. */
export function createTaskWorkingMemoryRecorder({ memoryRuntime, taskRuntime, enabled, onChanged = () => {} }) {
  function principal(taskId) {
    return { kind: 'agent', id: 'task:' + taskId, grants: { scopes: ['task:' + taskId], types: ['working'] } };
  }
  function contentOf(task) {
    const value = { schemaVersion: 1, taskId: task.id, scope: 'task:' + task.id,
      goal: clip(task.goal, 600),
      ownerReference: (task.ownerContext?.entries ?? []).slice(-4).map(row => ({messageId:row.id,text:clip(row.text,220)})),
      checkpoint: { summary: clip(task.checkpoint?.summary, 700), nextAction: clip(task.checkpoint?.nextAction, 500),
        verification: 'Checkpoint reference; model-authored reports are not independently verified.' },
      evidence: (task.executionEvidence ?? []).slice(-8).map(row => ({ eventId: clip(row.eventId,160),
        provider: clip(row.provider,80), sessionId:clip(row.sessionId,128), capability:clip(row.capability,100),
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
    if(enabled()!==true)return [];
    const task=taskRuntime.get({id:taskId}).task;
    const ref=(task.memoryRefs??[]).find(row=>row.note===NOTE && row.scope==='task:'+taskId && row.type==='working');
    if(!ref)return [];
    try {
      const memory=memoryRuntime.get({principal:principal(taskId),id:ref.memoryId}).memory;
      return [{memoryId:memory.id,scope:'task:'+taskId,content:memory.content}];
    } catch(error) {if(error?.code==='MEMORY_NOT_FOUND')return [];throw error;}
  }
  return {record,references};
}
