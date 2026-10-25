import type { AboutView } from '../types/views';

export interface ChatSession {
  id: string; title: string; createdAt: string | number | null; updatedAt: string | number | null;
  archived: boolean; taskId: string | null; config: { mode: string; modelProvider: string | null; model: string; agentProvider: string | null; workspaceId: string | null };
}
export interface ModelUsage {
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  reasoningTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null;
  requestCount: number | null; cacheHitRate: number | null; cost: { status: 'actual' | 'estimated' | 'unknown'; amount: number | null; knownAmount: number | null; currency: string | null; complete: boolean; sources: string[]; versions: string[] } | null; accountingComplete: boolean | null;
}
export interface ChatMessage {
  id: string; role: 'user' | 'assistant' | 'system'; text: string; at: string | number | null;
  requestId?: string | null;
  usage?: ModelUsage | null;
  attachments: string[]; toolActivity: { id: string; label: string; status: string; summary: string; durationMs: number | null }[];
  agentActivity?: { providerId: string; label: string; status: 'running' | 'completed' | 'cancelled' | 'failed' } | null;
  error: string | null; cancelled: boolean;
}
export interface ProviderSettingField {
  key: string; label: string; type: 'string' | 'number' | 'boolean';
  choices?: string[]; min?: number; max?: number;
}
export interface Task {
  usage?: ModelUsage | null;
  id: string; title: string; goal: string; status: string; currentPhase: string;
  progress: { percent: number; note: string }; workspaceId: string | null; agent: string | null;
  currentAgent: { provider: string; sessionId: string } | null;
  createdAt: string | number | null; updatedAt: string | number | null; rev: number | null;
  checkpoint: { summary: string; nextAction: string } | null; result: { summary: string } | null;
  artifacts: { id: string; kind: string; label: string; createdAt: string | number | null }[];
  executionEvidence: { eventId: string; capability: string; status: string; tool: string | null;
    exitCode: number | null; filePath: string | null; taskRev: number | null; at: string | number | null }[];
  agentHistory: { provider: string; sessionId: string; attachedAt: string | number | null; detachedAt: string | number | null; note: string }[];
  failure: { reason: string } | null;
}
export interface WorkshopProposal {
  id: string; title: string; description: string; requirements: string[];
  supplements: { id: string; text: string }[]; submitter: { kind: string; id: string };
  status: string; review: { decision: string; reason: string; at: string | number | null } | null;
  plan: { workspace: { name: string; root: string }; provider: string; capabilities: string[] } | null;
  workspaceId: string | null; taskId: string | null; errorCode: string | null;
  artifacts: { id: string; label: string; mediaType: string; deliveredAt: string | number | null }[];
  createdAt: string | number | null; updatedAt: string | number | null;
}
export interface Memory {
  id: string; type: string; scope: string; title: string; content: string; summary: string;
  tags: string[]; pinned: boolean; rev: number | null; createdAt: string | number | null; updatedAt: string | number | null;
}
export interface MemoryCandidate {
  id: string; status: string; type: string; scope: string; content: string; reason: string;
  proposedAt: string | number | null; memoryId: string | null;
}
export type AgentStatus = 'ready' | 'needs-setup' | 'descriptor-incomplete' | 'not-installed' | 'unavailable' | 'not-supported' | 'not-checked';
export interface Agent {
  id: string; name: string; role: string; description: string; available: boolean | null; installed: boolean | null; authenticated: boolean | null; compatible: boolean | null; status: AgentStatus;
  eligible: boolean | null; taskEligible: boolean | null; configured: boolean | null; reason: string | null; lastError: string | null; workspaceBoundary: string | null;
  reachable?: boolean | null; ready?: boolean | null; sessionCapable?: boolean | null;
  sandboxCapable?: boolean | null; installKind?: string | null; probePhase?: string | null; probeCode?: string | null; checkedAt?: string | null; requiresStandaloneNode?: boolean;
  configuration?: DshConfiguration | null;
  preset?: { purpose: string; id: string | null; compatible: boolean | null; loaded: boolean | null; loadState: 'loaded' | 'not-loaded' | 'unknown'; reason: string | null; verification: string | null } | null;
  diagnostic?: { stage: string; code: string | null; retryable: boolean; checkedAt: string | null } | null;
  version: string | null; desktopApp: { installed: boolean; running: boolean; status: string; version: string | null } | null;
}
export interface DshPresetCatalog { state: 'ready' | 'missing' | 'unreadable' | 'outside-root' | 'loading' | 'error'; truncated: boolean; presets: { id: string; compatible: boolean; reason: string | null }[] }
export interface DshSelection { codingPreset: string | null; socialPreset: string | null; homeDir: string | null; baseUrl: string | null }
export interface DshConfiguration {
  version: number; revision: number; activeRevision: number; pendingRevision: number | null; restartRequired: boolean;
  source: string; loadError: string | null; configFile: string | null; pendingConfigFile?: string | null; dataRoot: string | null; homeSource: string;
  active: DshSelection; pending: DshSelection | null;
}
export interface Plugin {
  id: string; name: string; summary: string; description: string; developer: string; version: string;
  status: string; category: string; kind: string; featured: boolean; installed: boolean; enabled: boolean;
  available: boolean; configured: boolean; eligible: boolean; reason: string | null; lastError: string | null;
  icon: string; permissions: string[]; changelog: string[]; compatibility: { minimum: string | null; maximum: string | null };
  screenshotCount: number; warning: string | null;
}
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
export interface Approval {
  id: string; title: string; capability: string; status: ApprovalStatus; createdAt: string | number | null;
  expiresAt: string | number | null; summary: string; risk: string; taskId: string | null;
}
export interface ApprovalDecisionResult {
  status: 'accepted' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'rejected'; operationId?: string; decision?: string; code?: string; approvalId?: string; requestId?: string; turnResumed?: boolean; resumePending?: boolean;
  resumeError?: string; taskResumed?: boolean;
}
export interface Attachment { name: string; content: string; mimeType?: string }
export type Settings = Record<string, Record<string, string | number | boolean | null>>;
export type ExtensionSettingType = 'boolean' | 'string' | 'number' | 'enum' | 'secretRef';
export interface ExtensionSettingField {
  key: string; label: string; type: ExtensionSettingType; required: boolean;
  default?: string | number | boolean | null; options: string[];
  min: number | null; max: number | null; maxLength: number | null;
}
export type ExtensionSettingValue = string | number | boolean | null | { configured: boolean };
export interface ExtensionSettingsDescription { id: string; name: string; available: boolean; fields: ExtensionSettingField[] }
export interface ExtensionSettingsSnapshot { id: string; values: Record<string, ExtensionSettingValue> }
export type IntegrationRestoreStatus = 'restored' | 'partial' | 'deprecated' | 'legacy-unsupported' | 'unknown';
export interface IntegrationToolSetting {
  id: string; name: string; enabled: boolean; available: boolean; restorable: boolean;
  restore: IntegrationRestoreStatus; reason: string; risk: string; permission: string;
}
export interface RetiredIntegrationTool {
  id: string; name: string; feature: string; restore: 'deprecated' | 'legacy-unsupported'; reason: string;
  replacement: { id: string; label: string } | null;
}
export interface LocalServiceSettings {
  status: string; installed: boolean | null; running: boolean; ready: boolean; configured: boolean | null;
  authenticated?: boolean; canSend?: boolean;
  accountId?: string | null;
  version: string | null; httpUrl: string | null; wsUrl: string | null; accessTokenConfigured: boolean;
  lastError: string | null; actions: string[];
}
export interface IntegrationSettings {
  id: string; name: string; enabled: boolean; available: boolean; tools: IntegrationToolSetting[];
  inventory: { restored: number; partial: number; legacyUnsupported: number } | null;
  legacyRetired: RetiredIntegrationTool[]; settings: Record<string, unknown>; localService: LocalServiceSettings | null;
}

