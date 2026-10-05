import { OWNER_ACTOR, capabilityError } from '../capability/types.js';

/** Smart decisions are consumed here; authority is always the trusted Desktop Owner. */
export function createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, legacyModel }) {
  async function route({ decision, record, text }) {
    if (decision.agentIntent) {
      const workspaceId = record.config.workspaceId || (await workspaceService.execute({ method: 'workspace.list' })).activeId;
      if (!workspaceId) throw capabilityError('WORKSPACE_REQUIRED', '请先在 Workspaces 选择工作区，再启动项目任务');
      let task = null;
      if (record.taskId) {
        try { task = taskRuntime.get({ id: record.taskId }).task; } catch { /* stale task reference */ }
      }
      if (task && task.workspaceId !== workspaceId) task = null;
      if (task && ['completed', 'cancelled', 'failed'].includes(task.status)) task = null;
      if (!task) {
        task = taskRuntime.create({ goal: text.slice(0, 2000), workspaceId, note: 'Smart Chat project task' });
        record.taskId = task.id;
      }
      const provider = record.config.agentProvider && record.config.agentProvider !== 'none' ? record.config.agentProvider : 'cetamesh';
      const result = await capabilityService.broker.execute({ actor: OWNER_ACTOR, taskId: task.id, workspaceId,
        capability: 'agent.run', input: { provider, content: text, modelProvider: record.config.modelProvider,
          model: record.config.model !== legacyModel ? record.config.model : undefined, reasoningEffort: record.config.reasoning }, reason: 'Smart project task' });
      if (result.result.reused) {
        await agentBroker.send({ provider: result.result.provider, sessionId: result.result.sessionId, content: text });
      }
      return { kind: 'agent', ...result.result };
    }
    if (decision.capabilityIntent) {
      const signals = decision.signals?.tool ?? [];
      const capability = signals.includes('time') ? 'clock.now' : signals.includes('search') || signals.includes('weather') ? 'web.search' : null;
      if (!capability) return { kind: 'tool', capabilityResult: { status: 'denied', code: 'NO_SAFE_CAPABILITY_MAPPING', signals } };
      try {
        return { kind: 'tool', capabilityResult: await capabilityService.broker.execute({ actor: OWNER_ACTOR,
          capability, input: capability === 'web.search' ? { query: text } : {}, reason: 'Explicit Smart tool request' }) };
      } catch (error) {
        return { kind: 'tool', capabilityResult: { status: 'denied', capability, code: error.code ?? 'PROVIDER_UNAVAILABLE' } };
      }
    }
    return null;
  }
  return { route };
}
