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

/** Trusted in-process API. Public transports must use execute/executeWorkspace,
 * which bind the Owner identity; Agent/Extension grants never come from IPC. */
export function createCapabilityService({ stateDir, workspaceService, memoryService,
  taskRuntime, agentBroker, bindAgentSession, searchImpl = null, audit = () => {}, now } = {}) {
  const file = stateDir ? path.join(stateDir, 'capability', 'task-grants.json') : null;
  let grants = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const provisioning = new Map();
  const journalFile = stateDir ? path.join(stateDir, 'capability', 'requests.json') : null;
  const journal = journalFile && fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
  const requests = new Map();
  function saveJournal() {
    if (!journalFile) return;
    fs.mkdirSync(path.dirname(journalFile), { recursive: true });
    const temp = journalFile + '.' + process.pid + '.tmp';
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
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(grants, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  function grantTask(taskId, value) {
    const task = taskFor(taskId);
    if (!task?.workspaceId) throw capabilityError('WORKSPACE_REQUIRED', 'Task workspace required');
    const capabilities = value?.capabilities ?? ['filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'test.run', 'memory.read'];
    for (const id of capabilities) broker.registry.require(id);
    if ((value?.workspaceIds ?? [task.workspaceId]).some(id => id !== task.workspaceId)) {
      throw capabilityError('WORKSPACE_NOT_AUTHORIZED', 'A Task grant cannot include another workspace');
    }
    grants[taskId] = { capabilities: [...new Set(capabilities)], workspaceIds: [task.workspaceId], taskIds: [taskId],
      scopes: [`task:${taskId}`, `workspace:${task.workspaceId}`], types: ['working', 'task', 'workspace', 'knowledge', 'skill'] };
    saveGrants();
    return principalForTask(taskId);
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
        risk: ['workspace.create', 'git.commit'].includes(id) ? 'high' : id === 'filesystem.write' || id === 'test.run' ? 'medium' : 'low',
        validate(request) {
          if (id === 'workspace.create') {
            assertSafeRootForm(request.input.root);
            if (fs.existsSync(request.input.root)) canonicalizeRoot(request.input.root);
            return;
          }
          if (id === 'test.run' && request.actor.kind !== 'owner') {
            throw capabilityError('TEST_SANDBOX_UNAVAILABLE', 'Agent code execution requires an isolated test runner; Owner may run reviewed tests');
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
            return workspaceService.execute({ method, params: { ...request.input,
              ...(id === 'git.diff' ? { excludeSensitive: request.actor.kind !== 'owner' } : {}),
              ...(request.workspaceId ? { id: request.workspaceId } : {}), actor: request.actor.id } });
          };
          return id === 'workspace.create' ? idempotent(request, run) : run();
        }
      });
    }
  }
  if (memoryService) {
    for (const action of ['read', 'write', 'link']) {
      broker.register({ id: 'memory.desktop.' + action, permission: 'memory.' + action,
        provider: 'memory', risk: 'low', execute: r => {
          if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Owner administration only');
          return memoryService.execute(r.input);
        }});
    }
    broker.register({ id: 'memory.read', permission: 'memory.read', provider: 'memory', risk: 'low', execute: r => {
      const principal = memoryPrincipal(r.actor);
      return r.input.id ? memoryService.runtime.get({ ...r.input, principal }) : memoryService.runtime.search({ ...r.input, principal });
    }});
    broker.register({ id: 'memory.write', permission: 'memory.write', provider: 'memory', risk: 'medium', execute: r => {
      const principal = memoryPrincipal(r.actor);
      const input = r.actor.kind === 'agent' ? { ...r.input, scope: `task:${r.taskId}` } : r.input;
      if (r.actor.kind !== 'owner' && input.type !== 'working') return memoryService.runtime.proposeCandidate({ ...input, principal });
      return memoryService.runtime.create({ ...input, principal });
    }});
    broker.register({ id: 'memory.link', permission: 'memory.link', provider: 'memory', risk: 'medium', execute: r => {
      const principal = memoryPrincipal(r.actor);
      if (r.input.source && r.input.target) return memoryService.runtime.createLink({ ...r.input, principal });
      return memoryService.runtime.buildContextPackage({ ...r.input, ...(r.actor.kind === 'agent' ? { scope: `task:${r.taskId}` } : {}), principal });
    }});
  }
  broker.register({ id: 'network', permission: 'network', provider: 'safe-fetch', risk: 'high',
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
    execute: r => {
      if (!searchImpl) throw capabilityError('PROVIDER_UNAVAILABLE', 'Web search adapter is not connected');
      return searchImpl(String(r.input.query ?? ''));
    } });
  broker.register({ id: 'clock.now', permission: 'log', provider: 'desktop', risk: 'low',
    execute: () => ({ iso: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) });
  broker.register({ id: 'agent.run', permission: 'agent.run', provider: 'agent-broker', workspace: true, risk: 'medium',
    async execute(r) {
      if (r.actor.kind !== 'owner') throw capabilityError('PERMISSION_DENIED', 'Only Owner may assign Agents');
      let task = taskFor(r.taskId);
      if (!task || task.workspaceId !== r.workspaceId) throw capabilityError('TASK_NOT_AUTHORIZED', 'Task workspace required');
      const provider = String(r.input.provider || 'cetamesh');
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
      if (original.actor.kind === 'agent' && original.taskId && agentBroker) {
        const task = taskFor(original.taskId);
        if (task?.currentAgent?.provider === 'cetamesh' && task.workspaceId === original.workspaceId) {
          try {
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
    const result = await broker.execute({ capability, actor: OWNER_ACTOR, input: params,
      ...(capability !== 'workspace.create' ? { workspaceId } : {}), approved: capability === 'workspace.create', reason: 'Desktop Owner action' });
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
  return { execute, executeWorkspace, executeMemory, broker, grantTask, principalForTask, memoryPrincipal };
}
