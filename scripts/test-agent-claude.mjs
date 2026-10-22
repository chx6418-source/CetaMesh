import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createJsonRpcTransport } from '../src/agent/protocol/json-rpc-transport.js';
import { createClaudeAgentProvider, claudeRunnerLaunchSpec } from '../src/agent/claude-agent-provider.js';
import { runClaudeSdkRunner } from '../src/agent/claude-sdk-runner.js';
const provider = createClaudeAgentProvider({ launchSdkRunner: () => { throw Error('must not launch'); } });
assert.equal((await provider.health()).available, false);
assert.equal(provider.capabilities().supported.send, false);
assert.equal(provider.capabilities().security.nativeSandboxSupported, false);
assert.deepEqual(claudeRunnerLaunchSpec({ executable: 'Core.exe', sea: true }).args, ['--agent-sdk-runner', 'claude']);
assert.deepEqual(claudeRunnerLaunchSpec({ executable: 'node', sea: false, entry: '/core-entry.js' }).args, ['/core-entry.js', '--agent-sdk-runner', 'claude']);
const input = new PassThrough(), output = new PassThrough();
let loads = 0, captured, interrupted = 0;
const events = [];
const runner = runClaudeSdkRunner({ input, output, loadSdk: async () => { loads++; return { query({ prompt, options }) {
  captured = { prompt, options };
  return { async *[Symbol.asyncIterator]() {
    const permission = await options.canUseTool('Bash', { command: 'echo unsafe' });
    assert.equal(permission.behavior, 'deny');
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '中文\nnext' } } };
    yield { type: 'result', subtype: 'success', session_id: 'native-1' };
  }, async interrupt() { interrupted++; } };
} }; } });
const client = createJsonRpcTransport({ readable: output, writable: input, framing: 'acp-v1-jsonl', onNotification(method, params) { events.push([method, params]); }, onRequest: async () => ({ approved: false }) });
assert.equal(loads, 0);
await assert.rejects(client.request('initialize', {}));
assert.equal(loads, 0);
await client.request('initialize', { credential: 'fixture-secret', runtimePath: '/verified/claude', cwd: '/workspace', tools: [] });
assert.equal(loads, 1);
await client.request('turn', { prompt: 'hello', resume: 'native-1' }, { timeoutMs: 0 });
assert.equal(captured.options.env.ANTHROPIC_API_KEY, 'fixture-secret');
assert.deepEqual(Object.keys(captured.options.env), ['ANTHROPIC_API_KEY']);
assert.deepEqual(captured.options.settingSources, []);
assert.deepEqual(captured.options.mcpServers, {});
assert.equal(captured.options.resume, 'native-1');
assert.equal(captured.options.pathToClaudeCodeExecutable, '/verified/claude');
assert.ok(events.some(([,p]) => p.text === '中文\nnext'));
assert.ok(!JSON.stringify(events).includes('fixture-secret'));
await client.request('shutdown');
input.end();
await runner;
client.close();
console.log('Claude guarded provider and SDK runner contract PASS');
// Internal ACP-shaped facade reuses the shared staging/import and permission lifecycle.
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const source = mkdtempSync(join(tmpdir(), 'claude-fixture-'));
let fixtureOptions, closedHandle = false;
const live = createClaudeAgentProvider({
  taskOptions: { credentialRef: 'ref-only', verifiedRuntime: { verified: true, sdkResourcesVerified: true, binaryVerified: true,
    runtimePath:'/verified/claude', tools:[], security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true} },
    resolveTaskWorkspace: async () => ({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root:source}}) },
  resolveCredential: async ref => { assert.equal(ref, 'ref-only'); return 'private-fixture-key'; },
  async launchSdkRunner(binding) {
    assert.notEqual(binding.cwd, source);
    const readable = new PassThrough(), writable = new PassThrough();
    const done = runClaudeSdkRunner({input:writable,output:readable,loadSdk:async()=>({query({options}) {
      fixtureOptions = options;
      return {async *[Symbol.asyncIterator]() { yield {type:'result',subtype:'success',session_id:'native-reuse'}; },async interrupt() {}};
    }})});
    return {readable,writable,done,async close(){closedHandle=true;writable.end();await done;}};
  }
});
try {
  assert.equal((await live.health()).available, true);
  const session = await live.createSession({taskId:'t',workspaceId:'w'});
  const sent = await live.send({sessionId:session.sessionId,content:'first'});
  assert.equal(sent.accepted,true);
  for (let i=0;i<100 && (await live.status({sessionId:session.sessionId})).running;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal((await live.status({sessionId:session.sessionId})).lastRunStatus,'completed');
  await live.send({sessionId:session.sessionId,content:'second'});
  for (let i=0;i<100 && (await live.status({sessionId:session.sessionId})).running;i++) await new Promise(r=>setTimeout(r,5));
  assert.equal(fixtureOptions.resume,'native-reuse');
  await live.closeSession({sessionId:session.sessionId});
  assert.equal(closedHandle,true);
} finally { rmSync(source,{recursive:true,force:true}); }
// Cancellation while native approval is waiting must settle and suppress late output.
const cancelIn = new PassThrough(), cancelOut = new PassThrough();
let approvalStarted;
const approvalSeen = new Promise(resolve => {approvalStarted=resolve;});
let releaseApproval;
const cancelEvents=[];
const cancelRunner=runClaudeSdkRunner({input:cancelIn,output:cancelOut,loadSdk:async()=>({query({options}) {
  return {async *[Symbol.asyncIterator]() {
    const result=await options.canUseTool('Bash',{command:'fixture-only'});
    assert.equal(result.behavior,'deny');
    yield {type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'late'}}};
  }, async interrupt() {}};
}})});
const cancelClient=createJsonRpcTransport({readable:cancelOut,writable:cancelIn,framing:'acp-v1-jsonl',
  onRequest:async()=>{approvalStarted();return new Promise(resolve=>{releaseApproval=resolve;});},
  onNotification:(_,p)=>cancelEvents.push(p)});
