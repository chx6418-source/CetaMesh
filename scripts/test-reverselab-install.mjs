import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createWorkspaceService} from '../src/workspace/index.js';
import {createExtensionService} from '../src/extension/service.js';
import {installReverseLabPlugin} from './reverselab/install-plugin.mjs';
import {acquireStateOwner} from '../src/app/state-owner.js';

const base=fs.mkdtempSync(path.join(os.tmpdir(),'reverselab-install-')),stateDir=path.join(base,'state'),project=path.join(base,'project');
for(const name of ['apps','results'])fs.mkdirSync(path.join(project,name),{recursive:true});
const preserved=path.join(project,'results','keep.txt');fs.writeFileSync(preserved,'user result retention');
try{
  const workspaceService=createWorkspaceService({stateDir});
  const ws=(await workspaceService.execute({method:'workspace.create',params:{root:project,name:'Install binding'}})).workspace;
  const selection={stateDir,workspaceId:ws.id,paths:['apps','results']};
  const review=await installReverseLabPlugin(selection);
  assert.equal(review.status,'REVIEW_REQUIRED');
  assert.equal(review.manifest.scope.workspace,ws.id);
  await assert.rejects(installReverseLabPlugin({...selection,paths:['apps'],approveReview:review.review.review.token}),{code:'REVIEW_MISMATCH'});
  const installed=await installReverseLabPlugin({...selection,approveReview:review.review.review.token});
  assert.equal(installed.status,'INSTALLED_DISABLED');
  const extensions=createExtensionService({stateDir});
  try{
    const entry=extensions.store.get('org.cetamesh.reverselab');
    assert.equal(entry.status,'installed');assert.equal(entry.manifest.scope.workspace,ws.id);
    await extensions.execute({method:'ext.enable',params:{id:entry.id}});
    assert.equal(extensions.store.get(entry.id).status,'enabled');
  }finally{await extensions.close();}
  await installReverseLabPlugin({stateDir,uninstall:true});
  const check=createExtensionService({stateDir});
  try{assert.equal(check.store.get('org.cetamesh.reverselab'),null);}finally{await check.close();}
  assert.equal(fs.readFileSync(preserved,'utf8'),'user result retention');
  fs.writeFileSync(path.join(stateDir,'extensions','registry.json'),'{');
  await assert.rejects(installReverseLabPlugin(selection));
  const released=acquireStateOwner(stateDir);released.release();
  console.log('PASS supported installer binds existing Workspace, rejects changed review scope, installs disabled, enables normally and uninstalls preserving user results');
}finally{assert.ok(path.basename(base).startsWith('reverselab-install-'));fs.rmSync(base,{recursive:true,force:true});}
