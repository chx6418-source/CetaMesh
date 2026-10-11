import type { AboutView } from '../types/views';

type MethodMap = {
  'app.ping': { params: Record<string, never>; result: { host: 'webview2'; ready: boolean } };
  'app.status': { params: Record<string, never>; result: { ready: boolean; needsAttention: boolean } };
  'app.about': { params: Record<string, never>; result: AboutView };
  'app.openExternal': { params: { url: string }; result: { opened: boolean } };
};

export type BridgeMethod = keyof MethodMap;
export type BridgeEvent =
  | 'core.status' | 'chat.updated' | 'task.updated' | 'agent.updated'
  | 'plugin.updated' | 'approval.pending' | 'approval.resolved' | 'model.updated' | 'update.status';

type BridgeEventData = { ready?: boolean; needsAttention?: boolean; id?: string };
type BridgeResult = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: { code: string; message: string } };
type HostEvent = { event: BridgeEvent; data: BridgeEventData };

interface CetaMeshBridge {
  invoke<M extends BridgeMethod>(method: M, params: MethodMap[M]['params']): Promise<MethodMap[M]['result']>;
  subscribe(event: BridgeEvent, handler: (data: BridgeEventData) => void): () => void;
}

declare global {
  interface Window {
    ipc?: { postMessage(message: string): void };
    cetamesh: CetaMeshBridge;
    __cetameshReceive?: (reply: BridgeResult) => void;
    __cetameshEvent?: (event: HostEvent) => void;
  }
}

const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: number }>();
const listeners = new Map<BridgeEvent, Set<(data: BridgeEventData) => void>>();
let sequence = 0;

window.__cetameshReceive = (reply) => {
  const entry = pending.get(reply.id);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(reply.id);
  if (reply.ok) entry.resolve(reply.result);
  else entry.reject(new Error(reply.error.message));
};

window.__cetameshEvent = ({ event, data }) => {
  for (const handler of listeners.get(event) ?? []) handler(data);
};

export const bridge: CetaMeshBridge = Object.freeze({
  invoke<M extends BridgeMethod>(method: M, params: MethodMap[M]['params']): Promise<MethodMap[M]['result']> {
    if (!window.ipc) return Promise.reject(new Error('当前为浏览器设计预览，桌面宿主能力不可用。'));
    const id = `ui-${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        reject(new Error('桌面宿主响应超时。'));
      }, 12_000);
      pending.set(id, { resolve, reject, timer });
      window.ipc!.postMessage(JSON.stringify({ id, method, params }));
    });
  },
  subscribe(event: BridgeEvent, handler: (data: BridgeEventData) => void) {
    const group = listeners.get(event) ?? new Set();
    group.add(handler);
    listeners.set(event, group);
    return () => { group.delete(handler); if (!group.size) listeners.delete(event); };
  }
});

window.cetamesh = bridge;

export async function openExternal(url: string): Promise<void> {
  if (!url.startsWith('https://')) return;
  if (window.ipc) await bridge.invoke('app.openExternal', { url });
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export { chatClient, taskClient, memoryClient, agentClient, pluginClient, settingsClient, updateClient, aboutClient, workspaceClient, approvalClient, onboardingClient, searchClient, hostClient } from './typed-client';
