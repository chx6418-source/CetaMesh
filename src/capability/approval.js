import path from 'node:path';import crypto from 'node:crypto';
import {capabilityError} from './types.js';
import {readJsonFile,writeJsonAtomic} from '../storage/json-file.js';
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));return value;}
export const requestFingerprint=request=>{const {approvalId,approved,...bound}=request;return crypto.createHash('sha256').update(JSON.stringify(canonical(bound))).digest('hex');};
const grantFingerprint=(request,entry,binding)=>requestFingerprint({actor:request.actor,taskId:request.taskId,
 workspaceId:request.workspaceId,capability:entry.id,permission:entry.permission,risk:entry.risk,
 descriptorVersion:entry.descriptorVersion??null,input:request.input,scope:request.scope??null,binding});
export function createCapabilityApproval({stateDir,now=()=>Date.now(),ttlMs=600000}={}){
 const file=stateDir?path.join(stateDir,'capability','approvals.json'):null;
 let rows=[];
 if(file){rows=readJsonFile(file,{missing:[]});if(!Array.isArray(rows))throw capabilityError('APPROVAL_STORE_CORRUPT','Invalid approval store');}
 function save(){if(file)writeJsonAtomic(file,rows);}
 function requireRow(id){const row=rows.find(r=>r.id===id);if(!row)throw capabilityError('APPROVAL_NOT_FOUND',id);return row;}
 function mutateGrant(row,change){const backup=structuredClone(row);Object.assign(row,change);try{save();}catch(error){Object.keys(row).forEach(key=>delete row[key]);Object.assign(row,backup);throw error;}}
 function validateGrant(id,request,entry,binding){
  const row=requireRow(id);
  if(row.kind!=='bounded-grant'||row.status!=='active'||row.expiresAt<=now()
    ||row.fingerprint!==grantFingerprint(request,entry,binding))throw capabilityError('GRANT_EXPIRED','Grant revoked, expired or its exact execution scope changed');
  return row;
 }
 const grantMethods={
  issueGrant({actor,request,entry,binding,ttlMs,maxUses}){
   if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner must issue bounded grants');
   if(!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>900000||!Number.isSafeInteger(maxUses)||maxUses<1||maxUses>20)
    throw capabilityError('INVALID_GRANT','Grant lifetime must be 1s–15min and uses 1–20');
   if(rows.length>=1000)throw capabilityError('APPROVAL_STORE_FULL','Review approval history before issuing another grant');
   const row={id:crypto.randomUUID(),kind:'bounded-grant',status:'active',createdAt:now(),expiresAt:now()+ttlMs,
    fingerprint:grantFingerprint(request,entry,binding),capability:entry.id,taskId:request.taskId,workspaceId:request.workspaceId,
    resource:request.input.path,issuedBy:actor.id,uses:0,maxUses};
   rows.push(row);try{save();}catch(error){rows.pop();throw error;}
   const {fingerprint,...summary}=row;return structuredClone(summary);
  },
  consumeGrant(request,entry,binding){
   const fingerprint=grantFingerprint(request,entry,binding);
   const row=rows.find(r=>r.kind==='bounded-grant'&&r.status==='active'&&r.expiresAt>now()&&r.uses<r.maxUses&&r.fingerprint===fingerprint);
   if(!row)return null;mutateGrant(row,{uses:row.uses+1,lastUsedAt:now()});return row.id;
  },
  validateGrant,
  listGrants:()=>rows.filter(row=>row.kind==='bounded-grant').map(({fingerprint,...summary})=>structuredClone(summary)),
  revokeGrant(id,actor){
   if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner must revoke bounded grants');
   const row=requireRow(id);if(row.kind!=='bounded-grant')throw capabilityError('INVALID_GRANT','Not a bounded grant');
   mutateGrant(row,{status:'revoked',revokedAt:now(),revokedBy:actor.id});return {id,status:row.status};
  }
 };
 return {...grantMethods,pending(request){const fingerprint=requestFingerprint(request);const existing=rows.find(r=>r.fingerprint===fingerprint&&r.status==='pending'&&r.expiresAt>now());if(existing)return structuredClone(existing);const row={id:crypto.randomUUID(),fingerprint,request:structuredClone(request),status:'pending',createdAt:now(),expiresAt:now()+ttlMs};rows.push(row);if(rows.length>1000)rows=rows.filter(r=>r.kind==='bounded-grant'&&r.status==='active'&&r.expiresAt>now()||r.status==='pending'||r.createdAt>now()-86400000).slice(-1000);save();return structuredClone(row);},list:()=>rows.filter(r=>r.status==='pending'&&r.expiresAt>now()).map(r=>structuredClone(r)),decide(id,approve,actor){if(actor?.kind!=='owner')throw capabilityError('PERMISSION_DENIED','Owner approval required');const row=requireRow(id);if(row.kind==='bounded-grant')throw capabilityError('INVALID_GRANT','Use bounded grant controls');if(row.status!=='pending')throw capabilityError('APPROVAL_ALREADY_DECIDED',id);if(row.expiresAt<=now())throw capabilityError('APPROVAL_EXPIRED',id);row.status=approve?'approved':'rejected';row.decidedBy=actor.id;row.decidedAt=now();save();return structuredClone(row);},cancel(id,reason='cancelled'){const row=requireRow(id);if(row.status!=='pending')return {cancelled:false,status:row.status};row.status='cancelled';row.cancelReason=String(reason).slice(0,200);row.cancelledAt=now();save();return {cancelled:true,status:row.status};},revoke(id,reason='binding-changed'){const row=requireRow(id);if(!['pending','approved'].includes(row.status))return {revoked:false,status:row.status};row.status='revoked';row.revokeReason=String(reason).slice(0,200);row.revokedAt=now();save();return {revoked:true,status:row.status};},consume(id,request){const row=requireRow(id);if(row.fingerprint!==requestFingerprint(request))throw capabilityError('APPROVAL_MISMATCH','Request changed');if(row.status!=='approved')throw capabilityError('APPROVAL_NOT_APPROVED',id);if(row.expiresAt<=now())throw capabilityError('APPROVAL_EXPIRED',id);row.status='consumed';save();},get:id=>structuredClone(requireRow(id))};
}
