import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import https from 'node:https';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stageClaudeSdkResource} from './claude-sdk-resource.mjs';
import {createClaudeRuntimeVerifier} from '../src/agent/claude-runtime.js';
import {createAcpProcessLauncher} from '../src/agent/acp-provider-descriptors.js';
import {createCetaMeshServices} from '../src/app/service-container.js';
if(process.env.WHALEBRIDGE_TEST_REAL_CLAUDE!=='1'){console.log('NOT_RUN_ENVIRONMENT real Claude CLI + local synthetic model opt-in required');process.exit(77);}
const executable=process.env.WHALEBRIDGE_TEST_CLAUDE_AUTH_EXECUTABLE,sdkSource=process.env.WHALEBRIDGE_TEST_CLAUDE_SDK_SOURCE;
const openssl='C:/Program Files/Git/usr/bin/openssl.exe';
if(process.platform!=='win32'||!executable||!sdkSource||!fs.existsSync(openssl)){console.log('NOT_RUN_ENVIRONMENT exact Claude CLI, SDK source and local TLS test utility required');process.exit(77);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-real-claude-')),project=path.join(root,'project'),stateDir=path.join(root,'state'),resourceRoot=path.join(root,'resources'),staging=path.join(root,'staging');
for(const dir of [project,stateDir,resourceRoot,staging])fs.mkdirSync(dir);
fs.writeFileSync(path.join(project,'input.txt'),'real Claude controlled read');
fs.writeFileSync(path.join(project,'check.cjs'),"const fs=require('node:fs');if(fs.readFileSync('output.txt','utf8')!=='verified edit')throw Error('bad output');console.log('CONTROLLED_TEST_PASS');\n");
await stageClaudeSdkResource(sdkSource,resourceRoot);
const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
execFileSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{windowsHide:true,stdio:'ignore'});
const checked=await createClaudeRuntimeVerifier({resourceRoot}).inspect(executable);assert.equal(checked.reason,null);assert.equal(checked.version,'2.1.308');
const secret='synthetic-local-claude-only';let core,stage,scenario='read',step=0,serverFailure,requests=0;const receipts=[];
const server=https.createServer({key:fs.readFileSync(key),cert:fs.readFileSync(cert)},async(req,res)=>{try{
 let source='';for await(const chunk of req){source+=chunk;if(source.length>4*1024*1024)throw Error('Request bound');}
 if(req.url.includes('count_tokens')){res.setHeader('content-type','application/json');res.end('{"input_tokens":20}');return;}
 const body=JSON.parse(source);requests++;assert.equal(req.headers['x-api-key'],secret);assert.equal(body.model,'claude-sonnet-4-6');
 const content=body.messages?.at(-1)?.content??[],results=Array.isArray(content)?content.filter(item=>item.type==='tool_result'):[];
 if(results.length)receipts.push(...results);
 const tool=step++===0;const toolName=scenario==='read'?'Read':scenario==='test'?'Bash':'Write';
 const args=scenario==='read'?{file_path:path.join(stage,'input.txt')}:scenario==='test'?{command:'node check.cjs',description:'Run controlled local fixture test'}:{file_path:path.join(stage,scenario==='deny'?'denied.txt':'output.txt'),content:'verified edit'};
 const block=tool?{type:'tool_use',id:'call_'+scenario,name:toolName,input:args}:{type:'text',text:'Controlled turn complete'};
 const message={id:'msg_local_'+requests,type:'message',role:'assistant',model:body.model,content:[block],stop_reason:tool?'tool_use':'end_turn',stop_sequence:null,usage:{input_tokens:20,output_tokens:10}};
 if(!body.stream){res.setHeader('content-type','application/json');res.end(JSON.stringify(message));return;}
 res.writeHead(200,{'content-type':'text/event-stream'});const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
 emit('message_start',{message:{...message,content:[],stop_reason:null,usage:{input_tokens:20,output_tokens:0}}});
 emit('content_block_start',{index:0,content_block:tool?{...block,input:{}}:{type:'text',text:''}});
 emit('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:block.text}});
 emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:message.stop_reason,stop_sequence:null},usage:{output_tokens:10}});emit('message_stop',{});res.end();
 }catch(error){serverFailure=error;res.statusCode=500;res.end('local fixture failed');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const baseUrl='https://localhost:'+server.address().port;
const runner=fileURLToPath(new URL('./helpers/claude-native-fixture-runner.mjs',import.meta.url));
try{
 core=createCetaMeshServices({stateDir,dataRoot:path.join(root,'data'),resourceRoot,agentStagingRoot:staging,agentClaudeOptions:{
  createRunner:({envSource})=>{const launch=createAcpProcessLauncher({executable:process.execPath,argv:[runner,resourceRoot,cert],envSource});return binding=>{stage=binding.cwd;return launch(binding);};}}});
 await core.agentService.execute({method:'agent.configure',params:{provider:'claude',settings:{runtimePath:executable,model:'claude-sonnet-4-6',baseUrl,apiKey:secret}}});
 const ui=(method,params)=>core.desktopUiService.execute({method,params});
 const {workspace}=await core.workspaceService.execute({method:'workspace.create',params:{root:project,name:'Claude real CLI fixture'}});
 const task=core.taskService.runtime.create({goal:'Read, edit and test via real Claude',workspaceId:workspace.id,requestedAgentProvider:'claude'});
 core.capabilityService.grantTask(task.id,{capabilities:['filesystem.read','filesystem.write','filesystem.search','test.run']});
 await core.agentService.broker.health('claude');const scope=core.agentService.broker.describeExecutionSecurity('claude',workspace.id);core.agentService.broker.authorizeExecution('claude',workspace.id,scope.fingerprint);
 async function waitFor(fn,label){const deadline=Date.now()+45000;while(Date.now()<deadline){if(serverFailure)throw serverFailure;const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out: '+label);}
 let session;
 async function turn(name){scenario=name;step=0;const dispatch=await core.capabilityService.execute({method:'capability.execute',params:{capability:'agent.run',taskId:task.id,workspaceId:workspace.id,requestId:'claude-'+name,input:{agentProvider:'claude',content:'Use native '+name+' tool for this controlled fixture.'}}});
  assert.equal(dispatch.status,'completed');session=dispatch.result.sessionId;
  const pending=await waitFor(()=>core.capabilityService.broker.approvals.list().find(row=>row.request.capability==='agent.native.approve'),'native '+name);
  await core.capabilityService.execute({method:'capability.approval.decide',params:{id:pending.id,approve:name!=='deny'}});
  if(name==='write'){const imported=await waitFor(()=>core.capabilityService.broker.approvals.list().find(row=>row.request.capability==='workspace.apply'),'source import');assert.equal(fs.existsSync(path.join(project,'output.txt')),false);await core.capabilityService.execute({method:'capability.approval.decide',params:{id:imported.id,approve:true}});}
  await waitFor(async()=>{const status=await core.agentService.broker.status({provider:'claude',sessionId:session});return !status.running&&status.lastRunStatus!=='idle'?status:null;},'terminal '+name);
 }
 const original=fs.readdirSync(staging);assert.deepEqual(original,[]);
 await turn('read');assert.match(JSON.stringify(receipts),/real Claude controlled read/);
 await turn('write');assert.equal(fs.readFileSync(path.join(project,'output.txt'),'utf8'),'verified edit');
 await turn('test');assert.match(JSON.stringify(receipts),/CONTROLLED_TEST_PASS/);
 await turn('deny');assert.equal(fs.existsSync(path.join(project,'denied.txt')),false);
 const current=core.taskService.runtime.get({id:task.id}).task;assert.ok(current.executionEvidence.some(row=>row.source==='native-result'&&row.resultSha256));
 await ui('ui.task.cancel',{id:task.id,expectedRev:current.rev});
 console.log('PASS actual Claude Code 2.1.308 + exact SDK0.3.308 + synthetic HTTPS model + Core approvals/read/edit/test/denial/import/evidence');
}finally{await core?.chatService.close();await core?.agentService.close();await core?.capabilityService.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
