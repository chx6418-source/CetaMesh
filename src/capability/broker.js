import path from 'node:path';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {normalizeRequest,capabilityError} from './types.js';import {createCapabilityRegistry} from './registry.js';import {createCapabilityPolicy} from './policy.js';import {createCapabilityApproval,requestFingerprint} from './approval.js';
export function createCapabilityBroker({registry=createCapabilityRegistry(),policy=createCapabilityPolicy(),approval=createCapabilityApproval(),audit=()=>{},stateDir=null}={}){
 const dispatchFile=stateDir?path.join(stateDir,'capability','dispatches.json'):null;
 const dispatches=dispatchFile?readJsonFile(dispatchFile,{missing:{}}):{};
 if(!dispatches || typeof dispatches!=='object' || Array.isArray(dispatches))throw capabilityError('DISPATCH_JOURNAL_CORRUPT','Capability dispatch journal is invalid');
 function claimDispatch(request,entry){
  // Only effects that may outlive a local Abort need durable replay protection.
  // Agent provisioning is intentionally retried by Workshop with its stable requestId.
  if(!['message.send','filesystem.write','git.commit','test.run','publish','network'].includes(entry.permission)||entry.id==='workspace.create')return;
  const key=request.requestId, fingerprint=requestFingerprint(request), previous=Object.hasOwn(dispatches,key)?dispatches[key]:null;
  if(previous){
   if(previous.fingerprint!==fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Request ID reused with different data');
   throw capabilityError('REQUEST_ALREADY_DISPATCHED','Request ID already dispatched; external effect may have completed');
  }
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  dispatches[key]={fingerprint,capability:entry.id,at:Date.now(),status:'started'};
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){delete dispatches[key];throw error;}
 }
 function settleDispatch(request, status) {
  const row=Object.hasOwn(dispatches,request.requestId)?dispatches[request.requestId]:null;
  if(!row)return;
  row.status=status;
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){audit({requestId:request.requestId,capability:request.capability,status:'dispatch-journal-failed',code:error.code??'WRITE_FAILED'});}
 }
 function abortError(signal,inFlight=false){
  if(!inFlight)return signal?.reason?.code?signal.reason:capabilityError('INVOKE_CANCELLED','Capability operation cancelled');
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
   // Boundary validation occurs before approval and is repeated at dispatch.
   await entry.validate?.(request);
   if(request.approvalId){const row=approval.get(request.approvalId);if(row.fingerprint!==requestFingerprint(request))throw capabilityError('APPROVAL_MISMATCH','Request changed');}
   if(decision.approvalRequired && !(request.actor.kind==='owner'&&request.approved===true)){
    if(request.approvalId)approval.consume(request.approvalId,request);
    else {const pending=approval.pending({...request,approvalBinding:decision.approvalBinding});audit({requestId:request.requestId,capability:entry.id,status:'pending'});return {requestId:request.requestId,status:'pending',capability:entry.id,approvalId:pending.id,expiresAt:pending.expiresAt};}
   }
   claimDispatch(request,entry);
   const providerRequest=signal?{...request,signal}:request;
   const providerPromise=Promise.resolve().then(()=>entry.execute(providerRequest));
   providerPromise.then(()=>settleDispatch(request,'completed'),()=>settleDispatch(request,'failed'));
   const result=await awaitWithAbort(providerPromise,signal);
   audit({requestId:request.requestId,capability:entry.id,status:'completed',actor:request.actor.id});
   return {requestId:request.requestId,status:'completed',capability:entry.id,result};
  }catch(error){audit({requestId:request.requestId,capability:request.capability,
   status:error.code==='INVOKE_CANCEL_UNCONFIRMED'?'cancel-requested':'denied',code:error.code??'PROVIDER_ERROR'});throw error;}
 }
 return {execute,register:registry.register,list:registry.list,registry,approvals:approval,
  dispatchStatus:id=>Object.hasOwn(dispatches,String(id))?{capability:dispatches[String(id)].capability,status:dispatches[String(id)].status,at:dispatches[String(id)].at}:null,
  async decide({id,approve,actor}){
  if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner approval required');
  if(approve){
   const pending=approval.get(id);
   try{await policy.authorize(pending.request,registry.require(pending.request.capability));}
   catch(error){approval.revoke(id,error.code??'authorization-changed');throw error;}
  }
  const row=approval.decide(id,approve,actor);
  if(!approve)return {status:'rejected',approvalId:id};
  try{return await execute({...row.request,approvalId:id});}
  catch(error){approval.revoke(id,error.code??'execution-failed');throw error;}
 }};
}
