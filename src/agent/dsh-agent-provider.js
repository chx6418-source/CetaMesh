// DSH Agent Provider（阶段 06；会话 2 起作为 Agent Broker 的第一个真实 Provider）：
// 把已核对的 DSH 0.1.5-rc.1 Typert 网关映射到标准 AgentProvider 契约。
//
// 复用现有 src/dsh-client.js 的 NodeApiClient（由 Core composition root 注入，不启动 DSH 进程）。
// 端点映射（均以本仓库真实调用与 2026-10-04 对运行中 DSH 的探测为准）：
//   createSession  → session/create（+ 可选 session/selectModel 绑定模型）
//   send           → session/prompt（requestId/mode/content 内容块数组）
//   cancel         → session/cancel（探测确认端点存在：假 sessionId 返回业务错 session/not-found）
//   status         → session/list 投影（running/blank/updatedAt/title）
//   contextUsage   → session/list 投影的 tokenUsage / contextPressure（旧会话可能无投影 → available:false）
//   resume         → session/list 存在性校验（DSH 会话持久于 DSH 侧，可重新挂载）
//   closeSession   → workspace/archiveSession
//   follow         → session/follow 流（turn/start / assistant/chunk / assistant/message / turn/end）
//   selectModel    → session/selectModel
//   health         → settings/describe（3s 超时；DSH 未启动时的优雅降级依据）
//   archiveSession / nativeCheckpoint / nativeHandoff → 不支持：DSH 无对应端点
//   （checkpoint 实测 HTTP 404、无跨 Provider 交接协议），由契约桩显式拒绝；
//   Broker 包装为 { supported:false, reason:'UNSUPPORTED' }，绝不伪造。
//
// rolloverStrategy：DSH 无原生压缩/续接能力，上下文临限时的推荐策略是"开新会话"。
import crypto from 'node:crypto';
import { agentProviderError, defineAgentProvider, normalizePromptContent, AGENT_EVENT_PROTOCOL_DSH } from './agent-provider.js';
import { fetchDshModelCatalog, selectDshSessionModel } from '../dsh-model-selection.js';
import { createDshFollowHub } from './dsh-follow-hub.js';

const CALL_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 3_000;

/**
 * 传输层失败 → PROVIDER_UNAVAILABLE（DSH 未启动/断连，调用方据此优雅降级）；
 * 其他失败（业务错误、协议错误）→ PROVIDER_ERROR。业务错误码（如 session/not-found）
 * 由调用方在更外层先判别，不经过这里。
 */
function wrapDshError(error, label) {
  const message = String(error?.message ?? error);
  const transport = /传输失败|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|WebSocket 错误|socket hang up|TIMEOUT/i.test(message);
  return agentProviderError(transport ? 'PROVIDER_UNAVAILABLE' : 'PROVIDER_ERROR', `${label}：${message}`, { cause: error });
}

