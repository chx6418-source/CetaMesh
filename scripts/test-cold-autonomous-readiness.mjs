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
