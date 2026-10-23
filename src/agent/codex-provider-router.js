import { AGENT_PROVIDER_METHODS, agentProviderError as fault } from './agent-provider.js';

/** Transport decisions come exclusively from trusted composition/session metadata. */
export function createCodexProviderRouter({legacyProvider,appServerProvider,rolloutEnabled=false,resolveTransport} = {}) {
  if (!legacyProvider) throw new TypeError('Legacy Codex Provider required');
  const bindings = new Map();
  const creating = new Set();
  const defaultProvider = rolloutEnabled ? appServerProvider : legacyProvider;
  let closing = false, shutdownPromise;
  async function route(params) {
    const id = params?.sessionId, binding = bindings.get(id);
    if (binding) {
      if ((params.taskId !== undefined && params.taskId !== binding.taskId)
        || (params.workspaceId !== undefined && params.workspaceId !== binding.workspaceId)) throw fault('TASK_WORKSPACE_MISMATCH','Codex session binding mismatch');
      return binding.transport === 'exec' ? legacyProvider : appServerProvider;
    }
    const transport = await resolveTransport?.(id);
    // Native staging/process ownership cannot be reconstructed from a bare thread ID.
    if (transport === 'exec') return legacyProvider;
    throw fault('SESSION_TRANSPORT_UNKNOWN','Codex session transport unavailable; create a new session');
  }
  const provider = {id:'codex',label:'Codex',eventProtocol:defaultProvider?.eventProtocol ?? null,
    capabilities:()=>({...defaultProvider?.capabilities(),id:'codex',appServerRolloutEnabled:rolloutEnabled,
      ...(!defaultProvider ? {available:false,readyForTask:false,security:{mode:'native',nativeSandboxSupported:false}} : {})}),
    health:params=>defaultProvider ? defaultProvider.health(params) : Promise.resolve({provider:'codex',available:false,taskEligible:false,reason:'app_server_unavailable'}),
    configure:settings => {
      if (typeof legacyProvider.configure !== 'function') throw fault('CONFIGURATION_UNSUPPORTED','Codex configuration unavailable');
      return legacyProvider.configure(settings);
    },
    async shutdown() {
      closing = true;
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = (async()=>{
        const failures=[];
        // Creations admitted before shutdown must publish their ownership before cleanup takes a snapshot.
        await Promise.allSettled([...creating]);
        const results=await Promise.allSettled([...bindings].map(async([sessionId,binding])=>{
          const selected=binding.transport === 'exec' ? legacyProvider : appServerProvider;
          await selected.closeSession({sessionId,taskId:binding.taskId,workspaceId:binding.workspaceId});
          bindings.delete(sessionId);
        }));
        for(const result of results) if(result.status === 'rejected') failures.push(result.reason);
        const shutdowns=await Promise.allSettled([...new Set([legacyProvider,appServerProvider])]
          .filter(p=>typeof p?.shutdown === 'function').map(p=>Promise.resolve().then(()=>p.shutdown())));
        for(const result of shutdowns) if(result.status === 'rejected') failures.push(result.reason);
        if(failures.length) throw fault('CODEX_SHUTDOWN_FAILED','Codex shutdown incomplete; owned resources retained');
      })();
      try {await shutdownPromise;} catch(error) {shutdownPromise=null;throw error;}
    },
    createSession(params = {}) {
      const pending = (async()=>{
      if (closing) throw fault('PROVIDER_UNAVAILABLE','Codex router shutting down');
      const transport = rolloutEnabled ? 'app-server':'exec';
      const selected = transport === 'exec' ? legacyProvider : appServerProvider;
      if (!selected) throw fault('PROVIDER_UNAVAILABLE','Codex App Server unavailable');
      const result = await selected.createSession(params);
      if (!result?.sessionId || bindings.has(result.sessionId)) throw fault('SESSION_ID_COLLISION','Codex session identity collision');
      bindings.set(result.sessionId,{transport,taskId:params.taskId,workspaceId:params.workspaceId});
      return {...result,provider:'codex'};
      })();
      creating.add(pending);
      pending.then(()=>creating.delete(pending),()=>creating.delete(pending));
      return pending;
    },
    async *follow(params) { yield* (await route(params)).follow(params); }
  };
  for (const method of AGENT_PROVIDER_METHODS) {
    if (provider[method]) continue;
    provider[method] = async params => {
      const selected = await route(params);
      const result = await selected[method](params);
      if (method === 'closeSession') bindings.delete(params.sessionId);
      return result;
    };
  }
  return Object.freeze(provider);
}
