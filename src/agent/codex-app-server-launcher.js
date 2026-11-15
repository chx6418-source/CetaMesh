import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliAgentProcess } from './cli-agent-process.js';
import { agentProviderError as fault } from './agent-provider.js';
import { CODEX_MODEL_CONTROL_SCHEMA_VERSION } from './protocol/codex-model-control.js';

const samePath = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function ownedEmptyDirectory(directory) {
  if (!path.isAbsolute(directory ?? '')) throw fault('AGENT_BOUNDARY_UNSUPPORTED','An owned absolute metadata directory is required');
  const stat=fs.lstatSync(directory),canonical=fs.realpathSync.native(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(canonical,path.resolve(directory)) || fs.readdirSync(directory).length)
    throw fault('AGENT_BOUNDARY_UNSUPPORTED','Metadata directory must be empty and have no links');
  return canonical;
}

/** Codex-only, no-account metadata launch. This does not admit Task execution or
 * reuse native account files. The existing CLI process owner supplies Windows
 * job receipts; the catalog provider retains ownership until confirmed cleanup.
 */
export function createCodexCatalogLauncher({stateDir,resolveExecutable,environment=process.env,
  createProcess=options=>new CliAgentProcess(options)}={}) {
  async function observation() {
    const result=await resolveExecutable?.();
    if (result?.version !== CODEX_MODEL_CONTROL_SCHEMA_VERSION)
      throw fault('CODEX_APP_SERVER_VERSION_UNSUPPORTED','The selected Codex version has no verified metadata protocol');
    if (!path.isAbsolute(result.executable??'') || !/^[a-f0-9]{64}$/.test(result.identity??''))
      throw fault('AGENT_RUNTIME_CHANGED','The selected Codex executable identity is unavailable');
    return result;
  }
  return Object.freeze({
    runtimeVersion:CODEX_MODEL_CONTROL_SCHEMA_VERSION,
    resolveIdentity:async()=> (await observation()).identity,
    async launch({cwd,profileRoot,purpose,transport,schemaVersion,onHandle}={}) {
      if (purpose !== 'model-catalog' || transport !== 'app-server' || schemaVersion !== CODEX_MODEL_CONTROL_SCHEMA_VERSION)
        throw fault('AGENT_BOUNDARY_UNSUPPORTED','This launcher admits only no-account metadata discovery');
      if (!path.isAbsolute(stateDir??'')) throw fault('AGENT_SUPERVISOR_UNAVAILABLE','Owned supervisor state is required');
      const selected=await observation();
      cwd=ownedEmptyDirectory(cwd);profileRoot=ownedEmptyDirectory(profileRoot);
      if (!samePath(path.dirname(cwd),path.dirname(profileRoot)) || samePath(cwd,profileRoot))
        throw fault('AGENT_BOUNDARY_UNSUPPORTED','Metadata directories must belong to the same isolated probe');
      // Fixed no-account provider: metadata cannot accidentally acquire the
      // caller's billing route. No generation method is sent by the owner.
      fs.writeFileSync(path.join(profileRoot,'config.toml'),[
        'model_provider = "cetamesh_catalog"','sandbox_mode = "read-only"','approval_policy = "on-request"',
        'web_search = "disabled"','cli_auth_credentials_store = "file"','[analytics]','enabled = false',
        '[features]','shell_tool = false','unified_exec = false','multi_agent = false','image_generation = false','view_image = false',
        '[model_providers.cetamesh_catalog]','name = "CetaMesh metadata only"','base_url = "http://127.0.0.1:1/v1"',
        'wire_api = "responses"','requires_openai_auth = false',''].join('\n'),{flag:'wx',mode:0o600});
      const env={CODEX_HOME:profileRoot,USERPROFILE:profileRoot,HOME:profileRoot,APPDATA:profileRoot,LOCALAPPDATA:profileRoot,TEMP:profileRoot,TMP:profileRoot,TMPDIR:profileRoot};
      for (const name of ['SystemRoot','WINDIR']) {
        const value=environment[name]??environment[name.toUpperCase()];
        if (typeof value==='string' && path.isAbsolute(value)) env[name]=value;
      }
      env.PATH=process.platform==='win32'&&env.SystemRoot ? path.join(env.SystemRoot,'System32') : '/usr/bin:/bin';
      if ((await observation()).identity !== selected.identity) throw fault('AGENT_RUNTIME_CHANGED','Codex executable changed before metadata launch');
      const cli=createProcess({name:'codex',executable:selected.executable,envSource:env,ownedTreeStateDir:stateDir});
      let handle;
      try {
        const version=await cli.probeAsync(['--version'],{timeoutMs:3000,environment:env});
        if (!version.available || String(version.stdout).trim() !== 'codex-cli '+CODEX_MODEL_CONTROL_SCHEMA_VERSION)
          throw fault('CODEX_APP_SERVER_VERSION_UNSUPPORTED','The selected binary did not confirm the pinned metadata version');
        if ((await observation()).identity !== selected.identity) throw fault('AGENT_RUNTIME_CHANGED','Codex executable changed during version verification');
        handle=cli.startSession({sessionId:'codex-catalog-'+crypto.randomUUID(),cwd,
          args:['app-server','--strict-config','--stdio'],inputMode:'open',timeoutMs:15000});
      } catch(error) {
        // A timed-out version callback may precede child close. Drain that same
        // existing process owner before reporting a launch that has no handle.
        await cli.shutdown();throw error;
      }
      const done=handle.done.then(result=>({exitCode:result.exitCode,processTreeExitConfirmed:result.processTreeExitConfirmed,
        terminationConfirmed:result.terminationConfirmed,effectStatus:result.effectStatus,code:result.code}));
      done.catch(()=>{});
      const raw={readable:handle.child.stdout,writable:handle.child.stdin,done,async close(){
        handle.shutdown();await done;
        if (!handle.cleanupPermitted()) throw fault('ACP_CLOSE_UNKNOWN','Metadata process tree remains unconfirmed');
        await cli.shutdown();
      }};
      onHandle?.(raw);
      return raw;
    }
  });
}
