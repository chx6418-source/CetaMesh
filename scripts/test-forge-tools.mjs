import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import selfsigned from 'selfsigned';
import {createCapabilityBroker} from '../src/capability/broker.js';
import {createCapabilityPolicy} from '../src/capability/policy.js';
import {createProviderSecrets} from '../src/providers/secrets.js';
import {createNetworkCredentialResolver} from '../src/integrations/network-credentials.js';

const forge = await import('../src/integrations/forge-adapter.js').catch(() => ({}));
assert.equal(typeof forge.createForgeAdapter, 'function', 'Forge adapter must execute bounded requests against the official APIs');
const {registerDeveloperCapabilities} = await import('../src/integrations/developer-tools.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-forge-'));
const seen = [];
let mode = 'normal';
const pem = await selfsigned.generate([{name:'commonName', value:'api.github.com'}], {days:1, keySize:2048, extensions:[{name:'subjectAltName',altNames:[{type:2,value:'api.github.com'},{type:2,value:'api.gitcode.com'}]}]});
const server = https.createServer({key:pem.private,cert:pem.cert}, async (req,res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const row={method:req.method,url:req.url,headers:req.headers,body:chunks.length?JSON.parse(Buffer.concat(chunks)):null}; seen.push(row);
  if(mode==='slow'){setTimeout(()=>{if(!res.destroyed)res.end('{}');},100);return;}
  if(mode==='redirect'){res.writeHead(302,{location:'https://attacker.invalid/steal'});res.end();return;}
  if(mode==='error'){res.writeHead(500,{'content-type':'application/json'});res.end('{"body":"private response token=serversecret"}');return;}
  res.setHeader('content-type','application/json');
  if(mode==='oversize'){res.end(JSON.stringify({body:'x'.repeat(50000)}));return;}
  if(mode==='malformed'){res.end('{');return;}
  if(mode==='wrong-effect'){res.end(JSON.stringify({ref:'refs/heads/main',object:{sha:'b'.repeat(40)}}));return;}
  if(req.url.includes('/actions/runs')){res.end(JSON.stringify(req.url.includes('/jobs')?{jobs:[{id:'31',name:'build',status:'COMPLETED',steps:[{env:['SECRET']}]}]}:{workflow_runs:[{workflow_run_id:'77',workflow_name:'checks',status:'FAILED',head_sha:'a'.repeat(40),body:'private'}]}));return;}
  if(req.method==='POST'&&req.url.endsWith('/dispatches')){res.writeHead(204);res.end();return;}
  if(req.method==='POST'){res.writeHead(201);res.end(JSON.stringify({id:12,number:3,name:'codex/probe',ref:'refs/heads/codex/probe',draft:true,body:'private response',html_url:'https://attacker.invalid/steal',object:{sha:'a'.repeat(40)}}));return;}
  if(req.url.includes('/branches')){res.end(JSON.stringify([{name:'codex/probe',commit:{sha:'a'.repeat(40)},description:'private response'}]));return;}
  if(req.url.includes('/issues')||req.url.includes('/pulls')||req.url.includes('/releases')){res.end(JSON.stringify([{id:12,number:3,title:'token=serversecret',body:'private response',html_url:'https://attacker.invalid'}]));return;}
  res.end(JSON.stringify({id:1,full_name:'owner/repo',default_branch:'main',private:true,body:'private response'}));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const requestImpl=(url,options,callback)=>{
  assert.ok(['https://api.github.com','https://api.gitcode.com'].includes(url.origin));
  return https.request(url,{...options,port:server.address().port,lookup:(_host,opts,done)=>opts?.all?done(null,[{address:'127.0.0.1',family:4}]):done(null,'127.0.0.1',4),ca:pem.cert,agent:false},callback);
};
const secrets=createProviderSecrets({root});
secrets.set({provider:'plugin-forge-github',apiKey:'dedicated-github-secret',baseUrl:'https://api.github.com'});
secrets.set({provider:'plugin-forge-gitcode',apiKey:'dedicated-gitcode-secret',baseUrl:'https://api.gitcode.com/api'});
const resolveCredential=createNetworkCredentialResolver(secrets);
const all=['repository.get','branches.list','issues.list','pulls.list','builds.list','builds.jobs','releases.list','branch.create','issue.create','pull.create','workflow.dispatch','release.draft'];
const create=(provider,extra={})=>forge.createForgeAdapter({provider,repositories:[{owner:'owner',repo:'repo',credentialRef:`plugin-forge-${provider}`,actions:all,branchPrefixes:['codex/'],workflows:[{id:'ci.yml',refs:['codex/probe'],inputs:{build_candidate:['false']}}]}],resolveCredential,requestImpl,timeoutMs:1000,maxResponseBytes:10000,...extra});
try {
  const github=create('github'),gitcode=create('gitcode');
  const input={owner:'owner',repo:'repo'};
  assert.equal((await github.execute('repository.get',input)).repository,'owner/repo');
  assert.equal(seen.at(-1).headers.authorization,'Bearer dedicated-github-secret');
  const anonymous=create('github',{repositories:[{owner:'owner',repo:'repo',publicRead:true,actions:['repository.get']}]});await anonymous.execute('repository.get',input);assert.equal(seen.at(-1).headers.authorization,undefined);
  assert.throws(()=>create('github',{repositories:[{owner:'owner',repo:'repo',publicRead:true,actions:['issue.create']}]}),{code:'FORGE_INVALID_CONFIG'});
  for(const action of ['branches.list','issues.list','pulls.list','releases.list']){
    const result=await github.execute(action,input);assert.equal(result.items.length,1);
    assert.ok(!JSON.stringify(result).includes('private response'));assert.ok(!JSON.stringify(result).includes('serversecret'));assert.ok(!JSON.stringify(result).includes('attacker.invalid'));
  }
  let before=seen.length;
  for(const bad of [{owner:'other',repo:'repo'},{owner:'owner',repo:'../repo'},{...input,url:'https://attacker.invalid'},{...input,credentialRef:'openai'}])await assert.rejects(()=>github.execute('repository.get',bad),{code:bad.owner==='other'?'FORGE_SCOPE_DENIED':'FORGE_INVALID_INPUT'});
  await assert.rejects(()=>create('github',{repositories:[]}).execute('repository.get',input),{code:'FORGE_SCOPE_DENIED'});
  await assert.rejects(()=>create('github',{repositories:[{...input,credentialRef:'plugin-forge-github',actions:['repository.get']}]}).execute('issues.list',input),{code:'FORGE_SCOPE_DENIED'});
  assert.equal(seen.length,before,'invalid or unauthorized requests must not reach transport');
  const abort=new AbortController();abort.abort();await assert.rejects(()=>github.execute('repository.get',input,{signal:abort.signal}),{code:'FORGE_ABORTED'});assert.equal(seen.length,before);
  mode='redirect';await assert.rejects(()=>github.execute('repository.get',input),{code:'FORGE_REDIRECT_DENIED'});assert.equal(seen.length,before+1);
  mode='error';await assert.rejects(()=>github.execute('repository.get',input),e=>e.code==='FORGE_HTTP_ERROR'&&!/private response|serversecret/.test(e.message));
  mode='oversize';await assert.rejects(()=>github.execute('repository.get',input),{code:'FORGE_RESPONSE_TOO_LARGE'});
  mode='malformed';await assert.rejects(()=>github.execute('repository.get',input),{code:'FORGE_RESPONSE_INVALID'});
  mode='slow';await assert.rejects(()=>create('github',{timeoutMs:30}).execute('repository.get',input),{code:'FORGE_TIMEOUT'});
  mode='normal';await assert.rejects(()=>Promise.race([create('github',{timeoutMs:30,resolveCredential:()=>new Promise(()=>{})}).execute('repository.get',input),new Promise(resolve=>setTimeout(()=>resolve('unbounded-credential-resolution'),200))]),{code:'FORGE_TIMEOUT'});
  mode='wrong-effect';await assert.rejects(()=>github.execute('branch.create',{...input,branch:'codex/probe',sha:'a'.repeat(40)}),{code:'FORGE_RESPONSE_INVALID'});
  mode='normal';
  await gitcode.execute('branch.create',{...input,branch:'codex/probe',sha:'a'.repeat(40)});
  assert.equal(seen.at(-1).url,'/api/v5/repos/owner/repo/branches');assert.deepEqual(seen.at(-1).body,{branch_name:'codex/probe',refs:'a'.repeat(40)});
  await gitcode.execute('issue.create',{...input,title:'probe',body:'controlled issue'});
  assert.equal(seen.at(-1).url,'/api/v5/repos/owner/issues');assert.deepEqual(seen.at(-1).body,{repo:'repo',title:'probe',body:'controlled issue'});
  await gitcode.execute('pull.create',{...input,title:'probe',head:'codex/probe',base:'main',body:'controlled PR'});assert.equal(seen.at(-1).url,'/api/v5/repos/owner/repo/pulls');
  const runs=await gitcode.execute('builds.list',input);assert.equal(runs.items[0].id,'77');assert.equal(seen.at(-1).url,'/api/v8/repos/owner/repo/actions/runs?per_page=20&page=1');
  assert.equal((await gitcode.execute('builds.jobs',{...input,runId:'77'})).items[0].id,'31');
  before=seen.length;await assert.rejects(()=>gitcode.execute('release.draft',{...input,tag:'v1',sha:'a'.repeat(40),name:'probe',body:''}),{code:'FORGE_UNSUPPORTED'});assert.equal(seen.length,before);
  for(const branch of ['main','master','../escape','codex/a.lock','codex/a..b'])await assert.rejects(()=>github.execute('branch.create',{...input,branch,sha:'a'.repeat(40)}));
  await github.execute('release.draft',{...input,tag:'v1',sha:'a'.repeat(40),name:'probe',body:''});assert.equal(seen.at(-1).body.draft,true);assert.equal(seen.at(-1).body.target_commitish,'a'.repeat(40));
  await github.execute('workflow.dispatch',{...input,workflow:'ci.yml',ref:'codex/probe',inputs:{build_candidate:'false'}});assert.equal(seen.at(-1).url,'/repos/owner/repo/actions/workflows/ci.yml/dispatches');
  before=seen.length;await assert.rejects(()=>github.execute('workflow.dispatch',{...input,workflow:'ci.yml',ref:'main',inputs:{build_candidate:'true'}}));assert.equal(seen.length,before);
  const broker=createCapabilityBroker({stateDir:path.join(root,'broker'),policy:createCapabilityPolicy({resolveTask:()=>({workspaceId:'w',status:'running'}),resolveWorkspace:()=>({root})})});
  registerDeveloperCapabilities({broker,forgeAdapters:[github,gitcode]});
  const req={requestId:'request1',operationId:'issue-operation',taskId:'t',workspaceId:'w',actor:{kind:'owner',id:'owner'},capability:'forge.github.issue.create',input:{...input,title:'approved probe',body:'controlled'}};
  const pending=await broker.execute(req);assert.equal(pending.status,'pending');assert.equal(seen.length,before);
  const completed=await broker.execute({...req,approved:true});assert.equal(completed.status,'completed');assert.equal(seen.length,before+1);
  assert.equal((await broker.execute({...req,requestId:'request2',approved:true})).replayed,true);assert.equal(seen.length,before+1,'logical operation cannot be sent twice');
  await assert.rejects(()=>broker.execute({...req,operationId:undefined,requestId:'missing-operation',approved:true}),{code:'FORGE_OPERATION_REQUIRED'});
  mode='error';await assert.rejects(()=>broker.execute({...req,requestId:'unknown1',operationId:'unknown',approved:true}));const uncertain=seen.length;
  mode='normal';await assert.rejects(()=>broker.execute({...req,requestId:'unknown2',operationId:'unknown',approved:true}),{code:'REQUEST_RECOVERY_REQUIRED'});assert.equal(seen.length,uncertain);
  const descriptors=broker.list();assert.equal(descriptors.find(x=>x.id==='forge.github.issue.create').risk,'high');assert.equal(descriptors.find(x=>x.id==='developer.browser.open').available,false);
  await assert.rejects(()=>broker.execute({actor:{kind:'owner',id:'owner'},capability:'developer.browser.open',input:{url:'https://example.com'}}),{code:'PROVIDER_UNAVAILABLE'});
  fs.writeFileSync(path.join(root,'probe.mjs'),'console.log("ok token=terminalsecret");');
  const local=createCapabilityBroker({stateDir:path.join(root,'local'),policy:createCapabilityPolicy({resolveTask:()=>({workspaceId:'w',status:'running'}),resolveWorkspace:()=>({root})})});
  registerDeveloperCapabilities({broker:local,resolveWorkspace:()=>({root}),terminalCommands:[{id:'probe',file:process.execPath,args:['probe.mjs']}],readLogs:async()=> 'token=logsecret\n'+'x'.repeat(10000)});
  const localRequest={actor:{kind:'owner',id:'owner'},taskId:'t',workspaceId:'w',operationId:'terminal-probe',approved:true,capability:'developer.terminal.run',input:{command:'probe'}};
  const processResult=await local.execute(localRequest);assert.equal(processResult.result.exitCode,0);assert.match(processResult.result.stdout,/ok/);assert.ok(!processResult.result.stdout.includes('terminalsecret'));
  await assert.rejects(()=>local.execute({...localRequest,operationId:'not-allowlisted',input:{command:'unlisted'}}),{code:'DEVELOPER_COMMAND_DENIED'});
  await assert.rejects(()=>local.execute({...localRequest,operationId:'shell-input',input:{command:'probe',args:['-e','process.exit(0)']}}),{code:'TOOL_ARGUMENTS_INVALID'});
  const logs=await local.execute({actor:{kind:'owner',id:'owner'},capability:'developer.logs.read',input:{maxBytes:1000}});assert.ok(Buffer.byteLength(logs.result.text)<=1000);assert.ok(!logs.result.text.includes('logsecret'));
  const truncatedLogs=createCapabilityBroker();registerDeveloperCapabilities({broker:truncatedLogs,readLogs:async()=> '-----BEGIN PRIVATE KEY-----\n'+'private-material'.repeat(10000)});
  const privateLog=await truncatedLogs.execute({actor:{kind:'owner',id:'owner'},capability:'developer.logs.read',input:{maxBytes:1000}});assert.ok(!privateLog.result.text.includes('private-material'),'truncation must not expose an incomplete PEM credential');
  const serviceModule=await import('../src/integrations/forge-service.js').catch(()=>({}));assert.equal(typeof serviceModule.createForgeService,'function','Owner must be able to save a token-free repository scope');
  const productBroker=createCapabilityBroker({stateDir:path.join(root,'product-broker'),policy:createCapabilityPolicy({resolveTask:()=>({workspaceId:'w',status:'running'}),resolveWorkspace:()=>({root})})});
  const product=serviceModule.createForgeService({stateDir:path.join(root,'product'),broker:productBroker,secretStore:secrets,resolveCredential,transportOptions:{requestImpl}});
  assert.equal(product.describe().revision,0);assert.equal(productBroker.list().find(x=>x.id==='forge.github.repository.get').available,false);
  const configuration={provider:'github',expectedRevision:0,repositories:[{...input,credentialRef:'plugin-forge-github',actions:all,branchPrefixes:['codex/'],workflows:[{id:'ci.yml',refs:['codex/probe'],inputs:{build_candidate:['false']}}]}]};
  const saved=product.save(configuration);assert.equal(saved.revision,1);assert.equal(productBroker.list().find(x=>x.id==='forge.github.repository.get').available,true);
  assert.ok(!fs.readFileSync(product.filePath,'utf8').includes('dedicated-github-secret'));
  assert.throws(()=>product.save({...configuration,expectedRevision:1,repositories:[{...configuration.repositories[0],apiKey:'must-not-persist'}]}),{code:'FORGE_INVALID_CONFIG'});
  assert.throws(()=>product.save(configuration),{code:'FORGE_CONFIG_CONFLICT'});
  assert.equal((await product.execute({method:'ui.developer.forge.invoke',params:{provider:'github',action:'repository.get',input}})).status,'completed');
  const productWrite={provider:'github',action:'issue.create',input:{...input,title:'product probe',body:'controlled'},taskId:'t',workspaceId:'w',operationId:'product-op',requestId:'product-request'};
  const approval=await product.execute({method:'ui.developer.forge.invoke',params:productWrite});assert.equal(approval.status,'pending');
  const oldVersion=productBroker.registry.require('forge.github.issue.create').descriptorVersion;
  product.save({...configuration,expectedRevision:1,repositories:[{...configuration.repositories[0],actions:['repository.get']}]});
  assert.notEqual(productBroker.registry.require('forge.github.issue.create').descriptorVersion,oldVersion);
  assert.equal(productBroker.list().find(x=>x.id==='forge.github.issue.create').available,false);
  await assert.rejects(()=>product.execute({method:'ui.developer.forge.invoke',params:productWrite}),{code:'FORGE_SCOPE_DENIED'});
  product.save({...configuration,expectedRevision:2});
  const credentialRequest={...productWrite,requestId:'credential-request',operationId:'credential-operation'};
  const credentialPending=await product.execute({method:'ui.developer.forge.invoke',params:credentialRequest});assert.equal(credentialPending.status,'pending');
  productBroker.approvals.decide(credentialPending.approvalId,true,{kind:'owner',id:'owner'});
  const credentialVersion=productBroker.registry.require('forge.github.issue.create').descriptorVersion;
  const savedCredential=await product.execute({method:'ui.developer.forge.credentials.save',params:{provider:'github',expectedRevision:3,token:'replacement-fixture-credential'}});
  assert.deepEqual(Object.keys(savedCredential).sort(),['configured','updatedAt']);assert.equal(savedCredential.configured,true);assert.ok(typeof savedCredential.updatedAt==='string');
  assert.equal(secrets.raw('plugin-forge-github').baseUrl,'https://api.github.com');assert.equal(product.describe().revision,4);
  assert.notEqual(productBroker.registry.require('forge.github.issue.create').descriptorVersion,credentialVersion);
  const credentialBefore=seen.length;
  await assert.rejects(()=>productBroker.execute({actor:{kind:'owner',id:'owner'},...credentialRequest,capability:'forge.github.issue.create',approvalId:credentialPending.approvalId}),{code:'APPROVAL_EXPIRED'});assert.equal(seen.length,credentialBefore);
  for(const bad of [{provider:'openai',token:'fixture-secret',expectedRevision:4},{provider:'github',token:'fixture-secret',expectedRevision:4,credentialRef:'openai'},{provider:'github',token:'fixture-secret',expectedRevision:4,baseUrl:'https://attacker.invalid'},{provider:'github',token:'short',expectedRevision:4}])await assert.rejects(async()=>product.execute({method:'ui.developer.forge.credentials.save',params:bad}),e=>e.code==='FORGE_INVALID_CONFIG'&&!e.message.includes(bad.token));
  await product.execute({method:'ui.developer.forge.credentials.save',params:{provider:'gitcode',expectedRevision:4,token:'gitcode-fixture-credential'}});assert.equal(secrets.raw('plugin-forge-gitcode').baseUrl,'https://api.gitcode.com/api');
  const externalRequest={...productWrite,requestId:'external-request',operationId:'external-operation'};const externalPending=await product.execute({method:'ui.developer.forge.invoke',params:externalRequest});productBroker.approvals.decide(externalPending.approvalId,true,{kind:'owner',id:'owner'});
  await new Promise(resolve=>setTimeout(resolve,5));secrets.set({provider:'plugin-forge-github',apiKey:'external-fixture-rotation',baseUrl:'https://api.github.com'});
  await assert.rejects(()=>productBroker.execute({actor:{kind:'owner',id:'owner'},...externalRequest,capability:'forge.github.issue.create',approvalId:externalPending.approvalId}),{code:'FORGE_CREDENTIAL_CHANGED'});
  assert.ok(!JSON.stringify(product.describe()).includes('replacement-fixture-credential'));assert.ok(!fs.readFileSync(product.filePath,'utf8').includes('replacement-fixture-credential'));assert.ok(!fs.readFileSync(path.join(root,'product-broker','capability','dispatches.json'),'utf8').includes('replacement-fixture-credential'));
  const candidate=await import('./ci-candidate.mjs');assert.equal(typeof candidate.verifyCandidateSource,'function','Cloud candidate metadata must verify the actual checkout');
  const sourceRoot=path.join(root,'candidate-source');fs.mkdirSync(sourceRoot);const git=args=>execFileSync('git',['-c','core.hooksPath=__none__','-c','commit.gpgsign=false',...args],{cwd:sourceRoot,encoding:'utf8',windowsHide:true});
  git(['init','--quiet']);fs.writeFileSync(path.join(sourceRoot,'source.txt'),'reviewed source');git(['add','source.txt']);git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--quiet','-m','fixture']);
  const commit=git(['rev-parse','HEAD']).trim(),tree=git(['rev-parse','HEAD^{tree}']).trim();
  assert.deepEqual(candidate.verifyCandidateSource({rootDir:sourceRoot,expectedCommit:commit}),{sourceCommit:commit,sourceTree:tree});
  assert.throws(()=>candidate.verifyCandidateSource({rootDir:sourceRoot,expectedCommit:'b'.repeat(40)}),/commit/i);
  fs.writeFileSync(path.join(sourceRoot,'source.txt'),'unreviewed local change');assert.throws(()=>candidate.verifyCandidateSource({rootDir:sourceRoot,expectedCommit:commit}),/clean/i);
  const browserModule=await import('../src/integrations/developer-browser.js').catch(()=>({}));assert.equal(typeof browserModule.createDeveloperBrowserExecutor,'function','Browser automation requires a real bounded executor');
  await assert.rejects(()=>browserModule.validateDeveloperBrowserTarget('file:///C:/Windows/win.ini'),{code:'DEVELOPER_URL_DENIED'});
  await assert.rejects(()=>browserModule.validateDeveloperBrowserTarget('http://127.0.0.1/'),{code:'DEVELOPER_URL_DENIED'});
  const nativeBrowser=browserModule.createDeveloperBrowserExecutor();
  if(nativeBrowser){
    let privateRequests=0,slowPage=false,abortOnRequest=null;
    const page=http.createServer((req,res)=>{if(req.url==='/secret'){privateRequests++;res.end('PRIVATE_LOCAL');return;}if(slowPage){abortOnRequest?.();return;}res.setHeader('content-type','text/html');res.end(`<h1>Browser fixture</h1><p>Visible sample</p><p style="display:none">hidden sample</p><img src="http://127.0.0.1:${page.address().port}/secret"><script>document.body.append('page-script-executed')</script>`);});
    await new Promise(resolve=>page.listen(0,'127.0.0.1',resolve));
    const target=`http://fixture.example:${page.address().port}/`;
    const profiles=path.join(root,'browser-profiles');fs.mkdirSync(profiles);
    const browser=browserModule.createDeveloperBrowserExecutor({profileRoot:profiles,timeoutMs:20000,resolveTarget:async value=>{if(value!==target)throw Error('fixture denied');return {url:new URL(target),ip:'127.0.0.1'};}});
    try{
      const result=await browser({url:target});assert.match(result.visibleText,/Browser fixture/);assert.ok(!result.visibleText.includes('hidden sample'));assert.ok(!result.visibleText.includes('page-script-executed'),'untrusted page scripts must remain disabled');assert.ok(result.screenshot.base64.length>100);assert.equal(privateRequests,0);assert.equal(fs.readdirSync(profiles).length,0,'temporary profile must be removed after real browser exit');
      const captureBroker=createCapabilityBroker();registerDeveloperCapabilities({broker:captureBroker,openBrowser:async({url})=>({...result,url})});
      const capture=await captureBroker.execute({actor:{kind:'owner',id:'owner'},approved:true,capability:'developer.browser.open',input:{url:'https://8.8.8.8/'}});
      assert.equal(capture.result.imageDelivery,'not-forwarded');assert.equal(capture.result.screenshot.bytes,Buffer.from(result.screenshot.base64,'base64').length);assert.match(capture.result.screenshot.sha256,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(capture.result).includes('base64'),'ordinary tool text must never contain browser image bytes');
      const cancelled=new AbortController();cancelled.abort();await assert.rejects(()=>browser({url:target,signal:cancelled.signal}),{code:'DEVELOPER_BROWSER_ABORTED'});
      slowPage=true;const inFlight=new AbortController();abortOnRequest=()=>inFlight.abort();await assert.rejects(()=>browser({url:target,signal:inFlight.signal}),{code:'DEVELOPER_BROWSER_ABORTED'});assert.equal(fs.readdirSync(profiles).length,0);
      abortOnRequest=null;const timed=browserModule.createDeveloperBrowserExecutor({profileRoot:profiles,timeoutMs:3000,resolveTarget:async()=>({url:new URL(target),ip:'127.0.0.1'})});await assert.rejects(()=>timed({url:target}),{code:'DEVELOPER_BROWSER_TIMEOUT'});assert.equal(fs.readdirSync(profiles).length,0);
      const early=new AbortController();const earlyTimer=setTimeout(()=>early.abort(),100);await assert.rejects(()=>browser({url:target,signal:early.signal}),{code:'DEVELOPER_BROWSER_ABORTED'});clearTimeout(earlyTimer);assert.equal(fs.readdirSync(profiles).length,0);
      const encodedRoot=Buffer.from(profiles,'utf8').toString('base64');const query=`$root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedRoot}'));@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) }).Count`;
      const remaining=execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(query,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();assert.equal(remaining,'0','no Edge or crash reporter process may retain the owned fixture profile');
      console.log('PASS real Edge headless fixture: visible DOM, screenshot, denied private subresource and temporary profile cleanup');
    }finally{page.closeAllConnections();await new Promise(resolve=>page.close(resolve));}
  }else console.log('NOT_RUN_ENVIRONMENT real browser fixture: Edge executable unavailable');
  console.log('PASS Forge real local TLS routes, credential binding, scopes, response limits, redirects, abort/timeout, scrubbed summaries, Broker approval and uncertain-effect no replay');
} catch(error) {console.error('Forge regression error:',error.code??error.name,error.message);throw error;} finally {
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));try{fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{console.error('Forge fixture cleanup pending');}
}