export type DesktopEvent = 'preview.browser' | 'core.status' | 'chat.updated' | 'chat.streaming' | 'chat.warning' | 'task.updated' | 'task.deleted'
  | 'core.restarted'
  | 'agent.updated' | 'workspace.updated' | 'plugin.updated' | 'plugin.downloadProgress' | 'approval.pending' | 'approval.resolved'
  | 'approval.operation' | 'channel.message' | 'channel.delivery'
  | 'model.updated' | 'memory.updated' | 'update.status' | 'device.updated';
export interface DesktopEventData {
  targetId?: string; revision?: number; generation?: number; url?: string; title?: string; loading?: boolean; error?: string; canBack?: boolean; canForward?: boolean; focusRequested?: boolean; historyUrls?: string[]; historyIndex?: number;
  sessionId?: string; taskId?: string; agentId?: string; pluginId?: string; serverId?: string; approvalId?: string; requestId?: string; retryCount?: number;
  turnId?: string; messageId?: string; historyRevision?: number;
  accountId?: string; channelId?: string; eventId?: string; sequence?: number; consumerId?: string;
  operationId?: string; decision?: string; code?: string;
  message?: string;
  provider?: string; status?: string; progress?: number; ready?: boolean; needsAttention?: boolean;
  delta?: string; replaceText?: string; reset?: boolean; toolActivity?: ChatMessage['toolActivity']; agentActivity?: ChatMessage['agentActivity'];
}
type UiMethod =
  | 'ui.preview.open' | 'ui.preview.read' | 'ui.preview.close'
  | 'ui.events.next'
  | 'ui.chat.sessions.list' | 'ui.chat.sessions.create' | 'ui.chat.sessions.rename' | 'ui.chat.sessions.archive' | 'ui.chat.sessions.delete'
  | 'ui.chat.history' | 'ui.chat.status' | 'ui.chat.send' | 'ui.chat.stop' | 'ui.chat.retry' | 'ui.chat.continue' | 'ui.chat.catalog' | 'ui.chat.config.set'
  | 'ui.task.overview' | 'ui.task.get' | 'ui.task.create' | 'ui.task.start' | 'ui.task.pause' | 'ui.task.resume' | 'ui.task.reconcile' | 'ui.task.cancel' | 'ui.task.handoff'
  | 'ui.workshop.proposals' | 'ui.workshop.proposal' | 'ui.workshop.review' | 'ui.workshop.retry' | 'ui.workshop.task.status' | 'ui.workshop.deliver'
  | 'ui.workspace.list' | 'ui.workspace.open' | 'ui.workspace.create'
  | 'ui.memory.overview' | 'ui.memory.get' | 'ui.memory.create' | 'ui.memory.update' | 'ui.memory.pin' | 'ui.memory.delete'
  | 'ui.memory.candidates.confirm' | 'ui.memory.candidates.confirmBatch'
  | 'ui.agent.security' | 'ui.agent.authorize' | 'ui.agent.list' | 'ui.agent.health' | 'ui.agent.configure' | 'ui.agent.presets'
  | 'ui.extensions.settings.describe' | 'ui.extensions.settings.get' | 'ui.extensions.settings.update'
  | 'ui.plugins.catalog' | 'ui.plugins.status' | 'ui.plugins.detail' | 'ui.plugins.refresh' | 'ui.plugins.stage' | 'ui.plugins.stage-local' | 'ui.plugins.install'
  | 'ui.plugins.enable.review' | 'ui.plugins.enable' | 'ui.plugins.disable' | 'ui.plugins.uninstall' | 'ui.plugins.integration.list' | 'ui.plugins.integration.settings'
  | 'ui.plugins.integration.manage' | 'ui.plugins.integration.tool.toggle' | 'ui.plugins.integration.action'
  | 'ui.mcp.list' | 'ui.mcp.tools' | 'ui.mcp.manage' | 'ui.mcp.config.get' | 'ui.mcp.config.update'
  | 'ui.settings.describe' | 'ui.settings.get' | 'ui.settings.update' | 'ui.about.info' | 'ui.about.update'
  | 'ui.feedback.links'
  | 'ui.update.capabilities' | 'ui.update.check' | 'ui.update.notes'
  | 'ui.onboarding.status' | 'ui.onboarding.start' | 'ui.onboarding.completeStep' | 'ui.onboarding.skipStep' | 'ui.onboarding.finish' | 'ui.onboarding.testProvider' | 'ui.onboarding.setModel'
  | 'ui.approvals.list' | 'ui.approvals.decide' | 'ui.approvals.operation' | 'ui.approvals.cancel' | 'ui.search';
