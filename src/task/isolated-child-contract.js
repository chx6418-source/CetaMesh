import path from 'node:path';
import { taskError } from './types.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const normalizedPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const contains = (parent, child) => {
  const relative = path.relative(normalizedPath(parent), normalizedPath(child));
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const scopes = value => Array.isArray(value) && value.length > 0 && value.length <= 50
  && new Set(value).size === value.length && value.every(scope => typeof scope === 'string' && scope.length <= 1024
    && scope && !/[\x00-\x1f\x7f:]/.test(scope) && !scope.replaceAll('\\', '/').startsWith('/')
    && scope.replaceAll('\\', '/').split('/').every(part => part && part !== '.' && part !== '..'));
const identity = value => exact(value, ['path','device','file']) && typeof value.path === 'string'
  && value.path.length <= 4096 && path.isAbsolute(value.path) && !/[\x00-\x1f\x7f]/.test(value.path)
  && typeof value.device === 'string' && /^\d{1,40}$/.test(value.device)
  && typeof value.file === 'string' && /^\d{1,40}$/.test(value.file);
const proofFields = ['version','parentTaskId','sourceWorkspaceId','workspaceId','provisionOperationId',
  'receiptSha256','baselineHead','baselineSha256','branch','rootIdentity','sourceRootIdentity','gitCommonIdentity'];

export function isolatedChildRootsOverlap(left, right) {
  return contains(left.path, right.path) || contains(right.path, left.path)
    || left.device === right.device && left.file === right.file;
}

/** Shape checks do not establish provenance. Only the Core-owned callback does. */
export function normalizeIsolatedChildBinding(value) {
  if (!exact(value, proofFields) || value.version !== 1
    || !['parentTaskId','sourceWorkspaceId','workspaceId','provisionOperationId','branch'].every(key => id(value[key]))
    || value.sourceWorkspaceId === value.workspaceId || !digest(value.receiptSha256) || !digest(value.baselineSha256)
    || !/^[a-f0-9]{40}$/.test(value.baselineHead ?? '')
    || !identity(value.rootIdentity) || !identity(value.sourceRootIdentity) || !identity(value.gitCommonIdentity)
    || contains(value.rootIdentity.path, value.sourceRootIdentity.path) || contains(value.sourceRootIdentity.path, value.rootIdentity.path)
    || value.rootIdentity.device === value.sourceRootIdentity.device && value.rootIdentity.file === value.sourceRootIdentity.file)
    throw taskError('TASK_CHILD_ISOLATION_INVALID', 'Current independent worktree and provision receipt facts are required');
  return Object.fromEntries(proofFields.map(key => [key, typeof value[key] === 'object'
    ? {path: value[key].path, device: value[key].device, file: value[key].file} : value[key]]));
}

export function normalizeIsolatedChildRequest(value) {
  if (!exact(value, ['mode','outputKind','readScope','writeScope','expectedEvidence'])
    || value.mode !== 'isolated-write' || value.outputKind !== 'changes'
    || !Array.isArray(value.expectedEvidence) || value.expectedEvidence.length < 1 || value.expectedEvidence.length > 50
    || value.expectedEvidence.some(item => !id(item)) || new Set(value.expectedEvidence).size !== value.expectedEvidence.length)
    throw taskError('INVALID_PARAMS', 'An explicit isolated writer output contract is required');
  if (!scopes(value.readScope) || !scopes(value.writeScope))
    throw taskError('TASK_CHILD_SCOPE_DENIED', 'Isolated writer scopes require bounded distinct relative paths');
  return {mode: 'isolated-write', outputKind: 'changes', readScope: value.readScope.map(scope => scope.replaceAll('\\','/')),
    writeScope: value.writeScope.map(scope => scope.replaceAll('\\','/')), expectedEvidence: [...value.expectedEvidence]};
}

export function validateStoredIsolatedChild(contract) {
  if (!object(contract)) return false;
  const {isolation, ...request} = contract;
  try { normalizeIsolatedChildRequest(request); normalizeIsolatedChildBinding(isolation); return true; }
  catch { return false; }
}
