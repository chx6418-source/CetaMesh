// CetaMesh Desktop —— 首次运行引导服务（产品化任务 D，第七节）。
//
// 完成条件是产品决策，不是工程细节：**配好一个 Model Provider + 测通连接 + 选定默认模型**。
// QQ / DSH / 移动端 / Agent / 扩展全都不在完成条件里 —— 缺它们必须照样能把引导走完，
// 否则「不装 QQ 就用不了 CetaMesh」会变成事实上的强制捆绑。
//
// 安全纪律（WHY）：
//   - 引导进度文件里**绝不落 API Key**：stepData 入库前过 sanitizeStepData，
//     任何 key/secret/token/password 字段直接丢弃。Key 的唯一归属地是 provider-keys.json；
//   - 连接测试失败一律结构化返回（中文原因 + 稳定错误码），从不把网络/认证异常抛给 UI；
//   - 可选步骤在缺少对应服务时"记录用户选择"即可，绝不因此阻断 finish。

import { createOnboardingStore, ONBOARDING_ERROR_CODES } from './store.js';
import {
  ONBOARDING_STEPS,
  STEP_STATES,
  missingRequiredStepIds,
  checkRequiredOrder,
  isKnownStepId,
  nextStepId,
  stepById
} from './steps.js';
import { describeProviderTestFailure } from '../product/provider-view.js';

const MAX_STEP_DATA_STRING = 200;
const SECRET_KEY_RE = /(key|secret|token|password|credential|passwd)/i;

function text(value, max = 200) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * 入库前的数据清洗：**只允许**非敏感的标量进入 stepData。
 * 这条规则存在的意义是防止「以后有人顺手把 apiKey 塞进 data」把密钥写进明文进度文件。
 */
export function sanitizeStepData(data, depth = 0) {
  if (data === undefined || data === null) return null;
  if (depth > 2) return null;
  if (typeof data === 'string') return data.slice(0, MAX_STEP_DATA_STRING);
  if (typeof data === 'number' || typeof data === 'boolean') return data;
  if (Array.isArray(data)) return data.slice(0, 20).map((item) => sanitizeStepData(item, depth + 1)).filter((item) => item !== null);
  if (typeof data !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY_RE.test(key)) continue; // 凭据字段一律不入库（含 apiKey/baseUrl 之外的任何 *key*）
    const cleaned = sanitizeStepData(value, depth + 1);
    if (cleaned !== null) out[key.slice(0, 60)] = cleaned;
  }
  return Object.keys(out).length ? out : null;
}