type Empty = Record<string, never>;
export type WindowAction = 'state' | 'drag' | 'minimize' | 'maximize' | 'close' | 'resizeNorth' | 'resizeNorthEast' | 'resizeEast' | 'resizeSouthEast' | 'resizeSouth' | 'resizeSouthWest' | 'resizeWest' | 'resizeNorthWest';
type HostMethod = 'app.previewBrowser.open' | 'app.previewBrowser.layout' | 'app.previewBrowser.command' | 'app.windowAction' | 'app.ping' | 'app.status' | 'app.about' | 'app.openExternal' | 'app.openArtifact' | 'app.pickFolder' | 'app.pickFiles' | 'app.pickExtensionPackage' | 'app.setWindowBehavior';
type HostMap = {
  'app.previewBrowser.open': { params: { targetId: string; url: string; bounds: PreviewBounds }; result: { opened: boolean } };
  'app.previewBrowser.layout': { params: { targetId: string; bounds: PreviewBounds; visible: boolean }; result: { updated: boolean } };
  'app.previewBrowser.command': { params: { targetId: string; action: 'back' | 'forward' | 'reload' | 'close' }; result: { updated: boolean } };
  'app.windowAction': { params: { action: WindowAction }; result: { maximized: boolean } };
  'app.ping': { params: Empty; result: { host: 'webview2'; ready: boolean } };
  'app.status': { params: Empty; result: { ready: boolean; needsAttention: boolean } };
  'app.about': { params: Empty; result: AboutView };
  'app.openExternal': { params: { url: string }; result: { opened: boolean } };
  'app.openArtifact': { params: { taskId: string; artifactId: string }; result: { opened: boolean } };
  'app.pickFolder': { params: Empty; result: { path: string | null } };
  'app.pickFiles': { params: Empty; result: { attachments: Attachment[] } };
  'app.pickExtensionPackage': { params: Empty; result: { path: string | null } };
  'app.setWindowBehavior': { params: { confirmOnExit: boolean }; result: { updated: boolean } };
};
type Reply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
type EventEnvelope = { event: DesktopEvent; data: DesktopEventData };
interface HostBridge {
  invoke<M extends HostMethod>(method: M, params: HostMap[M]['params']): Promise<HostMap[M]['result']>;
  subscribe(event: DesktopEvent, callback: (data: DesktopEventData) => void): () => void;
}
declare global {
  interface Window {
    ipc?: { postMessage(message: string): void };
    cetamesh: HostBridge;
    __cetameshReceive?: (reply: Reply) => void;
    __cetameshEvent?: (event: EventEnvelope) => void;
  }
}

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
const listeners = new Map<DesktopEvent, Set<(data: DesktopEventData) => void>>();
let nextId = 0;
let cursor = 0;
let coreInstanceId: string | null = null;
let eventPump: Promise<void> | null = null;
const MAX_BRIDGE_REQUEST_BYTES = 900 * 1024;
// Native selectors wait for human input. Keep their wait bounded without
// expiring them at the ordinary RPC deadline while the dialog is still open.
const NATIVE_SELECTOR_METHODS = new Set(['app.pickFolder', 'app.pickFiles', 'app.pickExtensionPackage']);

