import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
} from '../../domain/capability/Capability';
import {
  parseNotificationPayload,
  type NotificationPayload,
} from '../../domain/capability/NotificationSend';
import {CetaError} from '../../shared/errors/CetaError';
import Native from './NativeCetaNotificationSend';

type NotificationNativeModule = {
  send(payload: string): Promise<void>;
  cancel(): void;
};

const descriptor: CapabilityDescriptor = {
  name: 'notification.send',
  version: 1,
  platforms: ['android', 'ios'],
  requiresPermission: true,
};

function normalizeNativeError(error: unknown): CetaError {
  if (error instanceof CetaError) {
    return error;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (
      code === 'cancelled' ||
      code === 'permission_denied' ||
      code === 'storage_error' ||
      code === 'unsupported' ||
      code === 'timeout'
    ) {
      return new CetaError(code, 'Notification delivery was unavailable');
    }
  }
  return new CetaError('provider_error', 'Notification delivery was unavailable');
}

export class NotificationSendProvider implements CapabilityProvider {
  constructor(
    private readonly native: NotificationNativeModule | null = Native ?? null,
  ) {}

  listCapabilities(): readonly CapabilityDescriptor[] {
    return [descriptor];
  }

  async invoke(request: CapabilityRequest): Promise<CapabilityResult> {
    if (request.name !== descriptor.name) {
      throw new CetaError('unsupported', 'Notification delivery is unavailable');
    }
    const payload: NotificationPayload = parseNotificationPayload(request.input);
    if (!this.native) {
      throw new CetaError('unsupported', 'Notification delivery is unavailable');
    }
    try {
      await this.native.send(JSON.stringify(payload));
      return {name: request.name, output: {sent: true}};
    } catch (error) {
      throw normalizeNativeError(error);
    }
  }

  cancel(): void {
    this.native?.cancel();
  }
}
