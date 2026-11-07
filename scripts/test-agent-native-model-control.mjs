// Actual Provider implementations and owned synthetic JSON-RPC peers only.
// No native CLI generation, account, tool execution or remote inference.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createCodexAppServerProvider, CODEX_APP_SERVER_SCHEMA_VERSION } from '../src/agent/codex-app-server-provider.js';
import { createClaudeAgentProvider } from '../src/agent/claude-agent-provider.js';
import { createAcpAgentProvider } from '../src/agent/acp-agent-provider.js';
import { readCodexModelCatalog, projectCodexModelControl } from '../src/agent/protocol/codex-model-control.js';

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-native-model-control-')));
const version = '0.167.0-alpha.3.2';
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const security = { verified: true, mode: 'native', nativeSandboxSupported: true,
  nativeApprovalSupported: true, inheritedExtensionsDisabled: true, sandbox: 'read-only', approvalPolicy: 'on-request' };
const resolveTaskWorkspace = ({ taskId, workspaceId }) => ({ task: { id: taskId, workspaceId, goal: 'Synthetic native configuration' }, workspace: { id: workspaceId, root } });
const modelRows = [
  { id: 'catalog-entry-a', model: 'native-model-a', displayName: 'Native A', defaultReasoningEffort: 'medium', isDefault: true, hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Native medium' }, { reasoningEffort: 'xhigh', description: 'Native extended' }] },
  { id: 'catalog-entry-b', model: 'native-model-b', displayName: 'Native B', defaultReasoningEffort: 'high', isDefault: false, hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Native high' }, { reasoningEffort: 'low', description: 'Native low' }] }
];
function boundaryRows(descriptionLength, extraDescription = '') {
  return Array.from({ length: 256 }, (_, index) => ({
    model: 'model-' + String(index).padStart(3, '0'), displayName: 'L'.repeat(256),
    supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'R'.repeat(descriptionLength) + (index === 1 ? extraDescription : '') }],
    defaultReasoningEffort: 'low'
  }));
}
async function boundaryCatalog(descriptionLength, extraDescription = '') {
  const rows = boundaryRows(descriptionLength, extraDescription);
  let page = 0;
  return readCodexModelCatalog(async () => ({ data: rows.slice(page * 100, ++page * 100), nextCursor: page < 3 ? 'page-' + page : null }));
}
function nativeFixture({ runtimeVersion = version, verified = true, behavior = 'ack' } = {}) {
  let peer, nextBehavior=behavior, nextRows=modelRows;
  const provider = createCodexAppServerProvider({ taskOptions: { verifiedRuntime: { verified, version: runtimeVersion, security }, resolveTaskWorkspace },
    launch(binding) {
      const readable = new PassThrough(), writable = new PassThrough(); let finish;
      const done = new Promise(resolve => { finish = resolve; });
      const currentPeer=peer = { frames: [], model: 'native-model-a', effort: 'medium', behavior:nextBehavior, rows:nextRows, hasTurn: false, threadId: 'native-config-thread',
        send(frame) { readable.write(JSON.stringify(frame) + '\n'); },
        reply(frame, result) { this.send({ id: frame.id, result }); } };
      const receipt = () => ({ thread: { id: currentPeer.threadId }, model: currentPeer.model, reasoningEffort: currentPeer.effort,
        modelProvider: 'native-provider', cwd: binding.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'readOnly' } });
      writable.on('data', chunk => {const peer=currentPeer; for (const line of String(chunk).trim().split('\n')) {
        const frame = JSON.parse(line); peer.frames.push(frame);
        if (frame.method === 'initialize') peer.reply(frame, { userAgent: 'synthetic-codex' });
        if (frame.method === 'model/list') {
          const start = Number(frame.params.cursor ?? 0), end = start + 100;
          peer.reply(frame, { data: peer.rows.slice(start, end), nextCursor: end < peer.rows.length ? String(end) : null });
        }
        if (frame.method === 'thread/start') {
          if(peer.behavior==='reject-start'){peer.send({id:frame.id,error:{code:-32602,message:'Synthetic target refusal'}});continue;}
          if(frame.params.model)peer.model=frame.params.model;if(frame.params.config?.model_reasoning_effort)peer.effort=frame.params.config.model_reasoning_effort;
          const result=receipt();if(peer.behavior==='mismatch-start')result.reasoningEffort='medium';peer.reply(frame,result);
        }
        if (frame.method === 'thread/resume') {
          if (!peer.hasTurn) {peer.send({id:frame.id,error:{code:-32600,message:'No rollout before the first turn'}});continue;}
          if (peer.behavior === 'reject') { peer.send({ id: frame.id, error: { code: -32602, message: 'Synthetic configuration rejection' } }); continue; }
          if (frame.params.model) peer.model = frame.params.model;
          if (frame.params.config?.model_reasoning_effort) peer.effort = frame.params.config.model_reasoning_effort;
          const result = receipt();
          if (peer.behavior === 'mismatch') result.reasoningEffort = peer.effort === 'medium' ? 'xhigh' : 'medium';
          peer.reply(frame, result);
        }
        if (frame.method === 'turn/start') {peer.hasTurn=true;peer.reply(frame, { turn: { id: 'native-config-turn', status: 'inProgress', items: [], error: null } });}
        if (frame.method === 'turn/interrupt') { peer.reply(frame, {}); peer.send({ method: 'turn/completed', params: { threadId: peer.threadId, turn: { id: 'native-config-turn', status: 'interrupted' } } }); }
      } });
      const handle = { readable, writable, done, async close() {currentPeer.closes=(currentPeer.closes??0)+1; finish({ exitCode: 0, processTreeExitConfirmed: true }); } };
      binding.onHandle?.(handle); return handle;
    } });
  return { provider, get peer() { return peer; },setNextBehavior(value){nextBehavior=value;},setNextRows(value){nextRows=value;} };
}
async function settledSyntheticTurn(fixture, created) {
  await fixture.provider.send({...created,content:'Synthetic peer turn only'});await tick();
  fixture.peer.send({method:'turn/completed',params:{threadId:fixture.peer.threadId,turn:{id:'native-config-turn',status:'completed'}}});await tick();
}
let failures = 0;
async function check(name, action) {
  try { await action(); console.log('PASS ' + name); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.code || error.name || 'Error'} ${error.stack?.split('\n').find(line => line.includes('test-agent-native-model-control.mjs'))?.trim() ?? ''}`); }
}
try {
  await check('0.167 profile alone never grants execution eligibility', async () => {
    const fixture = nativeFixture({ verified: false });
    assert.equal((await fixture.provider.health()).available, false);
    await assert.rejects(fixture.provider.createSession({ taskId: 'unverified', workspaceId: 'workspace', model: 'native-model-a' }));
    assert.equal(fixture.peer, undefined, 'missing trusted runtime evidence is refused before launch');
    await fixture.provider.shutdown();
  });
  await check('0.163 without verified control profile rejects an override before launch', async () => {
    const fixture = nativeFixture({ runtimeVersion: CODEX_APP_SERVER_SCHEMA_VERSION });
    try {
      await assert.rejects(fixture.provider.createSession({ taskId: 'legacy-model', workspaceId: 'workspace', model: 'native-model-b' }), { code: 'AGENT_CONFIGURATION_UNSUPPORTED' });
      assert.equal(fixture.peer, undefined);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('native catalog and initial full-tuple ACK reach the ordinary provider', async () => {
    const fixture = nativeFixture();
    try {
      const created = await fixture.provider.createSession({ taskId: 'native-initial', workspaceId: 'workspace', model: 'native-model-b', reasoningEffort: 'high' });
      const control = (await fixture.provider.status(created)).modelControl;
      assert.equal(control.status, 'available'); assert.equal(control.application, 'runtime-confirmed'); assert.equal(control.runtimeVersion, version);
      assert.deepEqual(control.selection, { model: 'native-model-b', reasoningEffort: 'high', modelProvider: 'native-provider' });
      assert.deepEqual(control.model.options.map(row => row.value), ['native-model-a', 'native-model-b'], 'wire model values, not catalog record IDs');
      assert.ok(Array.isArray(control.model.options[0].reasoningOptions),'the target-model advertisement is present before UI consumption');
      assert.deepEqual(control.model.options[0].reasoningOptions.map(row=>row.value),['medium','xhigh']);
      assert.deepEqual(control.model.options[1].reasoningOptions.map(row=>row.value),['high','low'],'each target model retains its own advertised reasoning choices');
      assert.equal(control.model.options[1].defaultReasoningEffort,'high');
      assert.deepEqual(control.reasoning.options.map(row => row.value), ['high', 'low'], 'use only this native model advertisement');
      const count = fixture.peer.frames.length;
      await assert.rejects(fixture.provider.selectModel({ ...created, reasoningEffort: 'xhigh' }), { code: 'AGENT_CONFIGURATION_UNSUPPORTED' });
      await assert.rejects(fixture.provider.selectModel({ ...created, model: 'invented-managed-model' }), { code: 'AGENT_CONFIGURATION_UNSUPPORTED' });
      assert.equal(fixture.peer.frames.length, count, 'unadvertised requests do not mutate native configuration');
      assert.equal(fixture.peer.frames.filter(frame => frame.method === 'turn/start').length, 0, 'configuration is not inference');
      await fixture.provider.closeSession(created);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('native advertised defaults must belong to the same model options',async()=>{
    await assert.rejects(readCodexModelCatalog(async()=>({data:[{...modelRows[0],defaultReasoningEffort:'not-advertised'}],nextCursor:null})),{code:'CODEX_MODEL_CATALOG_INVALID'});
  });
  await check('nested native model metadata has a total byte budget',async()=>{
    const data=Array.from({length:100},(_,index)=>({...modelRows[0],model:'m'+String(index).padStart(3,'0')+'x'.repeat(240),displayName:'M'.repeat(256),
      supportedReasoningEfforts:['medium','high','low','xhigh'].map(reasoningEffort=>({reasoningEffort,description:'D'.repeat(256)}))}));
    await assert.rejects(readCodexModelCatalog(async()=>({data,nextCursor:null})),{code:'CODEX_MODEL_CATALOG_INVALID'});
  });
  await check('the complete native control envelope accepts the exact byte limit without altering native data', async () => {
    const catalog = await boundaryCatalog(142, 'R'.repeat(45));
    const selection = { model: 'model-000', modelProvider: 'synthetic', reasoningEffort: 'low' };
    const control = projectCodexModelControl({ version, catalog, selection });
    assert.equal(Buffer.byteLength(JSON.stringify(control)), 128 * 1024);
    assert.deepEqual(control.selection, selection);
    assert.deepEqual(control.model.options, catalog.map(({ value, label, efforts, defaultReasoningEffort }) => ({ value, label, reasoningOptions: efforts, defaultReasoningEffort })));
    assert.deepEqual(control.reasoning.options, catalog[0].efforts);
  });
  await check('the complete native control envelope rejects near-limit and UTF-8 overflow without truncation', async () => {
    const selection = { model: 'model-000', modelProvider: 'synthetic', reasoningEffort: 'low' };
    for (const catalog of [await boundaryCatalog(143), await boundaryCatalog(142, 'R'.repeat(46)), await boundaryCatalog(142, '\u754c'.repeat(16))]) {
      const before = structuredClone({ catalog, selection });
      assert.ok(catalog.reduce((total, row) => total + Buffer.byteLength(JSON.stringify(row)), 0) < 128 * 1024, 'the normalized rows fit before the final envelope is constructed');
      assert.throws(() => projectCodexModelControl({ version, catalog, selection }), { code: 'CODEX_MODEL_CATALOG_INVALID' });
      assert.deepEqual({ catalog, selection }, before, 'a refused projection preserves complete native identities, advertisements and ACK');
    }
  });
  await check('an oversized fresh target is refused and closed before publication while its source remains ready', async () => {
    const fixture = nativeFixture();
    try {
      const source = await fixture.provider.createSession({ taskId: 'budget-source', workspaceId: 'workspace' }), sourcePeer = fixture.peer;
      const selection = (await fixture.provider.status(source)).modelControl.selection;
      fixture.setNextRows(boundaryRows(143));
      await assert.rejects(fixture.provider.createSession({ taskId: 'budget-target', workspaceId: 'workspace', model: 'model-000', reasoningEffort: 'low' }), { code: 'CODEX_MODEL_CATALOG_INVALID' });
      assert.ok(fixture.peer.closes > 0, 'the unused oversized target has an observed close');
      assert.equal(sourcePeer.closes ?? 0, 0);
      assert.equal((await fixture.provider.status(source)).state, 'ready');
      assert.deepEqual((await fixture.provider.status(source)).modelControl.selection, selection);
      assert.equal(fixture.peer.frames.filter(frame => frame.method === 'turn/start').length, 0);
      await fixture.provider.closeSession(source);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('unadvertised initial override is a typed refusal before native thread creation',async()=>{
    const fixture=nativeFixture();try{
      await assert.rejects(fixture.provider.createSession({taskId:'invalid-initial-model',workspaceId:'workspace',model:'not-native-advertised'}),{code:'AGENT_CONFIGURATION_UNSUPPORTED'});
      assert.equal(fixture.peer.frames.some(frame=>frame.method==='thread/start'),false);
      assert.ok(fixture.peer.closes>0);
    }finally{await fixture.provider.shutdown();}
  });
  for(const behavior of ['reject-start','mismatch-start'])await check(`${behavior} on a fresh target preserves the existing source`,async()=>{
    const fixture=nativeFixture();try{
      const source=await fixture.provider.createSession({taskId:'source-'+behavior,workspaceId:'workspace'}),sourcePeer=fixture.peer;
      const selection=(await fixture.provider.status(source)).modelControl.selection;
      fixture.setNextBehavior(behavior);
      await assert.rejects(fixture.provider.createSession({taskId:'target-'+behavior,workspaceId:'workspace',model:'native-model-b',reasoningEffort:'high'}));
      assert.deepEqual((await fixture.provider.status(source)).modelControl.selection,selection);
      assert.equal((await fixture.provider.status(source)).state,'ready');assert.equal(sourcePeer.closes??0,0,'the old source is not cancelled on target failure');
      assert.ok(fixture.peer.closes>0,'the unused rejected target has an observed close');
      await fixture.provider.closeSession(source);
    }finally{await fixture.provider.shutdown();}
  });
  await check('matching native selection serializes exact turn parameters and refuses a running switch', async () => {
    const fixture = nativeFixture();
    try {
      const created = await fixture.provider.createSession({ taskId: 'native-wire', workspaceId: 'workspace' });
      const before=fixture.peer.frames.length;
      await assert.rejects(fixture.provider.selectModel({...created,reasoningEffort:'xhigh'}),{code:'AGENT_CONFIGURATION_REQUIRES_NEW_SESSION'});
      assert.equal(fixture.peer.frames.length,before,'a new native thread has no resumable rollout before its first turn');
      assert.equal((await fixture.provider.status(created)).modelControl.status,'available','known fresh-session refusal does not erase the confirmed initial tuple');
      await settledSyntheticTurn(fixture,created);
      const sourcePeer=fixture.peer,sourceCount=sourcePeer.frames.length;
      await assert.rejects(fixture.provider.selectModel({...created,reasoningEffort:'xhigh'}),{code:'AGENT_CONFIGURATION_REQUIRES_NEW_SESSION'});
      assert.equal(sourcePeer.frames.length,sourceCount,'a loaded thread resume ACK cannot prove that an override applied');
      const target=await fixture.provider.createSession({taskId:'native-wire-target',workspaceId:'workspace',model:'native-model-a',reasoningEffort:'xhigh'});
      assert.equal((await fixture.provider.status(created)).modelControl.selection.reasoningEffort,'medium','creating a new configured target preserves the old source');
      await fixture.provider.send({ ...target, content: 'Synthetic configuration only', runId: 'native-wire-run' }); await tick();
      const turn = fixture.peer.frames.findLast(frame => frame.method === 'turn/start');
      assert.equal(turn.params.model, 'native-model-a'); assert.equal(turn.params.effort, 'xhigh');
      assert.equal(turn.params.threadId, fixture.peer.threadId);
      await assert.rejects(fixture.provider.selectModel({ ...target, model: 'native-model-b', reasoningEffort: 'high' }), { code: 'TURN_BUSY' });
      assert.equal((await fixture.provider.status(target)).modelControl.selection.reasoningEffort, 'xhigh', 'turn acceptance is not a new model receipt');
      fixture.peer.send({ method: 'turn/completed', params: { threadId: fixture.peer.threadId, turn: { id: 'native-config-turn', status: 'completed' } } }); await tick();
      await fixture.provider.closeSession(target);await fixture.provider.closeSession(created);
    } finally { await fixture.provider.shutdown(); }
  });
  for (const behavior of ['reject', 'mismatch']) await check(`${behavior} preserves confirmed tuple and fences unknown native effects`, async () => {
    const fixture = nativeFixture();
    try {
      const created = await fixture.provider.createSession({ taskId: 'native-' + behavior, workspaceId: 'workspace' });
      await settledSyntheticTurn(fixture,created);
      const before = (await fixture.provider.status(created)).modelControl.selection;
      fixture.peer.behavior = behavior;
      await assert.rejects(fixture.provider.resume({ ...created,taskId:'native-'+behavior,workspaceId:'workspace' }));
      const after = (await fixture.provider.status(created)).modelControl;
      assert.deepEqual(after.selection, before); assert.equal(after.status, 'unknown');
      const turns = fixture.peer.frames.filter(frame => frame.method === 'turn/start').length;
      await assert.rejects(fixture.provider.send({ ...created, content: 'Do not dispatch unknown configuration' }), { code: 'AGENT_CONFIGURATION_UNKNOWN' });
      assert.equal(fixture.peer.frames.filter(frame => frame.method === 'turn/start').length, turns);
      await fixture.provider.closeSession(created);
    } finally { await fixture.provider.shutdown(); }
  });
  for(const reportedVersion of ['2.1.4','99.0.0']) await check(`ACP advertised controls require the verified method version (${reportedVersion})`,async()=>{
    let frames=[];
    let options=[{id:'model',category:'model',type:'select',currentValue:'native-a',options:[{value:'native-a',name:'A'},{value:'native-b',name:'B'}]}];
    const provider=createAcpAgentProvider({descriptor:{id:'opencode',label:'OpenCode',protocolVersion:1,runtimeVersion:'opencode v2.1.4',verifiedRuntime:true,security},resolveTaskWorkspace,
      launch(){const readable=new PassThrough(),writable=new PassThrough();let finish;const done=new Promise(resolve=>{finish=resolve;});
        const reply=(frame,result)=>readable.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result})+'\n');
        writable.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){const frame=JSON.parse(line);frames.push(frame);
          if(frame.method==='initialize')reply(frame,{protocolVersion:1,agentInfo:{name:'OpenCode',version:reportedVersion}});
          if(frame.method==='session/new')reply(frame,{sessionId:'native-acp-control',configOptions:options});
          if(frame.method==='session/set_config_option'){options=options.map(row=>({...row,currentValue:frame.params.value}));reply(frame,{configOptions:options});}
        }});return{readable,writable,done,async close(){finish({exitCode:0,processTreeExitConfirmed:true});}};
      }});
    try{
      const created=await provider.createSession({taskId:'acp-version-'+reportedVersion,workspaceId:'workspace'});
      const control=(await provider.status(created)).modelControl;
      if(reportedVersion==='2.1.4'){
        assert.equal(control.runtimeVersion,'2.1.4');
        assert.equal((await provider.selectModel({...created,model:'native-b'})).confirmed,true);
      }else{
        assert.equal(control.status,'unsupported','advertisement alone cannot establish method support on an unverified runtime version');
        const count=frames.length;await assert.rejects(provider.selectModel({...created,model:'native-b'}),{code:'AGENT_CONFIGURATION_UNSUPPORTED'});assert.equal(frames.length,count);
      }
      await provider.closeSession(created);
    }finally{await provider.shutdown();}
  });
  await check('Claude configured model is an explicit fresh-session request, never a native selection ACK', async () => {
    let launches = 0, bootstrap;
    const provider = createClaudeAgentProvider({ resolveCredential: async () => 'SYNTHETIC_CLAUDE_KEY',
      taskOptions: { resolveTaskWorkspace, verifiedRuntime: { verified: true, sdkResourcesVerified: true, binaryVerified: true,
        version: '2.1.308', sdkVersion: '0.3.308', model: 'owner-configured-model', runtimePath: 'fixture-runtime', security } },
      launchSdkRunner(binding) {
        launches++; const readable = new PassThrough(), writable = new PassThrough(); let finish;
        const done = new Promise(resolve => { finish = resolve; });
        writable.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) {
          const frame = JSON.parse(line); let result;
          if (frame.method === 'initialize') { if (frame.params.credential) bootstrap = frame.params; result = frame.params.protocolVersion ? { protocolVersion: 1 } : { initialized: true }; }
          if (frame.method === 'session/new') result = { sessionId: 'claude-synthetic-session' };
          if (result) readable.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\n');
        } });
        const handle = { readable, writable, done, async close() { finish({ exitCode: 0, processTreeExitConfirmed: true }); } }; binding.onHandle(handle); return handle;
      } });
    try {
      const created = await provider.createSession({ taskId: 'claude-fresh', workspaceId: 'workspace', model: 'owner-configured-model' });
      const control = (await provider.status(created)).modelControl;
      assert.equal(bootstrap.model, 'owner-configured-model');
      assert.equal(control.application, 'requires-new-session'); assert.equal(control.selection, null);
      assert.equal(control.requested.model, 'owner-configured-model'); assert.deepEqual(control.reasoning.options, []);
      const before = launches;
      await assert.rejects(provider.createSession({ taskId: 'claude-override', workspaceId: 'workspace', model: 'other-model' }), { code: 'AGENT_CONFIGURATION_UNSUPPORTED' });
      assert.equal(launches, before);
      await provider.closeSession(created);
    } finally { await provider.shutdown(); }
  });
} finally {
  assert.equal(path.dirname(root).toLowerCase(), fs.realpathSync.native(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(root).startsWith('cm-native-model-control-'));
  fs.rmSync(root, { recursive: true, force: true });
}
assert.equal(failures, 0, 'native model-control regressions remain');