function send<T>(method: HostMethod | UiMethod, params: object): Promise<T> {
  if (!window.ipc) return Promise.reject(new Error('桌面主机连接不可用。请从 CetaMesh Desktop 打开此界面。'));
  const payload = JSON.stringify({ id: `harbor-${nextId + 1}`, method, params });
  if (new TextEncoder().encode(payload).byteLength > MAX_BRIDGE_REQUEST_BYTES) {
    return Promise.reject(new Error('此请求超过桌面桥接大小限制。请减少附件数量或选择较小文件。'));
  }
  const id = `harbor-${++nextId}`;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('桌面主机响应超时。'));
    }, NATIVE_SELECTOR_METHODS.has(method) ? 300_000 : 32_000);
    pending.set(id, { resolve: value => resolve(value as T), reject, timer });
    window.ipc!.postMessage(JSON.stringify({ id, method, params }));
  });
}
const uiCall = <T>(method: UiMethod, params: object) => send<T>(method, params);

window.__cetameshReceive = (reply) => {
  const request = pending.get(reply.id);
  if (!request) return;
  window.clearTimeout(request.timer);
  pending.delete(reply.id);
  if (reply.ok) request.resolve(reply.result);
  else request.reject(Object.assign(new Error(reply.error.message), { code: reply.error.code }));
};
window.__cetameshEvent = ({ event, data }) => {
  for (const listener of listeners.get(event) ?? []) listener(data);
};

async function runEventPump(): Promise<void> {
  while (listeners.size > 0 && window.ipc) {
    try {
      const response = await uiCall<{ instanceId: string; events: { cursor: number; event: DesktopEvent; data: DesktopEventData }[]; cursor: number; reset?: boolean }>(
        'ui.events.next', { after: cursor, waitMs: 20_000 }
      );
      if (coreInstanceId !== response.instanceId) {
        const restarted = coreInstanceId !== null;
        coreInstanceId = response.instanceId;
        cursor = 0;
        if (restarted) {
          window.__cetameshEvent?.({ event: 'core.restarted', data: {} });
          continue;
        }
      }
      cursor = Math.max(cursor, response.cursor);
      if (response.reset) {
        cursor = response.cursor;
        window.__cetameshEvent?.({ event: 'core.restarted', data: { reset: true } });
        continue;
      }
      for (const event of response.events) window.__cetameshEvent?.(event);
    } catch {
      await new Promise(resolve => window.setTimeout(resolve, 1200));
    }
  }
}

export const bridge: HostBridge = Object.freeze({
  invoke<M extends HostMethod>(method: M, params: HostMap[M]['params']): Promise<HostMap[M]['result']> {
    return send(method, params);
  },
  subscribe(event: DesktopEvent, callback: (data: DesktopEventData) => void) {
    const group = listeners.get(event) ?? new Set();
    group.add(callback);
    listeners.set(event, group);
    if (!eventPump && window.ipc) eventPump = runEventPump().finally(() => { eventPump = null; });
    return () => { group.delete(callback); if (!group.size) listeners.delete(event); };
  }
});
window.cetamesh = bridge;

