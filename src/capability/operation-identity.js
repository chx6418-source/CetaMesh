import { requestFingerprint } from './approval.js';
import { capabilityError } from './types.js';
import { isSensitiveKey, redactText } from '../logging/redact.js';

/** Logical identity is Core metadata, never tool input or execution authority. */
export function operationIdentity(request, entry) {
  if (request.operationId === undefined) return null;
  if (!['owner', 'agent'].includes(request.actor?.kind) || !request.taskId || !request.workspaceId
    || typeof request.operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(request.operationId)) {
    throw capabilityError('INVALID_OPERATION_ID', 'A logical operation requires a bounded identity and an authorized Task Workspace');
  }
  const scope = { taskId: request.taskId, workspaceId: request.workspaceId };
  return { key: 'operation:' + requestFingerprint({ ...scope, operationId: request.operationId }),
    fingerprint: requestFingerprint({ ...scope, capability: entry.id, permission: entry.permission ?? entry.id,
      descriptorVersion: entry.descriptorVersion ?? null, input: request.input, scope: request.scope ?? null }) };
}

/** Only a trusted executor may select a bounded, non-sensitive result receipt. */
export function retainedOperationResult(entry, result, request) {
  if (typeof entry.retainOperationResult !== 'function') return null;
  try {
    const receipt = { value: entry.retainOperationResult(result),
      proof: typeof entry.operationProof === 'function' ? entry.operationProof(request, result) : null,
      accessInput: typeof entry.operationAccessInput === 'function' ? entry.operationAccessInput(request) : null };
    const text = JSON.stringify(receipt, (key, item) => {
      if ((key && isSensitiveKey(key)) || (typeof item === 'string' && redactText(item) !== item)) {
        throw capabilityError('OPERATION_RESULT_UNSAFE', 'Result contains sensitive data');
      }
      return item;
    });
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) return null;
    const parsed = JSON.parse(text);
    return Object.hasOwn(parsed, 'value') ? parsed : null;
  } catch {
    // The actual effect already completed. Omit an unsafe/unserializable receipt;
    // a later caller must review the outcome instead of executing it again.
    return null;
  }
}
