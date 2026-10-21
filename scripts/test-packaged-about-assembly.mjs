import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCetaMeshServices}from '../src/app/service-container.js';
import {writeJsonAtomic}from '../src/storage/json-file.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'m6b-about-'));
const executableDir=path.join(root,'installed'),dataRoot=path.join(root,'user-data'),resourceRoot=path.join(executableDir,'resources');
fs.mkdirSync(resourceRoot,{recursive:true});fs.mkdirSync(dataRoot,{recursive:true});
const build={version:'1.0.0-rc.2',buildNumber:1087,channel:'rc',commit:'a'.repeat(40),sourceCommit:'a'.repeat(40),buildId:'fixture-installed-build',dirty:false};
writeJsonAtomic(path.join(executableDir,'build-info.json'),build);
writeJsonAtomic(path.join(dataRoot,'build-info.json'),{...build,version:'9.9.9',buildNumber:9999,commit:'b'.repeat(40)});
writeJsonAtomic(path.join(dataRoot,'release/version.json'),{productVersion:'9.9.9',buildNumber:9999,channel:'dev'});
const services=createCetaMeshServices({packaged:true,executableDir,sourceRoot:dataRoot,resourceRoot,dataRoot,stateDir:path.join(dataRoot,'state')});
try{
 const info=services.aboutService.about.info();
 assert.equal(info.version,build.version,'packaged Core metadata must come from installed executable directory, not source/CWD/data roots');
 assert.equal(info.buildNumber,build.buildNumber);assert.equal(info.channel,'rc');assert.equal(info.build.commit,build.commit);
 const view=await services.desktopUiService.execute({method:'ui.about.info',params:{}});
 assert.equal(view.version,build.version);assert.equal(view.buildNumber,build.buildNumber);
 console.log('PASS actual service assembly: packaged About and Harbor projection use immutable installed build metadata');
}finally{
 await services.chatService.close();await services.agentService.close();await services.managedAgent.close();await services.capabilityService.close();await services.pluginCenterService.close();await services.extensionService.close();await services.channelService.close();await services.bionicService.close();
 if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith('m6b-about-'))throw Error('fixture cleanup boundary');
 fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
