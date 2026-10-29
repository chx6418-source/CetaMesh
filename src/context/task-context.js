import { redactText } from '../logging/redact.js';

const MAX_MEMORY_REFERENCES = 200;

function safeText(value, maxLength = 600) {
  if (typeof value !== 'string') return undefined;
  const cleaned = redactText(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function textField(target, key, value, maxLength) {
  const safe = safeText(value, maxLength);
  if (safe !== undefined) target[key] = safe;
}

function projectTask(task) {
  if (!task || typeof task !== 'object') return null;
  const projected = {};
  textField(projected, 'id', task.id, 160);
  textField(projected, 'goal', task.goal, Infinity);
  textField(projected, 'status', task.status, 80);
  textField(projected, 'currentPhase', task.currentPhase, Infinity);

  if (task.progress && typeof task.progress === 'object') {
    const progress = {};
    const percent = Number(task.progress.percent);
    if (Number.isFinite(percent)) progress.percent = Math.max(0, Math.min(100, percent));
    textField(progress, 'note', task.progress.note, Infinity);
    if (Object.keys(progress).length) projected.progress = progress;
  }

  if (task.checkpoint && typeof task.checkpoint === 'object') {
    const checkpoint = {};
    textField(checkpoint, 'summary', task.checkpoint.summary, Infinity);
    if (Object.keys(checkpoint).length) projected.checkpoint = checkpoint;
  }

  return projected;
}

function projectWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object') return null;
  const projected = {};
  textField(projected, 'id', workspace.id, 160);
  textField(projected, 'name', workspace.name, 200);
  if (typeof workspace.active === 'boolean') projected.active = workspace.active;

  if (workspace.git && typeof workspace.git === 'object') {
    const git = {};
    if (typeof workspace.git.isRepo === 'boolean') git.isRepo = workspace.git.isRepo;
    textField(git, 'branch', workspace.git.branch, 180);
    if (typeof workspace.git.dirty === 'boolean') git.dirty = workspace.git.dirty;
    if (Object.keys(git).length) projected.git = git;
  }

  return projected;
}

function projectMemoryReferences(references, include) {
  if (!include || !Array.isArray(references)) return [];
  const output = [];
  for (const reference of references.slice(0, MAX_MEMORY_REFERENCES)) {
    if (!reference || typeof reference !== 'object') continue;
    const projected = {};
    textField(projected, 'memoryId', reference.memoryId, 160);
    textField(projected, 'title', reference.title, 180);
    textField(projected, 'excerpt', reference.excerpt, 500);
    textField(projected, 'scope', reference.scope, 160);
    if (Number.isSafeInteger(reference.revision)) projected.revision = reference.revision;
    if (['user', 'chat-candidate', 'qq-adapter', 'system'].includes(reference.source)) projected.source = reference.source;
    for (const key of ['createdAt', 'updatedAt']) if (Number.isFinite(reference[key])) projected[key] = reference[key];
    if (['user-confirmed', 'agent-inference', 'historical-unverified'].includes(reference.provenance?.status)) {
      projected.provenance = { status: reference.provenance.status };
      textField(projected.provenance, 'actor', reference.provenance.actor, 160);
      if (Number.isFinite(reference.provenance.at)) projected.provenance.at = reference.provenance.at;
    }
    if (Array.isArray(reference.sourceRefs)) projected.sourceRefs = reference.sourceRefs.slice(0, 4).map(ref => {
      const value = {};
      for (const [key, max] of [['kind', 40], ['id', 128], ['scope', 160]]) textField(value, key, ref[key], max);
      return value;
    });
    if (reference.truncated === true || (typeof reference.excerpt === 'string' && reference.excerpt.length > 500)) projected.truncated = true;
    if (Object.keys(projected).length) output.push(projected);
  }
  return output;
}

/** Returns allowlisted, linked Task and Workspace facts, or null when neither exists. */
export function buildTaskContext({ task = null, workspace = null, memoryReferences = [] } = {}) {
  if (!task && !workspace && (!Array.isArray(memoryReferences) || memoryReferences.length === 0)) return null;
  const projectedTask = projectTask(task);
  return {
    task: projectedTask,
    workspace: projectWorkspace(workspace),
    memoryReferences: projectMemoryReferences(memoryReferences, true)
  };
}
