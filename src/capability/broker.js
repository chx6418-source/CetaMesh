import path from 'node:path';
import crypto from 'node:crypto';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
import {operationIdentity,retainedOperationResult} from './operation-identity.js';
import {safeContinuationInput} from './operation-context.js';
import {normalizeRequest,capabilityError} from './types.js';import {createCapabilityRegistry} from './registry.js';import {createCapabilityPolicy} from './policy.js';import {createCapabilityApproval,requestFingerprint} from './approval.js';
export function createCapabilityBroker({registry=createCapabilityRegistry(),policy=createCapabilityPolicy(),approval=createCapabilityApproval(),audit=()=>{},stateDir=null}={}){
 // A trusted in-process startup guard can only restrict existing authority.
 // It is never exposed as an IPC capability or an Agent-controlled permission.
 let executionGuard=()=>{};
 let readContextResolver=null;
 const dispatchFile=stateDir?path.join(stateDir,'capability','dispatches.json'):null;
 const dispatches=dispatchFile?readJsonFile(dispatchFile,{missing:{}}):{};
 if(!dispatches || typeof dispatches!=='object' || Array.isArray(dispatches))throw capabilityError('DISPATCH_JOURNAL_CORRUPT','Capability dispatch journal is invalid');
 // Request IDs are untrusted dictionary keys, including "__proto__" in existing JSON.
 Object.setPrototypeOf(dispatches,null);
 let recovered=false;
 for(const row of Object.values(dispatches))if(row?.status==='started'){
  row.status='outcome-unknown';row.recoveryCode='CORE_RESTART_RECONCILIATION_REQUIRED';recovered=true;
 }
 if(recovered&&dispatchFile)writeJsonAtomic(dispatchFile,dispatches);
 const activeDispatches=new Set();
 const aliasKey=id=>'operation-request:'+requestFingerprint({requestId:String(id)});
 function markOperationBlocker(request,entry,blocker,denied=false){
  const identity=operationIdentity(request,entry),row=identity&&dispatches[identity.key];
  if(!row||row.fingerprint!==identity.fingerprint||!['prepared','failed-no-effect'].includes(row.status))return;
  const backup=structuredClone(row);row.blocker=blocker;if(denied)row.authorizationDenied=true;
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){dispatches[identity.key]=backup;throw error;}
 }
 function assertRequestBinding(request,identity,{legacyValidated=true}={}){
  const alias=dispatches[aliasKey(request.requestId)];
  const legacy=Object.hasOwn(dispatches,request.requestId)?dispatches[request.requestId]:null;
  if((legacy&&(identity||(legacyValidated&&legacy.fingerprint!==requestFingerprint(request))))||(alias&&(!identity||alias.operationKey!==identity.key||alias.fingerprint!==requestFingerprint(request))))
   throw capabilityError('REQUEST_ID_CONFLICT','Request identity cannot change its logical operation or parameters');
 }
 function bindRequest(request,identity){
  if(!identity)return null;assertRequestBinding(request,identity);
  const key=aliasKey(request.requestId);if(dispatches[key])return null;
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  dispatches[key]={operationKey:identity.key,fingerprint:requestFingerprint(request)};return key;
 }
 function priorOperation(request,entry,options){
  const identity=operationIdentity(request,entry);assertRequestBinding(request,identity,options);
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
  if(entry.gitBranchApplication===true&&!dispatchFile)throw capabilityError('DISPATCH_PERSISTENCE_REQUIRED','Git application effects require the existing durable dispatch journal');
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
   ...(entry.gitBranchApplication === true ? {executionAttempt: crypto.randomUUID()} : {}),
   ...(grantId?{authorization:{kind:'bounded-grant',id:grantId}}:request.approvalId?{authorization:{kind:'approval',id:request.approvalId}}:{}),
   requestId:request.requestId,...(typeof request.taskId==='string'?{taskId:request.taskId}:{}),
   workspaceId:typeof request.workspaceId==='string'?request.workspaceId:null,executorId:request.actor.id,
   attemptId:typeof request.attemptId==='string'?request.attemptId.slice(0,160):null,...(identity?{
   operationId:request.operationId,...(previous?.logicalStepId?{logicalStepId:previous.logicalStepId}:{}),
   descriptorVersion:entry.descriptorVersion??null}: {})};
  try {
  if(entry.gitBranchApplication===true&&request.input.paths?.length===0){
   const original=request.input.mode==='finish-prepared'?entry.gitMetadataOriginal(request):gitBinding(key,dispatches[key]);
   dispatches[key].gitMetadata={schema:1,original,closed:false,
    ...(request.input.mode==='clean'?{reviewProof:captureGitMetadataReview(request,original,entry)}:{})};
  }
  if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){if(previous)dispatches[key]=previous;else delete dispatches[key];if(alias)delete dispatches[alias];throw error;}
  activeDispatches.add(key);
  return {dispatchClaim:{key,row:dispatches[key]}};
 }
 function settleDispatch(request, status,entry,result,claim) {
  // A read/delegating call never owns another invocation's durable intent.
  if(!claim||dispatches[claim.key]!==claim.row)return;
  const identity=operationIdentity(request,entry),key=identity?.key??request.requestId;
  const row=Object.hasOwn(dispatches,key)?dispatches[key]:null;
  if(!row)return;
  activeDispatches.delete(key);
  row.status=status;
  if((identity||entry.gitBranchApplication===true)&&status==='completed'){
   const receipt=retainedOperationResult(entry,result,request);
   if(receipt){row.retainedResult=receipt.value;row.operationProof=receipt.proof;row.accessInput=receipt.accessInput;}
  }
  const reconciled = [];
  try {
  if(status==='completed'&&entry.gitBranchApplication===true){
   if(!row.retainedResult)throw capabilityError('DISPATCH_RESULT_PERSIST_FAILED','Bounded Git completion receipt is required');
   const bindings=row.gitMetadata ? metadataChain(row.gitMetadata.original).filter(([,item])=>item.gitMetadata.closed&&['outcome-unknown','completed','reconciled'].includes(item.status)).map(([id,item])=>gitBinding(id,item)) : entry.gitClosedBindings?.(result)??[];
   for(const binding of bindings)if(binding.requestId!==request.requestId){
    const original=verifiedGitDispatch(binding);
    if(activeDispatches.has(binding.key))throw capabilityError('OPERATION_STILL_RUNNING','Original Git invocation is still active');
    if(!['outcome-unknown','completed','reconciled'].includes(original.status))throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original dispatch cannot be reconciled');
    reconciled.push([original,structuredClone(original)]);
    original.historicalStatus??=original.status;
    if(original.status!=='completed')original.status='reconciled';
    original.resolution='owner-reviewed-no-replay';original.completionRequestId=request.requestId;
   }
  }
  if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){audit({requestId:request.requestId,capability:request.capability,status:'dispatch-journal-failed',code:error.code??'WRITE_FAILED'});
   for(const [original,backup] of reconciled){Object.keys(original).forEach(key=>delete original[key]);Object.assign(original,backup);}
   row.status='outcome-unknown';
   const failure=capabilityError(identity?'OPERATION_RESULT_PERSIST_FAILED':'DISPATCH_RESULT_PERSIST_FAILED','Capability result was not durably recorded');
   failure.effectStatus='unknown';throw failure;}
 }
 function verifiedGitDispatch(binding,capability='git.branch.switch'){
  const row=binding&&dispatches[binding.key];
  if(!row||row.capability!==capability||binding.capability!==capability||row.fingerprint!==binding.fingerprint
   ||row.requestId!==binding.requestId||row.workspaceId!==binding.workspaceId||(row.taskId??null)!==binding.taskId
   ||(row.operationId??null)!==binding.operationId||row.executionAttempt!==binding.attemptId
   ||row.authorization?.kind!=='approval'||row.authorization.id!==binding.approvalId)
   throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original Git dispatch binding does not match its durable owner');
  return row;
 }
 function gitBinding(key,row){return {key,requestId:row.requestId,capability:row.capability,fingerprint:row.fingerprint,
  taskId:row.taskId??null,operationId:row.operationId??null,workspaceId:row.workspaceId,approvalId:row.authorization?.id,attemptId:row.executionAttempt};}
 function metadataReviewInput(input){
  // Retain only the original reviewed Git facts, never reason, model context,
  // actor extras or an approval-history copy. Native/working paths are empty.
  const fields=['paths','targetBranch','mode','expectedHead','expectedHeadRef','expectedTargetHead','indexIdentity','expectedRepositoryIdentity','expectedDirtyIdentity','expectedHashes','expectedWorkingModes'];
  if(!input||input.mode!=='clean'||!Array.isArray(input.paths)||input.paths.length
   ||['targetBranch','expectedHead','expectedTargetHead','expectedRepositoryIdentity','expectedDirtyIdentity'].some(key=>typeof input[key]!=='string'||!input[key])
   ||['expectedHeadRef','indexIdentity'].some(key=>input[key]!==null&&typeof input[key]!=='string')
   ||['expectedHashes','expectedWorkingModes'].some(key=>!input[key]||typeof input[key]!=='object'||Array.isArray(input[key])||Object.keys(input[key]).length))
   throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original metadata review must contain exact zero-file Git facts');
  const value=Object.fromEntries(fields.map(key=>[key,input[key]])),text=JSON.stringify(value);
  if(Buffer.byteLength(text)>8192)throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original metadata review exceeds its bound');
  return JSON.parse(text);
 }
 function verifiedMetadataApproval(request,original,entry){
  const consumed=approval.get(original.approvalId),identity=operationIdentity(request,entry);
  if(consumed.status!=='consumed'||consumed.fingerprint!==requestFingerprint(request)
   ||(identity?.fingerprint??requestFingerprint(request))!==original.fingerprint||(identity?.key??request.requestId)!==original.key
   ||request.requestId!==original.requestId||request.capability!=='git.branch.switch'||request.workspaceId!==original.workspaceId
   ||(request.taskId??null)!==original.taskId||(request.operationId??null)!==original.operationId)
   throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original metadata review does not match its consumed approval and dispatch');
  return consumed.fingerprint;
 }
 function captureGitMetadataReview(request,original,entry){
  // Called only after consume(), before the same dispatch intent is persisted.
  const approvalFingerprint=verifiedMetadataApproval(request,original,entry),input=metadataReviewInput(request.input);
  const scope={binding:structuredClone(original),approvalFingerprint,input};
  const proof={schema:1,...scope,scopeFingerprint:requestFingerprint(scope)};
  if(Buffer.byteLength(JSON.stringify(proof))>16384)throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original metadata review proof exceeds its bound');
  return proof;
 }
 function retainedGitMetadataReview(original){
  const row=verifiedGitDispatch(original),proof=row.gitMetadata?.reviewProof;
  if(proof!==undefined){
   if(!proof||proof.schema!==1||Buffer.byteLength(JSON.stringify(proof))>16384
    ||JSON.stringify(proof.binding)!==JSON.stringify(original)||!/^[a-f0-9]{64}$/.test(proof.approvalFingerprint??''))
    throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Invalid original metadata review proof');
   const input=metadataReviewInput(proof.input);
   if(proof.scopeFingerprint!==requestFingerprint({binding:proof.binding,approvalFingerprint:proof.approvalFingerprint,input})
    ||(!original.operationId&&proof.approvalFingerprint!==original.fingerprint))
    throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original metadata review proof changed scope');
   return input;
  }
  // Older dispatches can use their exact consumed approval if it still exists.
  // Missing legacy evidence is never reconstructed from a new request.
  let request;
  try{request=approval.get(original.approvalId).request;}
  catch(error){if(error.code!=='APPROVAL_NOT_FOUND')throw error;throw capabilityError('GIT_RECOVERY_PROOF_UNAVAILABLE','Legacy Git dispatch has no retained original review proof');}
  verifiedMetadataApproval(request,original,registry.require('git.branch.switch'));
  return metadataReviewInput(request.input);
 }
 function metadataChain(original){
  verifiedGitDispatch(original);
  const chain=Object.entries(dispatches).filter(([,row])=>row.gitMetadata?.original?.key===original.key);
  if(!chain.length||chain.length>16||chain.some(([,row])=>row.gitMetadata.schema!==1||typeof row.gitMetadata.closed!=='boolean'
   ||JSON.stringify(row.gitMetadata.original)!==JSON.stringify(original)||row.workspaceId!==original.workspaceId||(row.taskId??null)!==original.taskId))
   throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Invalid bounded metadata-only Git invocation chain');
  return chain;
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
 const nativeIdentityFields=['provider','sessionId','taskId','workspaceId','runId','phase','toolCallId'];
 const nativeScopeFields=[...nativeIdentityFields,'inputFingerprint','callFingerprint'];
 const nativeIdentifier=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f\x7f]/.test(value);
 function nativeScope(value){
  if(!value||nativeIdentityFields.some(key=>!nativeIdentifier(value[key]))||value.provider!=='dsh'||value.phase!=='user'
   ||['inputFingerprint','callFingerprint'].some(key=>!/^[a-f0-9]{64}$/.test(value[key]??''))
   ||(Object.hasOwn(value,'effectPolicy')&&value.effectPolicy!=='dsh-staging-read-v1'))
   throw capabilityError('AGENT_NATIVE_EFFECT_MISMATCH','A complete trusted native effect binding is required');
  return {...Object.fromEntries(nativeScopeFields.map(key=>[key,value[key]])),
   ...(Object.hasOwn(value,'effectPolicy')?{effectPolicy:value.effectPolicy}:{})};
 }
 function nativeEffectKey(scope){return 'native-effect:'+requestFingerprint(Object.fromEntries(nativeIdentityFields.map(key=>[key,scope[key]])));}
 function assertAgentNativeEffectAvailable(binding){
  const scope=nativeScope(binding);
  if(dispatches[nativeEffectKey(scope)])throw capabilityError('AGENT_NATIVE_EFFECT_ALREADY_RECORDED','This native call already received its one execution permit');
  return scope;
 }
 function beginAgentNativeEffect(request,binding){
  if(!dispatchFile)throw capabilityError('AGENT_NATIVE_EFFECT_PERSISTENCE_REQUIRED','Native execution requires the durable Core dispatch journal');
  const scope=assertAgentNativeEffectAvailable(binding),row=approval.get(request.approvalId);
  if(request.capability!=='agent.native.approve'||request.actor?.kind!=='owner'||request.actor.id!=='desktop'
   ||row.status!=='consumed'||row.fingerprint!==requestFingerprint(request)
   ||request.taskId!==scope.taskId||request.workspaceId!==scope.workspaceId
   ||requestFingerprint(request.input?.nativeBinding)!==requestFingerprint(scope))
   throw capabilityError('PERMISSION_DENIED','Native effects require their exact consumed Owner approval');
  if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
  const key=nativeEffectKey(scope),nativeEffectId=crypto.randomUUID();
  dispatches[key]={kind:'agent-native-effect',nativeEffectId,nativeBinding:scope,fingerprint:requestFingerprint(scope),
   capability:'agent.native.approve',requestId:'native-effect:'+nativeEffectId,taskId:scope.taskId,workspaceId:scope.workspaceId,
   executorId:scope.provider+':'+scope.sessionId,status:'started',at:Date.now(),
   authorization:{kind:'approval',id:request.approvalId,fingerprint:row.fingerprint}};
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){delete dispatches[key];throw error;}
  activeDispatches.add(key);
  return {nativeEffectId,inputFingerprint:scope.inputFingerprint};
 }
 function settleAgentNativeEffect(input={}){
  const pair=Object.entries(dispatches).find(([,row])=>row?.kind==='agent-native-effect'&&row.nativeEffectId===input.nativeEffectId);
  const [key,row]=pair??[],scope=row?.nativeBinding;
  if(!scope||['provider','sessionId','taskId','workspaceId','runId','toolCallId','inputFingerprint'].some(field=>input[field]!==scope[field]))
   throw capabilityError('AGENT_NATIVE_EFFECT_MISMATCH','Native result does not match its original call binding');
  const permitted=approval.get(row.authorization.id);
  if(permitted.status!=='consumed'||permitted.fingerprint!==row.authorization.fingerprint
   ||requestFingerprint(permitted.request)!==permitted.fingerprint
   ||requestFingerprint(permitted.request.input?.nativeBinding)!==requestFingerprint(scope))
   throw capabilityError('PERMISSION_DENIED','Native result has no exact consumed Owner approval');
  const terminal=['completed','failed'].includes(input.outcome);
  if(!terminal&&!['unknown','cancelled','disconnected'].includes(input.outcome))
   throw capabilityError('AGENT_NATIVE_EFFECT_EVIDENCE_REQUIRED','A supported native result outcome is required');
  let evidence;
  if(terminal){
   if(input.evidence?.source!=='native-result'||!/^[a-f0-9]{64}$/.test(input.evidence.resultSha256??'')||!nativeIdentifier(input.evidence.eventId))
    throw capabilityError('AGENT_NATIVE_EFFECT_EVIDENCE_REQUIRED','Actual terminal native output is required; activity and permit completion are not results');
   evidence={source:'native-result',resultSha256:input.evidence.resultSha256,eventId:input.evidence.eventId,outcome:input.outcome};
  }
  // Only the original, approved policy for the pinned read implementation can
  // settle an actual error without uncertain writes. Result labels cannot add
  // that policy. Writes, unclassified legacy calls and absent results stay unknown.
  const status=input.outcome==='completed'?'completed'
   :input.outcome==='failed'&&scope.effectPolicy==='dsh-staging-read-v1'?'failed':'outcome-unknown';
  if(terminal&&row.nativeEvidence&&requestFingerprint(row.nativeEvidence)!==requestFingerprint(evidence))
   throw capabilityError('AGENT_NATIVE_EFFECT_ALREADY_SETTLED','A contradictory native terminal result cannot replace retained execution evidence');
  if(!['started','outcome-unknown'].includes(row.status)){
   if(row.status===status&&requestFingerprint({evidence:row.nativeEvidence??null})===requestFingerprint({evidence:evidence??null}))return {nativeEffectId:row.nativeEffectId,status:row.status};
   throw capabilityError('AGENT_NATIVE_EFFECT_ALREADY_SETTLED','A native result cannot rewrite a settled or reviewed effect');
  }
  dispatches[key]={...row,status,...(evidence?{nativeEvidence:evidence}:{}),settledAt:Date.now()};
  activeDispatches.delete(key);
  try{if(dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}
  catch(error){dispatches[key]={...row,status:'outcome-unknown'};const failure=capabilityError('DISPATCH_RESULT_PERSIST_FAILED','Native effect result was not durably recorded');failure.effectStatus='unknown';throw failure;}
  return {nativeEffectId:row.nativeEffectId,status};
 }
 async function validatePluginParent(request){
  if(!request.pluginParent)return null;
  const ref=request.pluginParent,row=approval.get(ref.approvalId),parent=row.request;
  if(row.status!=='consumed'||row.expiresAt<=Date.now()||!parent||parent.capability!==ref.capability
    ||parent.taskId!==request.taskId||parent.workspaceId!==request.workspaceId||requestFingerprint({actor:parent.actor})!==requestFingerprint({actor:request.actor}))
    throw capabilityError('APPROVAL_EXPIRED','Nested request no longer belongs to its consumed parent decision');
  if(!registry.has(ref.capability))throw capabilityError('APPROVAL_EXPIRED','Plugin was disabled; concrete dispatch requires a fresh review');
  const descriptor=registry.require(ref.capability);
  if(descriptor.descriptorVersion!==ref.descriptorVersion||typeof descriptor.validateChildRequest!=='function'||typeof descriptor.projectChildResult!=='function')
    throw capabilityError('APPROVAL_EXPIRED','Parent plugin version or adapter changed');
  await policy.authorize(parent,descriptor);await descriptor.validate?.(parent);
  if(await descriptor.validateChildRequest(parent,request)!==true)throw capabilityError('APPROVAL_MISMATCH','Concrete request differs from the reviewed data endpoint');
  return {descriptor,parent};
 }
 async function execute(raw,{signal,consumeReadBytes,acquireReadSlot,beforeAgentSend}={}){
  const request=normalizeRequest(raw);
  let releaseRead=null;
  if(request.approvalId){
   const approvedRequest=approval.get(request.approvalId).request;
   if(!approvedRequest)throw capabilityError('APPROVAL_NOT_APPROVED','A bounded grant ID cannot be used as a one-shot approval');
   request.approvalBinding=approvedRequest.approvalBinding;
  }
  try {
   if(signal?.aborted)throw abortError(signal);
   const entry=registry.require(request.capability);
   const decision=await policy.authorize(request,entry);
   await executionGuard();
   await validatePluginParent(request);
   if(signal?.aborted)throw abortError(signal);
   const previous=priorOperation(request,entry,{legacyValidated:false});
   if(previous){await validateReplay(request,entry);
    if(signal?.aborted)throw abortError(signal);
    audit({requestId:request.requestId,capability:entry.id,status:'operation-replayed',actor:request.actor.id});return previous;}
   // Boundary validation occurs before approval and is repeated at dispatch.
   await entry.validate?.(request);
   await policy.authorize(request,entry);
   // Legacy fingerprints include descriptor-bound target metadata populated by
   // validation. Compare that shape before any approval or dispatch, not raw input.
   assertRequestBinding(request,operationIdentity(request,entry));
   if(signal?.aborted)throw abortError(signal);
   if(request.approvalId){const row=approval.get(request.approvalId);if(row.fingerprint!==requestFingerprint(request))throw capabilityError('APPROVAL_MISMATCH','Request changed');}
   let grantId=null;
   if(decision.approvalRequired && !(entry.gitBranchApplication!==true&&request.actor.kind==='owner'&&request.approved===true)){
    if(request.approvalId)approval.consume(request.approvalId,request);
    else if(!(grantId=approval.consumeGrant?.(request,entry,decision.approvalBinding))){const pending=approval.pending({...request,approvalBinding:decision.approvalBinding});markOperationBlocker(request,entry,'permission');audit({requestId:request.requestId,capability:entry.id,status:'pending'});return {requestId:request.requestId,status:'pending',capability:entry.id,approvalId:pending.id,expiresAt:pending.expiresAt};}
   }
   // Only trusted Core descriptors delegate; the nested Broker dispatch owns
   // approval, durable intent and the actual effect, including pending results.
   await executionGuard();
   if(entry.delegatesOperation===true)return await entry.execute(signal?{...request,signal}:request);
   const claimed=claimDispatch(request,entry,grantId);
   if(claimed&&!claimed.dispatchClaim){await validateReplay(request,entry);return claimed;}
   const claim=claimed?.dispatchClaim;
   const cooperativeRead=entry.readOnly===true&&entry.parallelSafe===true&&entry.effect==='read-only'
    &&entry.provider==='workspace'&&['filesystem.read','filesystem.search'].includes(entry.id);
   // Approved coordinator reads join the same process-local admission gate.
   // No slot is held while the request is merely waiting for Owner approval.
   if(cooperativeRead&&typeof acquireReadSlot==='function'){
    releaseRead=await acquireReadSlot(signal);
    if(typeof releaseRead!=='function')throw capabilityError('READ_ADMISSION_INVALID','Core read admission must supply its settlement release');
   }
   // This closure is in-process execution context, absent from durable requests,
   // transport schemas and plugin metadata. It can restrict but never grant.
   const assertAuthorized=async()=>{
    if(signal?.aborted)throw abortError(signal);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Capability changed during Workspace read');
    const authorized=await policy.authorize(request,entry);
    await executionGuard();await validatePluginParent(request);await entry.validate?.(request);
    if(grantId)approval.validateGrant(grantId,request,entry,authorized?.approvalBinding);
    await policy.authorize(request,entry);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Capability changed during Workspace read');
    if(signal?.aborted)throw abortError(signal);
   };
   let providerRequest=cooperativeRead?{...request,...(signal?{signal}:{}),assertAuthorized,
    consumeReadBytes:typeof consumeReadBytes==='function'?consumeReadBytes:undefined}:signal?{...request,signal}:request;
   // Core-only closure, never part of normalized/durable/model-supplied input.
   if(entry.id==='agent.run'&&typeof beforeAgentSend==='function')providerRequest={...providerRequest,beforeAgentSend};
   if(entry.gitBranchApplication===true)providerRequest={...providerRequest,gitDispatchBinding:{key:claim.key,
    requestId:request.requestId,capability:entry.id,fingerprint:claim.row.fingerprint,taskId:request.taskId??null,
    operationId:request.operationId??null,workspaceId:request.workspaceId,approvalId:request.approvalId,attemptId:claim.row.executionAttempt}};
   let executorEntered=false,knownNoEffect=false;
   const providerPromise=Promise.resolve().then(async()=>{
    if(signal?.aborted)throw abortError(signal);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Capability changed before dispatch');
    const authorized=await policy.authorize(request,entry);
    await executionGuard();
    const parent=await validatePluginParent(request);
    if(grantId)approval.validateGrant(grantId,request,entry,authorized?.approvalBinding);
    if(signal?.aborted)throw abortError(signal);
    try{executorEntered=true;const result=await entry.execute(providerRequest);
      if(parent){try{await validatePluginParent(request);}catch(error){error.effectStatus='unknown';throw error;}return parent.descriptor.projectChildResult(parent.parent,result);}
      return result;}
    catch(error){
     // Only an in-process Core descriptor can attest to the exact error.
     // Provider status/code fields and asynchronous guesses are not receipts.
     try{
      const proof=entry.isKnownNoEffectError?.(error);
      if(proof&&typeof proof.then==='function')Promise.resolve(proof).catch(()=>{});
      knownNoEffect=proof===true;
     }catch{knownNoEffect=false;}
     if(knownNoEffect)throw error;
     // Once a declared effect reaches its executor, a rejected response is not
     // proof that nothing happened. Do not let the model recover by replaying it.
     if((entry.effect&&entry.effect!=='read-only')||['message.send','filesystem.write','git.commit','test.run','publish'].includes(entry.permission??entry.id)
       ||((entry.permission??entry.id)==='network'&&error?.name==='AbortError')){
      const uncertain=capabilityError(typeof error?.code==='string'?error.code:'PROVIDER_ERROR','Capability failed after dispatch; verify its effect before retrying');
      uncertain.effectStatus='unknown';throw uncertain;
     }
     throw error;
    }
   }).then(result=>{settleDispatch(request,'completed',entry,result,claim);
    if(entry.gitBranchApplication===true)try{entry.afterDurableGitResult?.(result);}catch{result.cleanupPending=true;}
    return result;},error=>{settleDispatch(request,!executorEntered||knownNoEffect?'failed-no-effect':error.effectStatus==='unknown'?'outcome-unknown':'failed',entry,undefined,claim);throw error;});
   const result=await (entry.gitBranchApplication===true||entry.cancellationAware===true&&(request.actor.kind==='agent'||cooperativeRead)?providerPromise:awaitWithAbort(providerPromise,signal));
   audit({requestId:request.requestId,capability:entry.id,status:'completed',actor:request.actor.id});
   return {requestId:request.requestId,status:'completed',capability:entry.id,result};
  }catch(error){
   const blocker=['PERMISSION_DENIED','APPROVAL_EXPIRED','APPROVAL_NOT_APPROVED'].includes(error.code)?'permission'
    :['WORKSPACE_CONFLICT','TASK_WORKSPACE_BUSY','WORKSPACE_RECONCILIATION_REQUIRED'].includes(error.code)?'resource':null;
   if(blocker&&registry.has(request.capability))markOperationBlocker(request,registry.require(request.capability),blocker);
   audit({requestId:request.requestId,capability:request.capability,
   status:error.code==='INVOKE_CANCEL_UNCONFIRMED'?'cancel-requested':error.effectStatus==='unknown'?'outcome-unknown':'denied',code:error.code??'PROVIDER_ERROR'});throw error;}
  finally{if(typeof releaseRead==='function')releaseRead();}
 }
 return {execute,register:registry.register,list:registry.list,registry,approvals:approval,
  // Trusted Core observation only. Discovery may ask about a directory; the
  // caller must still enforce its own bounded content and path/hash contract.
  // Never consumes approval/grants, executes a provider or records an effect.
  async assertReadAuthorization(raw,{signal}={}){
   const request=normalizeRequest(raw);
   if(request.capability!=='filesystem.read'||['approvalId','approved','operationId'].some(key=>Object.hasOwn(request,key)))
    throw capabilityError('READ_AUTHORIZATION_ONLY','Only an exact, unapproved Core filesystem read may be queried');
   const entry=registry.require(request.capability);
   if(entry.provider!=='workspace'||entry.workspace!==true||entry.readOnly!==true||entry.effect!=='read-only'
    ||(entry.source!==undefined&&entry.source!=='workspace')||entry.catalogOwner||entry.delegatesOperation)
    throw capabilityError('READ_AUTHORIZATION_ONLY','The current exact Core Workspace read descriptor is required');
   const check=async()=>{
    if(signal?.aborted)throw abortError(signal);
    if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Core read descriptor changed during authorization');
    const decision=await policy.authorize(request,entry);
    if(decision?.allowed!==true||decision.approvalRequired===true)
     throw capabilityError('READ_AUTHORIZATION_APPROVAL_REQUIRED','An authorization query cannot grant or consume read approval');
    await executionGuard();await validatePluginParent(request);await entry.validate?.(request);
   };
   await check();await check();
   if(signal?.aborted)throw abortError(signal);
   if(registry.require(request.capability)!==entry)throw capabilityError('APPROVAL_EXPIRED','Core read descriptor changed during authorization');
   const decision=await policy.authorize(request,entry);
   if(decision?.allowed!==true||decision.approvalRequired===true)throw capabilityError('READ_AUTHORIZATION_APPROVAL_REQUIRED','Current read authorization is required');
   return {allowed:true,capability:entry.id};
  },
  // Trusted adapter receipts use the existing effect journal; neither method is an IPC capability.
  assertAgentNativeEffectAvailable,beginAgentNativeEffect,settleAgentNativeEffect,
  setExecutionGuard(guard){if(typeof guard!=='function')throw TypeError('Execution guard required');executionGuard=guard;},
  // Restricts approved Core reads using existing coordinator admission/checkpoint;
  // no callback, slot or quota is accepted from model inputs or durable grants.
  setReadContextResolver(resolve){if(typeof resolve!=='function')throw TypeError('Trusted read context resolver required');readContextResolver=resolve;},
  async prepareOperation(raw){
   const request=normalizeRequest(raw);
   if(request.actor.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Only Owner can establish an independent operation intent');
   const entry=registry.require(request.capability),identity=operationIdentity(request,entry);
   if(!identity||entry.delegatesOperation===true)throw capabilityError('INVALID_OPERATION_ID','Prepare a concrete capability operation');
   await policy.authorize(request,entry);await entry.validate?.(request);await policy.authorize(request,entry);
   const logicalStepId=request.logicalStepId;
   if(logicalStepId!==undefined&&(typeof logicalStepId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(logicalStepId)))
    throw capabilityError('INVALID_OPERATION_STEP','Logical step identity must be bounded and explicit');
   const previous=dispatches[identity.key];
   if(previous&&logicalStepId!==undefined&&previous.logicalStepId!==logicalStepId)
    throw capabilityError('OPERATION_STEP_CONFLICT','Existing operation cannot be rebound to another logical step');
   if(logicalStepId&&Object.values(dispatches).some(row=>row.operationId&&row.taskId===request.taskId
    &&row.workspaceId===request.workspaceId&&row.logicalStepId===logicalStepId&&row.operationId!==request.operationId))
    throw capabilityError('OPERATION_STEP_CONFLICT','Logical step is already bound to another operation');
   if(previous&&previous.fingerprint!==identity.fingerprint)throw capabilityError('REQUEST_ID_CONFLICT','Prepared operation parameters changed');
   if(previous)return {operationId:previous.operationId,status:previous.status,capability:previous.capability};
   if(Object.keys(dispatches).length>=50000)throw capabilityError('DISPATCH_JOURNAL_FULL','Capability dispatch journal needs Owner review');
   dispatches[identity.key]={operationId:request.operationId,fingerprint:identity.fingerprint,taskId:request.taskId,
    workspaceId:request.workspaceId,...(logicalStepId?{logicalStepId}:{}),capability:entry.id,descriptorVersion:entry.descriptorVersion??null,
    executorId:request.actor.id,status:'prepared',at:Date.now(),
    ...(safeContinuationInput(entry.id,request.input)?{continuationInput:safeContinuationInput(entry.id,request.input)}:{})};
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
  approvalDispatchReviewed(approvalId, request) {
   const alias=dispatches[aliasKey(request.requestId)];
   const row=dispatches[alias?.operationKey??request.requestId];
   return ['completed','reconciled'].includes(row?.status) && row.resolution==='owner-reviewed-no-replay'
    && row.authorization?.kind==='approval' && row.authorization.id===approvalId
    && row.requestId===request.requestId && row.capability===request.capability
    && row.taskId===request.taskId && row.workspaceId===(request.workspaceId??null);
  },
  uncertainDispatchesForTask:({taskId,workspaceId})=>Object.entries(dispatches)
   .filter(([,row])=>row?.taskId===taskId&&row.workspaceId===workspaceId&&['started','outcome-unknown'].includes(row.status))
   .map(([key,row])=>({requestId:row.requestId??key,capability:row.capability,status:row.status,at:row.at})),
  hasActiveDispatchForTask:({taskId,workspaceId})=>[...activeDispatches].some(key=>
   dispatches[key]?.taskId===taskId&&dispatches[key]?.workspaceId===workspaceId),
  verifyGitRecoveryBinding(binding){const row=verifiedGitDispatch(binding);if(activeDispatches.has(binding.key))throw capabilityError('OPERATION_STILL_RUNNING','Original Git invocation has not closed');
   if(!['outcome-unknown','completed','reconciled'].includes(row.status))throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Original dispatch has no eligible recovery outcome');return structuredClone(row);},
  gitMetadataRecovery(workspaceId,{currentBinding}={}){
   const unresolved=Object.entries(dispatches).filter(([,row])=>row.workspaceId===workspaceId&&row.capability==='git.branch.switch'
    &&row.gitMetadata&&['started','outcome-unknown'].includes(row.status));
   if(!unresolved.length)throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','No exact metadata-only Git operation requires completion');
   const original=unresolved[0][1].gitMetadata.original,chain=metadataChain(original);
   if(unresolved.some(([,row])=>row.gitMetadata.original.key!==original.key))throw capabilityError('WORKSPACE_OPERATION_UNCONFIRMED','Different Git metadata operations require their original owners');
   for(const [key,row] of chain){
    if(row.status==='failed-no-effect'&&!activeDispatches.has(key))continue;
    const current=currentBinding&&JSON.stringify(gitBinding(key,row))===JSON.stringify(currentBinding);
    if(!current&&(activeDispatches.has(key)||!row.gitMetadata.closed))throw capabilityError('EXECUTION_UNCONFIRMED','Exact metadata-only Git invocation has no persisted closure');
   }
   const input=retainedGitMetadataReview(original);
   return {kind:'metadata',dispatchBinding:structuredClone(original),metadataRecovery:input,
    closedBindings:chain.filter(([key,row])=>key!==currentBinding?.key&&['outcome-unknown','completed','reconciled'].includes(row.status)).map(([key,row])=>gitBinding(key,row)),count:chain.length};
  },
  closeGitMetadata(binding){
   const row=verifiedGitDispatch(binding);if(!row.gitMetadata)return;
   if(!activeDispatches.has(binding.key))throw capabilityError('EXECUTION_UNCONFIRMED','Only the active exact invocation can record awaited closure');
   row.gitMetadata.closed=true;
   try{writeJsonAtomic(dispatchFile,dispatches);}catch(error){row.gitMetadata.closed=false;throw error;}
  },
  gitApprovalReceipt(approvalId,request){
   const matches=Object.entries(dispatches).filter(([,row])=>row.capability==='git.branch.switch'
    &&row.authorization?.kind==='approval'&&row.authorization.id===approvalId);
   if(matches.length!==1)return null;
   const [key,row]=matches[0];if(activeDispatches.has(key))return null;
   if(request){
    if(request.capability!=='git.branch.switch')return null;
    const identity=operationIdentity(request,registry.require('git.branch.switch'));
    if(row.fingerprint!==(identity?.fingerprint??requestFingerprint(request))||row.requestId!==request.requestId
     ||row.workspaceId!==request.workspaceId||(row.taskId??null)!==(request.taskId??null))return null;
   }
   if(row.status==='completed'&&row.retainedResult?.phase==='completed')return structuredClone(row.retainedResult);
   if(row.status!=='reconciled'||row.resolution!=='owner-reviewed-no-replay'||!row.completionRequestId)return null;
   // settleDispatch persists this exact predecessor link and successor receipt
   // atomically. Retention of the consumed approval is not execution evidence.
   const successors=Object.entries(dispatches).filter(([,next])=>next.capability==='git.branch.switch'
    &&next.requestId===row.completionRequestId&&next.workspaceId===row.workspaceId&&(next.taskId??null)===(row.taskId??null));
   if(successors.length!==1)return null;
   const [nextKey,next]=successors[0];
   return !activeDispatches.has(nextKey)&&next.status==='completed'&&next.authorization?.kind==='approval'
    &&next.retainedResult?.phase==='completed'?structuredClone(next.retainedResult):null;
  },
  workspaceRecoveryBlocker({workspaceId,reviewedTaskId,closedGitBindings=[],currentGitBinding,overlaps=(left,right)=>left===right}) {
   for(const binding of closedGitBindings)verifiedGitDispatch(binding);
   if(currentGitBinding){
    if(currentGitBinding.capability==='git.checkpoint.restore'){
     // Only the live checkpoint invocation can exempt itself. Historical
     // checkpoint rows are never accepted as branch recovery bindings.
     if(!activeDispatches.has(currentGitBinding.key))throw capabilityError('WORKSPACE_RECOVERY_REQUIRED','Checkpoint invocation is not active');
     verifiedGitDispatch(currentGitBinding,'git.checkpoint.restore');
    }else verifiedGitDispatch(currentGitBinding);
   }
   for(const [key,row] of Object.entries(dispatches)) {
    if(!row?.workspaceId)continue;
    const active=activeDispatches.has(key);
    if(currentGitBinding&&key===currentGitBinding.key)continue;
    if(closedGitBindings.some(binding=>key===binding.key)&&!active)continue;
    // Include Owner effects without Task attribution. Only the inspected Task's
    // settled uncertainty belongs to its existing exact Owner review protocol.
    const reviewed=typeof reviewedTaskId==='string'&&row.taskId===reviewedTaskId;
    if(active||(!reviewed&&['started','outcome-unknown'].includes(row.status))) {
     if(!overlaps(row.workspaceId,workspaceId))continue;
     return {requestId:row.requestId??key,taskId:row.taskId??null,capability:row.capability,status:row.status,active};
    }
   }
   return null;
  },
  operationsForTask:({taskId,workspaceId})=>Object.values(dispatches).filter(row=>row.operationId&&row.taskId===taskId&&row.workspaceId===workspaceId)
   .map(({operationId,logicalStepId,capability,status,at,executorId,attemptId,requestId,blocker,continuationInput})=>({operationId,logicalStepId,capability,status,at,executorId,attemptId,requestId,blocker,...(safeContinuationInput(capability,continuationInput)?{continuationInput:safeContinuationInput(capability,continuationInput)}:{})})),
  operationRecordForStep:({taskId,workspaceId,logicalStepId})=>{
   const rows=Object.values(dispatches).filter(row=>row.operationId&&row.logicalStepId===logicalStepId
    &&row.taskId===taskId&&row.workspaceId===workspaceId);
   if(rows.length>1)throw capabilityError('OPERATION_STEP_CONFLICT','Logical step has ambiguous operation bindings');
   return rows.length?structuredClone(rows[0]):null;
  },
  operationRecordForTask:({taskId,workspaceId,operationId})=>{
   const row=Object.values(dispatches).find(row=>row.operationId===operationId&&row.taskId===taskId&&row.workspaceId===workspaceId);
   return row?structuredClone(row):null;
  },
  acknowledgeTaskOperations:({taskId,workspaceId,approvalIds=[]})=>{
   const rows=Object.entries(dispatches).filter(([,row])=>row?.taskId===taskId&&row.workspaceId===workspaceId
    &&(['started','outcome-unknown'].includes(row.status) || (row.status==='completed'
      && row.authorization?.kind==='approval' && approvalIds.includes(row.authorization.id)
      && row.resolution!=='owner-reviewed-no-replay')));
   if(rows.some(([key])=>activeDispatches.has(key)))throw capabilityError('OPERATION_STILL_RUNNING','The original operation has not settled');
   const prior=rows.map(([,row])=>({status:row.status,resolution:row.resolution}));
   for(const [,row]of rows){if(row.status!=='completed')row.status='reconciled';row.resolution='owner-reviewed-no-replay';}
   try{if(rows.length&&dispatchFile)writeJsonAtomic(dispatchFile,dispatches);}catch(error){
    rows.forEach(([,row],i)=>{row.status=prior[i].status;if(prior[i].resolution===undefined)delete row.resolution;else row.resolution=prior[i].resolution;});throw error;
   }
   return {reconciled:rows.length};
  },
  async decide({id,approve,actor},{signal}={}){
  if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner approval required');
  let readContext=null;
  if(approve){
   const pending=approval.get(id);
   try{await policy.authorize(pending.request,registry.require(pending.request.capability));}
   catch(error){approval.revoke(id,error.code??'authorization-changed');throw error;}
   if(['filesystem.read','filesystem.search'].includes(pending.request.capability)){
    readContext=await readContextResolver?.({approvalId:id,request:pending.request});
    if(pending.request.origin?.readBatch&&typeof readContext?.consumeReadBytes!=='function')throw capabilityError('BATCH_CONTEXT_UNAVAILABLE','Restore the bound batch checkpoint before approving this source read');
   }
  }
  const row=approval.decide(id,approve,actor);
  if(!approve){if(registry.has(row.request.capability))markOperationBlocker(row.request,registry.require(row.request.capability),'permission',true);return {status:'rejected',approvalId:id};}
  try{return await execute({...row.request,approvalId:id},{signal,...(readContext??{})});}
  catch(error){approval.revoke(id,error.code??'execution-failed');throw error;}
 }};
}
