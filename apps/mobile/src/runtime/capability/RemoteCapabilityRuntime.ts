import type {CapabilityRuntime} from './CapabilityRuntime';
import type {RemoteCapabilityRequest} from '../../domain/sync';
import {isKnownCapabilityName} from '../../domain/capability/Capability';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';

export class RemoteCapabilityRuntime {
  constructor(
    private readonly localRuntime: CapabilityRuntime,
    private readonly localDeviceId: string,
    private readonly consumeApproval?: (approvalId: string, nonce: string) => Promise<unknown>,
  ) {
    identifier(localDeviceId);
  }

  async invoke(request: RemoteCapabilityRequest): Promise<unknown> {
    if (!request.trusted) {
      throw new CetaError('unauthorized', 'Remote device trust is not active');
    }
    identifier(request.remoteDeviceId);
    if (!isKnownCapabilityName(request.capability)) {
      throw new CetaError('permission_denied', 'Unknown remote capability denied');
    }
    if (request.approval) {
      if (!this.consumeApproval) {
        throw new CetaError('permission_denied', 'Remote capability approval is unavailable');
      }
      await this.consumeApproval(request.approval.approvalId, request.approval.nonce);
    }
    return this.localRuntime.invoke({
      name: request.capability,
      input: request.input,
      caller: 'remote-node',
      deviceId: this.localDeviceId,
      taskId: request.taskId,
      scope: request.scope,
      target: request.target,
    });
  }
}
