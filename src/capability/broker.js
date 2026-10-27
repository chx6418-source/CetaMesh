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
  const alias=bindRequest(request,operationIdentity(request,entry));
  if(alias)try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){delete dispatches[alias];throw error;}
 }
 function claimDispatch(request,entry){
  // Only effects that may outlive a local Abort need durable replay protection.
  // Agent provisioning is intentionally retried by Workshop with its stable requestId.
  const declaredEffect=entry.effect && entry.effect!=='read-only';
  const identity=operationIdentity(request,entry);
  assertRequestBinding(request,identity);
  if(!identity&&((!declaredEffect&&!['message.send','filesystem.write','git.commit','test.run','publish','network'].includes(entry.permission))||entry.id==='workspace.create'))return;
  const key=identity?.key??request.requestId, fingerprint=identity?.fingerprint??requestFingerprint(request), previous=Object.hasOwn(dispatches,key)?dispatches[key]:null;
  if(previous){
   if(identity)return priorOperation(request,entry);
   if(previous.fingerprint!==fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Request ID reused with different data');
   throw capabilityError('REQUEST_ALREADY_DISPATCHED','Request ID already dispatched; external effect may have completed');
  }
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  const alias=bindRequest(request,identity);
  dispatches[key]={fingerprint,capability:entry.id,at:Date.now(),status:'started',...(identity?{
   operationId:request.operationId,requestId:request.requestId,taskId:request.taskId,workspaceId:request.workspaceId,
   descriptorVersion:entry.descriptorVersion??null,executorId:request.actor.id,attemptId:typeof request.attemptId==='string'?request.attemptId.slice(0,160):null}: {})};
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){delete dispatches[key];if(alias)delete dispatches[alias];throw error;}
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
   if(decision.approvalRequired && !(request.actor.kind==='owner'&&request.approved===true)){
    if(request.approvalId)approval.consume(request.approvalId,request);
    else {const pending=approval.pending({...request,approvalBinding:decision.approvalBinding});audit({requestId:request.requestId,capability:entry.id,status:'pending'});return {requestId:request.requestId,status:'pending',capability:entry.id,approvalId:pending.id,expiresAt:pending.expiresAt};}
   }
   const raced=claimDispatch(request,entry);if(raced){await validateReplay(request,entry);return raced;}
   const providerRequest=signal?{...request,signal}:request;
   const providerPromise=Promise.resolve().then(async()=>{
    if(signal?.aborted)throw abortError(signal);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Capability changed before dispatch');
    const authorized=policy.authorize(request,entry);
    if(authorized&&typeof authorized.then==='function')await authorized;
    if(signal?.aborted)throw abortError(signal);
    try{return await entry.execute(providerRequest);}
    catch(error){
     // Once a declared effect reaches its executor, a rejected response is not
     // proof that nothing happened. Do not let the model recover by replaying it.
     if(entry.effect&&entry.effect!=='read-only'){
      const uncertain=capabilityError(typeof error?.code==='string'?error.code:'PROVIDER_ERROR','Capability failed after dispatch; verify its effect before retrying');
      uncertain.effectStatus='unknown';throw uncertain;
     }
     throw error;
    }
   }).then(result=>{settleDispatch(request,'completed',entry,result);return result;},error=>{settleDispatch(request,error.effectStatus==='unknown'?'outcome-unknown':'failed',entry);throw error;});
   const result=await (entry.cancellationAware===true&&request.actor.kind==='agent'?providerPromise:awaitWithAbort(providerPromise,signal));
   audit({requestId:request.requestId,capability:entry.id,status:'completed',actor:request.actor.id});
   return {requestId:request.requestId,status:'completed',capability:entry.id,result};
  }catch(error){audit({requestId:request.requestId,capability:request.capability,
   status:error.code==='INVOKE_CANCEL_UNCONFIRMED'?'cancel-requested':error.effectStatus==='unknown'?'outcome-unknown':'denied',code:error.code??'PROVIDER_ERROR'});throw error;}
 }
 return {execute,register:registry.register,list:registry.list,registry,approvals:approval,
  dispatchStatus:id=>{const alias=dispatches[aliasKey(id)];const row=alias?dispatches[alias.operationKey]:dispatches[String(id)];return row?{capability:row.capability,status:row.status,at:row.at}:null;},
  operationsForTask:({taskId,workspaceId})=>Object.values(dispatches).filter(row=>row.operationId&&row.taskId===taskId&&row.workspaceId===workspaceId)
   .map(({operationId,capability,status,at,executorId,attemptId,requestId})=>({operationId,capability,status,at,executorId,attemptId,requestId})),
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
  if(!approve)return {status:'rejected',approvalId:id};
  try{return await execute({...row.request,approvalId:id},{signal});}
  catch(error){approval.revoke(id,error.code??'execution-failed');throw error;}
 }};
}
