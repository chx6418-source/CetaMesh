import type { AgentAuthStatus, AgentRuntimeProvider } from '../bridge/typed-client';
type Client = {
  authStart(provider: AgentRuntimeProvider, expectedRevision: number, methodId: string): Promise<AgentAuthStatus>;
  authStatus(provider: AgentRuntimeProvider, attemptId: string): Promise<AgentAuthStatus>;
  authCancel(provider: AgentRuntimeProvider, attemptId: string): Promise<AgentAuthStatus>;
};
/** Each mount owns one revision; close/navigation cannot adopt a late reply. */
export function createAuthPanelController({ provider, revision, client, onUpdate }: { provider: AgentRuntimeProvider; revision: number; client: Client; onUpdate(value: AgentAuthStatus): void }) {
  let closed = false, busy = false, generation = 0, attemptId: string | null = null;
  const active = (value: AgentAuthStatus) => ['starting', 'awaiting-user', 'exit-unconfirmed'].includes(value.state);
  const accept = (value: AgentAuthStatus) => { attemptId = active(value) ? value.attemptId : null; onUpdate(value); };
  const cancelAttempt = (id: string) => client.authCancel(provider, id);
  return {
    adopt(value: AgentAuthStatus) {
      if (closed || busy || generation !== 0 || attemptId || value.provider !== provider || value.revision !== revision) return false;
      if (active(value) && (typeof value.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.attemptId))) return false;
      ++generation; accept(value); return true;
    },
    async start(methodId: string) {
      if (closed || busy || attemptId) return;
      busy = true; const epoch = ++generation;
      try {
        const result = await client.authStart(provider, revision, methodId);
        if (closed || epoch !== generation) { if (result.attemptId) void cancelAttempt(result.attemptId).catch(() => {}); return; }
        accept(result);
      } finally { if (epoch === generation) busy = false; }
    },
    async status() {
      if (closed || !attemptId || busy) return;
      const id = attemptId, epoch = generation;
      const result = await client.authStatus(provider, id);
      if (!closed && epoch === generation && id === attemptId) {
        accept(result);
      }
    },
    async cancel() {
      if (closed) return;
      const id = attemptId; ++generation; busy = false;
      if (!id) return;
      const epoch = generation, result = await cancelAttempt(id);
      if (!closed && epoch === generation) { accept(result); }
    },
    dispose() { if (closed) return; closed = true; ++generation; if (attemptId) void cancelAttempt(attemptId).catch(() => {}); }
  };
}