await cancelClient.request('initialize',{credential:'not-public',runtimePath:'/verified',cwd:'/fixture',tools:['Bash']});
const pendingTurn=cancelClient.request('turn',{prompt:'wait'},{timeoutMs:0});
await approvalSeen;
await cancelClient.request('cancel');
assert.equal((await pendingTurn).outcome,'cancelled');
releaseApproval({approved:true});
assert.deepEqual(cancelEvents,[]);
await cancelClient.request('shutdown');cancelIn.end();await cancelRunner;cancelClient.close();

// Missing optional SDK returns a fixed RPC failure and leaves process supervision intact.
const absentIn=new PassThrough(),absentOut=new PassThrough();
const absentRunner=runClaudeSdkRunner({input:absentIn,output:absentOut});
const absentClient=createJsonRpcTransport({readable:absentOut,writable:absentIn,framing:'acp-v1-jsonl'});
await assert.rejects(absentClient.request('initialize',{credential:'never-log',runtimePath:'/verified',cwd:'/fixture',tools:[]}),e=>e.code==='RPC_REMOTE_ERROR'&&!e.message.includes('never-log'));
await absentClient.request('shutdown');absentIn.end();await absentRunner;absentClient.close();
// A failed secret bootstrap must transfer handle ownership before it can fail.
const { existsSync } = await import('node:fs');
for (const closeRejects of [true, false]) {
  const root=mkdtempSync(join(tmpdir(),'claude-bootstrap-'));
  let stage, finishExit, safeToStop=false, closeCalls=0;
  const done=new Promise(resolve=>{finishExit=resolve;});
  let peer;
  const broken=createClaudeAgentProvider({taskOptions:{credentialRef:'fixture',verifiedRuntime:{verified:true,sdkResourcesVerified:true,binaryVerified:true,
    runtimePath:'/verified',security:{mode:'native',verified:true,nativeSandboxSupported:true,nativeApprovalSupported:true}},
    resolveTaskWorkspace:async()=>({task:{id:'t',workspaceId:'w'},workspace:{id:'w',root}})},resolveCredential:async()=> 'private',
    async launchSdkRunner(binding){stage=binding.cwd;const readable=new PassThrough(),writable=new PassThrough();
      peer=createJsonRpcTransport({readable:writable,writable:readable,framing:'acp-v1-jsonl',onRequest:async()=>{throw Error('bootstrap fixture');}});
      return {readable,writable,done,async close(){closeCalls++;if(closeRejects&&!safeToStop)throw Error('fixture close refused');}};
    }});
  try {
    const failure=await broken.createSession({taskId:'t',workspaceId:'w'}).then(()=>null,e=>e);
    assert.equal(failure?.code,'ACP_CLOSE_UNKNOWN');
    assert.equal(typeof failure.sessionId,'string');
    assert.equal(existsSync(stage),true,'staging must survive unconfirmed exit');
    safeToStop=true;finishExit();
    await broken.closeSession({sessionId:failure.sessionId});
    assert.equal(existsSync(stage),false);assert.ok(closeCalls>=2);
  } finally {peer?.close();finishExit();rmSync(root,{recursive:true,force:true});}
}
const { verifyClaudeSdkBytes } = await import('../src/agent/claude-sdk-resource.js');
assert.throws(()=>verifyClaudeSdkBytes(Buffer.from('untrusted')), /CLAUDE_SDK_RESOURCE_UNVERIFIED/);
const { compileClaudeSdkResource }=await import('./claude-sdk-resource.mjs');
const staticSdk=join(process.cwd(),'.superpowers/sdd/2026-10-22-agent-expansion-plan/claude-sdk-static/package');
if (existsSync(join(staticSdk,'sdk.mjs'))) {
  // Static write:false only: neither SDK module evaluation nor vendor process execution.
  const bytes=await compileClaudeSdkResource(staticSdk);
  assert.equal(verifyClaudeSdkBytes(bytes),bytes);
  const tampered=Buffer.from(bytes);tampered[0]^=1;
  assert.throws(()=>verifyClaudeSdkBytes(tampered),/CLAUDE_SDK_RESOURCE_UNVERIFIED/);
  console.log('Official SDK0.3.308 static resource bytes verified (SDK not executed)');
}
const {loadClaudeSdkResource}=await import('../src/agent/claude-sdk-resource.js');
await assert.rejects(loadClaudeSdkResource({resourceRoot:join(tmpdir(),'absent-claude-resource')}),e=>e.code==='CLAUDE_SDK_RESOURCE_UNVERIFIED');
assert.equal(captured.options.strictMcpConfig,true);
if(existsSync(join(staticSdk,'sdk.mjs'))) {
  const {mkdirSync,writeFileSync}=await import('node:fs');
  const {CLAUDE_SDK_RESOURCE_FILE}=await import('../src/agent/claude-sdk-resource.js');
  const fixtureRoot=mkdtempSync(join(tmpdir(),'claude-resource-fixture-'));
  try {
    const file=join(fixtureRoot,CLAUDE_SDK_RESOURCE_FILE);
    mkdirSync(join(fixtureRoot,'agent-sdk'),{recursive:true});
    writeFileSync(file,await compileClaudeSdkResource(staticSdk));
    const official=await loadClaudeSdkResource({resourceRoot:fixtureRoot});
    assert.equal(typeof official.query,'function');
    // Module evaluation only: no query, CLI, credential, account or model call.
  } finally {rmSync(fixtureRoot,{recursive:true,force:true});}
}
const { createClaudeSdkRunnerLauncher } = await import('../src/agent/claude-agent-provider.js');
const {EventEmitter}=await import('node:events');
let spawnArguments;
const fakeChild=new EventEmitter();fakeChild.stdout=new PassThrough();fakeChild.stdin=new PassThrough();fakeChild.stderr=new PassThrough();
const fakeLaunch=createClaudeSdkRunnerLauncher({executable:'C:/Product/Core.exe',sea:true,entry:'must-not-run.js',
  envSource:{PATH:'fixture-path',ANTHROPIC_API_KEY:'must-not-inherit',NODE_OPTIONS:'--inspect'},
  spawnImpl:(...args)=>{spawnArguments=args;return fakeChild;}});