export const chatClient = {
  sessions: {
    list: (includeArchived = false) => uiCall<{ sessions: ChatSession[] }>('ui.chat.sessions.list', { includeArchived }),
    create: (title = '') => uiCall<ChatSession>('ui.chat.sessions.create', { title }),
    rename: (id: string, title: string) => uiCall<ChatSession>('ui.chat.sessions.rename', { id, title }),
    archive: (id: string, archived = true) => uiCall<ChatSession>('ui.chat.sessions.archive', { id, archived }),
    remove: (id: string) => uiCall<{ id: string; deleted: boolean }>('ui.chat.sessions.delete', { id })
  },
  history: (id: string, limit = 100, beforeMessageId: string | null = null, afterMessageId: string | null = null) => uiCall<{
    id: string; total: number; messages: ChatMessage[]; sessionUsage?: ModelUsage | null; nextBeforeMessageId: string | null; hasMore: boolean; nextAfterMessageId: string | null; hasMoreAfter: boolean
  }>('ui.chat.history', { id, limit, beforeMessageId, afterMessageId }),
  status: (id: string) => uiCall<{ id: string; taskId: string | null; dshSessionAlive: boolean; state: string; requestId: string | null; statusMessage: string | null; retryCount: number; followState: string; followError: string | null; displayText: string; toolActivity: ChatMessage['toolActivity']; agentActivity: ChatMessage['agentActivity']; error: string | null; errorCode: string | null; approvalId: string | null; approvalExpiresAt: string | number | null; routing: Record<string, unknown> }>('ui.chat.status', { id }),
  send: (id: string, text: string, attachments: Attachment[] = [], clientMessageId?: string) => {
    const params = { id, text, attachments, ...(clientMessageId ? { clientMessageId } : {}) };
    return uiCall<{ userMessageId?: string; requestId?: string }>('ui.chat.send', params).catch(error => {
      // The Core may have accepted the request while its ACK was lost. Retry only
      // with a stable message ID; Chat's persisted ID makes this idempotent.
      if (!clientMessageId || !(error instanceof Error) || error.message !== '桌面主机响应超时。') throw error;
      return uiCall<{ userMessageId?: string; requestId?: string }>('ui.chat.send', params);
    });
  },
  stop: (id: string) => uiCall<{ stopped?: boolean; state?: string; reason?: string }>('ui.chat.stop', { id }),
  retry: (id: string) => uiCall<{ userMessageId?: string }>('ui.chat.retry', { id }),
  continue: (id: string) => uiCall<{ continued?: boolean }>('ui.chat.continue', { id }),
  catalog: (refresh = false) => uiCall<{ models: unknown[]; modelProviders: { id: string; label: string; configured: boolean; catalogState: string; reachable: boolean | null; authenticated: boolean | null; inferencing: boolean | null; toolCalling: boolean; error: string | null; settingsFields: ProviderSettingField[]; models: { id?: string; name?: string; label?: string; toolCalling?: string; streaming?: string; reasoning?: string }[] }[]; agentProviders: Agent[]; modes: string[]; defaultModelProvider: string | null; available: boolean; reason: string | null }>('ui.chat.catalog', { refresh }),
  setConfig: (id: string, config: Record<string, unknown>) => uiCall<ChatSession>('ui.chat.config.set', { id, config })
};
export const taskClient = {
  overview: (query = '', status = '') => uiCall<{ tasks: Task[]; total: number; counts: Record<string, number>; needsAttention: string[] }>('ui.task.overview', { query, status, limit: 100 }),
  get: (id: string) => uiCall<{ task: Task }>('ui.task.get', { id }),
  create: (input: { goal: string; requirements?: string[]; workspaceId?: string | null; agentProvider?: string; requestId?: string; note?: string }) => uiCall<{ task: Task }>('ui.task.create', input),
  start: (id: string, expectedRev?: number, agentProvider?: string) => uiCall<{ task: Task }>('ui.task.start', { id, expectedRev, agentProvider }),
  pause: (id: string, expectedRev?: number) => uiCall<{ task: Task }>('ui.task.pause', { id, expectedRev }),
  resume: (id: string, expectedRev?: number) => uiCall<{ task: Task }>('ui.task.resume', { id, expectedRev }),
  reconcile: (id: string, expectedRev: number | undefined, reviewSummary: string, nextInstruction: string, requestId: string, provider?: string) =>
    uiCall<{ task: Task }>('ui.task.reconcile', { id, expectedRev, reviewed: true, reviewSummary, nextInstruction, requestId, provider }),
  cancel: (id: string, expectedRev?: number) => uiCall<{ task: Task }>('ui.task.cancel', { id, expectedRev }),
  handoff: (id: string, targetProvider: string, expectedRev?: number) => uiCall<{ task: Task; handoff: { success: boolean; from: unknown; to: unknown } }>('ui.task.handoff', { id, targetProvider, expectedRev })
};
export const workshopClient = {
  proposals: () => uiCall<{ proposals: WorkshopProposal[]; total: number }>('ui.workshop.proposals', {}),
  proposal: (id: string) => uiCall<{ proposal: WorkshopProposal }>('ui.workshop.proposal', { id }),
  review: (id: string, approve: boolean, reason: string, plan?: { workspace: { name: string; root: string; createIfMissing: boolean }; provider: string; capabilities: string[] }) =>
    uiCall<{ proposal: WorkshopProposal }>('ui.workshop.review', { id, approve, reason, plan }),
  retry: (id: string) => uiCall<{ proposal: WorkshopProposal }>('ui.workshop.retry', { id }),
  taskStatus: (id: string) => uiCall<{ proposalId: string; status: string; task: Task | null }>('ui.workshop.task.status', { id }),
  deliver: (id: string, label: string, content: string, requestId: string) =>
    uiCall<{ proposal: WorkshopProposal; artifact: { id: string; label: string } }>('ui.workshop.deliver', { id, label, content, requestId, approve: true })
};
export const memoryClient = {
  overview: (query = '', scope = '', limit = 100, offset = 0, types?: string[]) =>
    uiCall<{ memories: Memory[]; total: number; candidates: MemoryCandidate[];
      candidateMeta?: { pending: number; capacity: number; remaining: number }; recovery?: { failed: { code: string }[] } }>('ui.memory.overview', { query, scope, limit, offset, types }),
  confirmCandidate: (id: string, decision: 'accept' | 'reject') =>
    uiCall<{ candidate: MemoryCandidate; memory: Memory | null }>('ui.memory.candidates.confirm', { id, decision }),
  confirmBatch: (ids: string[], decision: 'accept' | 'reject') =>
    uiCall<{ results: { id: string; error?: { code: string; message: string } }[] }>('ui.memory.candidates.confirmBatch', { ids, decision }),
  get: (id: string) => uiCall<Memory>('ui.memory.get', { id}),
  create: (input: { type: string; scope: string; content: string; tags?: string[]; pinned?: boolean }) => uiCall<Memory>('ui.memory.create', input),
  update: (input: { id: string; expectedRev?: number; content: string; tags?: string[]; pinned?: boolean }) => uiCall<Memory>('ui.memory.update', input),
  pin: (id: string, pinned: boolean, expectedRev?: number) => uiCall<Memory>('ui.memory.pin', { id, pinned, expectedRev }),
  remove: (id: string, expectedRev?: number) => uiCall<{ id: string; deleted: boolean }>('ui.memory.delete', { id, expectedRev })
};
export const agentClient = {
  security: (provider: string, workspaceId: string) => uiCall<{ required: boolean; authorized: boolean; fingerprint: string; disclosure: string }>('ui.agent.security', { provider, workspaceId }),
  authorize: (provider: string, workspaceId: string, fingerprint: string) => uiCall<{ status: string; approvalId: string }>('ui.agent.authorize', { provider, workspaceId, fingerprint }),
  list: () => uiCall<{ agents: Agent[] }>('ui.agent.list', {}),
  health: (provider: string, refresh = false) => uiCall<Agent>('ui.agent.health', { provider, refresh }),
  presets: (homeDir: string | null) => uiCall<DshPresetCatalog>('ui.agent.presets', { provider: 'dsh', homeDir }),
  configure: (config: DshSelection) => uiCall<{ provider: 'dsh'; supported: boolean; applied: false; restartRequired: boolean; configuration: DshConfiguration }>('ui.agent.configure', { agentId: 'dsh', config })
};
export const extensionSettingsClient = {
  describe: (id: string) => uiCall<ExtensionSettingsDescription>('ui.extensions.settings.describe', { id }),
  get: (id: string) => uiCall<ExtensionSettingsSnapshot>('ui.extensions.settings.get', { id }),
  update: (id: string, values: Record<string, string | number | boolean | null>) =>
    uiCall<ExtensionSettingsSnapshot>('ui.extensions.settings.update', { id, values })
};export const pluginClient = {
  catalog: (query = '', category = '', view = 'all') => uiCall<{ available: boolean; configured: boolean; offline: boolean; reason: string | null; plugins: Plugin[] }>('ui.plugins.catalog', { query, category, view }),
  status: () => uiCall<{ catalogAvailable: boolean; configured: boolean; offline: boolean; developerMode: boolean; plugins: Plugin[]; installed: Plugin[]; integrations: { id: string; name: string; status: string; enabled: boolean; available: boolean; eligible: boolean; configured: boolean; reason: string | null; lastError: string | null }[]; mcp: { id: string; name: string; status: string; enabled: boolean; running: boolean; available: boolean; toolCallable: boolean; eligible: boolean; configured: boolean; source: string; toolCount: number | null; discoveredToolCount: number; transport: string; reason: string | null; lastError: string | null }[] }>('ui.plugins.status', {}),
  detail: (id: string) => uiCall<{ available: boolean; offline: boolean; plugin: Plugin | null }>('ui.plugins.detail', { id }),
  refresh: () => uiCall<Record<string, unknown>>('ui.plugins.refresh', {}),
  stage: (id: string) => uiCall<{ stageId: string; plugin: Plugin; requiresReview: boolean; installable: boolean; permissions: string[]; summary: string[]; trust: string }>('ui.plugins.stage', { id }),
  stageLocal: (file: string) => uiCall<{ stageId: string; plugin: Plugin; requiresReview: boolean; installable: boolean; permissions: string[]; summary: string[]; trust: string }>('ui.plugins.stage-local', { file }),
  install: (stageId: string) => uiCall<{ installed: boolean; plugin: Plugin }>('ui.plugins.install', { stageId, reviewed: true }),
  reviewEnable: (id: string) => uiCall<{ id: string; stageId: string; requiresReview: boolean; installable: boolean; permissions: string[]; summary: string[]; trust: string }>('ui.plugins.enable.review', { id }),
  enable: (id: string, stageId = '') => uiCall<Record<string, unknown>>('ui.plugins.enable', { id, stageId, reviewed: true }),
  disable: (id: string) => uiCall<Record<string, unknown>>('ui.plugins.disable', { id }),
  uninstall: (id: string) => uiCall<Record<string, unknown>>('ui.plugins.uninstall', { id }),
  integrations: () => uiCall<{ integrations: { id: string; name: string; status: string; enabled: boolean; available: boolean; eligible: boolean; configured: boolean; reason: string | null; lastError: string | null }[] }>('ui.plugins.integration.list', {}),
  integrationSettings: (id: string) => uiCall<IntegrationSettings>('ui.plugins.integration.settings', { id }),
  manageIntegration: (id: string, action: 'enable' | 'disable') => uiCall<Record<string, unknown>>('ui.plugins.integration.manage', { id, action }),
  integrationAction: (localService: 'snowluma' | 'qq' | 'bionic', action: 'health' | 'detect' | 'start' | 'stop' | 'reconnect' | 'install' | 'configure', params: Record<string, unknown> = {}) => uiCall<Record<string, unknown>>('ui.plugins.integration.action', { localService, action, params }),
  toggleTool: (pluginId: string, toolId: string, enabled: boolean) => uiCall<Record<string, unknown>>('ui.plugins.integration.tool.toggle', { pluginId, toolId, enabled }),
  mcp: () => uiCall<{ servers: { id: string; name: string; status: string; enabled: boolean; running: boolean; available: boolean; toolCallable: boolean; eligible: boolean; configured: boolean; source: string; toolCount: number | null; discoveredToolCount: number; transport: string; reason: string | null; lastError: string | null }[] }>('ui.mcp.list', {}),
  mcpTools: (id: string) => uiCall<{ serverId: string; tools: { id: string; name: string; description: string; enabled: boolean; discovered: boolean; callable: boolean }[] }>('ui.mcp.tools', { id }),
  manageMcp: (serverId: string, action: 'enable' | 'disable' | 'start' | 'stop' | 'restart') => uiCall<Record<string, unknown>>('ui.mcp.manage', { serverId, action }),
  mcpConfig: (serverId: string) => uiCall<{ id: string; enabled: boolean; hasArgs: boolean; hasEnvironment: boolean; timeoutMs: number | null; note: string }>('ui.mcp.config.get', { serverId }),
  updateMcpConfig: (serverId: string, config: { timeoutMs?: number; note?: string }) => uiCall<{ id: string; updatedKeys: string[] }>('ui.mcp.config.update', { serverId, config })
};
export const settingsClient = {
  describe: () => uiCall<{ sections: { section: string; label: string }[]; fields: SettingSection[] }>('ui.settings.describe', {}),
  get: () => uiCall<{ settings: Settings; revision: number | null; recoveryRequired: boolean; lastError: string | null; backupPath: string | null }>('ui.settings.get', {}),
  update: (section: string, values: Record<string, unknown>, expectedRevision?: number | null) => uiCall<{ settings: Settings; revision: number | null }>('ui.settings.update', { section, values, expectedRevision })
};
export interface SettingField {
  key: string; label: string; type: string; description: string; default: string | number | boolean | null;
  choices: string[]; locked: boolean; min: number | null; max: number | null;
}
export interface SettingSection { section: string; label: string; fields: SettingField[] }
export const updateClient = {
  capabilities: () => uiCall<Record<string, unknown>>('ui.update.capabilities', {}),
  check: () => uiCall<Record<string, unknown>>('ui.update.check', {}),
  notes: () => uiCall<Record<string, unknown>>('ui.update.notes', {})
};
export const aboutClient = {
  info: () => uiCall<AboutView & { productName?: string; buildNumber?: number; channel?: string; commit?: string; platform?: string }>('ui.about.info', {}),
  update: () => uiCall<Record<string, unknown>>('ui.about.update', {})
};
export const feedbackClient = {
  links: () => uiCall<{ configured: boolean; entries: { id: string; label: string; description: string; kind: 'feedback' | 'security'; url: string | null }[]; securityNotice: string; message: string }>('ui.feedback.links', {})
};
export const workspaceClient = {
  list: () => uiCall<{ workspaces: { id: string; name: string; status: string; lastActivity: string | number | null }[]; activeId: string | null }>('ui.workspace.list', {}),
  open: (id: string) => uiCall<{ activeId: string | null; workspace: { id: string; name: string; status: string } }>('ui.workspace.open', { id }),
  create: (name: string, root: string) => uiCall<{ id: string; name: string; status: string }>('ui.workspace.create', { name, root })
};
export const approvalClient = {
  list: () => uiCall<{ approvals: Approval[]; operations: ApprovalDecisionResult[] }>('ui.approvals.list', {}),
  decide: (id: string, approve: boolean) => uiCall<ApprovalDecisionResult>('ui.approvals.decide', { id, approve }),
  operation: (id: string) => uiCall<ApprovalDecisionResult>('ui.approvals.operation', { id }),
  cancel: (id: string) => uiCall<ApprovalDecisionResult>('ui.approvals.cancel', { id })
};
export interface OnboardingStatus { complete: boolean; currentStep: string | null; steps: { id: string; title: string; description: string; status: string; optional: boolean }[] }
export const onboardingClient = {
  status: () => uiCall<OnboardingStatus>('ui.onboarding.status', {}),
  start: () => uiCall<OnboardingStatus>('ui.onboarding.start', {}),
  completeStep: (stepId: string, data: Record<string, unknown> = {}) => uiCall<unknown>('ui.onboarding.completeStep', { stepId, data }),
  skipStep: (stepId: string) => uiCall<unknown>('ui.onboarding.skipStep', { stepId }),
  finish: () => uiCall<unknown>('ui.onboarding.finish', {}),
  testProvider: (provider: string, apiKey: string, baseUrl = '', model = '') => uiCall<{ ok: boolean; provider: string; message?: string; code?: string; phase?: string; configured?: boolean | null; reachable?: boolean | null; authenticated?: boolean | null; inferencing?: boolean | null; connectionStepCompleted?: boolean }>('ui.onboarding.testProvider', { provider, apiKey, baseUrl, model }),
  setModel: (provider: string, model: string) => uiCall<Record<string, unknown>>('ui.onboarding.setModel', { provider, model })
};
export const searchClient = { search: (query: string) => uiCall<{ sessions: ChatSession[]; tasks: Task[]; plugins: Plugin[] }>('ui.search', { query }) };
export const hostClient = {
  status: () => bridge.invoke('app.status', {}),
  about: () => bridge.invoke('app.about', {}),
  openArtifact: (taskId: string, artifactId: string) => bridge.invoke('app.openArtifact', { taskId, artifactId }),
  pickFolder: () => bridge.invoke('app.pickFolder', {}),
  pickFiles: () => bridge.invoke('app.pickFiles', {}),
  pickExtensionPackage: () => bridge.invoke('app.pickExtensionPackage', {}),
  windowAction: (action: WindowAction) => bridge.invoke('app.windowAction', { action }),
  setWindowBehavior: (confirmOnExit: boolean) => bridge.invoke('app.setWindowBehavior', { confirmOnExit })
};
export async function openExternal(url: string): Promise<void> {
  if (url.startsWith('https://')) await bridge.invoke('app.openExternal', { url });
}

