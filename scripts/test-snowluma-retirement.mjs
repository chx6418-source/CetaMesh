// Retirement must deny stale identifiers before creating transports or touching user processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCP_SERVER_CATALOG, allPluginDescriptors, buildToolCatalog } from '../src/integrations/catalog.js';
import { createIntegrationRegistry } from '../src/integrations/registry.js';
import { createIntegrationStore } from '../src/integrations/store.js';
import { createMcpRuntime, resolveMcpLaunch } from '../src/integrations/mcp-runtime.js';
import { assertMcpToolEnabled } from '../src/integrations/tool-policy.js';
import { createLocalServiceManager } from '../src/local-services.js';
import {createIntegrationService} from '../src/integrations/service.js';

const retired = error => error?.code === 'SNOWLUMA_INTEGRATION_RETIRED';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-snowluma-retirement-'));
try {
  for(const preset of ['whale-chat','whale-chat-v2']){
    const {apply}=await import('../dsh/agent-presets/'+preset+'/qq-tool-restrict.mjs');let guard;
    apply({tools:{restrict(){},guard(fn){guard=fn;}}});
    assert.equal(guard({name:'mcp__onebot__qq_get_prompt'}),undefined,'neutral MCP tools reach the existing Broker boundary');
    for(const name of ['mcp__snowluma__qq_status','mcp__snowluma-host__start_snowluma','dev_build_plugin','filesystem.write'])
      assert.equal(typeof guard({name}),'string',preset+' rejects retired namespaces and local development tools');
    const prompt=fs.readFileSync(new URL('../dsh/agent-presets/'+preset+'/agent.cordis.yml',import.meta.url),'utf8');
    assert.ok(!prompt.includes('mcp__snowluma__'));assert.ok(prompt.includes('mcp__onebot__'));
  }
  const oldSwitches = path.join(root, 'state', 'integrations', 'plugins.json');
  fs.mkdirSync(path.dirname(oldSwitches), { recursive: true });
  fs.writeFileSync(oldSwitches, JSON.stringify({ version: 1,
    plugins: { 'cetamesh-snowluma': { enabled: true, note: 'keep user history' } },
    mcp: { snowluma: { enabled: true }, 'snowluma-host': { enabled: true } }
  }, null, 2) + '\n');
  const switchesBefore = fs.readFileSync(oldSwitches);
  const registry = createIntegrationRegistry({ store: createIntegrationStore({ stateDir: path.join(root, 'state') }) });
  assert.equal(MCP_SERVER_CATALOG.some(server => ['snowluma', 'snowluma-host'].includes(server.id)), false,
    'retired SnowLuma servers must not be offered as launchable catalog entries');
  assert.equal(allPluginDescriptors().some(plugin => plugin.id === 'cetamesh-snowluma'), false);
  const onebot = registry.getMcpServer('onebot');
  assert.equal(onebot.enabled, false, 'a fresh installation must not enable a gateway implicitly');
  assert.equal(registry.pluginEnabled('cetamesh-onebot'), false);
  assert.equal(onebot.namespace, 'mcp__onebot__');
  assert.ok(buildToolCatalog().some(tool => tool.id === 'mcp__onebot__qq_status'));
  for (const id of ['mcp__snowluma__qq_status', 'mcp__snowluma__unknown', 'mcp__snowluma-host__start_snowluma']) {
    assert.throws(() => registry.invokeGuard(id), retired, id);
  }
  for (const id of ['snowluma', 'snowluma-host']) {
    assert.throws(() => registry.getMcpServer(id), retired);
    assert.throws(() => registry.setMcpEnabled(id, true), retired);
    assert.throws(() => assertMcpToolEnabled(id, 'qq_status', { stateDir: path.join(root, 'state') }), retired);
    assert.throws(() => resolveMcpLaunch({ id, entry: 'src/unused.js' }, {}, { packaged: true }), retired);
    assert.throws(() => resolveMcpLaunch({ id, entry: 'src/unused.js' }, {}, { packaged: false }), retired);
  }
  assert.throws(() => registry.setPluginEnabled('cetamesh-snowluma', true), retired);
  assert.deepEqual(fs.readFileSync(oldSwitches), switchesBefore,
    'stale enabled switches neither authorize OneBot nor get rewritten during retirement');
  const runtime = createMcpRuntime({ transportFactory: () => { throw new Error('retired call reached transport'); } });
  for (const id of ['snowluma', 'snowluma-host']) {
    assert.throws(() => runtime.start(id), retired);
    await assert.rejects(() => runtime.call(id, 'qq_status'), retired);
  }
  let stops=0,revokedBeforeStop=false,lifecycle;
  const localServices=()=>({onebot:{running:true,ready:true,authenticated:true}});
  localServices.actions={onebot:{stop:async()=>{stops++;revokedBeforeStop=!lifecycle.registry.pluginEnabled('cetamesh-onebot');return {stopped:true};}}};
  lifecycle=createIntegrationService({stateDir:path.join(root,'lifecycle-state'),localServices});
  try{
    await lifecycle.execute({method:'plugins.enable',params:{id:'cetamesh-onebot',approved:true}});
    await lifecycle.execute({method:'plugins.disable',params:{id:'cetamesh-onebot',approved:true}});
    assert.equal(stops,1,'disabling the connection adapter stops only its bound owned connector');
    assert.equal(revokedBeforeStop,true,'authority is revoked before awaiting connector exit');
    for(const method of ['plugins.enable','mcp.start','tools.invoke'])
      await assert.rejects(lifecycle.execute({method,params:{id:'cetamesh-snowluma',approved:true}}),retired);
    assert.equal(stops,1,'retired identities never reach a live local service');
  }finally{await lifecycle.close();}
  const { runMcpSnowLuma } = await import('../src/mcp-snowluma-safe.js');
  const { runMcpSnowLumaHost } = await import('../src/mcp-host-server.js');
  await assert.rejects(() => runMcpSnowLuma(), retired);
  await assert.rejects(() => runMcpSnowLumaHost(), retired);
  for (const entry of ['mcp-snowluma-safe.js', 'mcp-host-server.js']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/' + entry, import.meta.url))], {
      encoding: 'utf8', windowsHide: true, timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, 'retired source entry exits without starting MCP');
    assert.match(result.stderr, /SNOWLUMA_INTEGRATION_RETIRED/, 'command-line consumers receive an explicit retirement code');
  }

  const manager = createLocalServiceManager({ root, config: { dsh: { baseUrl: 'http://127.0.0.1:9' },
    snowluma: { homeDir: root, launcherPath: path.join(root, 'launcher.bat'), allowProcessControl: true } },
    detectionOptions: { userHome: root, fullScanRoots: [], environment: { PATH: '' } } });
  assert.deepEqual(Object.keys(manager.snapshot()), ['dsh'], 'local lifecycle manager owns only DSH');
  for (const method of ['findSnowLuma', 'selectSnowLuma', 'installSnowLuma', 'startSnowLuma', 'stopSnowLuma',
    'stopRecordedSnowLuma', 'quitQqProcesses', 'listQqProcesses', 'getSnowLumaReleasePage']) {
    assert.equal(Object.hasOwn(manager, method), false, method + ' is not an execution surface');
  }
  const markerFile = path.join(root, 'state', 'snowluma.pid');
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, '{"pid":123,"note":"retain user evidence"}\n');
  const markerBefore = fs.readFileSync(markerFile);
  await manager.detectAll();
  assert.deepEqual(fs.readFileSync(markerFile), markerBefore, 'retirement never cleans old markers or user processes');
  console.log('PASS SnowLuma identifiers fail explicitly; neutral OneBot stays opt-in; local lifecycle keeps only DSH');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
