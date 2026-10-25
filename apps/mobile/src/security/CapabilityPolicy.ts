import type {
  CapabilityDescriptor,
  CapabilityName,
  CapabilityRequest,
  CapabilityScope,
} from '../domain/capability/Capability';
import {isKnownCapabilityName} from '../domain/capability/Capability';
import {CetaError} from '../shared/errors/CetaError';

export type CapabilityPolicyMode = 'deny' | 'ask' | 'allow-once';

export type CapabilityPromptDecision = 'deny' | 'allow-once';

export type CapabilityPolicyPrompt = (
  request: CapabilityRequest,
  descriptor: CapabilityDescriptor,
) => Promise<CapabilityPromptDecision>;

export type CapabilityGrant = {
  readonly name: string;
  readonly expiresAt: number;
  readonly caller?: string;
  readonly deviceId?: string;
  readonly taskId?: string;
  readonly scope?: CapabilityScope;
  readonly target?: string;
};

export interface CapabilityPolicy {
  authorize(
    request: CapabilityRequest,
    descriptor: CapabilityDescriptor,
  ): Promise<CapabilityGrant>;
  consume(grant: CapabilityGrant): void;
  requiresApproval?(
    request: CapabilityRequest,
    descriptor: CapabilityDescriptor,
  ): boolean;
}

export type InMemoryCapabilityPolicyOptions = {
  readonly modes?: Partial<Record<CapabilityName, CapabilityPolicyMode>>;
  readonly clock?: () => number;
  readonly grantTtlMs?: number;
};

export class InMemoryCapabilityPolicy implements CapabilityPolicy {
  private readonly modes = new Map<CapabilityName, CapabilityPolicyMode>();
  private readonly grants = new WeakSet<CapabilityGrant>();
  private readonly clock: () => number;
  private readonly grantTtlMs: number;

  constructor(
    private readonly prompt: CapabilityPolicyPrompt,
    options: InMemoryCapabilityPolicyOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    const grantTtlMs = options.grantTtlMs;
    this.grantTtlMs =
      typeof grantTtlMs === 'number' &&
      Number.isFinite(grantTtlMs) &&
      grantTtlMs > 0
        ? grantTtlMs
        : 60_000;
    for (const [name, mode] of Object.entries(options.modes ?? {})) {
      if (isKnownCapabilityName(name)) {
        this.modes.set(name, mode);
      }
    }
  }

  getMode(name: string): CapabilityPolicyMode {
    if (!isKnownCapabilityName(name)) {
      return 'deny';
    }
    return this.modes.get(name) ?? 'deny';
  }

  requiresApproval(request: CapabilityRequest, descriptor: CapabilityDescriptor): boolean {
    return request.name === descriptor.name && this.getMode(request.name) === 'ask';
  }

  setMode(name: string, mode: CapabilityPolicyMode): void {
    if (!isKnownCapabilityName(name)) {
      throw new CetaError('permission_denied', 'Unknown capability denied');
    }
    this.modes.set(name, mode);
  }

  async authorize(
    request: CapabilityRequest,
    descriptor: CapabilityDescriptor,
  ): Promise<CapabilityGrant> {
    if (
      !isKnownCapabilityName(request.name) ||
      request.name !== descriptor.name ||
      !isKnownCapabilityName(descriptor.name)
    ) {
      throw new CetaError('permission_denied', 'Unknown capability denied');
    }

    let mode = this.getMode(request.name);
    if (mode === 'deny') {
      throw new CetaError('permission_denied', 'Capability access was denied');
    }

    if (mode === 'ask') {
      let decision: CapabilityPromptDecision;
      try {
        decision = await this.prompt(request, descriptor);
      } catch {
        throw new CetaError(
          'permission_denied',
          'Capability access was not confirmed',
        );
      }
      if (decision !== 'allow-once') {
        throw new CetaError('permission_denied', 'Capability access was denied');
      }
    } else if (mode === 'allow-once') {
      // A configured allow-once rule is consumed by this authorization. The
      // next request must ask again instead of silently becoming persistent.
      this.modes.set(request.name, 'ask');
    }

    const grant = Object.freeze({
      name: request.name,
      expiresAt: this.clock() + this.grantTtlMs,
      ...(request.caller ? {caller: request.caller} : {}),
      ...(request.deviceId ? {deviceId: request.deviceId} : {}),
      ...(request.taskId ? {taskId: request.taskId} : {}),
      ...(request.scope ? {scope: request.scope} : {}),
      ...(request.target ? {target: request.target} : {}),
    });
    this.grants.add(grant);
    return grant;
  }

  consume(grant: CapabilityGrant): void {
    const known = this.grants.delete(grant);
    if (!known || grant.expiresAt <= this.clock()) {
      throw new CetaError('permission_denied', 'Invalid or expired capability grant');
    }
  }
}
