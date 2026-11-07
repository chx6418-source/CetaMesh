import assert from 'node:assert/strict';
import {rankTaskAgents} from '../src/router/agent-assignment.js';
const health={available:true,installed:true,compatible:true,authenticated:true,sessionCapable:true,taskEligible:true,sandboxCapable:null,toolsAvailable:null};
const caps={workspaceBoundary:'native-staged',supportsReadinessCheck:true,assignment:{taskKinds:['code'],tools:[],maxDifficulty:3}};
let authorized=false;const agentBroker={ids:()=>['codex'],health:async()=>({...health}),capabilities:()=>caps,describeExecutionSecurity:()=>({required:true,authorized,fingerprint:'current'}),assertExecutionConsent:()=>{if(!authorized)throw Object.assign(Error('review'),{code:'AGENT_SECURITY_CONFIRMATION_REQUIRED'});}};
const input={agentBroker,workspaceId:'workspace',taskKind:'code',difficulty:2,allowUnknownCost:true,exclude:['cetamesh']};
assert.deepEqual(await rankTaskAgents(input),[],'cold native candidate never becomes task eligible');
const pending=await rankTaskAgents({...input,includePreparation:true});
assert.equal(pending.length,1,'explicit preparation policy discovers an authenticated compatible native candidate');
assert.equal(pending[0].taskEligible,false);assert.equal(pending[0].preparationRequired,true);assert.equal(pending[0].consentRequired,true);
assert.deepEqual(await rankTaskAgents({...input,includePreparation:true,allowUnknownCost:false}),[]);
for(const key of ['authenticated','sessionCapable','compatible','installed','available','quotaAvailable','workspaceCapable','launchable']){const before=health[key];health[key]=false;assert.deepEqual(await rankTaskAgents({...input,includePreparation:true}),[],key+' cannot be assumed');health[key]=before;}
health.sandboxCapable=false;assert.deepEqual(await rankTaskAgents({...input,includePreparation:true}),[],'failed native sandbox cannot be bypassed');
health.sandboxCapable=true;health.toolsAvailable=true;authorized=true;
assert.equal((await rankTaskAgents(input))[0].provider,'codex');
console.log('PASS cold discovery is conditional preparation, not execution authority; actual auth/cost/negative evidence gates retained');

