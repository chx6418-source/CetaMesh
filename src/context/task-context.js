import { redactText } from '../logging/redact.js';

const MAX_MEMORY_REFERENCES = 8;

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
  textField(projected, 'goal', task.goal, 1200);
  textField(projected, 'status', task.status, 80);
  textField(projected, 'currentPhase', task.currentPhase, 160);

  if (task.progress && typeof task.progress === 'object') {
    const progress = {};
    const percent = Number(task.progress.percent);
    if (Number.isFinite(percent)) progress.percent = Math.max(0, Math.min(100, percent));
    textField(progress, 'note', task.progress.note, 500);
    if (Object.keys(progress).length) projected.progress = progress;
  }

  if (task.checkpoint && typeof task.checkpoint === 'object') {
    const checkpoint = {};
    textField(checkpoint, 'summary', task.checkpoint.summary, 700);
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
    if (Object.keys(projected).length) output.push(projected);
  }
  return output;
}

/** Returns allowlisted, linked Task and Workspace facts, or null when neither exists. */
export function buildTaskContext({ task = null, workspace = null, memoryReferences = [] } = {}) {
  if (!task && !workspace) return null;
  const projectedTask = projectTask(task);
  return {
    task: projectedTask,
    workspace: projectWorkspace(workspace),
    memoryReferences: projectMemoryReferences(memoryReferences, Boolean(projectedTask))
  };
}
