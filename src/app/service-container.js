import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_PATHS } from '../app-paths.js';
import { DEFAULT_MODEL } from '../config/migrate.js';
import { PRIVILEGE_CONSOLE } from '../bridge-privilege.js';
import { createChatService } from '../desktop/chat-service.js';
import { createDesktopPlatformRuntime } from '../desktop/platform-runtime.js';
import { createCapabilityService, registerChannelMeshCapabilities } from '../capability/index.js';
import { createWorkshopService } from '../workshop/index.js';
import { createManagedAgentProvider } from '../agent/managed-agent-provider.js';
import { searchWeb } from '../mcp-web-search-safe.js';
import { createProviderSecrets } from '../providers/secrets.js';
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider, createToolExecutionCoordinator } from '../model/index.js';
import { createRouterService } from '../router/index.js';
import { createMemoryService } from '../memory/service.js';
import { createWorkspaceService } from '../workspace/index.js';
import { createIsolatedTestRunner } from '../workspace/isolated-runner.js';
import { createTaskService } from '../task/service.js';
import { createContinuityService, createWorkspaceReconciler } from '../continuity/index.js';
import { gitDiff, gitHead, gitStatus } from '../workspace/tools.js';
import { createDefaultAgentService } from '../agent/index.js';
import { createExtensionService } from '../extension/service.js';
import { createMeshService } from '../mesh/service.js';
import { createChannelService } from '../channel/service.js';
import { createSettingsService } from '../settings/service.js';
import { createIntegrationService } from '../integrations/index.js';
import { createDshDesktopIntegration } from '../integrations/dsh-desktop.js';
import { createAboutService } from '../about/service.js';
import { createUpdateService } from '../update/service.js';
import { createNotesCache } from '../update/notes-cache.js';
import { createOnboardingService } from '../onboarding/service.js';
import { createProductService } from '../product/service.js';
import { createErrorRegistry } from '../product/error-registry.js';
import { buildDiagnostics } from '../product/diagnostics.js';
import { loadReleaseConfig } from '../product/release-config.js';
import { createPluginCenterService } from '../plugin-center/service.js';
import { createProductContextService } from '../context/service.js';
import { OWNER_ACTOR } from '../capability/types.js';
import { createDesktopUiEventBus, createDesktopUiService } from '../desktop/ui-service.js';

const DEFAULT_DSH_CONFIG = Object.freeze({
  provider: 'deepseek-official',
  model: DEFAULT_MODEL,
  reasoningEffort: 'max'
});

