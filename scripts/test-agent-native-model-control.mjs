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
import { createCodexProviderRouter } from '../src/agent/codex-provider-router.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createAgentService } from '../src/agent/service.js';

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
function catalogFixture({ verified = true, runtimeVersion = version, catalog = modelRows, closeUnknown = false, hold = false, reverseRequest = false, hangLaunch = false, holdIdentityAt = 0, replaceRoot = false } = {}) {
  let identity = 'a'.repeat(64), peer, release, unknown = closeUnknown, identityCalls = 0, releaseIdentity, replacement;
  const heldIdentity = new Promise(resolve => { releaseIdentity = resolve; });
  const provider = createCodexAppServerProvider({ taskOptions: { verifiedRuntime: { verified, version: runtimeVersion, security }, resolveTaskWorkspace },
    launch() { throw new Error('Discovery must never use the Task launcher'); },
    catalogOptions: { resolveIdentity: async () => ++identityCalls === holdIdentityAt ? heldIdentity : identity, timeoutMs: 100,
      launch(binding) {
        assert.equal(binding.taskId, undefined); assert.equal(binding.workspaceId, undefined); assert.equal(binding.sessionId, undefined);
        assert.equal(binding.purpose, 'model-catalog'); assert.notEqual(binding.cwd, root);
        assert.deepEqual(fs.readdirSync(binding.cwd), []); assert.deepEqual(fs.readdirSync(binding.profileRoot), []);
        const readable = new PassThrough(), writable = new PassThrough(); let finish;
        const done = new Promise(resolve => { finish = resolve; });
        peer = { frames: [], binding, closes: 0, send: frame => readable.write(JSON.stringify(frame) + '\n') };
        writable.on('data', chunk => { for (const line of String(chunk).trim().split('\n')) {
          const frame = JSON.parse(line); peer.frames.push(frame);
          if (frame.method === 'initialize') {
            peer.send({ id: frame.id, result: { userAgent: 'synthetic-codex' } });
            if (reverseRequest) peer.send({ id: 'reverse-permission', method: 'item/commandExecution/requestApproval', params: { command: 'never-run' } });
          }
          if (frame.method === 'model/list') {
            const respond = () => peer.send({ id: frame.id, result: { data: catalog, nextCursor: null } });
            if (hold) release = respond; else respond();
          }
        } });
        const handle = { readable, writable, done, async close() {
          peer.closes++; if (unknown) throw Object.assign(new Error('Synthetic unconfirmed exit'), { code: 'ACP_CLOSE_UNKNOWN' });
          if (replaceRoot && !replacement) {
            const probeRoot = path.dirname(binding.cwd), parent = fs.realpathSync.native(os.tmpdir());
            assert.equal(path.dirname(probeRoot).toLowerCase(), parent.toLowerCase());
            const parking = fs.mkdtempSync(path.join(root, 'catalog-replacement-')), parked = path.join(parking, 'owned-original');
            assert.ok(path.resolve(parked).startsWith(root + path.sep));
            const originalIdentity = fs.lstatSync(probeRoot, { bigint: true });
            fs.renameSync(probeRoot, parked);
            const target = replaceRoot === 'junction' ? path.join(parking, 'replacement-target') : probeRoot;
            fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'replacement-owner.txt'), 'replacement directory must survive');
            if (replaceRoot === 'junction') fs.symlinkSync(target, probeRoot, process.platform === 'win32' ? 'junction' : 'dir');
            replacement = { probeRoot, parked, target, originalIdentity, identity: fs.lstatSync(probeRoot, { bigint: true }) };
          }
          finish({ exitCode: 0, processTreeExitConfirmed: true });
        } };
        binding.onHandle(handle); return hangLaunch ? new Promise(() => {}) : handle;
      }
    } });
  return { provider, get peer() { return peer; }, get identityCalls() { return identityCalls; }, get replacement() { return replacement; },
    restoreRoot() {
      if (!replacement) return;
      const { probeRoot, parked, identity: expected } = replacement;
      if (fs.existsSync(probeRoot)) {
        const current = fs.lstatSync(probeRoot, { bigint: true });
        assert.equal(current.dev, expected.dev); assert.equal(current.ino, expected.ino);
        if (current.isSymbolicLink()) fs.unlinkSync(probeRoot); else fs.rmSync(probeRoot, { recursive: true });
      }
      fs.renameSync(parked, probeRoot);
    },
    cleanupRestoredRoot() {
      if (!replacement || !fs.existsSync(replacement.probeRoot)) return;
      const current = fs.lstatSync(replacement.probeRoot, { bigint: true });
      assert.equal(current.dev, replacement.originalIdentity.dev); assert.equal(current.ino, replacement.originalIdentity.ino);
      assert.equal(current.isSymbolicLink(), false); fs.rmSync(replacement.probeRoot, { recursive: true });
    }, releaseIdentity() { releaseIdentity(identity); }, setIdentity(value) { identity = value; }, release() { release?.(); }, settleClose() { unknown = false; } };
}
async function check(name, action) {
  try { await action(); console.log('PASS ' + name); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.code || error.name || 'Error'} ${error.stack?.split('\n').find(line => line.includes('test-agent-native-model-control.mjs'))?.trim() ?? ''}`); }
}
try {
  await check('metadata-only native catalog never grants formal Task eligibility',async()=>{
    // Reuse only the controlled native wire peer; omit Task runtime verification.
    let closeCount=0;
    const provider=createCodexAppServerProvider({catalogOptions:{metadataOnly:true,runtimeVersion:version,resolveIdentity:()=> 'e'.repeat(64),
      launch(){const readable=new PassThrough(),writable=new PassThrough();let finish;const done=new Promise(resolve=>{finish=resolve;});
        writable.on('data',chunk=>{for(const line of String(chunk).trim().split('\n')){const frame=JSON.parse(line);if(frame.id)readable.write(JSON.stringify({id:frame.id,result:frame.method==='model/list'?{data:modelRows,nextCursor:null}:{userAgent:'fixture'}})+'\n');}});
        return{readable,writable,done,close(){closeCount++;finish({processTreeExitConfirmed:true});}};}}});
    try{const catalog=await provider.modelCatalog();assert.equal(catalog.supported,true);assert.equal(catalog.runtimeVersion,version);
      const health=await provider.health();assert.equal(health.taskEligible,false);assert.equal(health.reason,'CODEX_APP_SERVER_ACCOUNT_ISOLATION_UNVERIFIED');
      await assert.rejects(provider.createSession({taskId:'blocked-native-auth',workspaceId:'workspace'}),{code:'CODEX_APP_SERVER_ACCOUNT_ISOLATION_UNVERIFIED'});
      assert.equal(closeCount,1);
    }finally{await provider.shutdown();}
  });
  await check('explicit dynamic transport affects new operations while existing sessions retain their owner',async()=>{
    let transport='exec',execCreates=0,appCreates=0;
    const leaf=name=>({id:'codex',capabilities:()=>({}),health:async()=>({transport:name}),modelCatalog:async()=>({transport:name}),
      createSession:async()=>({sessionId:name==='exec'?'exec-'+(++execCreates):'app-'+(++appCreates)}),status:async()=>({transport:name}),closeSession:async()=>({closed:true}),shutdown:async()=>{}});
    const router=createCodexProviderRouter({legacyProvider:leaf('exec'),appServerProvider:leaf('app-server'),selectTransport:()=>transport});
    try{const old=await router.createSession({taskId:'old',workspaceId:'workspace'});transport='app-server';
      assert.equal((await router.modelCatalog()).transport,'app-server');assert.equal((await router.status(old)).transport,'exec');
      assert.equal((await router.createSession({taskId:'new',workspaceId:'workspace'})).sessionId,'app-1');
      transport='invalid';await assert.rejects(router.createSession({}),{code:'CODEX_TRANSPORT_UNSUPPORTED'});
    }finally{await router.shutdown();}
  });
  await check('Settings defaults to exec and refuses unverified App Server selection before persistence',async()=>{
    const {createSettingsService}=await import('../src/settings/service.js');
    const settings=createSettingsService({stateDir:path.join(root,'transport-settings')});
    assert.equal(settings.store.get().settings.agents.codexTransport,'exec');
    const rev=settings.store.get().revision;
    await assert.rejects(settings.execute({method:'settings.update',params:{section:'agents',values:{codexTransport:'app-server'},expectedRev:rev}}),{code:'CODEX_APP_SERVER_ACCOUNT_ISOLATION_UNVERIFIED'});
    assert.equal(settings.store.get().revision,rev);assert.equal(settings.store.get().settings.agents.codexTransport,'exec');
    await settings.execute({method:'settings.update',params:{section:'general',values:{theme:'dark'}}});
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(settings.store.file)).settings.agents,'codexTransport'),false,'inactive transport preference preserves the prior settings reader');
    let release;
    const held=createSettingsService({stateDir:path.join(root,'transport-settings-cas'),validateCodexTransport:()=>new Promise(resolve=>{release=resolve;})});
    const saving=held.execute({method:'settings.update',params:{section:'agents',values:{codexTransport:'app-server'}}});
    while(!release)await tick();
    await held.execute({method:'settings.update',params:{section:'general',values:{theme:'dark'}}});
    release();await assert.rejects(saving,{code:'SETTINGS_CONFLICT'});assert.equal(held.store.get().settings.agents.codexTransport,'exec');
    const accepted=createSettingsService({stateDir:path.join(root,'transport-settings-approved'),validateCodexTransport:async()=>{}});
    await accepted.execute({method:'settings.update',params:{section:'agents',values:{codexTransport:'app-server'}}});
    assert.deepEqual(accepted.store.compatibility().features,['codex-app-server']);
    assert.equal(accepted.store.compatibility().baseline.available,true);
  });
  await check('production Codex metadata launcher isolates its profile and requires supervised closure', async () => {
    const { createCodexCatalogLauncher } = await import('../src/agent/codex-app-server-launcher.js');
    const probeRoot=fs.mkdtempSync(path.join(root,'production-launcher-'));
    const cwd=path.join(probeRoot,'cwd'),profileRoot=path.join(probeRoot,'profile');fs.mkdirSync(cwd);fs.mkdirSync(profileRoot);
    let processOptions,started,stops=0,finish,reported;
    const readable=new PassThrough(),writable=new PassThrough();
    const done=new Promise(resolve=>{finish=resolve;});
    const snapshot={executable:process.execPath,version,identity:'b'.repeat(64)};
    const launcher=createCodexCatalogLauncher({stateDir:root,resolveExecutable:()=>snapshot,
      environment:{SystemRoot:process.env.SystemRoot,PATH:'UNTRUSTED_SEARCH_PATH',CODEX_HOME:'USER_PROFILE',OPENAI_API_KEY:'SECRET',HTTP_PROXY:'http://proxy.invalid'},
      createProcess(options){processOptions=options;return{async probeAsync(){return{available:true,stdout:'codex-cli '+version};},startSession(input){started=input;return{child:{stdout:readable,stdin:writable},done,shutdown(){stops++;finish({processTreeExitConfirmed:true,stdout:'not public',stderr:'not public'});},cleanupPermitted:()=>true};},async shutdown(){}};}});
    assert.equal(await launcher.resolveIdentity(),snapshot.identity);
    await assert.rejects(launcher.launch({cwd,profileRoot,purpose:'task',transport:'app-server',schemaVersion:version}),{code:'AGENT_BOUNDARY_UNSUPPORTED'});
    const handle=await launcher.launch({cwd,profileRoot,purpose:'model-catalog',transport:'app-server',schemaVersion:version,onHandle:value=>{reported=value;}});
    assert.equal(reported,handle);assert.equal(processOptions.executable,process.execPath);
    assert.equal(processOptions.envSource.CODEX_HOME,profileRoot);
    for(const key of ['OPENAI_API_KEY','OPENAI_BASE_URL','HTTP_PROXY','HTTPS_PROXY'])assert.equal(processOptions.envSource[key],undefined);
    assert.notEqual(processOptions.envSource.PATH,'UNTRUSTED_SEARCH_PATH');
    assert.equal(started.inputMode,'open');assert.deepEqual(started.args,['app-server','--strict-config','--stdio']);
    assert.ok(fs.readFileSync(path.join(profileRoot,'config.toml'),'utf8').includes('requires_openai_auth = false'));
    assert.equal(handle.readable,readable);assert.equal(handle.writable,writable);
    await handle.close();assert.equal(stops,1);assert.equal((await handle.done).processTreeExitConfirmed,true);
    assert.equal((await handle.done).stdout,undefined);
    snapshot.version='0.0.0';await assert.rejects(launcher.resolveIdentity(),{code:'CODEX_APP_SERVER_VERSION_UNSUPPORTED'});
  });
  await check('catalog-only discovery uses existing service and Broker without creating a Session or changing default transport', async () => {
    const fixture = catalogFixture();
    const legacy = { id: 'codex', capabilities: () => ({ workspaceBoundary: 'native-staged' }), health: async () => ({ available: true }) };
    const router = createCodexProviderRouter({ legacyProvider: legacy, appServerProvider: fixture.provider, rolloutEnabled: true });
    const broker = createAgentBroker({ registry: createAgentProviderRegistry({ providers: [router] }) });
    const service = createAgentService({ broker });
    try {
      const result = await service.execute({ method: 'agent.modelCatalog', params: { provider: 'codex' } });
      assert.equal(result.supported, true); assert.equal(result.source, 'codex-app-server-model-list');
      assert.equal(result.connectionIdentity, 'a'.repeat(64)); assert.equal(result.runtimeVersion, version);
      assert.equal(result.modelControl.selection, null); assert.equal(result.modelControl.status, 'unknown');
      assert.equal(result.modelControl.application, 'requires-new-session');
      assert.deepEqual(result.modelControl.model.options.map(row => row.value), ['native-model-a', 'native-model-b']);
      assert.deepEqual(result.modelControl.model.options[1].reasoningOptions.map(row => row.value), ['high', 'low']);
      assert.equal(fixture.peer.closes, 1); assert.equal(fs.existsSync(fixture.peer.binding.cwd), false);
      assert.deepEqual(fixture.peer.frames.map(frame => frame.method), ['initialize', 'initialized', 'model/list']);
      await assert.rejects(service.execute({ method: 'agent.modelCatalog', params: { provider: 'codex', cwd: root } }), { code: 'INVALID_PARAMS' });
      const execRouter = createCodexProviderRouter({ legacyProvider: legacy, appServerProvider: fixture.provider });
      assert.equal((await execRouter.modelCatalog()).supported, false, 'metadata must not silently switch the selected transport');
    } finally { await router.shutdown(); }
  });
  for (const options of [{ verified: false }, { runtimeVersion: CODEX_APP_SERVER_SCHEMA_VERSION }]) await check('unverified native discovery profile refuses before launch ' + JSON.stringify(options), async () => {
    const fixture = catalogFixture(options);
    try { await assert.rejects(fixture.provider.modelCatalog(), { code: 'AGENT_MODEL_CATALOG_UNSUPPORTED' }); assert.equal(fixture.peer, undefined); }
    finally { await fixture.provider.shutdown(); }
  });
  await check('native metadata invalid advertisements close the owned probe and do not publish a partial catalog', async () => {
    const fixture = catalogFixture({ catalog: [{ ...modelRows[0], defaultReasoningEffort: 'invented' }] });
    try { await assert.rejects(fixture.provider.modelCatalog(), { code: 'CODEX_MODEL_CATALOG_INVALID' }); assert.equal(fixture.peer.closes, 1); }
    finally { await fixture.provider.shutdown(); }
  });
  await check('catalog identity change during native read discards advertisements and closes its own process', async () => {
    const fixture = catalogFixture({ hold: true });
    try {
      const pending = fixture.provider.modelCatalog();
      for (let i = 0; i < 20 && !fixture.peer?.frames.some(frame => frame.method === 'model/list'); i++) await tick();
      fixture.setIdentity('b'.repeat(64)); fixture.release();
      await assert.rejects(pending, { code: 'AGENT_RUNTIME_CHANGED' }); assert.equal(fixture.peer.closes, 1);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('unconfirmed catalog process cleanup retains owned profile and can be closed on shutdown', async () => {
    const fixture = catalogFixture({ closeUnknown: true });
    try {
      await assert.rejects(fixture.provider.modelCatalog(), { code: 'ACP_CLOSE_UNKNOWN' });
      assert.equal(fs.existsSync(fixture.peer.binding.cwd), true);
      await assert.rejects(fixture.provider.modelCatalog(), { code: 'ACP_CLOSE_UNKNOWN' });
      fixture.settleClose(); await fixture.provider.shutdown();
      assert.equal(fs.existsSync(fixture.peer.binding.cwd), false);
    } finally { fixture.settleClose(); await fixture.provider.shutdown(); }
  });
  await check('simultaneous catalog readers share one bounded native observation and metadata reverse requests cannot grant permissions', async () => {
    const fixture = catalogFixture({ hold: true, reverseRequest: true });
    try {
      const first = fixture.provider.modelCatalog(), second = fixture.provider.modelCatalog();
      assert.equal(first, second);
      for (let i = 0; i < 20 && !fixture.peer?.frames.some(frame => frame.id === 'reverse-permission'); i++) await tick();
      assert.ok(fixture.peer.frames.find(frame => frame.id === 'reverse-permission')?.error);
      fixture.release(); await Promise.all([first, second]);
      assert.equal(fixture.peer.closes, 1);
      assert.equal(fixture.peer.frames.filter(frame => frame.method === 'model/list').length, 1);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('catalog control timeout closes the owned probe without publishing or leaving a stuck refresh', async () => {
    const fixture = catalogFixture({ hold: true });
    try {
      await assert.rejects(fixture.provider.modelCatalog(), { code: 'RPC_TIMEOUT' });
      assert.equal(fixture.peer.closes, 1); assert.equal(fs.existsSync(fixture.peer.binding.cwd), false);
    } finally { await fixture.provider.shutdown(); }
  });
  await check('shutdown drains in-flight catalog ownership and late advertisements cannot publish', async () => {
    const fixture = catalogFixture({ hold: true });
    const pending = fixture.provider.modelCatalog().then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 20 && !fixture.peer?.frames.some(frame => frame.method === 'model/list'); i++) await tick();
    await fixture.provider.shutdown(); fixture.release();
    assert.ok((await pending).error); assert.equal(fixture.peer.closes, 1);
    assert.equal(fs.existsSync(fixture.peer.binding.cwd), false);
    await assert.rejects(fixture.provider.modelCatalog(), { code: 'PROVIDER_UNAVAILABLE' });
  });
  await check('a catalog launcher stalled after handle capture remains bounded and shutdown closes its owned process', async () => {
    const fixture = catalogFixture({ hangLaunch: true });
    const pending = fixture.provider.modelCatalog().then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 20 && !fixture.peer; i++) await tick();
    await fixture.provider.shutdown();
    assert.ok((await pending).error); assert.equal(fixture.peer.closes, 1);
    assert.equal(fs.existsSync(fixture.peer.binding.cwd), false);
  });
  await check('router shutdown fences a held catalog before the provider can publish it', async () => {
    const fixture = catalogFixture({ hold: true });
    const legacy = { id: 'codex', capabilities: () => ({}), shutdown: async () => {} };
    const router = createCodexProviderRouter({ legacyProvider: legacy, appServerProvider: fixture.provider, rolloutEnabled: true });
    try {
      const reading = router.modelCatalog().then(value => ({ value }), error => ({ error }));
      for (let i = 0; i < 20 && !fixture.peer?.frames.some(frame => frame.method === 'model/list'); i++) await tick();
      const stopping = router.shutdown();
      await tick(); fixture.release();
      const result = await reading; await stopping;
      assert.equal(result.value, undefined, 'shutdown must fence metadata publication before waiting on readers');
      assert.ok(result.error); assert.equal(fixture.peer.closes, 1);
    } finally { fixture.release(); await router.shutdown(); }
  });
  for (const holdIdentityAt of [1, 2, 3]) await check('identity validation has a bounded wait at observation boundary ' + holdIdentityAt, async () => {
    const fixture = catalogFixture({ holdIdentityAt });
    const legacy = { id: 'codex', capabilities: () => ({}), shutdown: async () => {} };
    const router = createCodexProviderRouter({ legacyProvider: legacy, appServerProvider: fixture.provider, rolloutEnabled: true });
    let readSettled = false, shutdownSettled = false;
    const reading = router.modelCatalog().then(value => { readSettled = true; return { value }; }, error => { readSettled = true; return { error }; });
    for (let i = 0; i < 20 && fixture.identityCalls < holdIdentityAt; i++) await tick();
    const stopping = router.shutdown().then(() => { shutdownSettled = true; }, error => { shutdownSettled = true; return error; });
    await new Promise(resolve => setTimeout(resolve, 250));
    const bounded = readSettled && shutdownSettled;
    // Always release the synthetic dependency, including on the RED run.
    fixture.releaseIdentity(); const result = await reading; await stopping;
    assert.equal(bounded, true, 'catalog and router shutdown must settle without an identity resolver completing');
    assert.equal(result.value, undefined); assert.ok(result.error);
    if (holdIdentityAt === 1) assert.equal(fixture.peer, undefined, 'late preflight identity cannot launch after shutdown');
    if (fixture.peer) { assert.equal(fixture.peer.closes, 1); assert.equal(fs.existsSync(fixture.peer.binding.cwd), false); }
  });
  await check('direct provider shutdown during the final identity await prevents late publication even before timeout', async () => {
    const fixture = catalogFixture({ holdIdentityAt: 3 });
    const pending = fixture.provider.modelCatalog().then(value => ({ value }), error => ({ error }));
    for (let i = 0; i < 20 && fixture.identityCalls < 3; i++) await tick();
    const stopping = fixture.provider.shutdown();
    fixture.releaseIdentity();
    const result = await pending; await stopping;
    assert.equal(result.value, undefined); assert.ok(result.error); assert.equal(fixture.peer.closes, 1);
  });
  for (const replaceRoot of ['directory', 'junction']) await check('catalog cleanup retains a replaced owned root and its new owner bytes: ' + replaceRoot, async () => {
    const fixture = catalogFixture({ replaceRoot });
    try {
      const result = await fixture.provider.modelCatalog().then(value => ({ value }), error => ({ error }));
      assert.equal(fs.readFileSync(path.join(fixture.replacement.target, 'replacement-owner.txt'), 'utf8'), 'replacement directory must survive');
      assert.equal(result.value, undefined); assert.equal(result.error?.code, 'ACP_CLOSE_UNKNOWN');
      assert.equal(fs.lstatSync(fixture.replacement.probeRoot).isSymbolicLink(), replaceRoot === 'junction');
      await assert.rejects(fixture.provider.shutdown(), { code: 'ACP_CLOSE_UNKNOWN' });
      assert.equal(fs.readFileSync(path.join(fixture.replacement.target, 'replacement-owner.txt'), 'utf8'), 'replacement directory must survive');
    } finally {
      fixture.restoreRoot(); await fixture.provider.shutdown(); assert.equal(fixture.peer.closes, 1); fixture.cleanupRestoredRoot();
    }
  });
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
