import {normalizeRequest,capabilityError} from './types.js';import {createCapabilityRegistry} from './registry.js';import {createCapabilityPolicy} from './policy.js';import {createCapabilityApproval,requestFingerprint} from './approval.js';
export function createCapabilityBroker({registry=createCapabilityRegistry(),policy=createCapabilityPolicy(),approval=createCapabilityApproval(),audit=()=>{}}={}){
 function abortError(signal){return signal?.reason?.code?signal.reason:capabilityError('INVOKE_CANCELLED','Capability operation cancelled');}
 function awaitWithAbort(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(abortError(signal));
  let onAbort;
  const aborted=new Promise((_,reject)=>{onAbort=()=>reject(abortError(signal));signal.addEventListener('abort',onAbort,{once:true});});
  return Promise.race([promise,aborted]).finally(()=>signal.removeEventListener('abort',onAbort));
 }
 async function execute(raw,{signal}={}){
  const request=normalizeRequest(raw);
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
    else {const pending=approval.pending(request);audit({requestId:request.requestId,capability:entry.id,status:'pending'});return {requestId:request.requestId,status:'pending',capability:entry.id,approvalId:pending.id,expiresAt:pending.expiresAt};}
   }
   const providerRequest=signal?{...request,signal}:request;
   const result=await awaitWithAbort(Promise.resolve().then(()=>entry.execute(providerRequest)),signal);
   audit({requestId:request.requestId,capability:entry.id,status:'completed',actor:request.actor.id});
   return {requestId:request.requestId,status:'completed',capability:entry.id,result};
  }catch(error){audit({requestId:request.requestId,capability:request.capability,status:'denied',code:error.code??'PROVIDER_ERROR'});throw error;}
 }
 return {execute,register:registry.register,list:registry.list,registry,approvals:approval,async decide({id,approve,actor}){const row=approval.decide(id,approve,actor);if(!approve)return {status:'rejected',approvalId:id};return execute({...row.request,approvalId:id});}};
}
