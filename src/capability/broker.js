import path from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {operationIdentity,retainedOperationResult} from './operation-identity.js';
import {normalizeRequest,capabilityError} from './types.js';import {createCapabilityRegistry} from './registry.js';import {createCapabilityPolicy} from './policy.js';import {createCapabilityApproval,requestFingerprint} from './approval.js';
export function createCapabilityBroker({registry=createCapabilityRegistry(),policy=createCapabilityPolicy(),approval=createCapabilityApproval(),audit=()=>{},stateDir=null}={}){
 const dispatchFile=stateDir?path.join(stateDir,'capability','dispatches.json'):null;
 const dispatches=dispatchFile?readJsonFile(dispatchFile,{missing:{}}):{};
 if(!dispatches || typeof dispatches!=='object' || Array.isArray(dispatches))throw capabilityError('DISPATCH_JOURNAL_CORRUPT','Capability dispatch journal is invalid');
 let recovered=false;
 for(const row of Object.values(dispatches))if(row?.operationId&&row.status==='started'){
  row.status='outcome-unknown';row.recoveryCode='CORE_RESTART_RECONCILIATION_REQUIRED';recovered=true;
 }
 if(recovered&&dispatchFile)writeJsonAtomic(dispatchFile,dispatches);
 const activeLogical=new Set();
 const aliasKey=id=>'operation-request:'+requestFingerprint({requestId:String(id)});
 function markOperationBlocker(request,entry,blocker,denied=false){
  const identity=operationIdentity(request,entry),row=identity&&dispatches[identity.key];
  if(!row||row.fingerprint!==identity.fingerprint||!['prepared','failed-no-effect'].includes(row.status))return;
  const backup=structuredClone(row);row.blocker=blocker;if(denied)row.authorizationDenied=true;
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){dispatches[identity.key]=backup;throw error;}
 }
 function assertRequestBinding(request,identity){
  const alias=dispatches[aliasKey(request.requestId)];
  const legacy=identity&&Object.hasOwn(dispatches,request.requestId)?dispatches[request.requestId]:null;
  if(legacy||(alias&&(!identity||alias.operationKey!==identity.key||alias.fingerprint!==requestFingerprint(request))))
   throw capabilityError('REQUEST_ID_CONFLICT','Request identity cannot change its logical operation or parameters');
 }
 function bindRequest(request,identity){
  if(!identity)return null;assertRequestBinding(request,identity);
  const key=aliasKey(request.requestId);if(dispatches[key])return null;
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  dispatches[key]={operationKey:identity.key,fingerprint:requestFingerprint(request)};return key;
 }
 function priorOperation(request,entry){
  const identity=operationIdentity(request,entry);assertRequestBinding(request,identity);
  const row=identity?dispatches[identity.key]:null;
  if(!row)return null;
  if(row.fingerprint!==identity.fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Logical operation reused with different scope or parameters');
  if(row.authorizationDenied){const error=capabilityError('OPERATION_PERMISSION_REVIEW_REQUIRED','Owner rejected this logical operation; explicit Owner review is required before another approval');error.effectStatus='unknown';throw error;}
  if(row.status==='prepared'||row.status==='failed-no-effect'){
   if((row.attemptCount??0)>=3)throw capabilityError('OPERATION_RETRY_LIMIT','Known-unexecuted operation exhausted its controlled retry budget');
   return null;
  }
  if(row.status==='completed'&&Object.hasOwn(row,'retainedResult'))return {requestId:request.requestId,status:'completed',capability:entry.id,
   operationId:request.operationId,replayed:true,result:structuredClone(row.retainedResult)};
  if(row.status==='started')return {requestId:request.requestId,status:'running',capability:entry.id,operationId:request.operationId,replayed:true};
  const error=capabilityError(row.status==='completed'?'OPERATION_RESULT_REVIEW_REQUIRED':'REQUEST_RECOVERY_REQUIRED','Review the prior logical operation; its effect must not be repeated');
  error.effectStatus='unknown';throw error;
 }
 async function validateReplay(request,entry){
  await entry.validate?.(request,{replay:true});await policy.authorize(request,entry);
  const row=dispatches[operationIdentity(request,entry).key];
  if(row?.status==='completed'&&typeof entry.verifyOperationResult==='function'
   &&await entry.verifyOperationResult(request,row.operationProof)!==true)
   throw capabilityError('OPERATION_RESULT_STALE','The completed operation result changed; reconcile it before planning new work');
  await policy.authorize(request,entry);
  const alias=bindRequest(request,operationIdentity(request,entry));
  if(alias)try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){delete dispatches[alias];throw error;}
 }
 function claimDispatch(request,entry,grantId=null){
  // Only effects that may outlive a local Abort need durable replay protection.
  // Agent provisioning is intentionally retried by Workshop with its stable requestId.
  const declaredEffect=entry.effect && entry.effect!=='read-only';
  const identity=operationIdentity(request,entry);
  assertRequestBinding(request,identity);
  if(!identity&&((!declaredEffect&&!['message.send','filesystem.write','git.commit','test.run','publish','network'].includes(entry.permission))||entry.id==='workspace.create'))return;
  const key=identity?.key??request.requestId, fingerprint=identity?.fingerprint??requestFingerprint(request), previous=Object.hasOwn(dispatches,key)?dispatches[key]:null;
  if(previous&&!['prepared','failed-no-effect'].includes(previous.status)){
   if(identity)return priorOperation(request,entry);
   if(previous.fingerprint!==fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Request ID reused with different data');
   throw capabilityError('REQUEST_ALREADY_DISPATCHED','Request ID already dispatched; external effect may have completed');
  }
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  const alias=bindRequest(request,identity);
  if(previous&&previous.fingerprint!==fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Prepared operation parameters changed');
  dispatches[key]={fingerprint,capability:entry.id,at:previous?.at??Date.now(),status:'started',attemptCount:(previous?.attemptCount??0)+1,lastAttemptAt:Date.now(),
   ...(grantId?{authorization:{kind:'bounded-grant',id:grantId}}:request.approvalId?{authorization:{kind:'approval',id:request.approvalId}}:{}),...(identity?{
   operationId:request.operationId,requestId:request.requestId,taskId:request.taskId,workspaceId:request.workspaceId,
   descriptorVersion:entry.descriptorVersion??null,executorId:request.actor.id,attemptId:typeof request.attemptId==='string'?request.attemptId.slice(0,160):null}: {})};
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){if(previous)dispatches[key]=previous;else delete dispatches[key];if(alias)delete dispatches[alias];throw error;}
  if(identity)activeLogical.add(key);
 }
 function settleDispatch(request, status,entry,result) {
  const identity=operationIdentity(request,entry),key=identity?.key??request.requestId;
  const row=Object.hasOwn(dispatches,key)?dispatches[key]:null;
  if(!row)return;
  activeLogical.delete(key);
  row.status=status;
  if(identity&&status==='completed'){
   const receipt=retainedOperationResult(entry,result,request);
   if(receipt){row.retainedResult=receipt.value;row.operationProof=receipt.proof;row.accessInput=receipt.accessInput;}
  }
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){audit({requestId:request.requestId,capability:request.capability,status:'dispatch-journal-failed',code:error.code??'WRITE_FAILED'});
   if(identity){row.status='outcome-unknown';const failure=capabilityError('OPERATION_RESULT_PERSIST_FAILED','Logical operation result was not durably recorded');failure.effectStatus='unknown';throw failure;}}
 }
 function abortError(signal,inFlight=false){
  if(!inFlight)return typeof signal?.reason?.code==='string'?signal.reason:capabilityError('INVOKE_CANCELLED','Capability operation cancelled');
  const error=capabilityError('INVOKE_CANCEL_UNCONFIRMED','Cancellation requested; external side effect is not confirmed cancelled');
  error.effectStatus='unknown';
  return error;
 }
 function awaitWithAbort(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(abortError(signal));
  let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(abortError(signal,true));signal.addEventListener('abort',onAbort,{once:true});});
  return Promise.race([promise,aborted]).finally(()=>signal.removeEventListener('abort',onAbort));
 }
 async function execute(raw,{signal}={}){
  const request=normalizeRequest(raw);
  if(request.approvalId){
   const approvedRequest=approval.get(request.approvalId).request;
   if(!approvedRequest)throw capabilityError('APPROVAL_NOT_APPROVED','A bounded grant ID cannot be used as a one-shot approval');
   request.approvalBinding=approvedRequest.approvalBinding;
  }
  try {
   if(signal?.aborted)throw abortError(signal);
   const entry=registry.require(request.capability);
   const decision=await policy.authorize(request,entry);
   if(signal?.aborted)throw abortError(signal);
   const previous=priorOperation(request,entry);
   if(previous){await validateReplay(request,entry);
    if(signal?.aborted)throw abortError(signal);
    audit({requestId:request.requestId,capability:entry.id,status:'operation-replayed',actor:request.actor.id});return previous;}
   // Boundary validation occurs before approval and is repeated at dispatch.
   await entry.validate?.(request);
   await policy.authorize(request,entry);
   if(signal?.aborted)throw abortError(signal);
   if(request.approvalId){const row=approval.get(request.approvalId);if(row.fingerprint!==requestFingerprint(request))throw capabilityError('APPROVAL_MISMATCH','Request changed');}
   let grantId=null;
   if(decision.approvalRequired && !(request.actor.kind==='owner'&&request.approved===true)){
    if(request.approvalId)approval.consume(request.approvalId,request);
    else if(!(grantId=approval.consumeGrant?.(request,entry,decision.approvalBinding))){const pending=approval.pending({...request,approvalBinding:decision.approvalBinding});markOperationBlocker(request,entry,'permission');audit({requestId:request.requestId,capability:entry.id,status:'pending'});return {requestId:request.requestId,status:'pending',capability:entry.id,approvalId:pending.id,expiresAt:pending.expiresAt};}
   }
   // Only trusted Core descriptors delegate; the nested Broker dispatch owns
   // approval, durable intent and the actual effect, including pending results.
   if(entry.delegatesOperation===true)return await entry.execute(signal?{...request,signal}:request);
   const raced=claimDispatch(request,entry,grantId);if(raced){await validateReplay(request,entry);return raced;}
   const providerRequest=signal?{...request,signal}:request;
   let executorEntered=false;
   const providerPromise=Promise.resolve().then(async()=>{
    if(signal?.aborted)throw abortError(signal);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Capability changed before dispatch');
    const authorized=await policy.authorize(request,entry);
    if(grantId)approval.validateGrant(grantId,request,entry,authorized?.approvalBinding);
    if(signal?.aborted)throw abortError(signal);
    try{executorEntered=true;return await entry.execute(providerRequest);}
    catch(error){
     // Once a declared effect reaches its executor, a rejected response is not
     // proof that nothing happened. Do not let the model recover by replaying it.
     if((entry.effect&&entry.effect!=='read-only')||['message.send','filesystem.write','git.commit','test.run','publish'].includes(entry.permission??entry.id)
       ||((entry.permission??entry.id)==='network'&&error?.name==='AbortError')){
      const uncertain=capabilityError(typeof error?.code==='string'?error.code:'PROVIDER_ERROR','Capability failed after dispatch; verify its effect before retrying');
      uncertain.effectStatus='unknown';throw uncertain;
     }
     throw error;
    }
   }).then(result=>{settleDispatch(request,'completed',entry,result);return result;},error=>{settleDispatch(request,!executorEntered?'failed-no-effect':error.effectStatus==='unknown'?'outcome-unknown':'failed',entry);throw error;});
   const result=await (entry.cancellationAware===true&&request.actor.kind==='agent'?providerPromise:awaitWithAbort(providerPromise,signal));
   audit({requestId:request.requestId,capability:entry.id,status:'completed',actor:request.actor.id});
   return {requestId:request.requestId,status:'completed',capability:entry.id,result};
  }catch(error){
   const blocker=['PERMISSION_DENIED','APPROVAL_EXPIRED','APPROVAL_NOT_APPROVED'].includes(error.code)?'permission'
    :['WORKSPACE_CONFLICT','TASK_WORKSPACE_BUSY','WORKSPACE_RECONCILIATION_REQUIRED'].includes(error.code)?'resource':null;
   if(blocker&&registry.has(request.capability))markOperationBlocker(request,registry.require(request.capability),blocker);
   audit({requestId:request.requestId,capability:request.capability,
   status:error.code==='INVOKE_CANCEL_UNCONFIRMED'?'cancel-requested':error.effectStatus==='unknown'?'outcome-unknown':'denied',code:error.code??'PROVIDER_ERROR'});throw error;}
 }
 return {execute,register:registry.register,list:registry.list,registry,approvals:approval,
  async prepareOperation(raw){
   const request=normalizeRequest(raw);
   if(request.actor.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Only Owner can establish an independent operation intent');
   const entry=registry.require(request.capability),identity=operationIdentity(request,entry);
   if(!identity||entry.delegatesOperation===true)throw capabilityError('INVALID_OPERATION_ID','Prepare a concrete capability operation');
   await policy.authorize(request,entry);await entry.validate?.(request);await policy.authorize(request,entry);
   const previous=dispatches[identity.key];
   if(previous&&previous.fingerprint!==identity.fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Prepared operation parameters changed');
   if(previous)return {operationId:previous.operationId,status:previous.status,capability:previous.capability};
   if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
   dispatches[identity.key]={operationId:request.operationId,fingerprint:identity.fingerprint,taskId:request.taskId,
    workspaceId:request.workspaceId,capability:entry.id,descriptorVersion:entry.descriptorVersion??null,
    executorId:request.actor.id,status:'prepared',at:Date.now()};
   try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){delete dispatches[identity.key];throw error;}
   audit({requestId:request.requestId,capability:entry.id,status:'operation-prepared',actor:request.actor.id});
   return {operationId:request.operationId,status:'prepared',capability:entry.id};
  },
  reviewPreparedOperation({actor,taskId,workspaceId,operationId}){
   if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner must review a blocked intent');
   const key=Object.keys(dispatches).find(key=>dispatches[key].operationId===operationId&&dispatches[key].taskId===taskId&&dispatches[key].workspaceId===workspaceId);
   const row=key&&dispatches[key];
   if(!row||!['prepared','failed-no-effect'].includes(row.status))throw capabilityError('OPERATION_REVIEW_DENIED','Only a known unexecuted intent can be reopened');
   const backup=structuredClone(row);delete row.blocker;delete row.authorizationDenied;
   try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){dispatches[key]=backup;throw error;}
   audit({capability:row.capability,status:'operation-owner-reviewed',actor:actor.id});
   return {operationId,status:row.status,authorizationGranted:false};
  },
  dispatchStatus:id=>{const alias=dispatches[aliasKey(id)];const row=alias?dispatches[alias.operationKey]:dispatches[String(id)];return row?{capability:row.capability,status:row.status,at:row.at}:null;},
  operationsForTask:({taskId,workspaceId})=>Object.values(dispatches).filter(row=>row.operationId&&row.taskId===taskId&&row.workspaceId===workspaceId)
   .map(({operationId,capability,status,at,executorId,attemptId,requestId,blocker})=>({operationId,capability,status,at,executorId,attemptId,requestId,blocker})),
  operationRecordForTask:({taskId,workspaceId,operationId})=>{
   const row=Object.values(dispatches).find(row=>row.operationId===operationId&&row.taskId===taskId&&row.workspaceId===workspaceId);
   return row?structuredClone(row):null;
  },
  acknowledgeTaskOperations:({taskId,workspaceId})=>{
   const rows=Object.entries(dispatches).filter(([,row])=>row.operationId&&row.taskId===taskId&&row.workspaceId===workspaceId
    &&['started','outcome-unknown'].includes(row.status));
   if(rows.some(([key])=>activeLogical.has(key)))throw capabilityError('OPERATION_STILL_RUNNING','The original operation has not settled');
   const prior=rows.map(([,row])=>row.status);for(const [,row]of rows){row.status='reconciled';row.resolution='owner-reviewed-no-replay';}
   try{if(rows.length&&dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){rows.forEach(([,row],i)=>{row.status=prior[i];delete row.resolution;});throw error;}
   return {reconciled:rows.length};
  },
  async decide({id,approve,actor},{signal}={}){
  if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner approval required');
  if(approve){
   const pending=approval.get(id);
   try{await policy.authorize(pending.request,registry.require(pending.request.capability));}
   catch(error){approval.revoke(id,error.code??'authorization-changed');throw error;}
  }
  const row=approval.decide(id,approve,actor);
  if(!approve){if(registry.has(row.request.capability))markOperationBlocker(row.request,registry.require(row.request.capability),'permission',true);return {status:'rejected',approvalId:id};}
  try{return await execute({...row.request,approvalId:id},{signal});}
  catch(error){approval.revoke(id,error.code??'execution-failed');throw error;}
 }};
}
