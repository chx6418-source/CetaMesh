import crypto from 'node:crypto';
import fs from 'node:fs';
import {resolveInside} from '../workspace/boundary.js';
import {gitStatus} from '../workspace/tools.js';
import {taskError} from './types.js';
import {verifyTaskOutcome} from './outcome-verification.js';
const review=reason=>({status:'NEEDS_REVIEW',kind:'code',evidenceEventIds:[],reasons:[reason]});
function safePath(value){return typeof value==='string'&&value.length>0&&value.length<=240&&!value.includes('\\')&&!value.includes(':')
 &&!value.startsWith('/')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!/^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|credentials?|secrets?)$/i.test(part));}
export function normalizeDelegationVerification(value,acceptance=[]) {
 if(value==null)return null;
 const ids=acceptance.map(row=>row.id);
 if(!value||typeof value!=='object'||Array.isArray(value)||value.kind!=='code-tests'
  ||Object.keys(value).some(key=>!['kind','operationId','acceptanceIds','allowedPaths','unchangedFiles'].includes(key))
  ||typeof value.operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value.operationId)
  ||!Array.isArray(value.acceptanceIds)||!ids.length||value.acceptanceIds.length!==ids.length
  ||new Set(value.acceptanceIds).size!==ids.length||ids.some(id=>!value.acceptanceIds.includes(id))
  ||!Array.isArray(value.allowedPaths)||!value.allowedPaths.length||value.allowedPaths.length>30||!value.allowedPaths.every(safePath)
  ||new Set(value.allowedPaths).size!==value.allowedPaths.length
  ||!Array.isArray(value.unchangedFiles)||value.unchangedFiles.length<2||value.unchangedFiles.length>30
  ||!value.unchangedFiles.some(row=>row.path==='package.json')
  ||new Set(value.unchangedFiles.map(row=>row.path)).size!==value.unchangedFiles.length
  ||value.unchangedFiles.some(row=>!safePath(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256??'')||value.allowedPaths.includes(row.path)))
  throw taskError('INVALID_DELEGATION_VERIFICATION','Owner verification must cover every acceptance criterion with fixed tests, exact file scope and immutable verifier hashes');
 return {kind:'code-tests',operationId:value.operationId,acceptanceIds:[...value.acceptanceIds],allowedPaths:[...value.allowedPaths],
  unchangedFiles:value.unchangedFiles.map(row=>({path:row.path,sha256:row.sha256}))};
}
function fileHash(root,relative){const resolved=resolveInside(root,relative);
 if(!fs.lstatSync(resolved.absolute).isFile()||fs.statSync(resolved.real).size>16*1024*1024)throw Error('not a bounded regular file');
 return crypto.createHash('sha256').update(fs.readFileSync(resolved.real)).digest('hex');}
/** Only Owner-declared machine criteria can bypass a further semantic review. */
export async function verifyDelegationContract(task,{workspaceRoot}={}) {
 let contract;try{contract=normalizeDelegationVerification(task.delegationPolicy?.verification,task.acceptance);}catch{return review('VERIFICATION_CONTRACT_INVALID');}
 if(!contract||!workspaceRoot)return review('OWNER_MACHINE_VERIFICATION_NOT_CONFIGURED');
 const evidence=task.executionEvidence??[],proposal=task.delegationProposal,verifiedImportEventIds=[];
 const test=evidence.findLast(row=>row.capability==='test.run');
 if(test?.source!=='core-test'||test.operationId!==contract.operationId||test.runId!==proposal?.verificationRunId
  ||test.provider!=='cetamesh'||test.sessionId!==task.currentAgent?.sessionId||test.status!=='completed'||test.exitCode!==0)
  return review('CURRENT_CORE_TEST_NOT_VERIFIED');
 try{
  for(const item of contract.unchangedFiles)if(fileHash(workspaceRoot,item.path)!==item.sha256)return review('VERIFIER_CONTENT_CHANGED');
  const status=await gitStatus(workspaceRoot,{completeFiles:true});
  if(!status.isRepo||!status.entries.length||status.entries.some(row=>row.origPath||!contract.allowedPaths.includes(row.path)))return review('FILE_SCOPE_NOT_VERIFIED');
  const imported=new Map();
  for(const row of evidence)if(row.source==='core-import'&&row.status==='completed')for(const change of row.changes??[])imported.set(change.path,{...change,eventId:row.eventId});
  for(const item of contract.unchangedFiles)if(fileHash(workspaceRoot,item.path)!==item.sha256)return review('VERIFIER_CONTENT_CHANGED');
  for(const row of status.entries){const change=imported.get(row.path);
   if(change?.action!=='write'||fileHash(workspaceRoot,row.path)!==change.sha256)return review('CURRENT_IMPORTED_FILE_NOT_VERIFIED');
   verifiedImportEventIds.push(change.eventId);}
 }catch{return review('VERIFICATION_RESOURCE_UNAVAILABLE');}
 const result=verifyTaskOutcome({...task,acceptance:task.acceptance.map(row=>({...row,met:true}))},{kind:'code'},{workspaceRoot,verifiedImportEventIds:[...new Set(verifiedImportEventIds)]});
 return result.status==='VERIFIED'?{...result,machineAcceptanceIds:contract.acceptanceIds}:result;
}