export function createDshAgentProvider({ api, defaults = {}, log = () => {}, presetPolicy = null } = {}) {
  if (!api || typeof api.callEndpoint !== 'function' || typeof api.openRemoteStream !== 'function') {
    throw new Error('createDshAgentProvider 需要注入 dsh-client.js 的 NodeApiClient 实例');
  }
  const dshDefaults = {
    provider: String(defaults.provider ?? 'deepseek-official'),
    model: defaults.model ? String(defaults.model) : null,
    reasoningEffort: defaults.reasoningEffort ? String(defaults.reasoningEffort) : null
  };
  const followHub = createDshFollowHub({ api });
  const modelSessions = new Map();
  let modelCatalog=null,modelCatalogAt=0,modelCatalogRead=null;
  const nativeValue=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
  const modelState=sid=>{
    if(!modelSessions.has(sid))modelSessions.set(sid,{selection:null,unknown:false,configuring:false,dispatching:0});
    return modelSessions.get(sid);
  };
  async function readModelCatalog(refresh=false){
    if(!refresh&&Date.now()-modelCatalogAt<30000)return modelCatalog;
    if(modelCatalogRead)return modelCatalogRead;
    modelCatalogRead=fetchDshModelCatalog(api,{timeoutMs:HEALTH_TIMEOUT_MS})
      .then(value=>modelCatalog=value).catch(()=>modelCatalog=null).finally(()=>{modelCatalogAt=Date.now();modelCatalogRead=null;});
    return modelCatalogRead;
  }
  async function modelControl(sid){
    const state=modelState(sid),catalog=await readModelCatalog();
    const group=catalog?.groups.find(row=>row.id===state.selection?.modelProvider&&catalog.routableProviders.includes(row.id));
    const entry=group?.models.find(row=>row.id===state.selection?.model);
    const options=(values=[])=>[...new Set(values.filter(value=>nativeValue(value)))].slice(0,256).map(value=>({value,label:value}));
    return {status:state.selection&&!state.unknown?'available':'unknown',source:'dsh-session',application:'runtime-confirmed',
      selection:state.selection?{...state.selection}:null,
      model:group?{options:options(group.models.map(row=>row.id))}:null,
      reasoning:entry?.efforts.length?{options:options(entry.efforts)}:null};
  }
  function confirmedSelection(value,expected){
    const selected=value?.selected;
    if(!nativeValue(selected?.model)||!nativeValue(selected?.provider,80)
      || (selected.reasoningEffort!=null&&!nativeValue(selected.reasoningEffort))
      || selected.model!==expected.model || selected.provider!==expected.modelProvider
      || (expected.reasoningEffort&&selected.reasoningEffort!==expected.reasoningEffort)){
      throw agentProviderError('AGENT_CONFIGURATION_UNCONFIRMED','DSH did not confirm the requested native model configuration');
    }
    return{model:selected.model,modelProvider:selected.provider,reasoningEffort:selected.reasoningEffort??null};
  }

  /** session/list 单条投影；找不到返回 null（不抛错，由调用方决定语义）。 */
  async function findSessionItem(sessionId) {
    let value;
    try {
      value = await api.callEndpoint('session/list', { _request: {} }, AbortSignal.timeout(LIST_TIMEOUT_MS));
    } catch (error) {
      throw wrapDshError(error, '读取 DSH 会话列表失败');
    }
    const items = Array.isArray(value?.items) ? value.items : [];
    return items.find((item) => item?.sessionId === sessionId) ?? null;
  }

  function requireSessionId(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw agentProviderError('INVALID_PARAMS', 'sessionId 不能为空');
    }
    return sessionId.trim();
  }

  const contract = defineAgentProvider({
    id: 'dsh',
    label: 'DSH Agent',
    eventProtocol: AGENT_EVENT_PROTOCOL_DSH,
    capabilityExtras: {
      displayName: 'DSH',
      available: null,
      version: null,
      reason: null,
      // DSH's remote session API is stable, but the API adapter cannot prove that
      // every remote filesystem mutation is broker-mediated. Keep task execution fail-closed.
      workspaceBoundary: 'unverified',
      supportsFreshSession: true,
      supportsResume: true,
      contextUsage: { available: true, source: 'DSH session/list projections when present' },
      rolloverStrategy: {
        preferred: 'fresh-session',
        note: 'DSH 无原生压缩/续接端点：上下文临限时优先结束旧会话并开新会话（Bootstrap 结构化恢复）'
      }
    },
    methods: {
      async createSession({ cwd, model, reasoningEffort, modelProvider, purpose } = {}) {
        const request = {};
        if (cwd !== undefined && cwd !== null && String(cwd).trim()) request.cwd = String(cwd);
        if (presetPolicy && !purpose) throw agentProviderError('INVALID_PARAMS', 'DSH Session purpose must be coding or social');
        if (presetPolicy) request.agentPreset = presetPolicy.require(purpose);
        let value;
        try {
          value = await api.callEndpoint('session/create', { request }, AbortSignal.timeout(CALL_TIMEOUT_MS));
        } catch (error) {
          throw wrapDshError(error, '创建 DSH 会话失败');
        }
        const sessionId = String(value?.sessionId ?? '');
        if (!sessionId) throw agentProviderError('PROVIDER_ERROR', 'DSH 未返回 sessionId');
        // 模型绑定：显式入参优先，其次 bridge 默认模型（与 QQ 桥接 ensureSessionModel 行为一致）。
        // 未绑定成功的会话不能对外返回 Ready；尽力归档失败的半初始化 session 后报错。
        const wantModel = model !== undefined && model !== null ? String(model) : dshDefaults.model;
        let bound = null;
        if (wantModel) {
          try {
            const desiredReasoning=reasoningEffort??dshDefaults.reasoningEffort??undefined;
            const { value: result,request: applied } = await selectDshSessionModel(api, {
              sessionId,
              provider: String(modelProvider ?? dshDefaults.provider),
              model: wantModel,
              reasoningEffort: desiredReasoning
            }, { timeoutMs: CALL_TIMEOUT_MS, log });
            bound=confirmedSelection(result,{model:wantModel,modelProvider:applied.provider,reasoningEffort:desiredReasoning});
            modelState(sessionId).selection=bound;
          } catch (error) {
            try {
              await api.callEndpoint('workspace/archiveSession', { request: { sessionId } }, AbortSignal.timeout(LIST_TIMEOUT_MS));
            } catch (cleanupError) {
              log(`DSH 模型绑定失败后的临时会话清理失败（${sessionId}）：${cleanupError?.code ?? 'cleanup-error'}`);
            }
            modelSessions.delete(sessionId);
            throw agentProviderError('MODEL_BIND_FAILED', `DSH Agent 模型绑定失败，未创建可用会话：${String(error?.message ?? error)}`, { cause: error });
          }
        }
        return { sessionId, provider: 'dsh', model: bound?.model ?? null, modelBindingError: null,modelControl:await modelControl(sessionId) };
      },

      async send({ sessionId, content, mode = 'queue', onRequestId } = {}) {
        const sid = requireSessionId(sessionId);
        const configuration=modelState(sid);
        if(configuration.configuring)throw agentProviderError('CONFIG_BUSY','DSH model configuration is awaiting acknowledgement');
        if(configuration.unknown)throw agentProviderError('AGENT_CONFIGURATION_UNKNOWN','DSH configuration outcome is unknown; reconcile the session before dispatch');
        const blocks = normalizePromptContent(content);
        const requestId = `cetamesh-agent-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        configuration.dispatching+=1;
        let value;
        try {
          // In-process provenance binding precedes dispatch: Follow can beat the acknowledgement.
          onRequestId?.(requestId);
          value = await api.callEndpoint('session/prompt', {
            request: { requestId, sessionId: sid, mode, content: blocks }
          }, AbortSignal.timeout(CALL_TIMEOUT_MS));
        } catch (error) {
          throw wrapDshError(error, '提交回合失败');
        }finally{configuration.dispatching-=1;}
        return { accepted: true, requestId, sessionId: sid, value: value ?? null };
      },

      async cancel({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        try {
          await api.callEndpoint('session/cancel', { request: { sessionId: sid } }, AbortSignal.timeout(LIST_TIMEOUT_MS));
          return { cancelRequested: true, stopped: false, sessionId: sid };
        } catch (error) {
          if (String(error?.message ?? error).includes('session/not-found')) {
            throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`, { cause: error });
          }
          throw wrapDshError(error, '取消未确认');
        }
      },

      async status({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`);
        return {
          sessionId: sid,
          provider: 'dsh',
          running: typeof item.running==='boolean'?item.running:null,
          blank: item.blank === true,
          updatedAt: item.updatedAt ?? null,
          cwd: typeof item.cwd === 'string' ? item.cwd : null,
          title: item.projections?.values?.title ?? null,
          modelControl:await modelControl(sid)
        };
      },

      async contextUsage({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`);
        const values = item.projections?.values ?? {};
        if (!values.tokenUsage && !values.contextPressure) {
          // 旧会话投影未计算（asOfSeq=-1）：如实上报不可用，禁止伪造 0 值。
          return { sessionId: sid, provider: 'dsh', available: false };
        }
        return {
          sessionId: sid,
          provider: 'dsh',
          available: true,
          tokenUsage: values.tokenUsage ?? null,
          contextPressure: values.contextPressure ?? null
        };
      },

      async resume({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        const item = await findSessionItem(sid);
        if (!item) throw agentProviderError('SESSION_NOT_FOUND', `无法恢复：会话不存在：${sid}`);
        log(`DSH Agent Provider 恢复会话：${sid}（running=${item.running === true}）`);
        return {
          resumed: true,
          sessionId: sid,
          provider: 'dsh',
          running: item.running === true,
          updatedAt: item.updatedAt ?? null
        };
      },

      async closeSession({ sessionId } = {}) {
        const sid = requireSessionId(sessionId);
        try {
          await api.callEndpoint('workspace/archiveSession', { request: { sessionId: sid } }, AbortSignal.timeout(LIST_TIMEOUT_MS));
          followHub.closeSession(sid);
          modelSessions.delete(sid);
          return { closed: true, sessionId: sid };
        } catch (error) {
          if (String(error?.message ?? error).includes('session/not-found')) {
            throw agentProviderError('SESSION_NOT_FOUND', `会话不存在：${sid}`, { cause: error });
          }
          throw wrapDshError(error, '关闭会话失败');
        }
      },

      // 直接返回 async iterable（不包 async 包装，消费方 for await 即可）：
      // 事件流是有状态资源，调用方负责用 signal 中止。
      follow({ sessionId, signal, sinceSequence } = {}) {
        const sid = requireSessionId(sessionId);
        return followHub.follow({ sessionId: sid, signal, sinceSequence });
      },

      async selectModel({ sessionId, model, reasoningEffort, modelProvider } = {}) {
        const sid = requireSessionId(sessionId);
        const state=modelState(sid);
        if(state.unknown)throw agentProviderError('AGENT_CONFIGURATION_UNKNOWN','DSH configuration outcome is unknown; reconcile the session first');
        if(state.configuring)throw agentProviderError('CONFIG_BUSY','DSH model configuration is awaiting acknowledgement');
        if(state.dispatching)throw agentProviderError('TURN_BUSY','DSH prompt dispatch is awaiting acknowledgement');
        const selectedModel=model??state.selection?.model;
        const selectedProvider=modelProvider??state.selection?.modelProvider??dshDefaults.provider;
        if(!nativeValue(selectedModel)||!nativeValue(selectedProvider,80)||(reasoningEffort!=null&&!nativeValue(reasoningEffort)))
          throw agentProviderError('INVALID_PARAMS','Invalid DSH native model selection');
        if(state.selection&&selectedProvider!==state.selection.modelProvider)throw agentProviderError('AGENT_CONFIGURATION_UNSUPPORTED','DSH model choices belong to the current native provider');
        state.configuring=true;
        let attempted=false;
        try {
          const item=await findSessionItem(sid);
          if(!item)throw agentProviderError('SESSION_NOT_FOUND',`会话不存在：${sid}`);
          if(item.running!==false)throw agentProviderError('TURN_BUSY','DSH session must be confirmed idle before changing its model');
          const catalog=await readModelCatalog(true);
          const group=catalog?.groups.find(row=>row.id===selectedProvider&&catalog.routableProviders.includes(row.id));
          const entry=group?.models.find(row=>row.id===selectedModel);
          if(group&&!entry||reasoningEffort!=null&&entry&&!entry.efforts.includes(reasoningEffort))
            throw agentProviderError('AGENT_CONFIGURATION_UNSUPPORTED','DSH did not advertise the requested model or reasoning choice');
          attempted=true;
          const {value,request:applied}=await selectDshSessionModel(api, {
            sessionId: sid,
            provider:selectedProvider,model:selectedModel,reasoningEffort
          }, { timeoutMs: CALL_TIMEOUT_MS, log });
          const confirmed=confirmedSelection(value,{model:selectedModel,modelProvider:applied.provider,reasoningEffort});
          state.selection=confirmed;
          return {sessionId:sid,selected:true,confirmed:true,...confirmed,modelControl:await modelControl(sid)};
        } catch (error) {
          if(attempted&&!/session\/model-unavailable|session\/not-found/.test(String(error?.message??'')))state.unknown=true;
          if(['TURN_BUSY','SESSION_NOT_FOUND','AGENT_CONFIGURATION_UNSUPPORTED','AGENT_CONFIGURATION_UNCONFIRMED'].includes(error?.code))throw error;
          throw wrapDshError(error, '绑定模型失败');
        }finally{state.configuring=false;}
      },

      async health() {
        let settingsVerified = false;
        let stage = 'transport';
        const checkedAt = new Date().toISOString();
        const safeCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(String(error?.code ?? '')) ? error.code : 'DSH_API_ERROR';
        const diagnostic = (error, at = stage) => ({ stage: at, code: safeCode(error),
          retryable: ['DSH_REQUEST_TIMEOUT', 'DSH_UNREACHABLE', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.code), checkedAt });
        try {
          await api.callEndpoint('settings/describe', {}, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
          settingsVerified = true;
          stage = 'session-api';
          await api.callEndpoint('session/list', { _request: {} }, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
          const preset = presetPolicy?.inspect('coding') ?? null;
          let presetLoaded = null;
          let discoveryError = null;
          stage = 'native-loading';
          if (preset?.compatible) {
            try {
              const listed = await api.callEndpoint('agentPresets/list', {}, AbortSignal.timeout(HEALTH_TIMEOUT_MS));
              if (Array.isArray(listed?.presets)) presetLoaded = listed.presets.some(row => row?.id === preset.id);
              else discoveryError = diagnostic({ code: 'DSH_PRESET_LIST_UNVERIFIED' });
            } catch (error) {
              log(`DSH preset discovery failed: ${safeCode(error)}`);
              discoveryError = diagnostic(error);
            }
          }
          const presetReady = !preset || (preset.compatible && presetLoaded === true);
          const presetReason = preset && !preset.compatible ? preset.reason
            : preset && presetLoaded === false ? 'preset-not-loaded' : preset && presetLoaded === null ? 'preset-load-unknown' : null;
          const authRejected = discoveryError?.code === 'DSH_AUTHENTICATION_FAILED';
          return { status: presetReady ? 'available' : 'needs-setup', available: !authRejected, provider: 'dsh', processAlive: null,
            reachable: true, authenticated: authRejected ? false : discoveryError ? null : true, compatible: true, sessionCapable: !authRejected,
            configured: preset ? Boolean(preset.id) : null, ready: presetReady, taskEligible: false,
            diagnostic: discoveryError ?? { stage: presetReason === 'preset-not-configured' ? 'preset-selection' : presetReason === 'preset-not-loaded' ? 'native-loading' : presetReason ? 'preset-schema' : 'ready', code: null, retryable: false, checkedAt },
            preset: preset ? { purpose: 'coding', id: preset.id, compatible: preset.compatible, loaded: presetLoaded,
              loadState: presetLoaded === true ? 'loaded' : presetLoaded === false ? 'not-loaded' : 'unknown', reason: presetReason,
              verification: 'local-persona-only' } : null,
            reason: authRejected ? 'authentication-required' : discoveryError?.code === 'DSH_AUTH_MATERIAL_MISSING' ? 'authentication-material-missing' : presetReason };
        } catch (error) {
          const code = String(error?.code ?? '');
          const transportFailed = ['DSH_UNREACHABLE', 'DSH_REQUEST_TIMEOUT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
            || /ECONNREFUSED|ECONNRESET|fetch failed|传输失败/i.test(String(error?.message ?? ''));
          const missingAuth = code === 'DSH_AUTH_MATERIAL_MISSING';
          const authenticated = code === 'DSH_AUTHENTICATION_FAILED' ? false
            : settingsVerified && !missingAuth && !transportFailed ? true : null;
          const reachable = transportFailed ? false : missingAuth ? null
            : settingsVerified || authenticated === false || code === 'DSH_HOST_ORIGIN_REJECTED' ? true : null;
          return { status: authenticated === false || missingAuth ? 'needs-setup' : 'error', available: false, provider: 'dsh',
            processAlive: null, reachable, authenticated, compatible: settingsVerified ? true : null,
            configured: presetPolicy ? Boolean(presetPolicy.inspect('coding').id) : null,
            sessionCapable: false, ready: false, taskEligible: false, diagnostic: diagnostic(error),
            reason: authenticated === false ? 'authentication-required' : missingAuth ? 'authentication-material-missing'
              : transportFailed ? 'not_connected' : code === 'DSH_HOST_ORIGIN_REJECTED' ? 'host-origin-rejected' : 'session-api-unavailable' };
        }
      }
    }
  });
  return Object.freeze({ ...contract, shutdown: () => followHub.shutdown() });
}
