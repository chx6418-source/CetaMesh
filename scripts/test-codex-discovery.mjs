import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliAgentProcess, findCliExecutable, createMinimalAgentEnv } from '../src/agent/cli-agent-process.js';
import { createDesktopUiService } from '../src/desktop/ui-service.js';
import { createCetaMeshServices } from '../src/app/service-container.js';
import { createCodexAgentProvider } from '../src/agent/codex-agent-provider.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-discovery-'));
const failures = [];
async function check(name, run) { try { await run(); console.log('PASS', name); } catch (error) { failures.push(name + ": " + error.message); console.error('FAIL', name, error.message); } }
const env = { PATH: '', LOCALAPPDATA: path.join(root, 'Local App Data'), APPDATA: path.join(root, 'Roaming'), USERPROFILE: root };
const native = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
function probe(exe, args) {
 if (exe.includes('broken')) return { status: 1, stdout: '', stderr: '' };
 const text = args[0] === '--version' ? 'codex-cli 9.9.9-fixture' : args[0] === 'login' ? 'Logged in' : '--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check [SESSION_ID]';
 return { status: 0, stdout: text, stderr: '' };
}
function npmShimFixture(label, { name, packageName, binPath, layout = 'global', manifest } = {}) {
 const base = path.join(root, label);
 const directory = layout === 'global' ? base : layout === 'local-bin' ? path.join(base, 'node_modules', '.bin') : path.join(base, 'node_modules', '.bin', 'windows');
 const packageRoot = path.join(base, 'node_modules', ...packageName.split('/'));
 const script = path.join(packageRoot, binPath);
 fs.mkdirSync(path.dirname(script), { recursive: true }); fs.mkdirSync(directory, { recursive: true });
 const shim = path.join(directory, name + '.cmd'); fs.writeFileSync(shim, 'untrusted shell text must never execute');
 fs.writeFileSync(script, "console.log('" + name + "-fixture 1.2.3');");
 const manifestFile = path.join(packageRoot, 'package.json');
 if (manifest !== null) fs.writeFileSync(manifestFile, typeof manifest === 'string' ? manifest : JSON.stringify(manifest ?? { name: packageName, bin: { [name]: binPath } }));
 const codex = path.join(base, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
 fs.mkdirSync(path.dirname(codex), { recursive: true }); fs.writeFileSync(codex, "throw new Error('wrong provider: Codex must never run');");
 return { shim, script, packageRoot, manifestFile, directory };
}
const npmProviders = [
 { name: 'gemini', packageName: '@google/gemini-cli', binPath: 'dist/index.js' },
 { name: 'qwen', packageName: '@qwen-code/qwen-code', binPath: 'dist/index.js' }
];
try {
 const cli = new CliAgentProcess({ name: 'codex', envSource: env, platform: 'win32', probeImpl: probe });
 const provider = createCodexAgentProvider({ cliProcess: cli, resolveTaskWorkspace: () => null });
 assert.equal((await provider.health()).installed, false);
 fs.mkdirSync(path.dirname(native), { recursive: true }); fs.writeFileSync(native, 'controlled fake binary; probe injected');
 await check('official standalone absent from PATH', () => assert.equal(findCliExecutable('codex', { platform: 'win32', env, whereImpl: () => ({ status: 1 }) }), native));
 await check('install after provider construction with forced refresh', async () => {
  assert.equal((await provider.health()).installed, false, 'TTL remains cached before explicit refresh');
  const health = await provider.health({ refresh: true });
  assert.equal(health.installed, true); assert.equal(health.compatible, true); assert.equal(health.authenticated, true);
  assert.equal(health.sandboxCapable, null); assert.equal(health.taskEligible, true);
  assert.equal(health.installKind, 'standalone'); assert.equal(health.probePhase, 'ready');
  assert.equal(health.requiresStandaloneNode, false);
  assert.equal(provider.capabilities().installed, true, 'compatibility capabilities must use refreshed inspection rather than a startup snapshot');
 });
 await check('explicit user exe wins', () => assert.equal(new CliAgentProcess({ name: 'codex', envSource: { ...env, CODEX_CLI_PATH: native }, platform: 'win32', probeImpl: probe }).executable(), native));
 await check('invalid explicit path never silently falls back', () => {
  const health = createCodexAgentProvider({ environment: { ...env, CODEX_CLI_PATH: path.join(root, 'missing.exe') } });
  return health.health().then(value => { assert.equal(value.available, false); assert.equal(value.probeCode, 'CODEX_CLI_PATH_INVALID'); });
 });
 await check('broken PATH candidate cannot mask runnable standalone', async () => {
  const broken = path.join(root, 'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, 'codex.exe'), 'invalid');
  const fallback = createCodexAgentProvider({ cliProcess: new CliAgentProcess({ name: 'codex', envSource: { ...env, PATH: broken }, platform: 'win32', probeImpl: probe }) });
  assert.equal((await fallback.health()).available, true);
 });
 await check('missing Node reports shim diagnostic instead of not installed', async () => {
  const bin = path.join(root, 'shim'); const script = path.join(bin, 'node_modules/@openai/codex/bin/codex.js');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.writeFileSync(script, ''); const shim = path.join(bin, 'codex.cmd'); fs.writeFileSync(shim, '@echo off');
  const shimCli = new CliAgentProcess({ name: 'codex', executable: shim, envSource: { PATH: '' }, nodeExecutable: path.join(root, 'Core.exe'), platform: 'win32' });
  const health = await createCodexAgentProvider({ cliProcess: shimCli }).health();
  assert.equal(health.installed, true); assert.equal(health.compatible, false); assert.equal(health.probeCode, 'NODE_RUNTIME_UNAVAILABLE'); assert.equal(health.probePhase, 'version');
 });
 await check('CODEX_INSTALL_DIR is an explicit standalone bin location', () => {
  const selected = new CliAgentProcess({ name: 'codex', envSource: { PATH: '', CODEX_INSTALL_DIR: path.dirname(native) }, platform: 'win32', probeImpl: probe });
  assert.equal(selected.executable(), native);
 });
 await check('live environment snapshot is rebuilt during refresh', async () => {
  const current = { PATH: '', LOCALAPPDATA: path.join(root, 'not-installed') };
  const live = createCodexAgentProvider({ environment: current });
  assert.equal((await live.health()).installed, false);
  current.CODEX_CLI_PATH = native;
  assert.equal((await live.health({ refresh: true })).installed, true);
  assert.equal((await live.health()).compatible, false, 'invalid binary never becomes compatible');
 });
 await check('failed explicit CLI never selects another candidate', async () => {
  const broken = path.join(root, 'broken/codex.exe');
  const h = await createCodexAgentProvider({ cliProcess: new CliAgentProcess({ name: 'codex', envSource: { ...env, CODEX_CLI_PATH: broken }, platform: 'win32', probeImpl: probe }) }).health();
  assert.equal(h.installed, true); assert.equal(h.available, false); assert.equal(h.probePhase, 'version');
 });
 await check('real service assembly discovers installation without Core restart', async () => {
  const keys = ['PATH', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'CODEX_CLI_PATH', 'CODEX_INSTALL_DIR'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let services;
  try {
   process.env.PATH = ''; process.env.LOCALAPPDATA = path.join(root, 'production-local'); process.env.APPDATA = path.join(root, 'production-roaming');
   process.env.USERPROFILE = path.join(root, 'isolated-profile'); delete process.env.CODEX_CLI_PATH; delete process.env.CODEX_INSTALL_DIR;
   services = createCetaMeshServices({ stateDir: path.join(root, 'production-state'), dataRoot: path.join(root, 'production-data') });
   assert.equal((await services.desktopUiService.execute({ method: 'ui.agent.health', params: { provider: 'codex', refresh: true } })).installed, false);
   // Exercise the host's real discovery path, not Windows-only lookup on POSIX.
   const binary = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe')
    : path.join(root, 'production-bin', 'codex');
   fs.mkdirSync(path.dirname(binary), { recursive: true });
   if (process.platform !== 'win32') process.env.PATH = path.dirname(binary);
   fs.copyFileSync(process.execPath, binary);
   const h = await services.desktopUiService.execute({ method: 'ui.agent.health', params: { provider: 'codex', refresh: true } });
   assert.equal(h.installed, true); assert.equal(h.compatible, false); assert.equal(h.status, 'not-supported');
   assert.equal(h.installKind, process.platform === 'win32' ? 'standalone' : 'path'); assert.equal(h.probePhase, 'help');
   assert.equal(h.taskEligible, false, 'an executable without Codex protocol must not run tasks');
   assert.ok(!JSON.stringify(h).includes(root), 'Harbor diagnostics do not expose raw local paths');
  } finally {
   for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
   if (services) { await services.agentService.getProvider('codex').shutdown(); await services.capabilityService.close(); }
  }
 });
 await check('missing top-level protocol flag identifies help phase', async () => {
  const cli = { executable: () => 'fixture', probe: args => ({ available: true, stdout: args[0] === '--version' ? 'codex-cli 9.9.9' : args[0] === '--help' ? '--config --cd' : '--json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check [SESSION_ID]', stderr: '' }) };
  const h = await createCodexAgentProvider({ cliProcess: cli }).health(); assert.equal(h.compatible, false); assert.equal(h.probePhase, 'help');
 });
 await check('where.exe cannot authorize a cwd-only executable outside allowed directories', () => {
  const cwd = path.join(root, 'untrusted-cwd'); fs.mkdirSync(cwd); const exe = path.join(cwd, 'codex.exe');fs.writeFileSync(exe, 'not-authorized');
  assert.equal(findCliExecutable('codex', { platform: 'win32', env: { PATH: '' }, whereImpl: () => ({status: 0, stdout: exe}) }), null);
 });
 await check('old in-flight CLI cannot revalidate a replacement or A-B-A generation', async () => {
  const source = path.join(root, 'identity-workspace'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'sample.txt'), 'unchanged');
  let current = 'codex-A', finish;
  const cli = { executable: () => current, probe(args) { const r=probe(current,args);return {available:r.status===0,stdout:r.stdout,stderr:r.stderr}; },
   startSession({onStdout}) { onStdout(JSON.stringify({type:'thread.started',thread_id:'identity-thread'})+'\n'+JSON.stringify({type:'turn.completed'})+'\n');return {done:new Promise(resolve=>{finish=resolve;}),cancel:()=>({cancelled:true}),shutdown(){}}; }, async shutdown(){} };
  const p=createCodexAgentProvider({cliProcess:cli,stagingRoot:path.join(root,'identity-staging'),resolveTaskWorkspace:()=>({task:{id:'identity-task',workspaceId:'identity-workspace'},workspace:{id:'identity-workspace',root:source}})});
  try {
   const session=await p.createSession({taskId:'identity-task',workspaceId:'identity-workspace'});
   await p.send({sessionId:session.sessionId,content:'read only'});
   current='codex-B';assert.equal((await p.health({refresh:true})).sandboxCapable,null);
   current='codex-A';assert.equal((await p.health({refresh:true})).sandboxCapable,null);
   finish({exitCode:0,stdout:'',stderr:'',cancelled:false,timedOut:false});
   for(let i=0;i<100;i++){if((await p.status({sessionId:session.sessionId})).lastRunStatus==='completed')break;await new Promise(resolve=>setTimeout(resolve,10));}
   assert.equal((await p.status({sessionId:session.sessionId})).lastRunStatus,'completed');
   assert.equal((await p.health()).sandboxCapable,null,'completion belongs to the old inspection generation');
  } finally { await p.shutdown(); }
 });
 await check('known Sandbox refusal is not projected as a ready Agent badge', async () => {
  const ui=createDesktopUiService({services:{agentService:{execute:async()=>({id:'codex',available:true,installed:true,compatible:true,authenticated:true,sessionCapable:true,taskEligible:false,sandboxCapable:false,status:'sandbox_unavailable',reason:'sandbox_unavailable',workspaceBoundary:'staged-capability-broker'})}}});
  const h=await ui.execute({method:'ui.agent.health',params:{provider:'codex'}});
  assert.equal(h.taskEligible,false);assert.equal(h.status,'not-supported');assert.equal(h.sandboxCapable,false);
 });
 await check('desktop-managed CLI is discovered without PATH or explicit override after startup', async () => {
  const isolated={PATH:'',LOCALAPPDATA:path.join(root,'desktop-managed-local')};
  const p=createCodexAgentProvider({cliProcess:new CliAgentProcess({name:'codex',envSource:isolated,platform:'win32',probeImpl:probe})});
  assert.equal((await p.health()).installed,false);
  const bin=path.join(isolated.LOCALAPPDATA,'OpenAI/Codex/bin');
  const rgOnly=path.join(bin,'aaaaaaaaaaaaaaaa');fs.mkdirSync(rgOnly,{recursive:true});fs.writeFileSync(path.join(rgOnly,'rg.exe'),'not-a-cli');
  const generation=path.join(bin,'bbbbbbbbbbbbbbbb');fs.mkdirSync(generation);const exe=path.join(generation,'codex.exe');fs.writeFileSync(exe,'controlled native fixture');
  const h=await p.health({refresh:true});assert.equal(h.installed,true);assert.equal(h.compatible,true);assert.equal(h.installKind,'desktop-managed-cli');
  assert.equal(findCliExecutable('codex',{platform:'win32',env:isolated,whereImpl:()=>({status:1})}),exe);
  const outside=path.join(root,'external-generation');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'codex.exe'),'must-not-run');
  fs.unlinkSync(exe);fs.symlinkSync(outside,path.join(bin,'cccccccccccccccc'),process.platform==='win32'?'junction':'dir');
  assert.equal(findCliExecutable('codex',{platform:'win32',env:isolated,whereImpl:()=>({status:1})}),null,'junction cannot authorize outside code');
 });
 await check('Windows PATH aliases cannot retain a stale executor behind an explicit empty PATH', () => {
  const dir=path.join(root,'stale-path');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'codex.exe'),'stale');
  assert.equal(findCliExecutable('codex',{platform:'win32',env:{Path:dir,PATH:''},whereImpl:()=>({status:1})}),null);
  if(process.platform==='win32'){
   const clean=createMinimalAgentEnv({Path:dir},{PATH:'C:/Windows/System32'});assert.equal(clean.PATH,'C:/Windows/System32');assert.equal(Object.hasOwn(clean,'Path'),false);
  }
 });
 await check('unsupported shim remains installed with actionable code', async () => {
  const shim = path.join(root, 'unknown.cmd'); fs.writeFileSync(shim, 'untrusted command');
  const health = await createCodexAgentProvider({ cliProcess: new CliAgentProcess({ name: 'codex', executable: shim, envSource: { PATH: '' }, platform: 'win32' }) }).health();
  assert.equal(health.installed, true); assert.equal(health.probeCode, 'UNSUPPORTED_WINDOWS_SHIM');
 });
 await check('OpenCode desktop CLI is discovered only at the bounded native CLI path', () => {
  const isolated = { PATH: '', LOCALAPPDATA: path.join(root, 'opencode-local') };
  const app = path.join(isolated.LOCALAPPDATA, 'Programs', '@opencodedesktop');
  fs.mkdirSync(path.join(app, 'resources'), { recursive: true }); fs.writeFileSync(path.join(app, 'OpenCode.exe'), 'GUI must never launch');
  assert.equal(findCliExecutable('opencode', { platform: 'win32', env: isolated, whereImpl: () => ({ status: 1 }) }), null, 'GUI installation alone is not a CLI');
  const binary = path.join(app, 'resources', 'opencode-cli.exe'); fs.writeFileSync(binary, 'controlled native CLI fixture');
  assert.equal(findCliExecutable('opencode', { platform: 'win32', env: isolated, whereImpl: () => ({ status: 1 }) }), binary);
  const calls = [];
  const cli = new CliAgentProcess({ name: 'opencode', envSource: isolated, platform: 'win32', probeImpl(executable, args) { calls.push({ executable, args }); return { status: 0, stdout: '2.1.4', stderr: '' }; } });
  assert.equal(cli.version().available, true);
  assert.deepEqual(calls, [{ executable: binary, args: ['--version'] }]);
  assert.equal(findCliExecutable('gemini', { platform: 'win32', env: isolated, whereImpl: () => ({ status: 1 }) }), null);
  assert.equal(findCliExecutable('opencode', { platform: 'linux', env: isolated }), null);
 });
 for (const spec of [
  { name: 'gemini', packageName: '@google/gemini-cli', binPath: 'bundle/gemini.js', version: '0.65.0' },
  { name: 'qwen', packageName: '@qwen-code/qwen-code', binPath: 'cli-entry.js', version: '0.26.1' }
 ]) {
  await check(spec.name + ' pinned modern npm bin launches without executing shim text', () => {
   const fixture = npmShimFixture(spec.name + '-pinned-modern', { ...spec, manifest: { name: spec.packageName, version: spec.version, bin: { [spec.name]: spec.binPath } } });
   const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
   assert.equal(cli.version().version, spec.name + '-fixture 1.2.3');
   assert.deepEqual(cli.launchTarget().argsPrefix, [fixture.script]);
  });
  for (const version of [undefined, '9.9.9', spec.version + '-preview']) {
   await check(spec.name + ' rejects unverified version for modern npm bin ' + version, () => {
    const fixture = npmShimFixture(spec.name + '-unverified-modern-' + version, { ...spec, manifest: { name: spec.packageName, version, bin: { [spec.name]: spec.binPath } } });
    const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
    assert.equal(cli.probe(['--version']).code, 'UNSUPPORTED_WINDOWS_SHIM');
   });
  }
  await check(spec.name + ' rejects a manifest-selected arbitrary executable even at pinned version', () => {
   const fixture = npmShimFixture(spec.name + '-arbitrary-modern', { ...spec, binPath: 'other/execute.js', manifest: { name: spec.packageName, version: spec.version, bin: { [spec.name]: 'other/execute.js' } } });
   const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
   assert.equal(cli.probe(['--version']).code, 'UNSUPPORTED_WINDOWS_SHIM');
  });
 }
 for (const spec of npmProviders) {
  for (const layout of ['global', 'local-bin', 'nested-bin']) {
   await check(spec.name + ' npm shim selects its own package in ' + layout + ' layout', () => {
    const fixture = npmShimFixture(spec.name + '-' + layout + '-User Profile 空格', { ...spec, layout });
    const calls = [];
    const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32', probeImpl(executable, args, options) { calls.push({ executable, args, options }); return { status: 0, stdout: spec.name + '-fixture 1.2.3', stderr: '' }; } });
    assert.equal(cli.version().version, spec.name + '-fixture 1.2.3');
    assert.equal(calls.length, 1); assert.equal(calls[0].executable, process.execPath);
    assert.deepEqual(calls[0].args, [fixture.script, '--version']);
    assert.equal(calls[0].options.shell, undefined, 'npm command text is never sent to a shell');
   });
  }
  await check(spec.name + ' npm fixture executes directly through standalone Node', () => {
   const fixture = npmShimFixture(spec.name + '-actual-node', spec);
   const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
   assert.equal(cli.version().version, spec.name + '-fixture 1.2.3');
  });
  const invalidManifests = [
   ['missing', null], ['malformed', '{not-json'], ['wrong-package', { name: '@openai/codex', bin: { [spec.name]: spec.binPath } }],
   ['missing-bin', { name: spec.packageName }], ['wrong-bin-name', { name: spec.packageName, bin: { codex: spec.binPath } }],
   ['wrong-bin-target', { name: spec.packageName, bin: { [spec.name]: 'bin/codex.js' } }],
   ['non-string-bin', { name: spec.packageName, bin: { [spec.name]: [spec.binPath] } }],
   ['traversal-bin', { name: spec.packageName, bin: { [spec.name]: '../dist/index.js' } }]
  ];
  for (const [label, manifest] of invalidManifests) {
   await check(spec.name + ' rejects ' + label + ' package metadata without Codex fallback or writes', () => {
    const fixture = npmShimFixture(spec.name + '-invalid-' + label, { ...spec, manifest });
    const before = fs.existsSync(fixture.manifestFile) ? fs.readFileSync(fixture.manifestFile, 'utf8') : null;
    const entries = fs.readdirSync(fixture.packageRoot);
    const calls = [];
    const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32', probeImpl(...args) { calls.push(args); return { status: 0, stdout: 'wrong executor', stderr: '' }; } });
    assert.equal(cli.probe(['--version']).code, 'UNSUPPORTED_WINDOWS_SHIM'); assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(fixture.manifestFile) ? fs.readFileSync(fixture.manifestFile, 'utf8') : null, before);
    assert.deepEqual(fs.readdirSync(fixture.packageRoot), entries, 'vendor metadata is read without repair or quarantine writes');
   });
  }
  await check(spec.name + ' rejects an entrypoint outside its canonical package', () => {
   const fixture = npmShimFixture(spec.name + '-escape', spec);
   const outside = path.join(root, spec.name + '-outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'index.js'), 'must not execute');
   fs.unlinkSync(fixture.script); fs.rmdirSync(path.dirname(fixture.script));
   fs.symlinkSync(outside, path.dirname(fixture.script), process.platform === 'win32' ? 'junction' : 'dir');
   const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
   assert.throws(() => cli.launchTarget(), { code: 'UNSUPPORTED_WINDOWS_SHIM' });
  });
  await check(spec.name + ' never uses a Core executable as the npm Node runtime', () => {
   const fixture = npmShimFixture(spec.name + '-no-node', spec);
   const cli = new CliAgentProcess({ name: spec.name, executable: fixture.shim, envSource: { PATH: '' }, nodeExecutable: path.join(root, 'WhaleBridgeCore.exe'), platform: 'win32' });
   assert.equal(cli.probe(['--version']).code, 'NODE_RUNTIME_UNAVAILABLE');
  });
 }
 await check('unknown Windows shim cannot select a nearby Codex npm package', () => {
  const fixture = npmShimFixture('unknown-shim-with-codex', { name: 'unknown', packageName: '@other/unknown', binPath: 'dist/index.js' });
  const cli = new CliAgentProcess({ name: 'unknown', executable: fixture.shim, envSource: { PATH: '' }, platform: 'win32' });
  assert.equal(cli.probe(['--version']).code, 'UNSUPPORTED_WINDOWS_SHIM');
 });
 await check('provider mismatch cannot reinterpret another known npm command shim', () => {
  const fixture = npmShimFixture('provider-shim-mismatch', npmProviders[0]);
  const cli = new CliAgentProcess({ name: 'gemini', executable: path.join(fixture.directory, 'codex.cmd'), envSource: { PATH: '' }, platform: 'win32' });
  fs.writeFileSync(cli.executableOverride, 'untrusted command');
  assert.equal(cli.probe(['--version']).code, 'UNSUPPORTED_WINDOWS_SHIM');
 });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(failures.length, 0, failures.join(', '));
