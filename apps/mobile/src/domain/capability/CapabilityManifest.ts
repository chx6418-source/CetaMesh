import type {
  CapabilityApprovalPolicy,
  CapabilityAvailability,
  CapabilityName,
  CapabilityPlatform,
  CapabilityRisk,
} from './Capability';
import type {NodeRole} from '../device/NodeRole';

export type MobileCapabilityDescriptor = {
  readonly name: CapabilityName;
  readonly version: number;
  readonly risk: CapabilityRisk;
  readonly platforms: readonly CapabilityPlatform[];
  readonly availability: CapabilityAvailability;
  readonly approvalPolicy: CapabilityApprovalPolicy;
  readonly providerId: string;
  readonly inputSchemaVersion: number;
  readonly outputSchemaVersion: number;
};

export type MobileCapabilityManifest = {
  readonly deviceId: string;
  readonly role: NodeRole;
  readonly manifestVersion: number;
  readonly capabilities: readonly MobileCapabilityDescriptor[];
};
