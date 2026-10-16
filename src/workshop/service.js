// Workshop is a trusted-transport facade. Never take actor identity from params.
// External callers can submit text and read their own sanitized project projection.
import path from 'node:path';
import crypto from 'node:crypto';
import { StorageError, readJsonFile, writeJsonAtomic } from '../storage/json-file.js';

export const WORKSHOP_GRANT_CAPABILITIES = Object.freeze([
  'filesystem.read', 'filesystem.write', 'filesystem.search', 'git.status', 'git.diff', 'git.commit',
  'test.run', 'memory.read', 'memory.write', 'memory.link'
]);
export const WORKSHOP_METHODS = Object.freeze([
  'workshop.proposal.submit', 'workshop.proposal.supplement', 'workshop.proposal.get',
  'workshop.proposal.list', 'workshop.proposal.review', 'workshop.proposal.retry',
  'workshop.task.status', 'workshop.artifact.deliver'
]);
const copy = (value) => structuredClone(value);
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function text(value, field, max = 10000, required = true) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max) {
    fail('WORKSHOP_INVALID_PARAMS', field + ' must be a bounded string');
  }
  return value.trim();
}
function optionalText(value, field, max) { return value == null ? '' : text(value, field, max, false); }
function stringList(value, field, max = 100) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) fail('WORKSHOP_INVALID_PARAMS', field + ' must be a bounded list');
  return value.map((item) => text(item, field, 1000));
}
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createWorkshopService({ stateDir, workspaceService, taskRuntime, capabilityBroker, now = () => Date.now(), ownerId = 'desktop-owner' } = {}) {
  if (!stateDir || !workspaceService?.execute || !taskRuntime?.create || !capabilityBroker?.execute) {
    fail('WORKSHOP_INVALID_PARAMS', 'Workshop requires stateDir, Workspace, Task and Capability Broker services');
  }
  const file = path.join(stateDir, 'workshop', 'proposals.json');
  let state = { schemaVersion: 1, proposals: [] };
  try {
    state = readJsonFile(file);
    if (state?.schemaVersion !== 1 || !Array.isArray(state.proposals)
      || state.proposals.some((p) => !p?.id || !p.submitter?.id || !Array.isArray(p.supplements) || !Array.isArray(p.artifacts))) {
      fail('WORKSHOP_STORE_CORRUPT', 'Invalid Workshop store');
    }
  } catch (error) {
    // 首次启动没有状态文件 → 用默认空状态；其余（损坏/校验失败/读失败）一律 fail-closed。
    if (!(error instanceof StorageError && error.code === 'MISSING')) {
      fail('WORKSHOP_STORE_CORRUPT', 'Cannot read Workshop store');
    }
  }
  let queue = Promise.resolve();
  function save() {
    writeJsonAtomic(file, state);
  }
  function changed(p) { p.updatedAt = now(); p.rev++; save(); }
  function trustedActor(actor) {
    if (!actor) fail('WORKSHOP_ACTOR_REQUIRED', 'Trusted transport actor is required');
    if (!['owner', 'external'].includes(actor.kind) || typeof actor.id !== 'string' || !actor.id.trim()) {
      fail('WORKSHOP_FORBIDDEN', 'This caller cannot use Workshop');
    }
    return { kind: actor.kind, id: text(actor.id, 'actor.id', 200) };
  }
  function owner(actor) {
    if (actor.kind !== 'owner') fail('WORKSHOP_FORBIDDEN', 'Owner approval is required');
  }
  function requireProposal(id, actor) {
    const p = state.proposals.find((item) => item.id === id);
    if (!p || (actor.kind !== 'owner' && (p.submitter.kind !== actor.kind || p.submitter.id !== actor.id))) {
      fail('WORKSHOP_FORBIDDEN', 'Proposal is unavailable to this caller');
    }
    return p;
  }
  function projection(p, actor) {
    if (actor.kind === 'owner') return copy(p);
    return copy({ id: p.id, title: p.title, description: p.description, requirements: p.requirements,
      supplements: p.supplements.map(({ id, text: body, createdAt }) => ({ id, text: body, createdAt })),
      status: p.status, review: p.review ? { decision: p.review.decision, reason: p.review.reason, at: p.review.at } : null,
      taskId: p.taskId, artifacts: p.artifacts.map(({ id, label, mediaType, content, deliveredAt }) => ({ id, label, mediaType, content, deliveredAt })),
      createdAt: p.createdAt, updatedAt: p.updatedAt, rev: p.rev });
  }
  function planFor(input = {}) {
    if (!input.workspace || typeof input.workspace !== 'object') fail('WORKSHOP_INVALID_PARAMS', 'Approval requires a workspace plan');
    const capabilities = stringList(input.capabilities ?? ['filesystem.read', 'filesystem.write', 'git.status', 'git.diff'], 'capabilities', 30);
    if (capabilities.some((cap) => !WORKSHOP_GRANT_CAPABILITIES.includes(cap))) {
      fail('WORKSHOP_INVALID_PARAMS', 'Only explicit supported Task capabilities can be assigned');
    }
    return { workspace: { name: text(input.workspace.name, 'workspace.name', 100), root: text(input.workspace.root, 'workspace.root', 1024), createIfMissing: input.workspace.createIfMissing === true },
      provider: text(input.provider ?? 'cetamesh', 'provider', 100), capabilities: [...new Set(capabilities)],
      model: optionalText(input.model, 'model', 200), modelProvider: optionalText(input.modelProvider, 'modelProvider', 200),
      reasoningEffort: optionalText(input.reasoningEffort, 'reasoningEffort', 100) };
  }
  function unwrap(result) {
    if (result?.status === 'pending') fail('WORKSHOP_APPROVAL_PENDING', 'Provisioning requires confirmed Owner approval');
    return result?.status === 'completed' && Object.hasOwn(result, 'result') ? result.result : result;
  }
  const provisioning = new Map();
  async function provision(p, actor) {
    const active = provisioning.get(p.id);
    if (active) return active;
    const pending = provisionOnce(p, actor);
    provisioning.set(p.id, pending);
    try { return await pending; }
    finally { if (provisioning.get(p.id) === pending) provisioning.delete(p.id); }
  }
  async function provisionOnce(p, actor) {
    owner(actor);
    if (!p.plan || p.review?.decision !== 'approved') fail('WORKSHOP_REVIEW_REQUIRED', 'Owner must approve a plan first');
    if (p.status === 'delivered') return { proposal: projection(p, actor) };
    const previousAssignment = p.assignment;
    const alreadyActive = p.status === 'active';
    if (alreadyActive) p.provision.agentRequestId = null;
    p.status = 'provisioning'; p.provision.attempts++; p.provision.error = null; changed(p);
    try {
      if (!p.workspaceId) {
        const result = unwrap(await capabilityBroker.execute({ requestId: 'workshop:' + p.id + ':workspace', actor,
          capability: 'workspace.create', input: p.plan.workspace, reason: 'Owner approved Workshop proposal ' + p.id, approved: true }));
        const workspaceId = result?.workspace?.id ?? result?.id;
        if (!workspaceId) fail('WORKSHOP_PROVISION_FAILED', 'Workspace creation returned no id');
        p.workspaceId = workspaceId; p.provision.step = 'workspace-created'; changed(p);
      }
      if (!p.taskId) {
        const marker = 'workshop-proposal:' + p.id;
        const existing = taskRuntime.list({ workspaceId: p.workspaceId, limit: 5000 }).tasks.find((task) => task.progress?.note === marker);
        const task = existing ?? taskRuntime.create({ goal: p.description,
          requirements: [...p.requirements, ...p.supplements.map((item) => item.text)], workspaceId: p.workspaceId,
          note: marker, requestId: 'workshop:' + p.id + ':task', requestedAgentProvider: p.plan.provider });
        p.taskId = task.id; p.provision.step = 'task-created'; changed(p);
      }
      const grants = { workspaceIds: [p.workspaceId], taskIds: [p.taskId], capabilities: [...p.plan.capabilities] };
      p.assignment = { actor: { kind: 'agent', id: 'task:' + p.taskId, grants }, taskId: p.taskId, workspaceId: p.workspaceId, grants };
      changed(p);
      const task = taskRuntime.get({ id: p.taskId }).task;
      if (task.workspaceId !== p.workspaceId) fail('WORKSHOP_ASSIGNMENT_CONFLICT', 'Task workspace changed after approval');
      if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
        if (task.currentAgent && task.currentAgent.provider !== p.plan.provider) fail('WORKSHOP_ASSIGNMENT_CONFLICT', 'Task provider changed after approval');
        if (alreadyActive && previousAssignment?.sessionId && previousAssignment.sessionId === task.currentAgent?.sessionId) {
          p.assignment.sessionId = previousAssignment.sessionId;
          p.status = 'active'; p.provision.step = 'assigned'; changed(p);
          return { proposal: projection(p, actor) };
        }
        const dispatchRequestId = p.provision.agentRequestId
          ?? 'workshop:' + p.id + ':agent:' + (task.currentAgent?.sessionId ?? 'initial');
        p.provision.agentRequestId = dispatchRequestId; changed(p);
        const result = unwrap(await capabilityBroker.execute({ requestId: dispatchRequestId, actor, taskId: p.taskId, workspaceId: p.workspaceId,
          capability: 'agent.run', input: { provider: p.plan.provider, content: p.description + '\n' + [...p.requirements, ...p.supplements.map((item) => item.text)].join('\n'),
            grants, model: p.plan.model || undefined, modelProvider: p.plan.modelProvider || undefined, reasoningEffort: p.plan.reasoningEffort || undefined }, approved: true,
          reason: 'Owner approved Workshop Task assignment ' + p.id }));
        p.assignment.sessionId = result?.sessionId ?? result?.agent?.sessionId ?? null;
        if (result?.actor) { p.assignment.actor = copy(result.actor); p.assignment.grants = copy(result.actor.grants); }
        p.provision.agentRequestId = null;
      } else {
        p.assignment.sessionId = task.currentAgent?.sessionId ?? null;
      }
      p.status = 'active'; p.provision.step = 'assigned'; p.provision.error = null; changed(p);
    } catch (error) {
      p.status = 'provision_failed'; p.provision.error = { code: error?.code ?? 'WORKSHOP_PROVISION_FAILED', message: String(error?.message ?? error).slice(0, 2000) }; changed(p);
    }
    return { proposal: projection(p, actor) };
  }
  const handlers = {
    'workshop.proposal.submit': (params, actor) => {
      const body = { title: text(params.title, 'title', 200), description: text(params.description, 'description', 2000), requirements: stringList(params.requirements, 'requirements', 50) };
      const requestId = optionalText(params.requestId, 'requestId', 200);
      if (requestId) {
        const existing = state.proposals.find((p) => p.submitter.kind === actor.kind && p.submitter.id === actor.id && p.requestId === requestId);
        if (existing) {
          if (existing.submissionHash !== digest(body)) fail('WORKSHOP_IDEMPOTENCY_CONFLICT', 'Request id was used for different proposal data');
          return { proposal: projection(existing, actor) };
        }
      }
      if (state.proposals.length >= 5000) fail('WORKSHOP_STORE_FULL', 'Workshop proposal limit reached');
      const p = { id: 'proposal_' + crypto.randomUUID(), ...body, submitter: actor, requestId, submissionHash: digest(body), status: 'submitted',
        supplements: [], review: null, reviews: [], plan: null, workspaceId: null, taskId: null, assignment: null,
        provision: { step: 'unapproved', attempts: 0, error: null }, artifacts: [], createdAt: now(), updatedAt: now(), rev: 1 };
      state.proposals.push(p); save(); return { proposal: projection(p, actor) };
    },
    'workshop.proposal.supplement': (params, actor) => {
      const p = requireProposal(params.id, actor);
      const body = text(params.text, 'text', 1000);
      const requestId = optionalText(params.requestId, 'requestId', 200);
      const existing = requestId && p.supplements.find((s) => s.requestId === requestId);
      if (existing) {
        if (existing.text !== body) fail('WORKSHOP_IDEMPOTENCY_CONFLICT', 'Supplement request id was reused');
        return { proposal: projection(p, actor) };
      }
      if (!['submitted', 'rejected'].includes(p.status)) fail('WORKSHOP_REVIEW_REQUIRED', 'Approved work requires a new proposal for scope changes');
      if (p.requirements.length + p.supplements.length >= 50) fail('WORKSHOP_INVALID_PARAMS', 'Supplement limit reached');
      p.supplements.push({ id: 'supplement_' + crypto.randomUUID(), requestId, text: body, createdAt: now() });
      p.status = 'submitted'; p.review = null; changed(p); return { proposal: projection(p, actor) };
    },
    'workshop.proposal.get': (params, actor) => ({ proposal: projection(requireProposal(params.id, actor), actor) }),
    'workshop.proposal.list': (params, actor) => {
      const rows = state.proposals.filter((p) => actor.kind === 'owner' || (p.submitter.kind === actor.kind && p.submitter.id === actor.id));
      const limit = Number.isInteger(params.limit) && params.limit > 0 ? Math.min(params.limit, 500) : 100;
      return { proposals: rows.slice().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit).map((p) => projection(p, actor)), total: rows.length };
    },
    'workshop.proposal.review': async (params, actor) => {
      owner(actor); const p = requireProposal(params.id, actor);
      if (typeof params.approve !== 'boolean') fail('WORKSHOP_INVALID_PARAMS', 'Review requires an explicit approval decision');
      if (p.plan) {
        if (!params.approve || (params.plan && digest(planFor(params.plan)) !== digest(p.plan))) fail('WORKSHOP_REVIEW_REQUIRED', 'Approved provisioning plan cannot be changed');
        return provision(p, actor);
      }
      const plan = params.approve ? planFor(params.plan) : null;
      p.review = { decision: params.approve ? 'approved' : 'rejected', reason: optionalText(params.reason, 'reason', 2000), by: actor.id, at: now() };
      p.reviews.push(copy(p.review)); p.plan = plan; p.status = params.approve ? 'approved' : 'rejected'; changed(p);
      return params.approve ? provision(p, actor) : { proposal: projection(p, actor) };
    },
    'workshop.proposal.retry': (params, actor) => { owner(actor); return provision(requireProposal(params.id, actor), actor); },
    'workshop.task.status': (params, actor) => {
      const p = requireProposal(params.id, actor);
      if (!p.taskId) return { proposalId: p.id, status: p.status, task: null };
      const task = taskRuntime.get({ id: p.taskId }).task;
      return { proposalId: p.id, status: p.status, task: actor.kind === 'owner' ? task : {
        id: task.id, status: task.status, percent: task.progress.percent, createdAt: task.createdAt, updatedAt: task.updatedAt } };
    },
    'workshop.artifact.deliver': (params, actor) => {
      owner(actor); const p = requireProposal(params.id, actor);
      if (params.approve !== true) fail('WORKSHOP_REVIEW_REQUIRED', 'Delivery requires explicit Owner approval');
      const body = { label: text(params.label, 'label', 200), mediaType: text(params.mediaType ?? 'text/plain', 'mediaType', 100), content: (text(params.content, 'content', 1024 * 1024, false), params.content) };
      const requestId = optionalText(params.requestId, 'requestId', 200);
      const existing = requestId && p.artifacts.find((a) => a.requestId === requestId);
      if (existing) {
        if (existing.hash !== digest(body)) fail('WORKSHOP_IDEMPOTENCY_CONFLICT', 'Delivery request id was reused');
        return { artifact: copy(existing), proposal: projection(p, actor) };
      }
      const task = p.taskId && taskRuntime.get({ id: p.taskId }).task;
      if (!task || task.status !== 'completed') fail('WORKSHOP_TASK_NOT_COMPLETED', 'Final artifact delivery requires a completed Task');
      if (p.artifacts.length >= 100) fail('WORKSHOP_INVALID_PARAMS', 'Artifact limit reached');
      const artifact = { id: 'delivery_' + crypto.randomUUID(), ...body, requestId, hash: digest(body), approvedBy: actor.id, deliveredAt: now() };
      p.artifacts.push(artifact); p.status = 'delivered'; changed(p);
      return { artifact: copy(artifact), proposal: projection(p, actor) };
    }
  };
  function execute({ method, params = {}, actor } = {}) {
    const operation = queue.then(() => {
      const trusted = trustedActor(actor);
      if (!Object.hasOwn(handlers, method)) fail('METHOD_NOT_FOUND', 'Unknown Workshop method');
      return handlers[method](params ?? {}, trusted);
    });
    queue = operation.catch(() => {}); return operation;
  }
  return { execute, executeOwner: ({ method, params } = {}) => execute({ method, params, actor: { kind: 'owner', id: ownerId } }),
    runtime: { execute }, close: () => queue };
}
