import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createCetaMeshServices} from '../src/app/service-container.js';
import {SIMULATION_UI_METHODS} from '../src/simulation/ui-methods.js';
const nativePolicy=fs.readFileSync(new URL('../desktop-shell/src/webview_policy.rs',import.meta.url),'utf8');
const nativeMethods=new Set([...nativePolicy.matchAll(/"(ui\.[a-zA-Z.]+)"/g)].map(m=>m[1]));
for(const method of SIMULATION_UI_METHODS)assert.ok(nativeMethods.has('ui.simulation.'+method),'Native WebView2 must allow the exact trusted Simulation method: '+method);
assert.ok(!nativePolicy.split('#[cfg(test)]')[0].includes('starts_with("ui.simulation.")'),'unknown Simulation native methods must remain denied');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-simulation-'));
const services=createCetaMeshServices({stateDir:path.join(root,'state'),dataRoot:root,resourceRoot:root,sourceRoot:root,deferOptionalStart:true});
const ui=(method,params={})=>services.desktopUiService.execute({method,params});
try {
  assert.ok(services.simulationService,'Native Simulation must be composed without QQ or DSH readiness');
  services.providerSecrets.set({provider:'deepseek-official',apiKey:'synthetic-not-used'});
  const officialProfile=services.modelRegistry.require('deepseek-official').contextCapabilities('deepseek-flash');
  assert.equal(officialProfile.outputTokenParameter,'max_tokens','official DeepSeek must honor explicit bounded Simulation output');
  let calls=0;
  services.modelRegistry.register({id:'simulation-fixture',label:'Simulation local fixture',defaultModel:'fixture',supportsTools:false,
    health:async()=>({available:true}),listModels:async()=>[{id:'fixture'}],
    chat:async args=>{calls++;assert.equal(args.tools,undefined);return {text:'鲸收到啦，这只是讨论，工程结果等真实验收。',usage:{inputTokens:100,outputTokens:20,totalTokens:120}};},
    stream:async function*(){throw Error('discussion must use existing model chat entry');}});
  services.providerSecrets.set({provider:'simulation-fixture',apiKey:'synthetic-local-only'});
  const saved=await ui('ui.simulation.role.save',{name:'鲸',sourceText:'你是鲸。保留口语习惯，不自称完成真实工程。'});
  const made=await ui('ui.simulation.room.create',{title:'本地仿真',scene:'free',roleIds:[saved.role.id],modelProvider:'simulation-fixture',model:'fixture'});
  const sent=await ui('ui.simulation.message.send',{roomId:made.room.id,text:'你好',requestId:'native-integration-1'});
  let room=sent.room;
  for(let i=0;i<100;i++){room=(await ui('ui.simulation.room.get',{roomId:room.id})).room;if(room.status!=='running')break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(calls,1);assert.ok(room.messages.some(m=>m.roleId===saved.role.id&&m.text.includes('鲸收到')));
  assert.equal((await ui('ui.simulation.overview')).rooms.length,1);
  await ui('ui.simulation.message.send',{roomId:room.id,text:'你好',requestId:'native-integration-1'});assert.equal(calls,1);
  await assert.rejects(ui('ui.simulation.project.create',{roomId:room.id,requestId:'no-workspace'}),{code:'SIMULATION_WORKSPACE_REQUIRED'});
  console.log('PASS Core → trusted UI → Model Runtime Simulation without QQ/DSH; no persona tool execution or duplicate request.');
} finally {
  await services.simulationService?.close();
  await Promise.all([services.chatService.close(),services.agentService.close(),services.extensionService.close(),services.pluginCenterService.close(),services.managedAgent.close(),services.channelService.close(),services.bionicService.close(),services.meshService.close(),services.integrationService.close(),services.autonomousHandoff.close()]);
  fs.rmSync(root,{recursive:true,force:true});
}
