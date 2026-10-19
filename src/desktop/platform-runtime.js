import { OWNER_ACTOR, capabilityError } from '../capability/types.js';

/** Smart decisions are consumed here; authority is always the trusted Desktop Owner. */
export function createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, continuityRuntime, modelRuntime, legacyModel, prepareTaskContext = null }) {
  async function selectProvider(record, task) {
    const selected = record.config.agentProvider;
    const explicit = selected && selected !== 'none' ? selected : null;
    if (!explicit && task?.currentAgent?.provider) return task.currentAgent.provider;
    const boundaryAllowed = id => ['capability-broker', 'staged-capability-broker']
      .includes(agentBroker.capabilities(id)?.workspaceBoundary);
    if (explicit) {
      if (!boundaryAllowed(explicit)) throw capabilityError('AGENT_BOUNDARY_UNSUPPORTED', 'Selected Agent has no verified Task Workspace boundary');
      if (typeof agentBroker.health === 'function') {
        const health = await agentBroker.health(explicit);
        if (health?.available === false || health?.authenticated === false || health?.sessionCapable === false) {
          throw capabilityError('PROVIDER_UNAVAILABLE', `Selected Agent ${explicit} is not installed, authenticated, or session-capable`);
        }
        if (explicit === 'codex' && health?.sandboxCapable === false) {
          throw capabilityError('CODEX_SANDBOX_UNAVAILABLE', 'Codex Windows sandbox refused the required Workspace boundary');
        }
      }
      return explicit;
    }
    // Legacy callers without a Model Runtime retain the existing Managed default;
    // the production assembly supplies one and must prove both tool and provider readiness.
    if (!modelRuntime || typeof agentBroker.health !== 'function') return 'cetamesh';
    const candidates = typeof agentBroker.ids === 'function' ? new Set(agentBroker.ids()) : new Set(['cetamesh']);
    if (candidates.has('cetamesh') && boundaryAllowed('cetamesh')) {
      try {
        const modelTools = modelRuntime.supportsToolCalling(record.config.modelProvider ?? null,
          record.config.model !== legacyModel ? record.config.model : null) === true;
        const [modelHealth, agentHealth] = await Promise.all([
          modelRuntime.health(record.config.modelProvider ?? modelRuntime.defaultProviderId?.()),
          agentBroker.health('cetamesh')
        ]);
        if (modelTools && modelHealth?.configured === true && modelHealth?.available !== false
          && agentHealth?.available === true && agentHealth?.sessionCapable !== false) return 'cetamesh';
      } catch { /* A missing or unhealthy Model Provider is not eligible for automatic task routing. */ }
    }
    for (const id of ['codex', 'dsh']) {
      if (!candidates.has(id) || !boundaryAllowed(id)) continue;
      let health;
      try { health = await agentBroker.health(id); }
      catch { continue; /* A failing health probe cannot authorize an automatic executor. */ }
      if (health?.available === true && health?.authenticated === true && health?.sessionCapable === true
        && (id === 'codex' ? health.sandboxCapable === true : health.toolsAvailable === true)) return id;
    }
    throw capabilityError('AGENT_PROVIDER_SELECTION_REQUIRED', 'No verified tool-capable Agent is ready for this Workspace; choose and configure an Agent in Settings');
  }
  async function cancelAgentAfterAbort(session) {
    try { await agentBroker.cancel(session); }
    catch (error) {
      if (error?.code !== 'SESSION_NOT_FOUND') throw error;
    }
  }

  async function route({ decision, record, text, requestId, signal }) {
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
      if (!task) task = taskRuntime.findByGoalWorkspace({ goal: text.slice(0, 2000), workspaceId });
      const provider = await selectProvider(record, task);
      let createdTask = false;
      if (!task) {
        const concurrent = taskRuntime.findByGoalWorkspace({ goal: text.slice(0, 2000), workspaceId });
        task = concurrent ?? taskRuntime.create({ goal: text.slice(0, 2000), workspaceId,
          note: 'Smart Chat project task', requestId, requestedAgentProvider: provider });
        record.taskId = task.id;
        createdTask = !concurrent;
      } else {
        record.taskId = task.id;
        if (['paused', 'blocked', 'waiting'].includes(task.status)) {
          throw capabilityError('TASK_RECOVERY_REVIEW_REQUIRED', 'Existing Task requires explicit recovery before new Agent instructions');
        }
      }
      if (signal?.aborted) {
        if (createdTask) {
          taskRuntime.cancel({ id: task.id, expectedRev: task.rev, reason: 'Chat request was deleted before Agent startup' });
        }
        throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
      }
      const inheritedContext = typeof prepareTaskContext === 'function'
        ? await prepareTaskContext({ record, taskId: task.id }) : null;
      const dispatchText = !task.currentAgent && inheritedContext
        ? inheritedContext + '\n[Current request]\n' + text : text;
      if (task.currentAgent && task.currentAgent.provider !== provider) {
        if (typeof continuityRuntime?.rollover !== 'function') {
          throw capabilityError('AGENT_PROVIDER_SWITCH_REQUIRES_CONTINUITY', 'Changing Agent Provider on an existing Task requires Continuity Fresh Session');
        }
        const rollover = await continuityRuntime.rollover({
          taskId: task.id,
          targetProvider: provider,
          reason: 'provider-switch'
        });
        const nextAgent = rollover?.to;
        if (!nextAgent?.sessionId || nextAgent.provider !== provider) {
          throw capabilityError('PROVIDER_ERROR', 'Continuity did not create the selected Agent Provider session');
        }
        if (signal?.aborted) {
          await cancelAgentAfterAbort({ provider, sessionId: nextAgent.sessionId });
          throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
        }
        const sent = await capabilityService.broker.execute({ requestId, actor: OWNER_ACTOR,
          taskId: task.id, workspaceId, capability: 'agent.run',
          input: { agentProvider: provider, content: text }, reason: 'Smart project task after Handoff' }, { signal });
        if (sent.status !== 'completed' || sent.result?.accepted !== true) {
          throw capabilityError('AGENT_SEND_REJECTED', 'Agent did not accept the new Task instruction');
        }
        if (signal?.aborted) {
          await cancelAgentAfterAbort({ provider, sessionId: nextAgent.sessionId });
          throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
        }
        return { kind: 'agent', taskId: task.id, workspaceId, provider, sessionId: nextAgent.sessionId,
          accepted: true, requestId: sent.result?.requestId ?? null, turnId: sent.result?.turnId ?? null,
          continued: true };
      }
      // Smart Project 的 test.run 语义（v2 final security）：
      //   Grant（此处显式传入，含 test.run）= Agent 可以"请求"测试；
      //   执行 = 仍需 Owner Approve Once（test.run risk=high → 审批必经）。
      // 流程：Agent request test.run → pending → Owner 批准/拒绝 → 执行一次 →
      // 结果经决策参考数据回到 Agent。绝不因 grant 静默自动执行。
      let result;
      try {
        result = await capabilityService.broker.execute({ requestId, actor: OWNER_ACTOR, taskId: task.id, workspaceId,
          capability: 'agent.run', input: { provider, content: dispatchText, modelProvider: record.config.modelProvider,
            model: record.config.model !== legacyModel ? record.config.model : undefined, reasoningEffort: record.config.reasoning,
            grants: { capabilities: ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'memory.read', 'test.run'] } },
          reason: 'Smart project task' }, { signal });
      } catch (error) {
        // Chat owns only a Task it created for this startup attempt. If that request
        // is cancelled before Agent assignment, retain the Task record but close its
        // queued lifecycle so it cannot appear runnable without an owning Chat.
        if (createdTask && signal?.aborted) {
          const current = taskRuntime.get({ id: task.id }).task;
          if (current.status === 'queued' && !current.currentAgent) {
            taskRuntime.cancel({ id: task.id, expectedRev: current.rev,
              reason: 'Chat request was cancelled during Agent startup' });
          }
        }
        throw error;
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
