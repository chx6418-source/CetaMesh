export type {
  CapabilityDescriptor,
  CapabilityName,
  CapabilityPlatform,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
  CapabilityScope,
  CapabilityRisk,
  CapabilityAvailability,
  CapabilityApprovalPolicy,
} from '../../domain/capability/Capability';

import type {
  CapabilityDescriptor,
  CapabilityRequest,
} from '../../domain/capability/Capability';
export interface CapabilityRuntime {
  invoke(request: CapabilityRequest): Promise<unknown>;
  listCapabilities?(): readonly CapabilityDescriptor[];
}