// Actual exec Adapter contract with synthetic CLI protocol records, not a real CLI claim.
const {default:fs}=await import('node:fs'),{default:os}=await import('node:os'),{default:path}=await import('node:path');
const {createCodexAgentProvider}=await import('../src/agent/codex-agent-provider.js');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-readiness-proof-'));
try{for(const mode of ['command','assistant-only','failed-command','changes']){
 const home=path.join(root,mode);fs.mkdirSync(home);const source=path.join(home,'source');fs.mkdirSync(source);let imports=0;
 const token='CM_READY_'+'a'.repeat(32);
 const cli={executable:()=> 'codex-readiness-fixture',probe(args){const arg=args.join(' ');return {available:true,stdout:arg==='--version'?'codex-cli 9.9.9-fixture':arg==='--help'?'--config --ask-for-approval --cd --sandbox workspace-write':arg==='exec --help'?'--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check':arg==='login status'?'Logged in with fixture account':'exec resume [SESSION_ID] --json',stderr:''};},
 startSession({cwd,onStdout}){if(mode==='changes')fs.writeFileSync(path.join(cwd,'unexpected.txt'),'unexpected bootstrap edit');const rows=[{type:'thread.started',thread_id:'fixture'},
 ...(mode==='assistant-only'?[]:[{type:'item.completed',item:{id:'cmd',type:'command_execution',exit_code:mode==='failed-command'?1:0,aggregated_output:token+'\n'}}]),
 {type:'item.completed',item:{id:'assistant',type:'agent_message',text:token}},{type:'turn.completed'}];onStdout(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');return {done:Promise.resolve({exitCode:0,terminationConfirmed:true}),cancel:async()=>({cancelled:true})};},shutdown:async()=>{}};
 const provider=createCodexAgentProvider({cliProcess:cli,codexHome:home,stagingRoot:path.join(home,'staging'),resolveTaskWorkspace:()=>({task:{id:'t',workspaceId:'w',goal:'readiness only'},workspace:{id:'w',root:source}}),applyChanges:async()=>{imports++;return {status:'completed'};}});
 try{const created=await provider.createSession({taskId:'t',workspaceId:'w'});await provider.send({...created,content:'print token only',phase:'bootstrap',runId:'owned-bootstrap',nativeReadinessToken:token});
  let status;for(let i=0;i<100;i++){status=await provider.status(created);if(!status.running)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(imports,0,'bootstrap must never import changes');
  if(mode==='command'){assert.equal(status.readiness?.verified,true);assert.equal(status.readiness.runId,'owned-bootstrap');assert.equal((await provider.health()).toolsAvailable,true);}
  else {assert.equal(status.readiness??null,null);assert.equal(status.errorCode,mode==='changes'?'BOOTSTRAP_SIDE_EFFECT_DENIED':'AGENT_READINESS_UNVERIFIED');}
 }finally{await provider.shutdown();}
}}
finally{assert.equal(path.dirname(root),os.tmpdir());fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
console.log('PASS native command proof: actual completed command required, assistant echo/failed command/changed staging rejected without import');

const billingRoot=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'cm-codex-subscription-'));
try {
 const home=path.join(billingRoot,'home'),source=path.join(billingRoot,'project');fs.mkdirSync(home);fs.mkdirSync(source);
 let account='fixture-account-a',login='Logged in using ChatGPT',apiEnvironment=false;const dispatches=[];
 const auth=()=>fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',OPENAI_API_KEY:null,
  tokens:{account_id:account,access_token:'synthetic-access',refresh_token:'synthetic-refresh'}}));
 auth();fs.writeFileSync(path.join(home,'config.toml'),'model="fixture-model"\n');
 const cli={executable:()=> 'codex-subscription-fixture',probe(args){const command=args.join(' ');return {available:true,
  stdout:command==='--version'?'codex-cli subscription-fixture':command==='--help'?'--config --ask-for-approval --cd --sandbox workspace-write'
   :command==='exec --help'?'--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check'
   :command==='login status'?login:'exec resume [SESSION_ID] --json',stderr:''};},
  startSession(request){dispatches.push(request);request.onStdout(JSON.stringify({type:'thread.started',thread_id:'subscription-fixture'})+'\n'
   +JSON.stringify({type:'turn.completed'})+'\n');return {done:Promise.resolve({exitCode:0,terminationConfirmed:true}),cancel:async()=>({cancelled:true})};},shutdown:async()=>{}};
 const provider=createCodexAgentProvider({cliProcess:cli,codexHome:home,stagingRoot:path.join(billingRoot,'staging'),
  environment:{OPENAI_API_KEY:'synthetic-key-never-forwarded'},authorizeOpenAiEnvironment:()=>apiEnvironment,
  resolveTaskWorkspace:()=>({task:{id:'subscription-task',workspaceId:'subscription-workspace',goal:'Fixture analysis'},workspace:{id:'subscription-workspace',root:source}})});
 try {
  const first=(await provider.health()).billingRoute;
  assert.equal(first?.mode,'chatgpt-subscription','explicit ChatGPT login, stable account and official route qualify without a guessed monetary price');
  assert.equal(first.verified,true);assert.match(first.fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(provider.capabilities().security.billingRoute,first,'health and native consent share one route identity');
  assert.equal(JSON.stringify(first).includes(account),false,'account identity is hashed, not published');
  const refreshed=JSON.parse(fs.readFileSync(path.join(home,'auth.json'),'utf8'));refreshed.tokens.access_token='synthetic-renewed';refreshed.tokens.refresh_token='synthetic-renewed-refresh';
  fs.writeFileSync(path.join(home,'auth.json'),JSON.stringify(refreshed));
  assert.equal(provider.capabilities().security.billingRoute.fingerprint,first.fingerprint,'same-account token renewal cannot invalidate a working handoff');
  const session=await provider.createSession({taskId:'subscription-task',workspaceId:'subscription-workspace'});
  await provider.send({...session,content:'Fixed synthetic turn',runId:'subscription-run'});
  for(let i=0;i<100&&(await provider.status(session)).running;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(dispatches[0].args.includes('forced_login_method="chatgpt"'),'the actual exec invocation must refuse API login fallback');
  assert.equal(dispatches[0].env.OPENAI_API_KEY,undefined,'subscription execution does not forward an ambient API key');
  assert.deepEqual(dispatches[0].authorizedEnvKeys,[]);
  account='fixture-account-b';auth();
  assert.equal(provider.capabilities().security.billingRoute,null,'a changed account invalidates old consent before any new probe');
  await assert.rejects(provider.send({...session,content:'Do not dispatch after account switch',runId:'stale-subscription-run'}),{code:'CODEX_BILLING_ROUTE_CHANGED'});
  assert.equal(dispatches.length,1,'account switch cannot start another native invocation');
  const next=(await provider.health({refresh:true})).billingRoute;assert.ok(next);assert.notEqual(next.fingerprint,first.fingerprint,'fresh login observation binds only the new account');
  fs.writeFileSync(path.join(home,'config.toml'),'model_provider="custom"\n[model_providers.custom]\nbase_url="https://example.invalid/v1"\n');
  assert.equal(provider.capabilities().security.billingRoute,null,'a custom model route never borrows subscription authority');
  fs.writeFileSync(path.join(home,'config.toml'),'model="fixture-model"\n');apiEnvironment=true;
  assert.equal(provider.capabilities().security.billingRoute,null,'Owner-authorized API environment excludes the subscription-only route');
  apiEnvironment=false;login='Logged in using an API key';
  assert.equal((await provider.health({refresh:true})).billingRoute,null,'authenticated is not evidence of subscription login');
  login='Logged in using ChatGPT';fs.rmSync(path.join(home,'auth.json'));
  assert.equal((await provider.health({refresh:true})).billingRoute,null,'no stable account witness means subscription route remains unverified');
 } finally {await provider.shutdown();}
} finally {assert.ok(path.basename(billingRoot).startsWith('cm-codex-subscription-'));fs.rmSync(billingRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
console.log('PASS Codex subscription routing: stable account renewal, changed identity refusal, fixed ChatGPT login and no API environment');

// Closing a Provider permanently fences its pending creates/sends. The shared
// CLI can still be reused by other owners after one shutdown cycle.
const {createStagingWorkspace}=await import('../src/workspace/staging.js');
for(const boundary of ['refresh','workspace','roots','stage','send']) {
 const parent=fs.realpathSync(os.tmpdir()),closingRoot=fs.mkdtempSync(path.join(parent,'cm-codex-closing-'));
 const source=path.join(closingRoot,'project'),home=path.join(closingRoot,'home');fs.mkdirSync(source);fs.mkdirSync(home);
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;});
 let stage,dispatches=0,asyncProbes=0,shutdownCalls=0,pendingRefresh,creation,created;
 const probe=args=>({available:true,stdout:args[0]==='--version'?'codex-cli closing-fixture':args[0]==='login'?'Logged in with fixture account'
  :'--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check [SESSION_ID]',stderr:''});
 const cli={executable:()=> 'codex-closing-fixture',probe,async probeAsync(args){asyncProbes++;if(boundary==='refresh'&&asyncProbes===1){entered();await gate;}return probe(args);},
  startSession(request){dispatches++;request.onStdout(JSON.stringify({type:'turn.completed'})+'\n');return{done:Promise.resolve({exitCode:0,terminationConfirmed:true})};},
  async shutdown(){if(boundary==='send'&&shutdownCalls++===0){entered();await gate;}}};
 const provider=createCodexAgentProvider({cliProcess:cli,codexHome:home,stagingRoot:path.join(closingRoot,'staging'),
  async resolveTaskWorkspace(){if(boundary==='workspace'){entered();await gate;}return{task:{id:'closing-task',workspaceId:'closing-workspace',goal:'Closing fixture'},workspace:{id:'closing-workspace',root:source}};},
  async listWorkspaceRoots(){if(boundary==='roots'){entered();await gate;}return[];},
  async createStage(options){stage=await createStagingWorkspace(options);if(boundary==='stage'){entered();await gate;}return stage;}});
 try {
  if(boundary==='refresh'){pendingRefresh=provider.health({refresh:true});await reached;}
  creation=provider.createSession({taskId:'closing-task',workspaceId:'closing-workspace'});creation.then(value=>{created=value;},()=>{});
  if(boundary==='send'){
   created=await creation;const generation=provider._sessionLifecycle.read(created.sessionId).generation;
   const stopping=provider.shutdown();await reached;
   await assert.rejects(provider.send({...created,content:'Must not dispatch while closing',runId:'closing-send'}),{code:'PROVIDER_SHUTTING_DOWN'});
   assert.equal(provider._sessionLifecycle.read(created.sessionId).generation,generation,'a refused send must not allocate a lifecycle run');
   release();await stopping;
  } else {
   if(boundary!=='refresh')await reached;
   const stopping=provider.shutdown();release();
   await assert.rejects(creation,{code:'PROVIDER_SHUTTING_DOWN'});await stopping;await pendingRefresh;
   if(boundary==='refresh')assert.equal(asyncProbes,1,'an aborted inspection cannot launch probes for remaining candidates');
  }
  assert.equal(dispatches,0);assert.equal(provider._sessions.size,0);
  if(stage)assert.equal(fs.existsSync(stage.root),false,'a pending creation removes only its own inert stage after closing');
  await assert.rejects(provider.createSession({taskId:'closing-task',workspaceId:'closing-workspace'}),{code:'PROVIDER_SHUTTING_DOWN'});
  assert.equal((await provider.health()).available,false,'closed provider stays unavailable even though the shared CLI supports later owners');
 } finally {release();await Promise.allSettled([creation,pendingRefresh]);await provider.shutdown();assert.equal(path.dirname(closingRoot),parent);fs.rmSync(closingRoot,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
console.log('PASS Provider close fences refresh, workspace/root resolution, staging completion and send without creating late sessions or runs');
