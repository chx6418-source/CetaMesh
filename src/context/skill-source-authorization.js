// A trusted composition adapter. Task/Capability/Workspace/Settings/Extension
// remain authoritative; issued principals are ephemeral provenance, not state.
import path from 'node:path';
import { requestFingerprint } from '../capability/approval.js';
import { normalizeSkillSources } from './skill-sources.js';

const fail = () => { throw Object.assign(new Error('Current trusted Skill reference authority is required'), { code: 'SKILL_PERMISSION_DENIED' }); };
const sameRoot = (a, b) => typeof a === 'string' && typeof b === 'string'
  && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export function createSkillSourceAuthorizer({ capabilityService, taskRuntime, workspaceService,
  userSources = () => [], extensionRuntime = null } = {}) {
  const issued = new WeakMap();
  function issue(actor, taskId = null) {
    const principal = structuredClone(actor);
    issued.set(principal, { taskId, owner: actor.kind === 'owner', fingerprint: requestFingerprint(principal) });
    return principal;
  }
  function principalForTask(taskId) { return issue(capabilityService.principalForTask(taskId), taskId); }
  function ownerPrincipal({ taskId = null } = {}) {
    if (taskId && !taskRuntime.get({ id: taskId }).task) fail();
    return issue({ kind: 'owner', id: 'desktop' }, taskId);
  }
  async function authorizeSource(check) {
    const binding = issued.get(check.principal);
    if (!binding || binding.fingerprint !== requestFingerprint(check.principal) || (binding.taskId ?? null) !== (check.taskId ?? null)) fail();
    let actor;
    const task = binding.taskId ? taskRuntime.get({ id: binding.taskId }).task : null;
    if (binding.taskId && !binding.owner) {
      actor = capabilityService.principalForTask(binding.taskId);
      if (requestFingerprint(actor) !== binding.fingerprint || !task || task.workspaceId !== check.workspaceId
        || !['queued', 'running', 'waiting'].includes(task.status)) fail();
    } else {
      actor = { kind: 'owner', id: 'desktop' };
      if (binding.taskId && (!task || task.workspaceId !== check.workspaceId)) fail();
    }
    const workspace = check.workspaceId ? workspaceService.describeWorkspace(check.workspaceId) : null;
    if (check.sourceKind === 'project') {
      if (!workspace || workspace.id !== check.workspaceId || check.sourceId !== 'workspace:' + workspace.id
        || !sameRoot(workspace.root, check.root) || !(check.relativePath === '.cetamesh/skills' || check.relativePath.startsWith('.cetamesh/skills/'))) fail();
      await capabilityService.broker.assertReadAuthorization({ actor, taskId: binding.taskId ?? undefined, workspaceId: workspace.id,
        capability: 'filesystem.read', input: { path: check.relativePath } });
    } else if (check.sourceKind === 'user' || check.sourceKind === 'installed') {
      // A child has only its precise Workspace read scope. A globally enabled
      // reference library must never broaden that contract.
      if (!binding.owner && task?.parentTaskId && task.childContract?.mode === 'read-only') fail();
      // Explicit Owner-enabled content is a reference grant, independent of
      // executable filesystem tools. The live Task principal and lifecycle are
      // checked here; project files still use Broker's exact read policy above.
      if (check.sourceKind === 'user') {
        const sources = normalizeSkillSources(await userSources());
        const source = sources.find(row => row.sourceId === check.sourceId);
        if (!source || !source.enabled || source.revision !== check.sourceRevision || !sameRoot(source.root, check.root)) fail();
      } else {
        const source = extensionRuntime?.listSkillSources?.().find(row => row.sourceId === check.sourceId);
        if (!source || source.sourceRevision !== check.sourceRevision) fail();
      }
    } else fail();
    // Every awaited policy/Settings boundary can change live Task authority.
    if (task) {
      const current = taskRuntime.get({ id: task.id }).task;
      if (current.workspaceId !== check.workspaceId) fail();
      if (!binding.owner && (!['queued', 'running', 'waiting'].includes(current.status)
        || requestFingerprint(capabilityService.principalForTask(task.id)) !== binding.fingerprint)) fail();
    }
    return { allowed: true };
  }
  return { authorizeSource, principalForTask, ownerPrincipal };
}
