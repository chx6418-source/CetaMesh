import { OWNER_ACTOR, capabilityError } from '../capability/types.js';
import crypto from 'node:crypto';
import { rankTaskAgents } from '../router/agent-assignment.js';
import { isSafeAgentDispatchPreflight } from '../capability/service.js';

/** Smart decisions are consumed here; authority is always the trusted Desktop Owner. */
export function createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, continuityRuntime, modelRuntime, legacyModel, prepareTaskContext = null }) {
  async function selectProviders(record, task, decision) {
    const selected = record.config.agentProvider;
    if (selected === 'none' || decision.agentEnabled === false) {
      throw capabilityError('AGENT_DISABLED', 'Agent execution is disabled for this Chat');
    }
    const explicit = selected && selected !== 'none' ? selected : null;
    const pinned = explicit || task?.currentAgent?.provider;
    if (pinned) {
      const health = await agentBroker.health(pinned);
      if (pinned === 'codex' && health?.sandboxCapable === false) {
        throw capabilityError('CODEX_SANDBOX_UNAVAILABLE', 'Codex Windows sandbox refused the required Workspace boundary');
      }
      return rankTaskAgents({ agentBroker, workspaceId: task?.workspaceId || record.config.workspaceId,
        explicitProvider: pinned });
    }
    // The production assembly must prove Managed tool readiness. An unknown
    // paid tariff never silently authorizes an additional automatic Agent.
    let managedReady = false;
    if (modelRuntime) {
      try {
        const modelTools = modelRuntime.supportsToolCalling(record.config.modelProvider ?? null,
          record.config.model !== legacyModel ? record.config.model : null) === true;
        const modelHealth = await modelRuntime.health(record.config.modelProvider ?? modelRuntime.defaultProviderId?.());
        managedReady = modelTools && modelHealth?.configured === true && modelHealth?.available !== false;
      } catch { /* A missing or unhealthy Model Provider is not eligible for automatic task routing. */ }
    }
    const projectSignals = decision.signals?.project ?? [];
    const requiredTools = [...new Set([
      ...(projectSignals.includes('run-tests') ? ['test.run'] : []),
      ...(projectSignals.includes('git') ? ['git.status'] : [])
    ])];
    const difficulty = projectSignals.some(value => ['multi-file', 'refactor'].includes(value)) ? 3 : 2;
    const modelProvider = record.config.modelProvider;
    const model = record.config.model;
    if (!modelProvider || !model || model === legacyModel) {
      throw capabilityError('AGENT_PROVIDER_SELECTION_REQUIRED',
        'Automatic Agent assignment needs a concrete selected Model identity and verified cost');
    }
    const eligibleBroker = { ...agentBroker, ids: () => agentBroker.ids().filter(id => id !== 'cetamesh' || managedReady) };
    const candidates = await rankTaskAgents({ agentBroker: eligibleBroker,
      workspaceId: task?.workspaceId || record.config.workspaceId, taskKind: 'code', requiredTools, difficulty,
      modelProvider, model });
    if (!candidates.length) throw capabilityError('AGENT_PROVIDER_SELECTION_REQUIRED',
      'No verified tool-capable Agent has a known authorized cost for automatic Task execution');
    return candidates;
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
      if (task?.status === 'queued' && !task.currentAgent) {
        throw capabilityError('TASK_DISPATCH_INCOMPLETE',
          'An existing queued Task has no confirmed Agent; review its original Owner selection before dispatch');
      }
      const candidates = await selectProviders(record, task, decision);
      const provider = candidates[0].provider;
      let createdTask = false;
      if (!task) {
        const concurrent = taskRuntime.findByGoalWorkspace({ goal: text.slice(0, 2000), workspaceId });
        if (concurrent?.status === 'queued' && !concurrent.currentAgent) {
          throw capabilityError('TASK_DISPATCH_INCOMPLETE', 'Concurrent queued Task requires Owner review before dispatch');
        }
        task = concurrent ?? taskRuntime.create({ goal: text.slice(0, 2000), workspaceId,
          note: 'Smart Chat project task', requestId, requestedAgentProvider: record.config.agentProvider || null });
        record.taskId = task.id;
        createdTask = !concurrent;
      } else {
        record.taskId = task.id;
        if (['paused', 'blocked', 'waiting'].includes(task.status)) {
          throw capabilityError('TASK_RECOVERY_REVIEW_REQUIRED', '当前任务需要先恢复：请点“查看任务”，在任务详情的“人工核对后恢复”中填写核对结果和新的执行指令；不会自动重放旧操作。');
        }
      }
      if (signal?.aborted) {
        if (createdTask) {
          taskRuntime.cancel({ id: task.id, expectedRev: task.rev, reason: 'Chat request was deleted before Agent startup' });
        }
        throw Object.assign(new Error('Chat operation cancelled'), { code: 'ABORTED' });
      }
      const inheritedContext = typeof prepareTaskContext === 'function'
        ? await prepareTaskContext({ record, taskId: task.id,
          requireComplete: !task.currentAgent || task.currentAgent.provider !== provider }) : null;
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
        for (const [index, choice] of candidates.slice(0, 2).entries()) {
          if (signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Task dispatch was cancelled');
          try {
            // Recheck after selection and before the real Broker call. The
            // Broker repeats its own authority check at the send boundary.
            await rankTaskAgents({ agentBroker, workspaceId, explicitProvider: choice.provider });
            result = await capabilityService.broker.execute({
              requestId: index === 0 ? requestId : crypto.randomUUID(), actor: OWNER_ACTOR,
              taskId: task.id, workspaceId, capability: 'agent.run',
              input: { provider: choice.provider, content: dispatchText, modelProvider: record.config.modelProvider,
                model: record.config.model !== legacyModel ? record.config.model : undefined,
                reasoningEffort: record.config.reasoning,
                grants: { capabilities: ['filesystem.read', 'filesystem.write', 'filesystem.search',
                  'git.status', 'git.diff', 'memory.read', 'test.run', 'operation.read'] } },
              reason: index ? 'Smart project task safe reassignment after verified preflight failure' : 'Smart project task'
            }, { signal });
            if (result.status !== 'completed' || result.result?.accepted !== true) {
              throw capabilityError('AGENT_SEND_REJECTED', 'Agent dispatch did not confirm acceptance');
            }
            break;
          } catch (error) {
            const fresh = taskRuntime.get({ id: task.id }).task;
            const safe = !record.config.agentProvider && index === 0 && candidates.length > 1
              && isSafeAgentDispatchPreflight(error) && error.code === 'PROVIDER_UNAVAILABLE'
              && !signal?.aborted && fresh.status === 'queued' && !fresh.currentAgent
              && !(fresh.attempts ?? []).length && !(fresh.executionEvidence ?? []).length;
            if (!safe) throw error;
            taskRuntime.setProgress({ id: task.id, expectedRev: fresh.rev,
              note: `Verified preflight failure for ${choice.provider}; one safe reassignment to ${candidates[1].provider}` });
          }
        }
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