export function createOnboardingService({
  stateDir,
  store = null,
  providerSecrets = null,
  modelRuntime = null,
  settingsService = null,
  extensionService = null,
  agentService = null,
  connectAgentImpl = null,
  setDefaultModel = null,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (!store && (!stateDir || typeof stateDir !== 'string')) {
    throw new Error('createOnboardingService 需要 stateDir 或 store');
  }
  const progress = store || createOnboardingStore({ stateDir, now });

  function onboardingError(code, message, extra = {}) {
    return Object.assign(new Error(message), { name: 'OnboardingError', code, ...extra });
  }

  function currentState() {
    return progress.read();
  }

  function stepState(state, step) {
    if (state.completed.includes(step.id)) return 'completed';
    if (state.skipped.includes(step.id)) return 'skipped';
    const next = nextStepId(state.completed, state.skipped);
    return state.currentStepId === step.id || next === step.id ? 'current' : 'pending';
  }

  /** 面向 UI 的完整视图：步骤列表 + 当前步 + 是否可以收尾。永不包含凭据。 */
  function status() {
    const state = currentState();
    const missing = missingRequiredStepIds(state.completed);
    const optionalPending = ONBOARDING_STEPS
      .filter((step) => step.optional && !state.completed.includes(step.id) && !state.skipped.includes(step.id))
      .map((step) => step.id);
    return {
      status: state.status,
      currentStepId: state.status === 'completed' ? null : (state.currentStepId || nextStepId(state.completed, state.skipped)),
      steps: ONBOARDING_STEPS.map((step) => ({
        id: step.id,
        order: step.order,
        label: step.label,
        description: step.description,
        optional: step.optional === true,
        state: stepState(state, step)
      })),
      completed: [...state.completed],
      skipped: [...state.skipped],
      missingRequired: missing,
      optionalPending,
      canFinish: missing.filter((id) => id !== 'done').length === 0,
      startedAt: state.startedAt ?? null,
      completedAt: state.completedAt ?? null,
      lastError: state.lastError ?? progress.lastError() ?? null
    };
  }

  /** 幂等启动：已经 in_progress/completed 时不重置任何进度。 */
  function start() {
    const state = currentState();
    if (state.status !== 'not_started') return status();
    progress.update((draft) => {
      draft.status = 'in_progress';
      draft.startedAt = new Date(now()).toISOString();
      draft.currentStepId = nextStepId(draft.completed, draft.skipped);
      return draft;
    });
    return status();
  }

  function completeStep({ stepId, data } = {}) {
    const step = stepById(stepId);
    if (!step) throw onboardingError(ONBOARDING_ERROR_CODES.STEP_NOT_FOUND, '未知引导步骤：' + String(stepId ?? ''));
    const state = currentState();
    if (state.completed.includes(step.id)) return status(); // 幂等：重复完成不报错

    if (step.required) {
      const order = checkRequiredOrder(step.id, state.completed);
      if (!order.ok) {
        throw onboardingError(
          ONBOARDING_ERROR_CODES.STEP_ORDER,
          '请先完成前面的必填步骤：' + order.missing.join('、'),
          { missing: order.missing }
        );
      }
    }

    const sanitized = sanitizeStepData(data);
    progress.update((draft) => {
      if (draft.status === 'not_started') {
        draft.status = 'in_progress';
        draft.startedAt = new Date(now()).toISOString();
      }
      if (!draft.completed.includes(step.id)) draft.completed.push(step.id);
      draft.skipped = draft.skipped.filter((id) => id !== step.id);
      if (sanitized) draft.stepData = { ...(draft.stepData ?? {}), [step.id]: sanitized };
      draft.currentStepId = nextStepId(draft.completed, draft.skipped);
      return draft;
    });
    return status();
  }

  function skipStep({ stepId } = {}) {
    const step = stepById(stepId);
    if (!step) throw onboardingError(ONBOARDING_ERROR_CODES.STEP_NOT_FOUND, '未知引导步骤：' + String(stepId ?? ''));
    if (!step.optional) {
      throw onboardingError(ONBOARDING_ERROR_CODES.STEP_REQUIRED, '步骤「' + step.label + '」是必填项，不能跳过');
    }
    const state = currentState();
    if (state.completed.includes(step.id) || state.skipped.includes(step.id)) return status();
    progress.update((draft) => {
      if (draft.status === 'not_started') {
        draft.status = 'in_progress';
        draft.startedAt = new Date(now()).toISOString();
      }
      if (!draft.skipped.includes(step.id)) draft.skipped.push(step.id);
      draft.currentStepId = nextStepId(draft.completed, draft.skipped);
      return draft;
    });
    return status();
  }

  /** 收尾：done 是"最后的必填标记"，由 finish 自动置位，避免 UI 多一次点击。 */
  function finish() {
    const state = currentState();
    if (state.status === 'completed') return status();
    const missing = missingRequiredStepIds(state.completed).filter((id) => id !== 'done');
    if (missing.length) {
      throw onboardingError(
        ONBOARDING_ERROR_CODES.INCOMPLETE,
        '还有必填步骤未完成：' + missing.join('、'),
        { missing }
      );
    }
    progress.update((draft) => {
      draft.status = 'completed';
      if (!draft.completed.includes('done')) draft.completed.push('done');
      draft.currentStepId = null;
      draft.completedAt = new Date(now()).toISOString();
      if (!draft.startedAt) draft.startedAt = draft.completedAt;
      return draft;
    });
    return status();
  }

  function reset() {
    progress.reset();
    return status();
  }

  /**
   * 真实连接测试：成功时顺带把 connection 步骤标记完成（用户在界面上做的就是"点一下测试"）。
   * 失败绝不抛错 —— 引导里"测试失败"是正常路径，用户会改 Key 再来。
   */
  async function testProvider({ provider, apiKey, baseUrl, model, fetchImpl } = {}) {
    const providerId = text(provider, 64);
    if (!providerId) {
      throw onboardingError(ONBOARDING_ERROR_CODES.INVALID_PARAMS, '必须提供 provider');
    }
    if (!providerSecrets) {
      return { ok: false, provider: providerId, code: 'PROVIDER_TEST_UNAVAILABLE', message: '当前运行环境不支持连接测试', detail: null };
    }
    const key = text(apiKey, 512);
    const candidateUrl = text(baseUrl, 600);
    const modelId = text(model, 120);

    let result;
    try {
      result = await providerSecrets.test({
        provider: providerId,
        ...(key ? { apiKey: key } : {}),
        ...(candidateUrl ? { baseUrl: candidateUrl } : {}),
        ...(modelId ? { model: modelId } : {}),
        ...(fetchImpl ? { fetchImpl } : {})
      });
    } catch (error) {
      const code = String(error?.code ?? '');
      const described = describeProviderTestFailure({ code: code || 'PROVIDER_TEST_KEY_MISSING' });
      return { ok: false, provider: providerId, status: 0, code: described.code, phase: 'configuration', message: described.message, detail: String(error?.message ?? error) };
    }

    if (result?.ok === true) {
      // Candidate credentials commit only after the candidate endpoint has accepted them.
      // A failed replacement must leave the currently working key and Base URL untouched.
      if (key || candidateUrl) {
        try {
          const existing = key ? null : providerSecrets.raw(providerId);
          providerSecrets.set({ provider: providerId, apiKey: key || existing.apiKey,
            ...(candidateUrl ? { baseUrl: candidateUrl } : {}) });
        } catch (error) {
          return { ok: false, provider: providerId, status: 0, code: 'PROVIDER_TEST_KEY_INVALID', phase: 'configuration', message: '凭据无法安全保存，请检查输入后重试', detail: String(error?.code ?? error?.message ?? error) };
        }
      }
      let completed = false;
      try {
        const state = currentState();
        if (checkRequiredOrder('connection', state.completed).ok && !state.completed.includes('connection')) {
          completeStep({ stepId: 'connection', data: { provider: providerId } });
          completed = true;
        }
      } catch (error) {
        // 自动标记失败不影响"测试成功"这个事实：UI 仍可手动完成该步骤。
        log('Onboarding 连接测试成功但自动完成步骤失败：' + String(error?.message ?? error));
      }
      return {
        ok: true, provider: providerId, status: result.status ?? 0, code: null,
        phase: result.phase ?? 'catalog', configured: result.configured ?? true,
        reachable: result.reachable ?? true, authenticated: result.authenticated ?? true,
        inferencing: result.inferencing ?? null,
        message: result.inferencing === true ? '模型推理验证成功' : '连接成功，API Key 与模型目录可用',
        detail: null, connectionStepCompleted: completed
      };
    }

    const described = describeProviderTestFailure(result ?? {});
    return {
      ok: false,
      provider: providerId,
      status: Number(result?.status ?? 0),
      code: described.code,
      phase: result?.phase ?? 'catalog',
      configured: result?.configured ?? null,
      reachable: result?.reachable ?? null,
      authenticated: result?.authenticated ?? null,
      inferencing: result?.inferencing ?? null,
      message: described.message,
      detail: described.detail ?? (result?.message ?? null)
    };
  }

  /** 保存默认 Provider/Model 后才完成必填步骤；失败时进度不得前进。 */
  async function setModel({ provider, model } = {}) {
    const providerId = text(provider, 64);
    const modelId = text(model, 120);
    if (!providerId || !modelId) throw onboardingError(ONBOARDING_ERROR_CODES.INVALID_PARAMS, '必须提供 provider 和 model');
    if (modelRuntime && (!modelRuntime.isRegistered(providerId) || !modelRuntime.hasKey(providerId))) {
      throw onboardingError(ONBOARDING_ERROR_CODES.INVALID_PARAMS, '请选择已配置凭据的 Model Provider');
    }
    const state = currentState();
    const order = checkRequiredOrder('model', state.completed);
    if (!order.ok) throw onboardingError(ONBOARDING_ERROR_CODES.STEP_ORDER, '请先完成前面的必填步骤：' + order.missing.join('、'), { missing: order.missing });
    if (typeof setDefaultModel === 'function') {
      await setDefaultModel({ provider: providerId, model: modelId });
    } else if (settingsService?.store?.update) {
      settingsService.store.update('models', { provider: providerId, defaultModel: modelId });
    } else {
      throw onboardingError(ONBOARDING_ERROR_CODES.INVALID_PARAMS, '当前运行环境无法保存默认模型');
    }
    completeStep({ stepId: 'model', data: { provider: providerId, model: modelId } });
    return { provider: providerId, model: modelId, persisted: true };
  }

  async function connectAgent(payload = {}) {
    const provider = text(payload.provider, 64);
    if (typeof connectAgentImpl === 'function') {
      try {
        const result = await connectAgentImpl({ provider });
        completeStep({ stepId: 'agent', data: { provider } });
        return { ok: true, step: 'agent', connected: result?.ok !== false, detail: result ?? null };
      } catch (error) {
        // Agent 是可选增项：接入失败不该把用户挡在引导外面。
        return { ok: false, step: 'agent', code: String(error?.code ?? 'AGENT_CONNECT_FAILED'), message: 'Agent 接入失败，可稍后在设置中重试', detail: String(error?.message ?? error) };
      }
    }
    completeStep({ stepId: 'agent', data: { provider } });
    return {
      ok: true,
      step: 'agent',
      connected: false,
      note: '当前运行环境没有 Agent 服务；已记录你的选择，可稍后在设置中接入（不影响使用 CetaMesh）'
    };
  }

  async function enableIntegration({ id, enable = true } = {}) {
    const extensionId = text(id, 120);
    if (!extensionId) throw onboardingError(ONBOARDING_ERROR_CODES.INVALID_PARAMS, '必须提供 Integration id');
    if (!extensionService?.execute) {
      completeStep({ stepId: 'integration', data: { id: extensionId, enable: enable === true } });
      return { ok: true, step: 'integration', enabled: false, note: '当前运行环境没有扩展服务；已记录你的选择（不影响使用 CetaMesh）' };
    }
    try {
      const result = await extensionService.execute({ method: enable === false ? 'ext.disable' : 'ext.enable', params: { id: extensionId } });
      completeStep({ stepId: 'integration', data: { id: extensionId, enable: enable === true } });
      return { ok: true, step: 'integration', enabled: enable !== false, detail: result ?? null };
    } catch (error) {
      return { ok: false, step: 'integration', code: String(error?.code ?? 'INTEGRATION_FAILED'), message: 'Integration 启用失败，可稍后在插件页重试', detail: String(error?.message ?? error) };
    }
  }

  const handlers = {
    'onboarding.status': () => status(),
    'onboarding.start': () => start(),
    'onboarding.completeStep': (p) => completeStep(p),
    'onboarding.skipStep': (p) => skipStep(p),
    'onboarding.finish': () => finish(),
    'onboarding.reset': () => reset(),
    'onboarding.testProvider': (p) => testProvider(p),
    'onboarding.setModel': (p) => setModel(p),
    'onboarding.connectAgent': (p) => connectAgent(p),
    'onboarding.enableIntegration': (p) => enableIntegration(p)
  };

  return {
    store: progress,
    status,
    start,
    completeStep,
    skipStep,
    finish,
    reset,
    testProvider,
    setModel,
    connectAgent,
    enableIntegration,
    steps: ONBOARDING_STEPS,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(onboardingError('METHOD_NOT_FOUND', '未知 Onboarding 方法：' + String(method ?? '')));
      }
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
