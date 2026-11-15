import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {acquireStateOwner} from '../../src/app/state-owner.js';
import {createWorkspaceService} from '../../src/workspace/index.js';
import {createExtensionService} from '../../src/extension/service.js';
import {prepareReverseLabPlugin} from './prepare-plugin.mjs';
import {REVERSELAB_ID} from '../../src/reverselab/contracts.js';

export async function installReverseLabPlugin({stateDir,workspaceId,paths,approveReview,uninstall=false}){
  const owner=acquireStateOwner(stateDir);
  let extensions;
  try{
    extensions=createExtensionService({stateDir});
    if(uninstall)return await extensions.execute({method:'ext.uninstall',params:{id:REVERSELAB_ID}});
    const workspaceService=createWorkspaceService({stateDir});
    const staging=path.join(stateDir,'extensions','install-source','reverselab');fs.mkdirSync(staging,{recursive:true});
    const prepared=prepareReverseLabPlugin({workspaceService,workspaceId,paths,outputRoot:path.join(staging,crypto.randomUUID())});
    const review=await extensions.execute({method:'ext.review',params:{sourceDir:prepared.sourceDir}});
    if(!approveReview)return {status:'REVIEW_REQUIRED',workspaceId,paths,manifest:prepared.manifest,review,sourceDir:prepared.sourceDir,
      next:'Repeat the same workspace and paths with --approve-review '+review.review.token};
    if(approveReview!==review.review.token)throw Object.assign(new Error('Workspace, paths or package differs from the reviewed selection.'),{code:'REVIEW_MISMATCH'});
    const installed=await extensions.execute({method:'ext.install',params:{sourceDir:prepared.sourceDir,approval:{approved:true,token:approveReview}}});
    // Retain standard installed/disabled state. Enable through the ordinary CetaMesh plugin entry.
    return {status:'INSTALLED_DISABLED',installed,workspaceId,paths};
  }finally{await extensions?.close();owner.release();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i++){
    if(args[i]==='--uninstall'){options.uninstall=true;continue;}
    const key={'--state-dir':'stateDir','--workspace':'workspaceId','--paths':'paths','--approve-review':'approveReview'}[args[i]];
    if(!key||!args[i+1])throw Error('Usage: install-plugin.mjs --state-dir DIR --workspace ID --paths apps,results [--approve-review TOKEN] [--uninstall]');
    options[key]=args[++i];
  }
  if(!options.stateDir)throw Error('An explicit development StateDir is required. Close that Core before installing.');
  options.stateDir=path.resolve(options.stateDir);options.paths=options.paths?.split(',').map(p=>p.trim());
  console.log(JSON.stringify(await installReverseLabPlugin(options),null,2));
}
