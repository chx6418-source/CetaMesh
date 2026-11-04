import { explicitDelegationTarget } from './explicit-delegation.js';
import { OWNER_ACTOR, capabilityError } from '../capability/types.js';
import crypto from 'node:crypto';
import { rankTaskAgents } from '../router/agent-assignment.js';
import { isSafeAgentDispatchPreflight } from '../capability/service.js';
import { inspectTaskSession } from '../agent/session-recovery.js';

/** Owner application operations reuse the existing Task and execution authorities. */
export function createDesktopPlatformRuntime({ capabilityService, workspaceService, taskRuntime, agentBroker, continuityRuntime, toolExecutionCoordinator, modelRuntime, legacyModel, prepareTaskContext = null }) {
  async function stopTask(taskRow, { cancelMissingManagedSession = false } = {}) {
    if (taskRow.recoveryIntent) throw capabilityError('TASK_RECOVERY_REVIEW_REQUIRED', '上次核对尚未完整提交，请先在任务详情完成恢复核对');
    if (continuityRuntime?.isInFlight?.(taskRow.id)) {
      throw capabilityError('TASK_HANDOFF_IN_FLIGHT', '任务正在交接执行者，暂不能暂停或取消');
    }
    if (!taskRow.currentAgent) {
      const pending = capabilityService?.taskReviewState?.({ taskId: taskRow.id, workspaceId: taskRow.workspaceId });
      if (pending?.workspaceFences?.length) throw capabilityError('TASK_RECOVERY_REVIEW_REQUIRED', '新建会话仍有未确认归属，请先在任务详情核对后释放占用');
      return;
    }
    try {
      await agentBroker.cancel(taskRow.currentAgent);
      if (taskRow.currentAgent.provider === 'codex'
        && !(await inspectTaskSession(agentBroker, taskRow)).stopped) {
        throw capabilityError('SESSION_EXECUTION_UNCONFIRMED', '旧 Codex 执行尚未确认停止，请保留任务并核查恢复凭据');
      }
    } catch (error) {
      // Managed Sessions belong to this Core. A missing external Session or
      // transport alone never proves the persisted execution owner stopped.
      const provider = agentBroker.require?.(taskRow.currentAgent.provider);
      const unknownCodexTransport = taskRow.currentAgent.provider === 'codex'
        && error?.code === 'SESSION_TRANSPORT_UNKNOWN';
      if (!cancelMissingManagedSession || (error?.code !== 'SESSION_NOT_FOUND' && !unknownCodexTransport)) throw error;
      if (taskRow.currentAgent.provider === 'cetamesh') return;
      const recovery = capabilityService?.recoveryForTask;
      const approvals = capabilityService?.broker?.approvals;
      const toolRecovery = toolExecutionCoordinator?.recoveryForTask;
      if (typeof recovery !== 'function' || typeof approvals?.list !== 'function'
          || typeof toolRecovery !== 'function' || typeof provider?.verifyStoppedTask !== 'function'
          || recovery(taskRow.id) || toolRecovery(taskRow.id)
          || approvals.list().some(row => row.request?.taskId === taskRow.id)) throw error;
      const proof = await provider.verifyStoppedTask({ taskId: taskRow.id,
        workspaceId: taskRow.workspaceId, sessionId: taskRow.currentAgent.sessionId });
      if (proof?.stopped !== true || proof.taskId !== taskRow.id
          || proof.workspaceId !== taskRow.workspaceId || proof.provider !== taskRow.currentAgent.provider
          || proof.sessionId !== taskRow.currentAgent.sessionId) throw error;
    }
  }

  async function confirmStoppedReadChild(taskRow) {
    if (!taskRow.parentTaskId || taskRow.childContract?.mode !== 'read-only') return;
    if (taskRow.currentAgent) {
      try {
        const status = await agentBroker.status(taskRow.currentAgent);
        if (status?.running !== false || Number(status?.queued ?? 0) > 0 || status?.waitingForApproval) {
          throw capabilityError('INVOKE_CANCEL_UNCONFIRMED', 'Child Agent stop is not confirmed');
        }
      } catch (error) {
        if (!(taskRow.currentAgent.provider === 'cetamesh' && error?.code === 'SESSION_NOT_FOUND')) throw error;
      }
    }
    let current = (await taskRuntime.get({ id: taskRow.id })).task;
    for (const attempt of current.attempts ?? []) {
      if (!['started', 'accepted'].includes(attempt.state)) continue;
      current = taskRuntime.settleAttempt({ id: current.id, expectedRev: current.rev,
        requestId: attempt.requestId, state: 'unknown', reason: 'Owner confirmed stop; final turn effect was not observed' });
    }
  }

  async function pauseTask({ id, expectedRev, reason } = {}) {
    const preflight = (await taskRuntime.get({ id })).task;
    if (expectedRev !== undefined && preflight.rev !== expectedRev) throw capabilityError('TASK_CONFLICT', 'Task changed before pause');
    let fence = null;
    if (!preflight.parentTaskId) {
      const children = (await taskRuntime.listChildren({ parentTaskId: preflight.id })).children;
      if (children.some(child => !['completed', 'failed', 'cancelled'].includes(child.status))) {
        throw capabilityError('TASK_CHILD_ACTIVE', 'Stop and reconcile child Tasks before pausing the parent');
      }
      fence = (await taskRuntime.block({ id: preflight.id, expectedRev: preflight.rev,
        reason: 'Owner pause in progress; Agent stop must be confirmed' })).task;
      const afterFence = (await taskRuntime.listChildren({ parentTaskId: preflight.id })).children;
      if (afterFence.some(child => !['completed', 'failed', 'cancelled'].includes(child.status))) {
        throw capabilityError('TASK_CHILD_ACTIVE', 'A child started during pause preparation; parent remains blocked for review');
      }
    }
    const operations = await capabilityService?.cancelTaskOperations?.({ taskId: id });
    if (operations?.some(row => row.status === 'unknown')) throw capabilityError('INVOKE_CANCEL_UNCONFIRMED', '操作结果未知，需核验后暂停任务');
    const current = (await taskRuntime.get({ id })).task;
    if (current.rev !== (fence?.rev ?? preflight.rev)) throw capabilityError('TASK_CONFLICT', 'Task changed during pause');
    await stopTask(current);
    return taskRuntime.pause({ id: current.id, expectedRev: current.rev, reason });
  }

  async function cancelTask({ id, expectedRev, reason } = {}) {
    const first = (await taskRuntime.get({ id })).task;
    if (expectedRev !== undefined && first.rev !== expectedRev) throw capabilityError('TASK_CONFLICT', 'Task changed before cancellation');
    const children = !first.parentTaskId ? (await taskRuntime.listChildren({ parentTaskId: first.id })).children : [];
    if (children.some(child => !['completed', 'failed', 'cancelled'].includes(child.status))) {
      if (!['blocked', 'completed', 'failed', 'cancelled'].includes(first.status)) {
        await taskRuntime.block({ id: first.id, expectedRev: first.rev, reason: 'Owner cancelling child Tasks' });
      }
      for (const child of children) {
        if (['completed', 'failed', 'cancelled'].includes(child.status)) continue;
        const childOperations = await capabilityService?.cancelTaskOperations?.({ taskId: child.id });
        if (childOperations?.some(row => row.status === 'unknown')) throw capabilityError('INVOKE_CANCEL_UNCONFIRMED', 'Child effect requires review before parent cancellation');
        const currentChild = (await taskRuntime.get({ id: child.id })).task;
        await stopTask(currentChild, { cancelMissingManagedSession: true });
        await confirmStoppedReadChild(currentChild);
        const settledChild = (await taskRuntime.get({ id: child.id })).task;
        await taskRuntime.cancel({ id: settledChild.id, expectedRev: settledChild.rev, reason: 'Parent cancelled by Owner' });
      }
    }
    const stoppedOperations = await capabilityService?.cancelTaskOperations?.({ taskId: id });
    if (stoppedOperations?.some(row => row.status === 'unknown')) throw capabilityError('INVOKE_CANCEL_UNCONFIRMED', '操作结果未知，需核验后取消任务');
    const current = (await taskRuntime.get({ id })).task;
    await stopTask(current, { cancelMissingManagedSession: true });
    await confirmStoppedReadChild(current);
    const settled = (await taskRuntime.get({ id: current.id })).task;
    return taskRuntime.cancel({ id: settled.id, expectedRev: settled.rev, reason });
  }

  async function selectProviders(record, task, decision, requested = null) {
    const selected = record.config.agentProvider;
    if (selected === 'none' || decision.agentEnabled === false) {
      throw capabilityError('AGENT_DISABLED', 'Agent execution is disabled for this Chat');
    }
    if (requested && selected && requested !== selected) throw capabilityError('AGENT_SELECTION_CONFLICT', '请求的执行者与会话选择不同，请确认执行者后重试');
    const explicit = requested || (selected && selected !== 'none' ? selected : null);
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

  async function route({ decision, record, text, sourceText, requestId, signal,attachmentManifest=[] }) {
    // This observation describes this request only. It never grants retry or
    // releases an earlier Task's execution/unknown-effect fence.
    let executionEntered = false;
    let handoffEntered = false;
    try {
    const requested = explicitDelegationTarget(sourceText ?? text);
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
      const candidates = await selectProviders(record, task, decision, requested);
      const provider = candidates[0].provider;
      // Only the local Chat service supplies this normalized manifest. It contains
      // references, never file bytes; the reader rechecks the committed Session/Task.
      const attachedText=attachmentManifest.some(r=>r.kind==='text'&&r.scope?.sessionId===record.id&&r.scope?.workspaceId===workspaceId);
      if(attachmentManifest.length&&provider!=='cetamesh')throw capabilityError('ATTACHMENT_AGENT_UNSUPPORTED','当前外部 Agent 没有受控附件读取桥；请先申请将项目ZIP导入Workspace，或使用CetaMesh分析附件');
      let createdTask = false;
      if (!task) {
        const concurrent = taskRuntime.findByGoalWorkspace({ goal: text.slice(0, 2000), workspaceId });
        if (concurrent?.status === 'queued' && !concurrent.currentAgent) {
          throw capabilityError('TASK_DISPATCH_INCOMPLETE', 'Concurrent queued Task requires Owner review before dispatch');
        }
        task = concurrent ?? taskRuntime.create({ goal: text.slice(0, 2000), workspaceId,
          note: 'Smart Chat project task', requestId, requestedAgentProvider: requested || record.config.agentProvider || null });
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
        executionEntered = true;
        handoffEntered = true;
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
      let dispatchBegun = false;
      try {
        for (const [index, choice] of candidates.slice(0, 2).entries()) {
          if (signal?.aborted) throw capabilityError('INVOKE_CANCELLED', 'Task dispatch was cancelled');
          try {
            // Recheck after selection and before the real Broker call. The
            // Broker repeats its own authority check at the send boundary.
            if (!requested && !record.config.agentProvider && !task.currentAgent) {
              // An automatic selection remains automatic at the dispatch boundary:
              // never apply the weaker explicit Owner-selection exception here.
              const currentCandidates = await selectProviders(record, task, decision);
              if (!currentCandidates.some(candidate => candidate.provider === choice.provider)) {
                throw capabilityError('AGENT_PROVIDER_SELECTION_REQUIRED', 'Automatic Agent eligibility changed before dispatch');
              }
            } else {
              await rankTaskAgents({ agentBroker, workspaceId, explicitProvider: choice.provider });
            }
            dispatchBegun = true;
            executionEntered = true;
            result = await capabilityService.broker.execute({
              requestId: index === 0 ? requestId : crypto.randomUUID(), actor: OWNER_ACTOR,
              taskId: task.id, workspaceId, capability: 'agent.run',
              input: { provider: choice.provider, content: dispatchText,
                // Managed Chat settings are not native Agent model authorization.
                ...(choice.provider === 'cetamesh' || record.config.agentProvider === choice.provider ? { modelProvider: record.config.modelProvider,
                  model: record.config.model !== legacyModel ? record.config.model : undefined,
                  reasoningEffort: record.config.reasoning } : {}),
                grants: { capabilities: ['filesystem.read', 'filesystem.write', 'filesystem.search',
                  'git.status', 'git.diff', 'memory.read', 'test.run', 'operation.read', 'operation.continue',...(attachedText?['attachment.read']:[])] } },
              reason: index ? 'Smart project task safe reassignment after verified preflight failure' : 'Smart project task'
            }, { signal });
            if (result.status !== 'completed' || result.result?.accepted !== true) {
              throw capabilityError('AGENT_SEND_REJECTED', 'Agent dispatch did not confirm acceptance');
            }
            break;
          } catch (error) {
            const fresh = taskRuntime.get({ id: task.id }).task;
            const safe = !requested && !record.config.agentProvider && index === 0 && candidates.length > 1
              && isSafeAgentDispatchPreflight(error) && error.code === 'PROVIDER_UNAVAILABLE'
              && !signal?.aborted && fresh.status === 'queued' && !fresh.currentAgent
              && !(fresh.attempts ?? []).length && !(fresh.executionEvidence ?? []).length;
            if (!safe) throw error;
            dispatchBegun = false; // trusted preflight confirms no Agent side effect
            executionEntered = false;
            taskRuntime.setProgress({ id: task.id, expectedRev: fresh.rev,
              note: `Verified preflight failure for ${choice.provider}; one safe reassignment to ${candidates[1].provider}` });
          }
        }
      } catch (error) {
        if (createdTask && !dispatchBegun && error.code === 'AGENT_PROVIDER_SELECTION_REQUIRED') {
          const current = taskRuntime.get({ id: task.id }).task;
          if (current.status === 'queued' && !current.currentAgent
            && !(current.attempts ?? []).length && !(current.executionEvidence ?? []).length) {
            taskRuntime.fail({ id: task.id, expectedRev: current.rev,
              reason: 'Automatic Agent eligibility changed before dispatch; no Agent was started' });
          }
        }
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
        executionEntered = true;
        return { kind: 'tool', capabilityResult: await capabilityService.broker.execute({ actor: OWNER_ACTOR,
          capability, input: capability === 'web.search' ? { query: text } : {}, reason: 'Explicit Smart tool request' }) };
      } catch (error) {
        return { kind: 'tool', capabilityResult: { status: 'denied', capability, code: error.code ?? 'PROVIDER_UNAVAILABLE' } };
      }
    }
    return null;
    } catch (error) {
      if (error && typeof error === 'object') {
        error.failureStage = !executionEntered || (!handoffEntered && isSafeAgentDispatchPreflight(error)) ? 'pre-dispatch' : 'unknown';
      }
      throw error;
    }
  }
  return { route, pauseTask, cancelTask };
}

