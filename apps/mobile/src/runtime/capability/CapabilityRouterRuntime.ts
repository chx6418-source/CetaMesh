import type {
  CapabilityDescriptor,
  CapabilityPlatform,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
} from '../../domain/capability/Capability';
import {isKnownCapabilityName} from '../../domain/capability/Capability';
import type {CapabilityPolicy} from '../../security/CapabilityPolicy';
import {CetaError} from '../../shared/errors/CetaError';
import type {CapabilityAuditEvent, CapabilityAuditSink} from '../../domain/capability/CapabilityAudit';
import {newId} from '../../shared/utils/id';
import type {CapabilityRuntime} from './CapabilityRuntime';
import type {CapabilityGrant} from '../../security/CapabilityPolicy';

type RegisteredCapability = {
  readonly descriptor: CapabilityDescriptor;
  readonly provider: CapabilityProvider;
};

const SAFE_PROVIDER_CODES = new Set([
  'cancelled',
  'invalid_protocol',
  'permission_denied',
  'provider_error',
  'timeout',
  'unsupported',
]);

function isDescriptor(value: CapabilityDescriptor): boolean {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    isKnownCapabilityName(value.name) &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    Array.isArray(value.platforms) &&
    value.platforms.length > 0 &&
    value.platforms.every(
      platform => platform === 'android' || platform === 'ios',
    ) &&
    typeof value.requiresPermission === 'boolean'
  );
}

function normalizeProviderError(error: unknown): CetaError {
  if (error instanceof CetaError) {
    return error;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (SAFE_PROVIDER_CODES.has(code)) {
      return new CetaError(
        code as
          | 'cancelled'
          | 'invalid_protocol'
          | 'permission_denied'
          | 'provider_error'
          | 'timeout'
          | 'unsupported',
        'Capability provider failed',
      );
    }
  }
  return new CetaError('provider_error', 'Capability provider failed');
}

function grantMatchesRequest(grant: CapabilityGrant, request: CapabilityRequest): boolean {
  const scopesMatch = grant.scope?.kind === request.scope?.kind && grant.scope?.id === request.scope?.id;
  return grant.name === request.name &&
    grant.caller === request.caller &&
    grant.deviceId === request.deviceId &&
    grant.taskId === request.taskId &&
    scopesMatch &&
    grant.target === request.target;
}

export class CapabilityRouterRuntime implements CapabilityRuntime {
  private readonly routes = new Map<string, RegisteredCapability>();

  constructor(
    providers: readonly CapabilityProvider[],
    private readonly policy: CapabilityPolicy,
    private readonly platform: CapabilityPlatform,
    private readonly audit?: CapabilityAuditSink,
  ) {
    for (const provider of providers) {
      for (const descriptor of provider.listCapabilities()) {
        if (!isDescriptor(descriptor) || !descriptor.platforms.includes(platform)) {
          continue;
        }
        if (this.routes.has(descriptor.name)) {
          throw new CetaError(
            'invalid_protocol',
            'Multiple providers advertise the same capability',
          );
        }
        this.routes.set(descriptor.name, {descriptor, provider});
      }
    }
  }

  listCapabilities(): readonly CapabilityDescriptor[] {
    return Array.from(this.routes.values(), route => route.descriptor);
  }

  async invoke(request: CapabilityRequest): Promise<CapabilityResult> {
    const candidate = request && typeof request === 'object' ? request : undefined;
    const requestId = candidate?.context?.eventId ?? newId('capability');
    const record = (type: CapabilityAuditEvent['type'], errorCode?: string) => {
      this.audit?.record({
        eventId: newId('capability-event'),
        type,
        requestId,
        capability: candidate?.name ?? 'unknown',
        ...(candidate?.caller ? {caller: candidate.caller} : {}),
        ...(candidate?.deviceId ? {deviceId: candidate.deviceId} : {}),
        ...(candidate?.taskId ? {taskId: candidate.taskId} : {}),
        ...(candidate?.scope ? {scope: candidate.scope} : {}),
        ...(candidate?.target ? {target: candidate.target} : {}),
        ...(errorCode ? {errorCode} : {}),
      });
    };
    record('requested');
    if (!request || !isKnownCapabilityName(request.name)) {
      record('denied', 'permission_denied');
      throw new CetaError('permission_denied', 'Unknown capability denied');
    }

    const route = this.routes.get(request.name);
    if (!route) {
      record('failed', 'unsupported');
      throw new CetaError(
        'unsupported',
        'Capability is not implemented on this platform',
      );
    }

    let grant;
    try {
      if (this.policy.requiresApproval?.(request, route.descriptor)) {
        record('approval_required');
      }
      grant = await this.policy.authorize(request, route.descriptor);
      if (!grant || !grantMatchesRequest(grant, request)) {
        throw new CetaError('permission_denied', 'Capability access was denied');
      }
      this.policy.consume(grant);
    } catch (error) {
      record(error instanceof CetaError && error.code === 'permission_denied' ? 'denied' : 'approval_required', error instanceof CetaError ? error.code : 'permission_denied');
      if (error instanceof CetaError) {
        throw error;
      }
      throw new CetaError('permission_denied', 'Capability access was denied');
    }

    try {
      record('started');
      const result = await route.provider.invoke(request);
      if (
        !result ||
        typeof result !== 'object' ||
        result.name !== request.name ||
        !('output' in result)
      ) {
        throw new CetaError(
          'invalid_protocol',
          'Capability provider returned an invalid result',
        );
      }
      record('completed');
      return result;
    } catch (error) {
      const normalized = normalizeProviderError(error);
      record('failed', normalized.code);
      throw normalized;
    }
  }
}
