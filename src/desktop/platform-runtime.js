import { OWNER_ACTOR, capabilityError } from '../capability/types.js';

/** Smart decisions are consumed here; authority is always the trusted Desktop Owner. */
export function createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, continuityRuntime, legacyModel }) {
  async function cancelAgentAfterAbort(session) {
    try { await agentBroker.cancel(session); }
    catch (error) {
      if (error?.code !== 'SESSION_NOT_FOUND') throw error;
    }
  }

  async function route({ decision, record, text, signal }) {
    if (decision.agentIntent) {
      if (signal?.aborted) throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
      const workspaceId = record.config.workspaceId || (await workspaceService.execute({ method: 'workspace.list' })).activeId;
      if (!workspaceId) throw capabilityError('WORKSPACE_REQUIRED', '请先在 Workspaces 选择工作区，再启动项目任务');
      if (signal?.aborted) throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
      let task = null;
      if (record.taskId) {
        try { task = taskRuntime.get({ id: record.taskId }).task; }
        catch (error) {
          if (error?.code !== 'TASK_NOT_FOUND') throw error;
        }
      }
      if (task && task.workspaceId !== workspaceId) task = null;
      if (task && ['completed', 'cancelled', 'failed'].includes(task.status)) task = null;
      let createdTask = false;
      if (!task) {
        task = taskRuntime.create({ goal: text.slice(0, 2000), workspaceId, note: 'Smart Chat project task' });
        record.taskId = task.id;
        createdTask = true;
      }
      if (signal?.aborted) {
        if (createdTask) {
          taskRuntime.cancel({ id: task.id, expectedRev: task.rev, reason: 'Chat request was deleted before Agent startup' });
        }
        throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
      }
      const provider = record.config.agentProvider && record.config.agentProvider !== 'none' ? record.config.agentProvider : 'cetamesh';
      if (task.currentAgent && task.currentAgent.provider !== provider) {
        if (typeof continuityRuntime?.rollover !== 'function') {
          throw capabilityError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'Changing Agent Provider on an existing Task requires Continuity Fresh Session');
        }
        const rollover = await continuityRuntime.rollover({
          taskId: task.id,
          targetProvider: provider,
          reason: 'agent-provider-switch'
        });
        const nextAgent = rollover?.to;
        if (!nextAgent?.sessionId || nextAgent.provider !== provider) {
          throw capabilityError('PROVIDER_ERROR', 'Continuity did not create the selected Agent Provider session');
        }
        if (signal?.aborted) {
          await cancelAgentAfterAbort({ provider, sessionId: nextAgent.sessionId });
          throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
        }
        await agentBroker.send({ provider, sessionId: nextAgent.sessionId, content: text });
        if (signal?.aborted) {
          await cancelAgentAfterAbort({ provider, sessionId: nextAgent.sessionId });
          throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
        }
        return { kind: 'agent', taskId: task.id, workspaceId, provider, sessionId: nextAgent.sessionId, accepted: true, continued: true };
      }
      // Smart Project 的 test.run 语义（v2 final security）：
      //   Grant（此处显式传入，含 test.run）= Agent 可以"请求"测试；
      //   执行 = 仍需 Owner Approve Once（test.run risk=high → 审批必经）。
      // 流程：Agent request test.run → pending → Owner 批准/拒绝 → 执行一次 →
      // 结果经决策参考数据回到 Agent。绝不因 grant 静默自动执行。
      const result = await capabilityService.broker.execute({ actor: OWNER_ACTOR, taskId: task.id, workspaceId,
        capability: 'agent.run', input: { provider, content: text, modelProvider: record.config.modelProvider,
          model: record.config.model !== legacyModel ? record.config.model : undefined, reasoningEffort: record.config.reasoning,
          grants: { capabilities: ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'memory.read', 'test.run'] } },
        reason: 'Smart project task' }, { signal });
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
