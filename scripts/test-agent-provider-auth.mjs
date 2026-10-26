import {PassThrough} from 'node:stream';
import {createAuthTransport} from '../src/agent/auth/transport.js';
import {createAcpProcessLauncher} from '../src/agent/acp-provider-descriptors.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createGeminiAuthAdapter,geminiAuthProfile} from '../src/agent/auth/gemini.js';
import {createOpenCodeAuthAdapter,openCodeAuthStatus} from '../src/agent/auth/opencode.js';
import {createClaudeAuthAdapter,claudeAuthStatus} from '../src/agent/auth/claude.js';
import {openCodeNativePolicy} from '../src/agent/native-acp-runtime.js';
import {describeRuntimeAuth,runtimeConnectionEvidence} from '../src/agent/runtime-auth-capabilities.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cetamesh-provider-auth-'));
try {
 const rootFor=id=>{const dir=path.join(root,id);fs.mkdirSync(dir,{recursive:true});return {root:dir,provider:id,validate(){}};};
 const gemini=geminiAuthProfile(rootFor('gemini'));
 assert.equal(gemini.environment.GEMINI_CLI_HOME,gemini.root);
 assert.equal(gemini.authDirectory,path.join(gemini.root,'.gemini'));
 assert.equal(gemini.environment.GOOGLE_GEMINI_BASE_URL,undefined);assert.equal(gemini.environment.GEMINI_API_KEY,undefined);assert.equal(gemini.environment.NO_BROWSER,undefined);
 gemini.validate();fs.writeFileSync(path.join(gemini.authDirectory,'settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));gemini.validate();
 fs.writeFileSync(path.join(gemini.authDirectory,'settings.json'),'{}');assert.throws(()=>gemini.validate(),{code:'AGENT_RUNTIME_CHANGED'});
 for(const provider of ['gemini','opencode','claude'])assert.equal(describeRuntimeAuth({provider,runtimeEvidence:{version:'2.1.4',authMethods:['oauth-personal','opencode-login'],securityVerified:true}}).methods.some(m=>m.id!=='api-key'&&m.supported),false);
 assert.equal(runtimeConnectionEvidence({provider:'claude',configuration:{authMode:'provider-login',credentialConfigured:true}}).authentication.state,'not-configured','retained API key is not account authentication evidence');
 const config={authMode:'provider-login',model:'fixture',providerId:'openai',methodId:'chatgpt-headless'};
 const policy=openCodeNativePolicy(config);assert.equal(policy.model,'openai/fixture');assert.deepEqual(policy.providers,{});
 assert.deepEqual(policy.permissions,[{action:'*',resource:'*',effect:'ask'}]);assert.equal(policy.policies.find(p=>p.action==='provider.use'&&p.effect==='allow').resource,'openai');
 assert.deepEqual(policy.plugins,[]);assert.deepEqual(policy.mcp,{servers:{}});assert.deepEqual(policy.skills,[]);
 assert.doesNotMatch(JSON.stringify(policy),/CETAMESH_AGENT_API_KEY|baseURL|apiKey/);
 const connections=[{id:'openai',name:'untrusted label',connections:[{type:'credential',id:'synthetic',label:'private account',method:'oauth'}]}];
 assert.equal(openCodeAuthStatus(connections,'openai').state,'session-present');
 for(const value of [[],{},[{id:'openai',connections:[{type:'env',name:'OPENAI_API_KEY'}]}],[{id:'openai',connections:[{type:'credential',method:'oauth',status:{status:'needs_auth',message:'secret'}}]}],[{id:'openai',connections:[...connections[0].connections,...connections[0].connections]}]])assert.notEqual(openCodeAuthStatus(value,'openai').state,'session-present');
 let captured;
 const transport={async run(spec){captured=spec;return {exitCode:0,stdout:JSON.stringify(connections)};},start(spec,{onHandle}={}){captured=spec;const handle={done:Promise.resolve({exitCode:0}),async close(){}};onHandle?.(handle);return handle;}};
 const opencode=createOpenCodeAuthAdapter({configuration:{get:()=>config},runtime:async()=>({version:'opencode v2.1.4',target:{executable:process.execPath,argsPrefix:[]},validate(){}}),transport});
 const opProfile=rootFor('opencode');await opencode.start({profile:opProfile,methodId:'chatgpt-headless',onHandle(){},onEvent(){}});
 assert.deepEqual(captured.argv,['auth','login','openai','--method','chatgpt-headless','--standalone']);
 assert.equal(captured.environment.CETAMESH_AGENT_API_KEY,undefined);
 assert.equal((await opencode.inspect({profile:opProfile})).state,'session-present');assert.deepEqual(captured.argv,['auth','list','--standalone','--format','json']);
 assert.doesNotMatch(JSON.stringify(captured),/\/api\/credential|auth.*export/);
 await assert.rejects(opencode.start({profile:opProfile,methodId:'opencode-login'}),{code:'AGENT_AUTH_UNSUPPORTED'});
 const claudeProfile=rootFor('claude');fs.mkdirSync(path.join(claudeProfile.root,'config'));
 assert.equal(claudeAuthStatus({loggedIn:true,authMethod:'claude.ai',configDirectory:path.join(claudeProfile.root,'config')},claudeProfile).state,'session-present');
 for(const status of [{loggedIn:true,authMethod:'api_key'},{loggedIn:true,authMethod:'claude.ai',configDirectory:root},{loggedIn:false,authMethod:'claude.ai',configDirectory:path.join(claudeProfile.root,'config')}])assert.notEqual(claudeAuthStatus(status,claudeProfile).state,'session-present');
 const wrong=createClaudeAuthAdapter({runtime:async()=>({version:'2.1.76',runtimePath:process.execPath}),transport});await assert.rejects(wrong.start({profile:claudeProfile}),{code:'AGENT_AUTH_UNSUPPORTED'});
 const geminiAdapter=createGeminiAuthAdapter({runtime:async()=>({version:'0.65.0',target:{executable:process.execPath,argsPrefix:[]},argv:['--acp'],packageIdentity:'fixture',validate(){}}),transport});
 const methods=[];let handle;
 const geminiTransport={start(){const readable=new PassThrough(),writable=new PassThrough();let resolve;const done=new Promise(r=>resolve=r);handle={readable,writable,done,async close(){resolve({exitCode:0});}};
 writable.on('data',chunk=>{const request=JSON.parse(String(chunk));methods.push([request.method,request.params]);readable.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='initialize'?{protocolVersion:1,agentInfo:{name:'gemini-cli',version:'0.65.0'},authMethods:[{id:'oauth-personal'}]}:{}})+'\n');});return handle;}};
 const realGeminiAdapter=createGeminiAuthAdapter({runtime:async()=>({version:'0.65.0',target:{executable:process.execPath,argsPrefix:[]},argv:['--acp'],packageIdentity:'fixture',validate(){}}),transport:geminiTransport});
 await realGeminiAdapter.start({profile:rootFor('gemini-login'),onHandle(){},onEvent(){}});await handle.done;
 assert.deepEqual(methods.map(m=>m[0]),['initialize','authenticate']);assert.deepEqual(methods[1][1],{methodId:'oauth-personal'});
 assert.equal((await realGeminiAdapter.inspect()).state,'no-session','successful ACP auth is not a passive metadata status API');
 assert.equal(geminiAdapter.timeoutMs,300000);assert.equal((await geminiAdapter.inspect({profile:rootFor('gemini-status')})).state,'no-session');
 assert.equal(describeRuntimeAuth({provider:'qwen'}).accountReason,'qwen_oauth_discontinued');
 // Real process boundary, synthetic child only: ambient credential / keychain
 // toggles and user profile hints never survive the auth transport allowlist.
 const saved={...process.env};process.env.GEMINI_API_KEY='unowned';process.env.OPENAI_API_KEY='unowned';process.env.CLAUDE_CODE_OAUTH_TOKEN='unowned';process.env.CODEX_HOME='unowned';process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE='true';process.env.NO_BROWSER='true';
 try {
  const transport=createAuthTransport({launchFactory:createAcpProcessLauncher});
  const result=await transport.run({executable:process.execPath,argv:['-e','process.stdout.write(JSON.stringify({key:process.env.GEMINI_API_KEY,openai:process.env.OPENAI_API_KEY,claude:process.env.CLAUDE_CODE_OAUTH_TOKEN,codex:process.env.CODEX_HOME,keychain:process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE,noBrowser:process.env.NO_BROWSER,home:process.env.HOME}))'],root,environment:{HOME:root,USERPROFILE:root}});
  assert.deepEqual(JSON.parse(result.stdout),{home:root});
 } finally {for(const key of ['GEMINI_API_KEY','OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CODEX_HOME','GEMINI_FORCE_ENCRYPTED_FILE_STORAGE','NO_BROWSER']){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}}
 console.log('PASS pinned provider auth commands, scoped policy, metadata-only status and closed production gates');
} finally {fs.rmSync(root,{recursive:true,force:true});}
