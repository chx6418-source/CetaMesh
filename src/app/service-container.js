import fs from 'node:fs';
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
import { createModelProviderRegistry, createModelRuntimeService, createOpenAiCompatibleModelProvider } from '../model/index.js';
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
import { createAboutService } from '../about/service.js';
import { createUpdateService } from '../update/service.js';
import { createProductContextService } from '../context/service.js';

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
  const socialV2File = options.socialV2File;
  const api = options.api ?? null;
  const controlService = options.controlService ?? null;
  const log = options.log ?? (() => {});

  const providerSecrets = createProviderSecrets({ root: dataRoot });
  const agentService = createDefaultAgentService({ api, defaults: dshDefaults, log });
  const agentBroker = agentService.broker;

  const modelRegistry = createModelProviderRegistry({
    providers: [
      createOpenAiCompatibleModelProvider({
        id: 'deepseek-official',
        label: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        secrets: providerSecrets,
        supportsStreamOptions: true,
        log
      }),
      createOpenAiCompatibleModelProvider({
        id: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        secrets: providerSecrets,
        reasoningParam: 'reasoning_effort',
        supportsStreamOptions: true,
        log
      }),
      createOpenAiCompatibleModelProvider({
        id: 'openai-compatible',
        label: 'OpenAI 兼容',
        baseUrl: '',
        secrets: providerSecrets,
        reasoningParam: 'reasoning_effort',
        log
      })
    ]
  });
  const modelRuntime = createModelRuntimeService({ registry: modelRegistry, secrets: providerSecrets, log });
  // Chat and Managed Agent are composed before all context sources exist; the callback is bound later.
  let productContextService = null;
  const managedAgent = createManagedAgentProvider({
    modelRuntime,
    buildProductContext: request => productContextService?.buildForAgent(request),
    capabilityExecutor: request => capabilityService.broker.execute(request),
    taskPrincipalResolver: ({ provider, sessionId }) => {
      const task = taskService.runtime.findByAgent({ provider, sessionId });
      return task ? { taskId: task.id, workspaceId: task.workspaceId, actor: capabilityService.principalForTask(task.id) } : null;
    },
    onTurnEnd: payload => agentBroker.reportTurnEnd(payload)
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
    router: routerService,
    buildProductContext: request => productContextService?.buildForChat(request),
    platformRoute: request => platformRuntime.route(request),
    agentFollow: request => agentBroker.follow(request),
    defaults: dshDefaults,
    stateDir,
    onTurnEnd: payload => agentBroker.reportTurnEnd(payload)
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
  const taskService = createTaskService({ stateDir });
  const workspaceService = createWorkspaceService({
    stateDir,
    audit: event => log('Workspace ' + event.action + '（' + (event.workspaceId ?? 'none') + '）')
  });
  const capabilityService = createCapabilityService({
    stateDir,
    workspaceService,
    memoryService,
    taskRuntime: taskService.runtime,
    agentBroker,
    bindAgentSession: managedAgent.bindSession,
    searchImpl: searchWeb,
    audit: event => log('Capability ' + event.capability + ' ' + event.status),
    isolatedRunner: createIsolatedTestRunner({
      resolveWorkspace: async workspaceId => workspaceService.describeWorkspace(workspaceId),
      log
    })
  });
  const platformRuntime = createDesktopPlatformRuntime({
    capabilityService,
    workspaceService,
    taskRuntime: taskService.runtime,
    agentBroker,
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
  const continuityService = createContinuityService({
    taskRuntime: taskService.runtime,
    stateDir,
    agentBroker,
    reconciler: continuityReconciler,
    listPendingApprovals: ({ taskId }) => capabilityService.broker.approvals
      .list()
      .filter(row => row.request?.taskId === taskId)
      .map(row => ({ approvalId: row.id, capability: row.request?.capability ?? null, expiresAt: row.expiresAt })),
    log
  });
  agentBroker.onTurnEnd(payload => continuityService.runtime.observeAgentTurn(payload)
    .catch(error => log('Continuity 回合观察失败：' + String(error?.message ?? error))));

  const extensionService = createExtensionService({ stateDir, capabilityBroker: capabilityService.broker,
    isTrustedVmExtension: options.isTrustedVmExtension });
  const meshService = createMeshService({ stateDir });
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

  productContextService = createProductContextService({
    taskRuntime: taskService.runtime,
    workspaceService,
    memoryService,
    capabilityService,
    extensionService,
    agentBroker
  });

  const aboutService = createAboutService({ rootDir: sourceRoot });
  const settingsService = createSettingsService({ stateDir });
  const updateService = createUpdateService({
    currentVersion: aboutService.about.info().version,
    settingsStore: settingsService.store
  });
  const systemServices = {
    settings: settingsService,
    about: aboutService,
    update: updateService
  };

  return {
    controlService,
    providerSecrets,
    agentService,
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
    meshService,
    channelService,
    aboutService,
    settingsService,
    updateService,
    systemServices,
    system: systemServices
  };
}
