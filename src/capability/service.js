import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInside, canonicalizeRoot, assertSafeRootForm } from '../workspace/boundary.js';
import { safeFetch } from '../safe-fetch.js';
import { createCapabilityBroker } from './broker.js';
import { createCapabilityPolicy } from './policy.js';
import { createCapabilityApproval, requestFingerprint } from './approval.js';
import { OWNER_ACTOR, capabilityError } from './types.js';

export const WORKSPACE_CAPABILITIES = Object.freeze({
  'workspace.read': 'filesystem.read', 'workspace.write': 'filesystem.write',
  'workspace.file.search': 'filesystem.search', 'workspace.git.status': 'git.status',
  'workspace.git.diff': 'git.diff', 'workspace.git.commit': 'git.commit',
  'workspace.test.run': 'test.run', 'workspace.create': 'workspace.create'
});

const stringField = description => ({ type: 'string', description });
const objectInput = (properties = {}, required = []) => ({
  type: 'object', properties, required, additionalProperties: false
});
const WORKSPACE_TOOL_DESCRIPTORS = Object.freeze({
  'filesystem.read': ['Read a file inside the authorized Workspace.', objectInput({ path: stringField('Workspace-relative file path.'), maxChars: { type: 'integer', minimum: 1, maximum: 50000 } }, ['path'])],
  'filesystem.write': ['Write text to a file inside the authorized Workspace. Owner approval is required.', objectInput({ path: stringField('Workspace-relative file path.'), content: stringField('Text to write.'), append: { type: 'boolean' } }, ['path', 'content'])],
  'filesystem.search': ['Search file names or contents inside the authorized Workspace.', objectInput({ query: stringField('Search text or file-name query.'), path: stringField('Optional Workspace-relative directory.'), maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, ['query'])],
  'git.status': ['Read the current Git status for the authorized Workspace.', objectInput()],
  'git.diff': ['Read a bounded Git diff summary inside the authorized Workspace.', objectInput({ path: stringField('Optional Workspace-relative file path.'), statOnly: { type: 'boolean' } })],
  'git.commit': ['Create a Git commit in the authorized Workspace.', objectInput({ message: stringField('Commit message.') }, ['message'])],
  'test.run': ['Run an allowlisted test command in the authorized Workspace. Owner approval is required.', objectInput({ tool: stringField('Allowlisted test tool.'), args: { type: 'array', items: { type: 'string' }, maxItems: 40 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 } }, ['tool', 'args'])],
  'workspace.create': ['Register an explicitly selected local Workspace root. Owner approval is required.', objectInput({ root: stringField('Local directory selected by the Owner.'), name: stringField('Optional Workspace display name.') }, ['root'])]
});

/** Trusted in-process API. Public transports must use execute/executeWorkspace,
 * which bind the Owner identity; Agent/Extension grants never come from IPC. */
export function createCapabilityService({ stateDir, workspaceService, memoryService,
  taskRuntime, agentBroker, bindAgentSession, resumeAgentApproval = null, searchImpl = null, audit = () => {}, now,
  isolatedRunner = null } = {}) {
  const file = stateDir ? path.join(stateDir, 'capability', 'task-grants.json') : null;
  let grants = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const provisioning = new Map();
  let approvalDecisionListener = null;
  const journalFile = stateDir ? path.join(stateDir, 'capability', 'requests.json') : null;
  const journal = journalFile && fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
  const requests = new Map();
  function saveJournal() {
    if (!journalFile) return;
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    const temp = journalFile + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
    fs.renameSync(temp, journalFile);
  }
  async function idempotent(request, run) {
    const hash = requestFingerprint(request), old = journal[request.requestId];
    if (old && old.hash !== hash) throw capabilityError('REQUEST_ID_CONFLICT', 'Request ID reused with different data');
    if (old?.status === 'completed') return structuredClone(old.result);
    if (requests.has(request.requestId)) return requests.get(request.requestId);
    journal[request.requestId] = { hash, status: 'in-flight' }; saveJournal();
    const pending = Promise.resolve().then(run);
    requests.set(request.requestId, pending);
    try { const result = await pending; journal[request.requestId] = { hash, status: 'completed', result }; saveJournal(); return result; }
    catch (error) { journal[request.requestId] = { hash, status: 'failed', code: error.code }; saveJournal(); throw error; }
    finally { requests.delete(request.requestId); }
  }
  const taskFor = id => { try { return taskRuntime?.get({ id }).task ?? null; } catch { return null; } };
  const resolveWorkspace = id => workspaceService?.describeWorkspace(id);
  const broker = createCapabilityBroker({
    policy: createCapabilityPolicy({ resolveWorkspace, resolveTask: taskFor }),
    approval: createCapabilityApproval({ stateDir, now }), audit
  });
  function saveGrants() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(grants, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function grantTask(taskId, value) {
    const task = taskFor(taskId);
    if (!task?.workspaceId) throw capabilityError('WORKSPACE_REQUIRED', 'Task workspace required');
    // 默认 Agent 能力集（v2 final security）：**不含 test.run**。
    // Agent 可以默认修改 Workspace ≠ Agent 可以默认执行 Workspace 代码——
    // test.run 执行的是 Agent 可经 filesystem.write 修改的项目代码（package.json
    // 脚本 / 测试 / 构建脚本），allowlist 只防命令注入、防不了项目代码本身。
    // 需要 test.run 的任务必须显式传入（Workshop Owner 勾选 / Smart 路径显式
    // request-only grant），且每一次执行仍需 Owner Approve Once（risk=high）。
    const capabilities = value?.capabilities ?? ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'memory.read'];
    for (const id of capabilities) broker.registry.require(id);
    if ((value?.workspaceIds ?? [task.workspaceId]).some(id => id !== task.workspaceId)) {
      throw capabilityError('WORKSPACE_NOT_AUTHORIZED', 'A Task grant cannot include another workspace');
    }
    grants[taskId] = { capabilities: [...new Set(capabilities)], workspaceIds: [task.workspaceId], taskIds: [taskId],
      scopes: [`task:${taskId}`, `workspace:${task.workspaceId}`], types: ['working', 'task', 'workspace', 'knowledge', 'skill'] };
    saveGrants();
    return principalForTask(taskId);
  }
  function refreshTaskWorkspaceGrant(taskId) {
    const task = taskFor(taskId);
    if (!task?.workspaceId) throw capabilityError('WORKSPACE_REQUIRED', 'Task workspace required');
    if (!grants[taskId]) return { refreshed: false, actor: null };
    grants[taskId].workspaceIds = [task.workspaceId];
    grants[taskId].taskIds = [taskId];
    grants[taskId].scopes = [...new Set([...(grants[taskId].scopes ?? []).filter(scope => !String(scope).startsWith('workspace:')), `workspace:${task.workspaceId}`])];
    saveGrants();
    return { refreshed: true, actor: principalForTask(taskId) };
  }
  function principalForTask(taskId) {
    if (!grants[taskId] || !taskFor(taskId)) throw capabilityError('TASK_NOT_AUTHORIZED', taskId);
    return { kind: 'agent', id: `task:${taskId}`, grants: structuredClone(grants[taskId]) };
  }
  function memoryPrincipal(actor) {
    return actor.kind === 'owner' ? { kind: 'user', id: actor.id }
      : { kind: 'agent', id: actor.id, grants: { scopes: actor.grants?.scopes ?? [], types: actor.grants?.types } };
  }
  if (workspaceService) {
    for (const [method, id] of Object.entries(WORKSPACE_CAPABILITIES)) {
      broker.register({ id, permission: id, provider: 'workspace', workspace: id !== 'workspace.create',
        description: WORKSPACE_TOOL_DESCRIPTORS[id][0],
        inputSchema: WORKSPACE_TOOL_DESCRIPTORS[id][1],
        category: id.startsWith('filesystem.') ? 'filesystem' : id.startsWith('git.') ? 'git' : 'workspace',
        // test.run = 执行 Workspace 中可被 Agent 修改的代码：high（审批必经），
        // 不是普通 medium。Owner 直接点击"运行测试"走 executeWorkspace 的
        // approved:true（Owner 的点击本身就是显式决定，语义与既往一致）。
        risk: ['workspace.create', 'git.commit', 'test.run'].includes(id) ? 'high' : id === 'filesystem.write' ? 'medium' : 'low',
        validate(request) {
          if (id === 'workspace.create') {
            assertSafeRootForm(request.input.root);
            if (fs.existsSync(request.input.root)) canonicalizeRoot(request.input.root);
            return;
          }
          if (id === 'test.run' && request.actor.kind !== 'owner') {
            // v2 final security：Agent test.run = 三层同时满足——
            //   1) Agent Grant 含 test.run（= 可以"请求"，不等于可以执行）；
            //   2) Capability Permission（policy.authorize）；
            //   3) Owner Approve Once（risk=high → 审批必经，见 broker policy）。
            // 缺第一层 → PERMISSION_DENIED；缺第三层 → pending 待 Owner 决定。
            // grant 含 test.run 绝不会被解释为"无需审批"。
            if (!isolatedRunner) {
              throw capabilityError('TEST_SANDBOX_UNAVAILABLE', 'Controlled test runner unavailable; Agent test execution stays denied');
            }
            if (typeof request.input?.tool !== 'string' || !Array.isArray(request.input?.args)) {
              throw capabilityError('INVALID_PARAMS', 'test.run 需要 { tool, args }（allowlist 形态）');
            }
          }
          if (id === 'filesystem.read' || id === 'filesystem.write') {
            const ws = resolveWorkspace(request.workspaceId);
            if (request.actor.kind !== 'owner') {
              const segments = path.relative(ws.root, path.resolve(ws.root, String(request.input.path ?? ''))).split(/[\\/]/);
              if (segments.some(s => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(s))) {
                throw capabilityError('SENSITIVE_RESOURCE_DENIED', 'Repository controls and credentials require Owner access');
              }
            }
            try {
              const resolved = resolveInside(ws.root, request.input.path, { forWrite: id === 'filesystem.write' });
              if (request.actor.kind !== 'owner' && path.relative(ws.root, resolved.real).split(/[\\/]/)
                .some(s => /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(s))) {
                throw capabilityError('SENSITIVE_RESOURCE_DENIED', 'Resolved target is a protected resource');
              }
              if (request.actor.kind === 'extension') {
                const scoped = request.actor.grants.paths.some(rel => {
                  const allowed = resolveInside(ws.root, rel, { forWrite: true }).real;
                  return resolved.real === allowed || resolved.real.startsWith(allowed + path.sep);
                });
                if (!scoped) throw capabilityError('FILESYSTEM_SCOPE_DENIED', 'Real path escapes Extension declared scope');
              }
            }
            catch (error) { if (/OUTSIDE|ESCAPE|ABSOLUTE|TRAVERSAL|INVALID_PATH/.test(error.code ?? '')) throw capabilityError('PATH_OUTSIDE_WORKSPACE', error.message); throw error; }
          }
        },
        execute: request => {
          const run = async () => {
            if (id === 'workspace.create' && journal[request.requestId]) {
              const list = await workspaceService.execute({ method: 'workspace.list' });
              const existing = list.workspaces.find(ws => path.resolve(ws.root) === path.resolve(request.input.root));
              if (existing) return { workspace: existing, recovered: true };
            }
            if (id === 'test.run' && request.actor.kind !== 'owner') {
              // Agent 的 test.run 走 Controlled Test Runner（命令 allowlist，绝不执行
              // Owner 的 testCommand 字符串，也绝不接受调用方 shell）。
              // 到达这里意味着 Owner 已经 Approve Once（risk=high 审批已消费）。
              return isolatedRunner.run({ workspaceId: request.workspaceId,
                tool: request.input.tool, args: request.input.args, timeoutMs: request.input.timeoutMs });
            }
            return workspaceService.execute({ method, params: { ...request.input,
              ...(id === 'git.diff' ? { excludeSensitive: request.actor.kind !== 'owner' } : {}),
              ...(request.workspaceId ? { id: request.workspaceId } : {}), actor: request.actor.id } });
          };
          return id === 'workspace.create' ? idempotent(request, run) : run();
        }
      });
    }
  }
  if (taskRuntime) {
    broker.register({
      id: 'task.create',
      permission: 'task.create',
      provider: 'task-runtime',
      risk: 'medium',
      description: 'Create a CetaMesh Task bound to the current authorized Workspace.',
      inputSchema: objectInput({
        goal: stringField('Task outcome to achieve.'),
        requirements: { type: 'array', items: stringField('Task requirement.'), maxItems: 50 },
        acceptanceCriteria: { type: 'array', items: stringField('Verifiable completion criterion.'), maxItems: 50 },
        note: stringField('Short initial Task note.')
      }, ['goal']),
      validate(request) {
        if (request.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may create a Task from Chat');
        if (request.workspaceId && !resolveWorkspace(request.workspaceId)) throw capabilityError('WORKSPACE_NOT_FOUND', request.workspaceId);
      },
      execute(request) {
        const task = taskRuntime.create({
          goal: request.input.goal,
          requirements: request.input.requirements,
          acceptanceCriteria: request.input.acceptanceCriteria,
          note: request.input.note,
          workspaceId: request.workspaceId ?? null
        });
        return { task: { id: task.id, goal: task.goal, status: task.status, workspaceId: task.workspaceId } };
      }
    });
  }
  if (memoryService) {
    for (const action of ['read', 'write', 'link']) {
      broker.register({ id: 'memory.desktop.' + action, permission: 'memory.' + action,
        provider: 'memory', risk: 'low', modelCallable: false, execute: r => {
          if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Owner administration only');
          return memoryService.execute(r.input);
        }});
    }
    broker.register({ id: 'memory.read', permission: 'memory.read', provider: 'memory', requiresTask: true, risk: 'low',
      description: 'Search or read Memory only within the current authorized Task scope.',
      inputSchema: objectInput({ id: stringField('Optional Memory record id.'), query: stringField('Search query within the current Task scope.'), limit: { type: 'integer', minimum: 1, maximum: 20 } }),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      const input = { ...r.input, ...(r.taskId ? { scope: 'task:' + r.taskId } : {}), principal };
      return input.id ? memoryService.runtime.get(input) : memoryService.runtime.search(input);
    }});
    broker.register({ id: 'memory.write', permission: 'memory.write', provider: 'memory', requiresTask: true, risk: 'medium',
      description: 'Write or propose a Memory item within the current authorized scope.',
      inputSchema: objectInput({ title: stringField('Memory title.'), content: stringField('Memory content.'), type: stringField('Memory type.') }, ['title', 'content']),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      const input = { ...r.input, ...(['owner', 'agent'].includes(r.actor.kind) ? { scope: `task:${r.taskId}` } : {}) };
      if (r.actor.kind !== 'owner' && input.type !== 'working') return memoryService.runtime.proposeCandidate({ ...input, principal });
      return memoryService.runtime.create({ ...input, principal });
    }});
    broker.register({ id: 'memory.link', permission: 'memory.link', provider: 'memory', requiresTask: true, risk: 'medium',
      description: 'Build a bounded Memory reference package from the current authorized Task scope.',
      inputSchema: objectInput({ query: stringField('Reference query within the current Task scope.') }, ['query']),
      validate: r => { if (['owner', 'agent'].includes(r.actor.kind) && !r.taskId) throw capabilityError('TASK_REQUIRED', 'Memory model tools require a CetaMesh Task scope'); },
      execute: r => {
      const principal = memoryPrincipal(r.actor);
      return memoryService.runtime.buildContextPackage({ ...r.input,
        ...(['owner', 'agent'].includes(r.actor.kind) ? { scope: `task:${r.taskId}` } : {}), principal });
    }});
  }
  broker.register({ id: 'network', permission: 'network', provider: 'safe-fetch', risk: 'high', modelCallable: false,
    validate: r => {
      if (r.input.init?.method && r.input.init.method.toUpperCase() !== 'GET' || r.input.init?.body !== undefined) {
        throw capabilityError('NETWORK_OPERATION_DENIED', 'Only read-only GET is implemented');
      }
    },
    execute: r => safeFetch(String(r.input.url), Math.min(50000, Number(r.input.maxChars) || 50000), {
      authorizeUrl: url => {
        if (r.actor.kind === 'extension' && !r.actor.grants.hosts.includes(url.host)) {
          throw capabilityError('NETWORK_SCOPE_DENIED', 'Redirect host not declared');
        }
      }
    }) });
  broker.register({ id: 'web.search', permission: 'web.search', provider: 'mcp-adapter', risk: 'medium',
    available: typeof searchImpl === 'function',
    description: 'Search the public web through the configured safe-search adapter.',
    inputSchema: objectInput({ query: stringField('Public web search query.') }, ['query']),
    execute: r => {
      if (!searchImpl) throw capabilityError('PROVIDER_UNAVAILABLE', 'Web search adapter is not connected');
      return searchImpl(String(r.input.query ?? ''));
    } });
  broker.register({ id: 'clock.now', permission: 'log', provider: 'desktop', risk: 'low',
    description: 'Return the current local time and timezone.',
    inputSchema: objectInput(),
    execute: () => ({ iso: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  broker.register({ id: 'agent.run', permission: 'agent.run', provider: 'agent-broker', workspace: true, requiresTask: true, risk: 'medium',
    available: Boolean(agentBroker?.ids?.().length),
    description: 'Assign the current CetaMesh Task to a registered Agent Provider.',
    inputSchema: objectInput({
      agentProvider: stringField('Registered Agent Provider id.'),
      content: stringField('Task instructions for the Agent.'),
      modelProvider: stringField('Optional Model Provider id.'),
      model: stringField('Optional Model id.'),
      reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
    }),
    async execute(r) {
      if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may assign Agents');
      let task = taskFor(r.taskId);
      if (!task || task.workspaceId !== r.workspaceId) throw capabilityError('TASK_NOT_AUTHORIZED', 'Task workspace required');
      const provider = String(r.input.agentProvider || r.input.provider || 'cetamesh');
      if (agentBroker?.capabilities(provider)?.workspaceBoundary !== 'capability-broker') {
        throw capabilityError('AGENT_BOUNDARY_UNSUPPORTED', 'Provider has no enforced Capability Broker workspace boundary');
      }
      if (provisioning.has(task.id)) return provisioning.get(task.id);
      const pending = (async () => {
        const actor = grants[task.id] ? principalForTask(task.id) : grantTask(task.id, r.input.grants);
        if (task.currentAgent) {
          try {
            await agentBroker.status(task.currentAgent);
            return { taskId: task.id, ...task.currentAgent, reused: true, actor };
          } catch (error) {
            if (error.code !== 'SESSION_NOT_FOUND') throw error;
            task = taskRuntime.detachAgent({ id: task.id, expectedRev: task.rev, note: 'Managed session unavailable after restart; fresh authorized session' }).task;
          }
        }
        const ws = resolveWorkspace(r.workspaceId);
        const created = await agentBroker.createSession(provider, { cwd: ws.root,
          model: r.input.model, modelProvider: r.input.modelProvider, reasoningEffort: r.input.reasoningEffort });
        if (!created?.sessionId) throw capabilityError('PROVIDER_ERROR', 'Agent returned no session');
        const attached = taskRuntime.attachAgent({ id: task.id, expectedRev: task.rev, provider, sessionId: created.sessionId });
        bindAgentSession?.(created.sessionId, { taskId: task.id, workspaceId: ws.id, actor });
        if (attached.task.status === 'queued') taskRuntime.start({ id: task.id, expectedRev: attached.task.rev });
        const sent = await agentBroker.send({ provider, sessionId: created.sessionId, content: String(r.input.content || task.goal) });
        return { taskId: task.id, workspaceId: ws.id, provider, sessionId: created.sessionId, accepted: sent?.accepted === true, actor };
      })();
      provisioning.set(task.id, pending);
      try { return await pending; } finally { provisioning.delete(task.id); }
    }
  });
  async function execute({ method, params = {} } = {}) {
    if (method === 'capability.list') return { capabilities: broker.list() };
    if (method === 'capability.approval.list') return { approvals: broker.approvals.list() };
    if (method === 'capability.approval.decide') {
      const original = broker.approvals.get(params.id).request;
      const result = await broker.decide({ id: params.id, approve: params.approve === true, actor: OWNER_ACTOR });
      if (typeof approvalDecisionListener === 'function') {
        const resumed = await approvalDecisionListener({ approvalId: params.id,
          requestFingerprint: requestFingerprint(original), decisionResult: result, request: original });
        if (resumed) return { ...result, turnResumed: resumed.resumed === true, resumePending: resumed.pending === true,
          ...(resumed.error ? { resumeError: resumed.error } : {}) };
      }
      if (original.actor.kind === 'agent' && original.taskId && agentBroker) {
        const task = taskFor(original.taskId);
        if (task?.currentAgent?.provider === 'cetamesh' && task.workspaceId === original.workspaceId) {
          try {
            if (typeof resumeAgentApproval === 'function') {
              const resumed = await resumeAgentApproval({ sessionId: task.currentAgent.sessionId,
                approvalId: params.id, decisionResult: result });
              if (resumed?.resumed === true) return { ...result, taskResumed: true };
              if (resumed?.error) return { ...result, taskResumed: false, resumeError: resumed.error };
            }
            await agentBroker.send({ ...task.currentAgent, content: '[Owner capability decision reference data]\n'
              + JSON.stringify({ approvalId: params.id, decision: result }).slice(0, 16000) });
            return { ...result, taskResumed: true };
          } catch (error) { return { ...result, taskResumed: false, resumeError: error.code ?? 'PROVIDER_ERROR' }; }
        }
      }
      return result;
    }
    if (method === 'capability.execute') return broker.execute({ ...params, actor: OWNER_ACTOR });
    throw capabilityError('METHOD_NOT_FOUND', method);
  }
  async function executeWorkspace({ method, params = {} } = {}) {
    const capability = WORKSPACE_CAPABILITIES[method];
    if (!capability) return workspaceService.execute({ method, params }); // Owner-only registry/settings/legacy approvals
    const workspaceId = params.id || (await workspaceService.execute({ method: 'workspace.list' })).activeId;
    // test.run 保持 Owner 直接操作语义：Owner 在 Workspace UI 点击"运行测试"就是
    // 显式决定（approved:true，跳过审批队列）；Managed Agent 的 test.run 不走此
    // 路径，risk=high 使其必然进入 Approve Once。
    const ownerDirect = ['workspace.create', 'test.run'].includes(capability);
    const result = await broker.execute({ capability, actor: OWNER_ACTOR, input: params,
      ...(capability !== 'workspace.create' ? { workspaceId } : {}), approved: ownerDirect, reason: 'Desktop Owner action' });
    return result.status === 'completed' ? result.result : result;
  }
  async function executeMemory(command) {
    // Desktop administration methods retain their existing confirmation/state semantics,
    // but every call still passes registry and the central permission decision.
    const capability = /create|update|delete|pin|import|confirm|propose/.test(command.method) ? 'memory.write'
      : /links|references|context/.test(command.method) ? 'memory.link' : 'memory.read';
    const result = await broker.execute({ capability: 'memory.desktop.' + capability.slice('memory.'.length),
      actor: OWNER_ACTOR, input: command, reason: 'Desktop Owner Memory action' });
    return result.result;
  }
  return { execute, executeWorkspace, executeMemory, broker, grantTask, principalForTask, refreshTaskWorkspaceGrant, memoryPrincipal,
    setApprovalDecisionListener(listener) {
      if (listener !== null && typeof listener !== 'function') throw capabilityError('INVALID_PARAMS', 'Approval decision listener must be a function');
      approvalDecisionListener = listener;
      return true;
    }
  };
}
