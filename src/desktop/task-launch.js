import crypto from 'node:crypto';
import fs from 'node:fs';
import {resolveInside} from '../workspace/boundary.js';
import {gitStatus} from '../workspace/tools.js';
import {normalizeDelegationVerification} from '../task/delegation-verification.js';

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
/** Renderer intent only. Core derives all authority, hashes and operation identities. */
export function normalizeTaskCollaboration(value) {
 if(value==null)return null;
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['enabled','allowUnknownCost','prepareNative','verification'].includes(k))
  ||typeof value.enabled!=='boolean'||typeof value.allowUnknownCost!=='boolean'||typeof value.prepareNative!=='boolean')fail('INVALID_TASK_COLLABORATION','Collaboration requires explicit bounded choices');
 if(!value.enabled){if(value.allowUnknownCost||value.prepareNative||value.verification!=null)fail('INVALID_TASK_COLLABORATION','Disabled collaboration grants no additional authority');return {enabled:false,allowUnknownCost:false,prepareNative:false};}
 const result={enabled:true,allowUnknownCost:value.allowUnknownCost,prepareNative:value.prepareNative};
 if(value.verification!=null){const v=value.verification;
  if(typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['editablePaths','testFiles'].includes(k))||!Array.isArray(v.editablePaths)||!Array.isArray(v.testFiles))fail('INVALID_DELEGATION_VERIFICATION','Exact edit paths and fixed test files are required');
  const files=['package.json',...v.testFiles.filter(f=>f!=='package.json')];
  normalizeDelegationVerification({kind:'code-tests',operationId:'launch-validation',acceptanceIds:['machine'],allowedPaths:v.editablePaths,unchangedFiles:files.map(path=>({path,sha256:'0'.repeat(64)}))},[{id:'machine'}]);
  result.verification={editablePaths:[...v.editablePaths].sort(),testFiles:files.filter(f=>f!=='package.json').sort()};
 }
 return result;
}
export function taskLaunchFingerprint(collaboration,{modelProvider,model}={}) {
 if(collaboration==null&&!modelProvider&&!model)return null;
 return crypto.createHash('sha256').update(JSON.stringify({collaboration,modelProvider:modelProvider||null,model:model||null})).digest('hex');
}
export async function snapshotTaskVerification(services,workspaceId,collaboration) {
 if(!collaboration?.verification)return null;
 const workspace=services.workspaceService.describeWorkspace(workspaceId);
 if(!workspace?.root)fail('WORKSPACE_NOT_FOUND','Machine criteria need a registered Workspace');
 const status=await gitStatus(workspace.root,{completeFiles:true});
 if(!status.isRepo||status.entries.length)fail('TASK_VERIFICATION_BASELINE_REQUIRED','自动验收需要干净的 Git 基线；请先核对已有改动，或使用人工验收');
 const files=['package.json',...collaboration.verification.testFiles];
 const unchangedFiles=files.map(path=>{const file=resolveInside(workspace.root,path);if(!fs.lstatSync(file.absolute).isFile()||fs.statSync(file.real).size>16*1024*1024)fail('INVALID_DELEGATION_VERIFICATION','Verification files must be bounded regular files');
  return {path,sha256:crypto.createHash('sha256').update(fs.readFileSync(file.real)).digest('hex')};});
 return {allowedPaths:collaboration.verification.editablePaths,unchangedFiles};
}
export async function configureTaskCollaboration(services,task,{collaboration,verification,modelProvider,model}={}) {
 if(!collaboration?.enabled)return task;
 const rt=services.taskService.runtime;
 task=rt.setModelConfig({id:task.id,expectedRev:task.rev,modelProvider,model});
 let contract=null;
 if(verification){
  const operationId='verify:'+crypto.createHash('sha256').update(task.id).digest('hex').slice(0,40);
  services.capabilityService.grantTask(task.id,{capabilities:[...services.capabilityService.principalForTask(task.id).grants.capabilities,'test.run']});
  await services.capabilityService.execute({method:'capability.operation.prepare',params:{taskId:task.id,workspaceId:task.workspaceId,operationId,capability:'test.run',input:{tool:'npm',args:['test'],timeoutMs:120000}}});
  contract={kind:'code-tests',operationId,acceptanceIds:task.acceptance.map(row=>row.id),...verification};
 }
 return (await services.capabilityService.execute({method:'capability.delegation.authorize',params:{taskId:task.id,expectedRev:task.rev,policy:{expiresAt:Date.now()+1800000,maxDelegations:1,allowUnknownCost:collaboration.allowUnknownCost,prepareNative:collaboration.prepareNative,...(contract?{verification:contract}:{})}}})).task;
}
