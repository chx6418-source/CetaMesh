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
async function check(name, run) { try { await run(); console.log('PASS', name); } catch (error) { failures.push(name); console.error('FAIL', name, error.message); } }
const env = { PATH: '', LOCALAPPDATA: path.join(root, 'Local App Data'), APPDATA: path.join(root, 'Roaming'), USERPROFILE: root };
const native = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
function probe(exe, args) {
 if (exe.includes('broken')) return { status: 1, stdout: '', stderr: '' };
 const text = args[0] === '--version' ? 'codex-cli 9.9.9-fixture' : args[0] === 'login' ? 'Logged in' : '--config --ask-for-approval --cd --sandbox workspace-write --json --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check [SESSION_ID]';
 return { status: 0, stdout: text, stderr: '' };
}
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
   const binary = path.join(process.env.LOCALAPPDATA, 'Programs/OpenAI/Codex/bin/codex.exe'); fs.mkdirSync(path.dirname(binary), { recursive: true });
   fs.copyFileSync(process.execPath, binary);
   const h = await services.desktopUiService.execute({ method: 'ui.agent.health', params: { provider: 'codex', refresh: true } });
   assert.equal(h.installed, true); assert.equal(h.compatible, false); assert.equal(h.status, 'not-supported');
   assert.equal(h.installKind, 'standalone'); assert.equal(h.probePhase, 'help');
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
} finally { fs.rmSync(root, { recursive: true, force: true }); }
assert.equal(failures.length, 0, failures.join(', '));