let observedHandle;
const fakeHandle=await fakeLaunch({cwd:'C:/staging',onHandle:handle=>{observedHandle=handle;}});
assert.equal(observedHandle,fakeHandle);
assert.deepEqual(spawnArguments[1],['--agent-sdk-runner','claude']);
assert.equal(spawnArguments[0],'C:/Product/Core.exe');
assert.equal(spawnArguments[2].shell,false);
assert.equal(spawnArguments[2].env.ANTHROPIC_API_KEY,undefined);
assert.equal(spawnArguments[2].env.NODE_OPTIONS,undefined);
fakeChild.emit('close',0,null);await fakeHandle.close();await fakeHandle.done;
const runnerCwd=mkdtempSync(join(tmpdir(),'claude-source-runner-'));
try {
  const actual=await createClaudeSdkRunnerLauncher()({cwd:runnerCwd});
  let raw='';actual.readable.on('data',chunk=>{raw+=chunk.toString();});
  const connection=createJsonRpcTransport({readable:actual.readable,writable:actual.writable,framing:'acp-v1-jsonl'});
  await assert.rejects(connection.request('initialize',{credential:'source-fixture-only',runtimePath:'/not-launched',cwd:runnerCwd,tools:[]}),e=>e.code==='RPC_REMOTE_ERROR');
  actual.writable.end();
  assert.equal((await actual.done).exitCode,0);
  await actual.close();connection.close();
  assert.ok(!raw.includes('source-fixture-only'));
  assert.ok(raw.split('\n').filter(Boolean).every(line=>JSON.parse(line).jsonrpc==='2.0'));
  const {readdirSync}=await import('node:fs');assert.deepEqual(readdirSync(runnerCwd),[]);
}finally{rmSync(runnerCwd,{recursive:true,force:true});}
