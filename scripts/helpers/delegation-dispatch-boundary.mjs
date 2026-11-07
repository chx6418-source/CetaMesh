import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTaskRuntime } from '../../src/task/runtime.js';
import { createWorkspaceService } from '../../src/workspace/index.js';
import { createMemoryService } from '../../src/memory/index.js';
import { createCapabilityService } from '../../src/capability/service.js';
import { createAgentBroker } from '../../src/agent/broker.js';
import { createAgentProviderRegistry } from '../../src/agent/registry.js';
import { defineAgentProvider } from '../../src/agent/agent-provider.js';
import { OWNER_ACTOR } from '../../src/capability/types.js';

// The protocol/status leaf is controlled; Task, Capability and the nested Agent
// Broker dispatch boundary are production code. No process/model/API is used.
export async function testDelegationDispatchBoundary() {
  for (const direction of ['outbound', 'verification']) {
    for (const control of ['expire', 'revoke', 'replace', 'continue', ...(direction === 'outbound' ? ['billing'] : [])]) {
      const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'cm-final-delegation-'));
      let clock = Date.now(), capability, taskId, executing, statuses = 0, sends = 0;
      let releaseStatus, enteredStatus;
      const held = new Promise(resolve => { releaseStatus = resolve; });
      const reached = new Promise(resolve => { enteredStatus = resolve; });
      let route = { mode: 'chatgpt-subscription', verified: true, source: 'codex-login-status', fingerprint: 'a'.repeat(64) };
      try {
        const project = path.join(root, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'proof.txt'), 'no effect');
        const stateDir = path.join(root, 'state');
        const workspaces = createWorkspaceService({ stateDir });
        const workspace = (await workspaces.execute({ method: 'workspace.create', params: { root: project, name: 'Final dispatch boundary' } })).workspace;
        const tasks = createTaskRuntime({ stateDir, now: () => clock });
        const target = direction === 'outbound' ? 'codex' : 'cetamesh';
        const security = () => ({ mode: 'native', nativeSandboxSupported: true, nativeApprovalSupported: true,
          nativeSandboxMode: 'fixture-only', billingRoute: route });
        const leaf = defineAgentProvider({ id: target, label: 'Controlled status boundary', eventProtocol: 'agent-turn-events-v1',
          capabilityExtras: { workspaceBoundary: 'native-staged' }, methods: {
            async health() { return { available: true, installed: true, compatible: true, authenticated: true, sessionCapable: true,
              toolsAvailable: true, sandboxCapable: true, billingRoute: route }; },
            async createSession() { return { sessionId: 'target-session' }; },
            async status() { if (++statuses === 2) { enteredStatus(); await held; } return { running: false, queued: 0, waitingForApproval: false }; },
            async send() { sends++; return { accepted: true, requestId: 'native-accepted' }; },
            async cancel() { return { cancelled: true }; }, async closeSession() { return { closed: true }; },
            async *follow({ signal }) { while (!signal.aborted) await delay(1); }
          } });
        const provider = { ...leaf, capabilities: () => ({ ...leaf.capabilities(), security: security() }) };
        const registry = createAgentProviderRegistry({ providers: [provider] });
        const broker = createAgentBroker({ registry, resolveWorkspaceIdentity: id => workspaces.describeWorkspace(id)?.root,
          resolveExecutionTask: id => tasks.get({ id }).task });
        capability = createCapabilityService({ stateDir, workspaceService: workspaces, taskRuntime: tasks, agentBroker: broker,
          memoryService: createMemoryService({ stateDir }), now: () => clock });
        const scope = broker.describeExecutionSecurity(target, workspace.id);
        const consent = await capability.broker.execute({ actor: OWNER_ACTOR, workspaceId: workspace.id,
          capability: 'agent.execution.authorize', input: { provider: target, fingerprint: scope.fingerprint }, reason: scope.disclosure.slice(0, 1000) });
        assert.equal(consent.status, 'pending');
        await capability.execute({ method: 'capability.approval.decide', params: { id: consent.approvalId, approve: true } });
        let task = tasks.create({ goal: 'Only dispatch under the exact current policy', workspaceId: workspace.id }); taskId = task.id;
        capability.grantTask(taskId);
        task = tasks.setDelegationPolicy({ id: taskId, expectedRev: task.rev, actor: OWNER_ACTOR,
          policy: { expiresAt: clock + 60000, maxDelegations: 1, allowUnknownCost: false, allowSubscriptionOnly: true } });
        task = tasks.start({ id: taskId, expectedRev: task.rev, provider: 'cetamesh', sessionId: 'source-session' }).task;
        tasks.beginExecutionObservation({ id: taskId, provider: 'cetamesh', sessionId: 'source-session', runId: 'source-run', phase: 'user' });
        tasks.recordDelegationProposal({ id: taskId, actor: capability.principalForTask(taskId), provider: 'cetamesh', sessionId: 'source-session',
          runId: 'source-run', requestId: 'proposal', intent: { taskKind: 'analysis', difficulty: 1, requiredTools: [], instruction: 'No effects outside the test.' } });
        tasks.observeExecution({ id: taskId, provider: 'cetamesh', sessionId: 'source-session', runId: 'source-run', phase: 'user', state: 'awaiting-review' });
        task = tasks.claimDelegationProposal({ id: taskId, requestId: 'proposal', selectedProvider: 'codex' });
        if (direction === 'verification') {
          task = tasks.attachAgent({ id: taskId, expectedRev: task.rev, provider: 'codex', sessionId: 'external-session' }).task;
          task = tasks.recordDelegationTarget({ id: taskId, requestId: 'proposal', selectedProvider: 'codex', sessionId: 'external-session' });
          tasks.beginExecutionObservation({ id: taskId, provider: 'codex', sessionId: 'external-session', runId: 'external-run', phase: 'user' });
          tasks.observeExecution({ id: taskId, provider: 'codex', sessionId: 'external-session', runId: 'external-run', phase: 'user', state: 'awaiting-review' });
          tasks.settleDelegationProposal({ id: taskId, requestId: 'proposal', state: 'awaiting-result' });
          task = tasks.claimDelegationReturn({ id: taskId, requestId: 'proposal', provider: 'codex', sessionId: 'external-session', runId: 'external-run' });
        }
        const session = await broker.createSession(target, { taskId, workspaceId: workspace.id });
        task = tasks.attachAgent({ id: taskId, expectedRev: tasks.get({ id: taskId }).task.rev, provider: target, sessionId: session.sessionId }).task;
        if (direction === 'outbound') tasks.recordDelegationTarget({ id: taskId, requestId: 'proposal', selectedProvider: target, sessionId: session.sessionId });
        else tasks.recordDelegationReturnTarget({ id: taskId, requestId: 'proposal', sessionId: session.sessionId });
        const before = tasks.get({ id: taskId }).task;
        const request = { requestId: 'final-dispatch', actor: OWNER_ACTOR, taskId, workspaceId: workspace.id,
          capability: 'agent.run', input: { agentProvider: target, content: before.goal, delegationRequestId: 'proposal', delegationDirection: direction } };
        executing = capability.broker.execute(request); executing.catch(() => {});
        await reached;
        assert.equal(statuses, 2, 'the held status belongs to the real Agent Broker after Capability preflight');
        assert.equal(sends, 0);
        if (control === 'expire') clock = before.delegationPolicy.expiresAt;
        if (control === 'revoke') tasks.revokeDelegationPolicy({ id: taskId, expectedRev: tasks.get({ id: taskId }).task.rev, actor: OWNER_ACTOR });
        if (control === 'replace') tasks.attachAgent({ id: taskId, expectedRev: tasks.get({ id: taskId }).task.rev, provider: target, sessionId: 'replacement-session' });
        if (control === 'billing') route = { ...route, fingerprint: 'b'.repeat(64) };
        releaseStatus();
        if (control === 'continue') {
          assert.equal((await executing).result.accepted, true); assert.equal(sends, 1);
          assert.equal((await capability.broker.execute(request)).result.accepted, true); assert.equal(sends, 1, 'an accepted request reuses its receipt rather than dispatching twice');
        } else {
          await assert.rejects(executing, error => ['DELEGATION_POLICY_DENIED', 'AGENT_ASSIGNMENT_EXPIRED', 'DELEGATION_BILLING_ROUTE_CHANGED', 'AGENT_SECURITY_CONFIRMATION_REQUIRED', 'AGENT_SECURITY_POLICY_CHANGED', 'TASK_NOT_AUTHORIZED', 'TASK_NOT_RUNNING'].includes(error.code), direction + ' ' + control);
          assert.equal(sends, 0, 'changed authority at the final status boundary must prevent actual native send');
          assert.deepEqual(tasks.get({ id: taskId }).task.executionObservation, before.executionObservation, 'a refused dispatch must not begin or replace a Task Run');
        }
        console.log('PASS actual Capability -> nested Broker final status: ' + direction + ' ' + control + ', sends=' + sends);
      } finally {
        releaseStatus(); await Promise.allSettled([executing]); await capability?.close();
        assert.equal(path.dirname(root), parent); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  }
}