export function createCetaMeshServices(options = {}) {
  const config = options.config ?? {};
  const dshDefaults = { ...DEFAULT_DSH_CONFIG, ...(config.dsh ?? {}) };
  const stateDir = options.stateDir ?? APP_PATHS.stateDir;
  const dataRoot = options.dataRoot ?? APP_PATHS.dataRoot;
  const sourceRoot = options.sourceRoot ?? APP_PATHS.sourceRoot;
  const resourceRoot = options.resourceRoot ?? APP_PATHS.resourceRoot;
  const socialV2File = options.socialV2File;
  const api = options.api ?? null;
  const controlService = options.controlService ?? null;
  const log = options.log ?? (() => {});
  const uiEventBus = createDesktopUiEventBus();
  const settingsService = options.settingsService ?? createSettingsService({ stateDir });
  const dshDesktop = options.dshDesktop ?? createDshDesktopIntegration({ platform: options.platform ?? process.platform });

  const workspaceService = createWorkspaceService({
    stateDir,
    audit: event => log('Workspace ' + event.action + '（' + (event.workspaceId ?? 'none') + '）')
  });
  const taskService = createTaskService({
    stateDir,
    ownedArtifactRoot: path.join(dataRoot, 'artifacts'),
    resolveWorkspace: workspaceId => workspaceService.describeWorkspace(workspaceId)
  });
  let capabilityService = null;
  let continuityService = null;
  const agentTaskOptions = {
    stagingRoot: options.agentStagingRoot ?? path.join(os.tmpdir(), 'CetaMesh', 'agent-staging'),
    excludedRoots: [stateDir, dataRoot],
    resolveTaskWorkspace: ({ taskId, workspaceId }) => {
      const task = taskService.runtime.get({ id: taskId }).task;
      if (task.workspaceId !== workspaceId) return null;
      const workspace = workspaceService.describeWorkspace(workspaceId);
      return workspace ? { task, workspace } : null;
    },
    listWorkspaceRoots: async () => (await workspaceService.execute({ method: 'workspace.list' })).workspaces,
    applyChanges: request => capabilityService.applyAgentWorkspaceChanges(request),
    approvalStatus: approvalId => capabilityService.workspaceImportStatus(approvalId),
    cancelApproval: approvalId => capabilityService.cancelWorkspaceImportApproval(approvalId)
  };

  const providerSecrets = createProviderSecrets({ root: dataRoot });
  const agentService = createDefaultAgentService({ api, defaults: dshDefaults, log,
    dshOptions: agentTaskOptions,
    codexOptions: { ...agentTaskOptions,
      authorizeOpenAiEnvironment: () => settingsService.store.get().settings.agents.codexOpenAiEnvironmentAuthorized === true },
    desktopStatus: () => dshDesktop.status() });
  const agentBroker = agentService.broker;

  const modelRegistry = createModelProviderRegistry({
    providers: [
      createOpenAiCompatibleModelProvider({
        id: 'deepseek-official',
        label: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-flash',
        supportsTools: true,
        secrets: providerSecrets,
        supportsStreamOptions: true,
        log
      }),
      createOpenAiCompatibleModelProvider({
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        supportsTools: true,
        secrets: providerSecrets,
        reasoningParam: 'reasoning_effort',
        supportsReasoning: true,
        supportsStreamOptions: true,
        log
      }),
      createOpenAiCompatibleModelProvider({
        id: 'openai-compatible',
        label: 'OpenAI 兼容',
        baseUrl: '',
        secrets: providerSecrets,
        reasoningParam: 'reasoning_effort',
        supportsTools: () => settingsService.store.get().settings.models.openaiCompatibleToolCalling === true,
        supportsReasoning: model => settingsService.store.get().settings.models.openaiCompatibleReasoningEffort === true,
        log
      })
    ]
  });
  const modelRuntime = createModelRuntimeService({
    registry: modelRegistry, secrets: providerSecrets,
    preferredProviderId: () => settingsService.store.get().settings.models.provider,
    log
  });
  // Chat and Managed Agent are composed before all context sources exist; the callback is bound later.
  let productContextService = null;
  let managedAgent = null;
  let toolExecutionCoordinator = null;
  const toolExecutionProxy = {
    run: request => {
      if (!toolExecutionCoordinator) throw new Error('Model tool execution is unavailable');
      return toolExecutionCoordinator.run(request);
    },
    resumeApproval: request => {
      if (!toolExecutionCoordinator) throw new Error('Model tool execution is unavailable');
      return toolExecutionCoordinator.resumeApproval(request);
    },
    pendingTarget: approvalId => toolExecutionCoordinator?.pendingTarget(approvalId) ?? null,
    cancelSession: (sessionId, reason) => toolExecutionCoordinator?.cancelSession(sessionId, reason) ?? { cancelled: 0 }
  };
  managedAgent = createManagedAgentProvider({
    modelRuntime,
    toolExecutionCoordinator: toolExecutionProxy,
    buildProductTurnContext: request => productContextService?.buildForAgentTurn(request),
    requireProductContext: true,
    capabilityExecutor: request => capabilityService.broker.execute(request),
    taskPrincipalResolver: ({ provider, sessionId }) => {
      const task = taskService.runtime.findByAgent({ provider, sessionId });
      return task ? { taskId: task.id, expectedWorkspaceId: task.workspaceId,
        workspaceId: managedAgent.executionWorkspaceId(sessionId) ?? task.workspaceId,
        actor: capabilityService.principalForTask(task.id) } : null;
    },
    onTurnEnd: payload => agentBroker.reportTurnEnd(payload),
    resolveWorkspace: workspaceId => workspaceService.describeWorkspace(workspaceId),
    onEvent: event => uiEventBus.publish(event.event, event.data)
  });
  agentBroker.register(managedAgent.provider);

  const routerService = createRouterService({ stateDir, log });
  const chatService = createChatService({
    api,
    controlExecute: command => {
      if (!controlService) throw new Error('Desktop control service is unavailable');
      return controlService.execute({ ...command, actor: { privilege: PRIVILEGE_CONSOLE } });
    },
    agentProviders: agentService.listProviders(),
    agentExecute: command => agentService.execute(command),
    modelRuntime,
    toolExecutionCoordinator: toolExecutionProxy,
    buildProductTurnContext: request => productContextService?.buildForChatTurn(request),
    requireProductContext: true,
    router: routerService,
    buildProductContext: request => productContextService?.buildForChat(request),
    resolveWorkspace: workspaceId => workspaceService.describeWorkspace(workspaceId),
    resolveTask: taskId => taskService.runtime.get({ id: taskId }).task,
    handoffTask: request => continuityService.runtime.rollover(request),
    platformRoute: request => platformRuntime.route(request),
    agentFollow: request => agentBroker.follow(request),
    defaults: dshDefaults,
    defaultModelConfig: () => settingsService.store.get().settings.models,
    defaultAgentProvider: () => settingsService.store.get().settings.agents.defaultAgentProvider,
    stateDir,
    onTurnEnd: payload => agentBroker.reportTurnEnd(payload),
    onEvent: event => uiEventBus.publish(event.event, event.data)
  });

  const memoryService = createMemoryService({
    stateDir,
    ...(socialV2File ? { socialV2File } : {}),
    audit: decision => {
      if (decision.action !== 'read') {
        log('Memory ' + decision.action + ' by ' + decision.principal.kind + ':' + decision.principal.id);
      }
    }
  });
  capabilityService = createCapabilityService({
    stateDir,
    workspaceService,
    memoryService,
    taskRuntime: taskService.runtime,
    agentBroker,
    bindAgentSession: managedAgent.bindSession,
    resumeAgentApproval: managedAgent.resumeLegacyApproval,
    searchImpl: searchWeb,
    audit: event => log('Capability ' + event.capability + ' ' + event.status),
    isolatedRunner: createIsolatedTestRunner({
      resolveWorkspace: async workspaceId => workspaceService.describeWorkspace(workspaceId),
      log
    })
  });
  toolExecutionCoordinator = createToolExecutionCoordinator({
    modelRuntime,
    capabilityBroker: capabilityService.broker,
    stateDir,
    actorResolver: ({ actorKind, actorId, sessionId, scope }) => {
      if (actorKind === 'owner') return OWNER_ACTOR;
      if (actorKind === 'agent') {
        const taskId = String(scope?.taskId ?? '');
        const workspaceId = String(scope?.workspaceId ?? '');
        const task = taskId && sessionId
          ? taskService.runtime.findByAgent({ provider: 'cetamesh', sessionId })
          : null;
        if (!task || task.id !== taskId || task.workspaceId !== workspaceId) return null;
        let actor;
        try { actor = capabilityService.principalForTask(taskId); }
        catch (error) {
          if (['TASK_NOT_AUTHORIZED', 'TASK_NOT_FOUND'].includes(error?.code)) return null;
          throw error;
        }
        if (actor.kind !== 'agent' || actor.id !== actorId
          || !actor.grants?.taskIds?.includes(taskId)
          || !actor.grants?.workspaceIds?.includes(workspaceId)) return null;
        return actor;
      }
      return null;
    }
  });
  const platformRuntime = createDesktopPlatformRuntime({
    capabilityService,
    workspaceService,
    taskRuntime: taskService.runtime,
    agentBroker,
    continuityRuntime: { rollover: params => {
      if (!continuityService) throw Object.assign(new Error('Continuity Runtime is unavailable'), { code: 'PROVIDER_UNAVAILABLE' });
      return continuityService.runtime.rollover(params);
    } },
    legacyModel: dshDefaults.model
  });
  const workshopService = createWorkshopService({
    stateDir,
    workspaceService,
    taskRuntime: taskService.runtime,
    capabilityBroker: capabilityService.broker
  });

  const continuityReconciler = createWorkspaceReconciler({
    resolveWorkspace: async workspaceId => workspaceService.describeWorkspace(workspaceId),
    gitStatus: root => gitStatus(root),
    gitHead: root => gitHead(root),
    gitDiffSummary: async root => {
      const diff = await gitDiff(root, { statOnly: true });
      return diff?.output ?? null;
    },
    fileExists: (root, relPath) => {
      const resolvedRoot = path.resolve(root);
      const target = path.resolve(resolvedRoot, String(relPath ?? ''));
      if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return false;
      return fs.existsSync(target);
    }
  });
  continuityService = createContinuityService({
    taskRuntime: taskService.runtime,
    stateDir,
    agentBroker,
    reconciler: continuityReconciler,
    workspaceService,
    capabilityService,
    canRollover: ({ taskId }) => !capabilityService.isTaskProvisioning(taskId),
    onHandoffComplete: assignment => capabilityService.trackTaskAgent(assignment),
    listPendingApprovals: ({ taskId }) => capabilityService.broker.approvals
      .list()
      .filter(row => row.request?.taskId === taskId)
      .map(row => ({ approvalId: row.id, capability: row.request?.capability ?? null, expiresAt: row.expiresAt })),
    log
  });
  capabilityService.setTaskHandoffGuard(taskId => continuityService.runtime.isInFlight(taskId));
  agentBroker.onTurnEnd(payload => continuityService.runtime.observeAgentTurn(payload)
    .catch(error => log('Continuity 回合观察失败：' + String(error?.message ?? error))));

  const extensionService = createExtensionService({ stateDir, capabilityBroker: capabilityService.broker,
    isTrustedVmExtension: options.isTrustedVmExtension });
  const meshService = createMeshService({ stateDir, settingsStore: settingsService.store,
    isEnabled: () => settingsService.store.get().settings.devices.meshEnabled === true });
  const channelService = createChannelService();
  registerChannelMeshCapabilities({
    broker: capabilityService.broker,
    channelService,
    meshService,
    isTargetAllowed: (kind, id) => {
      const list = kind === 'group' ? config.allow?.groups : config.allow?.private;
      return Array.isArray(list) && list.map(String).includes(String(id));
    }
  });

  // ── 产品化任务 B：Plugins / Tools / MCP 统一入口。底层仍是既有 Channel/Agent Provider 与
  // Extension/ProcessExtensionHost；本服务只做注册表、开关、生命周期与能力边界适配。 ──
  const integrationService = createIntegrationService({
    stateDir,
    capabilityBroker: capabilityService.broker,
    ...(options.localServices ? { localServices: options.localServices } : {}),
    dshDesktop,
    agentHealth: () => agentBroker.health('dsh'),
    settingsSnapshot: () => settingsService.store.get().settings,
    // Provider 快照 = "底层是否真的接入"：
    //   - agent：DSH 在未注入 API 时**仍会注册**但 available=false / health=unavailable，
    //     所以必须按真实可用性过滤（注册 ≠ 可用）；
    //   - channel：注册表即"该 Channel Provider 是否存在"（qq），实时连接状态由通道自身
    //     state 与本地服务（SnowLuma 进程）另行如实上报。
    providerSnapshot: () => ({
      channel: channelService.registry.list()
        .filter(channel => channel.state !== 'unavailable' && channel.state !== 'error')
        .map(channel => channel.id),
      agent: agentService.listProviders()
        .filter(provider => provider.available === true)
        .map(provider => provider.id),
      agentProviders: agentService.listProviders()
    }),
    log
  });

  // ── 产品化任务 D：产品面服务（About / 更新公告 / 反馈入口 / Onboarding / 产品文案） ──
  // 发行配置 release-config.json 与"最近错误码"是 About 与产品服务共用的事实源，各建一份。
  const releaseConfig = loadReleaseConfig({ rootDir: resourceRoot });
  const errorRegistry = createErrorRegistry();
  productContextService = createProductContextService({
    taskRuntime: taskService.runtime,
    workspaceService,
    memoryService,
    capabilityService,
    extensionService,
    agentBroker,
    modelRuntime
  });

  capabilityService.setApprovalDecisionListener(async decision => {
    const target = toolExecutionCoordinator.pendingTarget(decision.approvalId);
    if (target?.kind === 'chat') return chatService.resumeApproval(decision);
    if (target?.kind === 'agent') return managedAgent.resumeApproval(decision);
    return null;
  });

  const notesCache = createNotesCache({ stateDir });

  /**
   * 诊断快照：**只在本机展示**（About 页）。反馈已改为"链接入口 + 系统浏览器"，
   * 软件内不再有诊断附件与上传通道；这里依旧坚持白名单 + 脱敏构造。
   */
  function diagnosticsSnapshot() {
    let extensions = [];
    try {
      extensions = extensionService.runtime?.list?.() ?? [];
    } catch (error) {
      // 扩展注册表损坏不该让"查看诊断信息"失败：如实降级为空列表并记录。
      log('诊断信息读取扩展列表失败：' + String(error?.message ?? error));
    }
    return buildDiagnostics({
      aboutInfo: aboutService.about.info(),
      providers: modelRuntime.listProviders(),
      extensions,
      settings: settingsService.store.get().settings,
      errorRegistry
    });
  }

  const aboutService = createAboutService({
    rootDir: sourceRoot,
    releaseConfig: releaseConfig.config,
    notesCache,
    diagnosticsProvider: diagnosticsSnapshot
  });
  const pluginCenterService = createPluginCenterService({
    stateDir,
    catalogUrl: options.pluginCatalogUrl ?? releaseConfig.config.pluginService.catalogUrl,
    allowedHosts: options.pluginCatalogAllowedHosts ?? releaseConfig.config.pluginService.allowedHosts,
    currentVersion: aboutService.about.info().version,
    fetchImpl: options.pluginCenterFetchImpl ?? null,
    extensionRuntime: extensionService.runtime,
    settingsStore: settingsService.store,
    log
  });
  const updateService = createUpdateService({
    currentVersion: aboutService.about.info().version,
    currentBuildNumber: aboutService.about.info().buildNumber ?? 0,
    settingsStore: settingsService.store,
    notesCache,
    log
  });
  // 产品文案 / Provider 配置视图 / 反馈入口链接：纯函数服务，UI 直接消费，
  // 避免同一句话、同一个官方域名在多处漂移。
  const productService = createProductService({
    aboutInfo: () => aboutService.about.info(),
    releaseConfig: releaseConfig.config,
    modelProviders: () => modelRuntime.listProviders()
  });
  // 首次运行引导：QQ / DSH / 移动端 / Agent 都不在完成条件里（见 src/onboarding/steps.js）。
  const onboardingService = createOnboardingService({
    stateDir,
    providerSecrets,
    modelRuntime,
    settingsService,
    extensionService,
    pluginCenterService,
    log
  });
  const systemServices = {
    settings: settingsService,
    about: aboutService,
    update: updateService,
    onboarding: onboardingService,
    product: productService
  };
  const desktopUiService = createDesktopUiService({
    services: {
      chatService, taskService, workspaceService, memoryService, capabilityService, agentBroker, continuityService,
      agentService, pluginCenterService, integrationService, extensionService, settingsService, systemServices
    },
    system: systemServices,
    eventBus: uiEventBus
  });

  return {
    controlService,
    providerSecrets,
    agentService,
    dshDesktop,
    agentBroker,
    managedAgent,
    modelRegistry,
    modelRuntime,
    productContextService,
    routerService,
    chatService,
    memoryService,
    taskService,
    workspaceService,
    capabilityService,
    platformRuntime,
    workshopService,
    continuityService,
    extensionService,
    pluginCenterService,
    meshService,
    channelService,
    integrationService,
    aboutService,
    settingsService,
    updateService,
    onboardingService,
    productService,
    releaseConfig,
    errorRegistry,
    systemServices,
    system: systemServices,
    desktopUiService,
    uiEventBus
  };
}