export type PreviewSource = { kind: 'message'; sessionId: string; messageId: string; href: string } | { kind: 'artifact'; taskId: string; artifactId: string };
export type PreviewBounds = { x: number; y: number; width: number; height: number; scale: number };
export type PreviewMetadata = { kind: 'web'; url: string; name: string } | { kind: 'unsupported'; name: string; message: string } | { kind: 'image' | 'code' | 'markdown' | 'text'; handle: string; name: string; mimeType: string; size: number; line: number | null };
export const previewClient = {
  open: (source: PreviewSource) => uiCall<PreviewMetadata>('ui.preview.open', { source }),
  read: (handle: string, offset: number) => uiCall<{ offset: number; nextOffset: number | null; encoding: 'base64'; data: string }>('ui.preview.read', { handle, offset }),
  close: (handle: string) => uiCall<{ closed: boolean }>('ui.preview.close', { handle }),
  browserOpen: (targetId: string, url: string, bounds: PreviewBounds) => bridge.invoke('app.previewBrowser.open', { targetId, url, bounds }),
  browserLayout: (targetId: string, bounds: PreviewBounds, visible: boolean) => bridge.invoke('app.previewBrowser.layout', { targetId, bounds, visible }),
  browserCommand: (targetId: string, action: 'back' | 'forward' | 'reload' | 'close') => bridge.invoke('app.previewBrowser.command', { targetId, action })
};

