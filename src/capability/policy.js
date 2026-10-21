import {PERMISSIONS,FORBIDDEN_PERMISSIONS,RISK_RANK,capabilityError} from './types.js';
import {requestFingerprint} from './approval.js';
export function createCapabilityPolicy({resolveWorkspace,resolveTask,resolveGrants,isTaskHandoff=()=>false}={}){
 return {authorize(request,entry){
  const permission=entry.permission??entry.id;
  if(entry.descriptorVersion&&request.approvalId&&request.approvalBinding?.descriptorVersion!==entry.descriptorVersion)
   throw capabilityError('APPROVAL_EXPIRED','Reconfirm the current capability version before execution');
  if(request.approvalBinding?.descriptorVersion!==undefined
    &&request.approvalBinding.descriptorVersion!==entry.descriptorVersion)
   throw capabilityError('APPROVAL_EXPIRED','Capability version changed while approval was pending');
  if(FORBIDDEN_PERMISSIONS.includes(permission))throw capabilityError('PERMISSION_FORBIDDEN',permission);
  if(!PERMISSIONS.includes(permission))throw capabilityError('UNKNOWN_PERMISSION',permission);
  const actor=request.actor;
  if(actor.kind==='external'||actor.kind==='device')throw capabilityError('PERMISSION_DENIED','External/device callers require a trusted restricted adapter');
  if(actor.kind!=='owner' && !actor.grants?.capabilities?.includes(entry.id))throw capabilityError('PERMISSION_DENIED',entry.id+' not granted');
  // Reject a foreign Task before consulting its grants or any Task/Workspace state.
  if(actor.kind==='agent'&&(!request.taskId||!actor.grants?.taskIds?.includes(request.taskId)))
   throw capabilityError('TASK_NOT_AUTHORIZED','Assigned task required');
  const currentGrants=actor.kind==='agent'&&resolveGrants?resolveGrants(request.taskId):actor.grants;
  if(actor.kind==='agent'&&resolveGrants&&requestFingerprint({grants:currentGrants})!==requestFingerprint({grants:actor.grants}))
   throw capabilityError('PERMISSION_DENIED','Task grants changed; request must be authorized again');
  if(request.taskId){
   if(actor.kind==='agent'&&isTaskHandoff(request.taskId))throw capabilityError('TASK_HANDOFF_IN_FLIGHT','Task Handoff has not committed the target Agent authority');
   const task=resolveTask?.(request.taskId);
   if(!task)throw capabilityError('TASK_NOT_AUTHORIZED','Assigned Task required');
   if((task.workspaceId??null)!==(request.workspaceId??null))throw capabilityError('WORKSPACE_RECONCILIATION_REQUIRED','Task and execution Workspace do not match');
   if(['completed','failed','cancelled'].includes(task.status))throw capabilityError('TASK_NOT_AUTHORIZED','Terminal Task cannot execute capabilities');
   if(actor.kind==='agent'&&['paused','blocked'].includes(task.status))throw capabilityError('TASK_NOT_AUTHORIZED','Paused or interrupted Task cannot execute Agent capabilities');
   if(request.assignment && (task.currentAgent?.provider!==request.assignment.provider || task.currentAgent?.sessionId!==request.assignment.sessionId))
    throw capabilityError('AGENT_ASSIGNMENT_EXPIRED','Agent Session no longer owns this Task');
   if(request.approvalBinding && (request.approvalBinding.version!==2
     || (task.authorizationRevision??task.rev)!==request.approvalBinding.authorizationRevision
     || task.workspaceId!==request.approvalBinding.workspaceId
     || requestFingerprint({grants:currentGrants})!==request.approvalBinding.grantsFingerprint
     || task.currentAgent?.provider!==request.approvalBinding.provider
     || task.currentAgent?.sessionId!==request.approvalBinding.sessionId))
    throw capabilityError('APPROVAL_EXPIRED','Task or Agent assignment changed while approval was pending');
  }
  if(actor.kind==='agent'){
   if(!request.taskId || !actor.grants?.taskIds?.includes(request.taskId))throw capabilityError('TASK_NOT_AUTHORIZED','Assigned task required');
   const task=resolveTask?.(request.taskId);
   if(!task)throw capabilityError('TASK_NOT_AUTHORIZED','Assigned Task required');
  }
  if(entry.workspace){
   if(!request.workspaceId)throw capabilityError('WORKSPACE_REQUIRED','Explicit workspace required');
   if(actor.kind!=='owner'&&!actor.grants?.workspaceIds?.includes(request.workspaceId))throw capabilityError('WORKSPACE_NOT_AUTHORIZED',request.workspaceId);
   if(!resolveWorkspace?.(request.workspaceId))throw capabilityError('WORKSPACE_NOT_FOUND',request.workspaceId);
  }
  if(actor.kind==='extension'&&entry.id==='network'){
   const url=new URL(String(request.input.url??''));
   if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw capabilityError('NETWORK_SCOPE_DENIED','Invalid network URL');
   if(!actor.grants?.hosts?.some(h=>url.host.toLowerCase()===String(h).toLowerCase()))throw capabilityError('NETWORK_SCOPE_DENIED','Host not declared');
  }
  if(actor.kind==='extension'&&entry.id.startsWith('filesystem.')){
   const rel=String(request.input.path??'').replaceAll('\\','/');
   if(rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some(part=>part==='..'||part==='.'))throw capabilityError('FILESYSTEM_SCOPE_DENIED','Relative declared paths only');
   if(!actor.grants?.paths?.some(p=>rel===p||rel.startsWith(p.replace(/\/$/,'')+'/')))throw capabilityError('FILESYSTEM_SCOPE_DENIED','Path not declared');
  }
  const risk=entry.risk??'low';
  if(!Object.hasOwn(RISK_RANK,risk))throw capabilityError('INVALID_RISK',risk);
  // Extension review grants are supplied by the installed registry, never by its code.
  // Exact declared scopes are still checked above on every call.
  const reviewed = actor.kind==='extension' && actor.grants?.approvedCapabilities?.includes(entry.id);
  const task=request.taskId?resolveTask?.(request.taskId):null;
  return {allowed:true,risk,approvalRequired:RISK_RANK[risk]>=RISK_RANK.high&&!reviewed,
   approvalBinding:task?{version:2,...(entry.descriptorVersion?{descriptorVersion:entry.descriptorVersion}:{}),authorizationRevision:task.authorizationRevision??task.rev,
    workspaceId:task.workspaceId,grantsFingerprint:requestFingerprint({grants:currentGrants}),
    provider:task.currentAgent?.provider,sessionId:task.currentAgent?.sessionId}:
    entry.descriptorVersion?{version:2,descriptorVersion:entry.descriptorVersion}:null};
 }};
}
