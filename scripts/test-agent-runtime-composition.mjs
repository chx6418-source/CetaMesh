import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCetaMeshServices } from '../src/app/service-container.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-agent-composition-'));
let services;
try {
 const stateDir=path.join(root,'state'),dataRoot=path.join(root,'data');
 services=createCetaMeshServices({stateDir,dataRoot});
 const fixtureKey='fixture-not-a-real-provider-credential';
 for(const provider of ['gemini','opencode','qwen','claude']) {
  await services.settingsService.execute({method:'settings.update',params:{section:'agents',values:{defaultAgentProvider:provider}}});
  assert.equal(services.settingsService.store.get().settings.agents.defaultAgentProvider,provider,'each connected provider is a valid saved default');
 }
 const result=await services.desktopUiService.execute({method:'ui.agent.configure',params:{provider:'opencode',config:{runtimePath:path.join(root,'absent-runtime.exe'),model:'fixture-model',apiKey:fixtureKey,baseUrl:'https://api.example.invalid/v1'}}});
 assert.equal(result.supported,true);assert.equal(result.configuration.model,'fixture-model');
 assert.equal(result.configuration.credentialConfigured,true);
 assert.equal(JSON.stringify(result).includes(fixtureKey),false);
 const health=await services.agentService.execute({method:'agent.health',params:{provider:'opencode',refresh:true}});
 assert.equal(health.runtimeConfiguration.model,'fixture-model');
 assert.equal(health.runtimeConfiguration.executionMode,'native-permissions');
 assert.equal(health.available,false,'a missing actual runtime never becomes ready from saved settings');
 assert.equal(JSON.stringify(health).includes(fixtureKey),false);
 const stored=fs.readFileSync(path.join(stateDir,'agent-runtimes.json'),'utf8');
 assert.equal(stored.includes(fixtureKey),false);
 assert.equal(typeof services.capabilityService.requestAgentNativeApproval,'function');
 assert.equal(services.capabilityService.broker.registry.require('agent.native.approve').modelCallable,false);
 const corruptState=path.join(root,'corrupt-state');fs.mkdirSync(corruptState);fs.writeFileSync(path.join(corruptState,'agent-runtimes.json'),'{broken');
 const unaffected=createCetaMeshServices({stateDir:corruptState,dataRoot:path.join(root,'corrupt-data')});
 try {
   const rows=await unaffected.agentService.execute({method:'agent.list'});
   const list=Array.isArray(rows)?rows:rows.providers;
   for(const provider of ['gemini','opencode','qwen','claude']) {
     const row=list.find(item=>item.id===provider);assert.equal(row.available,false,provider+' corrupt optional configuration must fail closed');
     assert.match(row.reason,/agent_runtime_config_corrupt/i,provider+' startup must preserve a useful configuration error');
   }
   assert.equal(fs.readFileSync(path.join(corruptState,'agent-runtimes.json'),'utf8'),'{broken','malformed configuration is preserved for recovery');
 } finally {await unaffected.capabilityService.close();await unaffected.agentService.close();}
 console.log('PASS production setup reaches owned runtime configuration and credential vault without enabling missing runtimes or returning secrets');
} finally {
 if(services){await services.capabilityService.close();await services.agentService.close();}
 fs.rmSync(root,{recursive:true,force:true});
}
