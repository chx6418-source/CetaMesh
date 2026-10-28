import { capabilityError } from './types.js';
import { requestFingerprint } from './approval.js';
import { validateSchema } from '../model/input-schema.js';

/** An explicit ledger reference, never semantic similarity, links a new call. */
export function registerOperationContinuation({ broker }) {
  broker.register({ id: 'operation.continue', permission: 'storage', risk: 'low',
    effect: 'unknown', delegatesOperation: true, workspace: true, requiresTask: true, provider: 'task-runtime',
    description: 'Continue one Task operation by its operation reference or Owner-prepared logical step, with exact original input. Source permissions and approval still apply. Never guess a reference.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['input'],
      properties: { operationRef: { type: 'string', minLength: 1, maxLength: 160 }, logicalStepId: { type: 'string', minLength: 1, maxLength: 160 }, input: { type: 'object', additionalProperties: true } } },
    async execute(request) {
      const { operationRef, logicalStepId } = request.input;
      if (Boolean(operationRef) === Boolean(logicalStepId))
        throw capabilityError('INVALID_OPERATION_REFERENCE', 'Supply exactly one operation or Owner-prepared logical step reference');
      const row = logicalStepId
        ? broker.operationRecordForStep({ taskId: request.taskId, workspaceId: request.workspaceId, logicalStepId })
        : broker.operationRecordForTask({ taskId: request.taskId, workspaceId: request.workspaceId, operationId: operationRef });
      if (!row) throw capabilityError('OPERATION_NOT_FOUND', 'No operation reference in this Task Workspace');
      const source = broker.registry.require(row.capability);
      if (source.delegatesOperation === true) throw capabilityError('OPERATION_REFERENCE_INVALID', 'Continuation cannot delegate to itself');
      if ((source.descriptorVersion ?? null) !== row.descriptorVersion) throw capabilityError('OPERATION_DESCRIPTOR_CHANGED', 'Original capability version changed');
      if(request.actor.kind==='agent'&&(source.modelCallable===false||!source.inputSchema))
        throw capabilityError('OPERATION_SOURCE_NOT_CALLABLE','Continuation cannot expose a source hidden from model tool calls');
      if(source.inputSchema)validateSchema(source.inputSchema,request.input.input);
      // Do not inherit Owner approval or old executor authority. The nested call
      // returns the original Broker envelope, including a real pending approval.
      return broker.execute({ actor: request.actor, taskId: request.taskId, workspaceId: request.workspaceId,
        assignment: request.assignment, operationId: row.operationId, scope: request.scope,
        requestId: 'resume:' + requestFingerprint({ requestId: request.requestId, operationId: row.operationId }),
        capability: row.capability, input: request.input.input, reason: 'Continue explicit Task operation' },
      { signal: request.signal });
    }
  });
}
