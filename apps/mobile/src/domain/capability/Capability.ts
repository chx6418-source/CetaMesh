import type {CorrelationContext} from '../../shared';

export type CapabilityPlatform = 'android' | 'ios';
export type CapabilityRisk = 'low' | 'medium' | 'high' | 'critical';
export type CapabilityAvailability = 'available' | 'unavailable' | 'degraded';
export type CapabilityApprovalPolicy = 'none' | 'ask' | 'allow-once';
export type CapabilityScopeKind = 'local' | 'task' | 'device' | 'mesh';

export type CapabilityScope = {
  readonly kind: CapabilityScopeKind;
  readonly id?: string;
};

export type CapabilityName =
  | 'camera.capture'
  | 'camera.scanDocument'
  | 'camera.scanQr'
  | 'microphone.record'
  | 'location.current'
  | 'nfc.read'
  | 'nfc.write'
  | 'bluetooth.scan'
  | 'bluetooth.connect'
  | 'file.pick'
  | 'photos.select'
  | 'share.receive'
  | 'share.send'
  | 'notification.send';

export const CAPABILITY_CATALOG: readonly CapabilityName[] = [
  'camera.capture',
  'camera.scanDocument',
  'camera.scanQr',
  'microphone.record',
  'location.current',
  'nfc.read',
  'nfc.write',
  'bluetooth.scan',
  'bluetooth.connect',
  'file.pick',
  'photos.select',
  'share.receive',
  'share.send',
  'notification.send',
];

export type CapabilityDescriptor = {
  readonly name: CapabilityName;
  readonly version: number;
  readonly platforms: readonly CapabilityPlatform[];
  readonly requiresPermission: boolean;
  readonly risk?: CapabilityRisk;
  readonly availability?: CapabilityAvailability;
  readonly approvalPolicy?: CapabilityApprovalPolicy;
  readonly providerId?: string;
  readonly inputSchemaVersion?: number;
  readonly outputSchemaVersion?: number;
};

export type CapabilityRequest = {
  readonly name: string;
  readonly input?: unknown;
  readonly caller?: string;
  readonly deviceId?: string;
  readonly taskId?: string;
  readonly scope?: CapabilityScope;
  readonly target?: string;
  readonly expiresAt?: string;
  readonly context?: CorrelationContext;
};

export type CapabilityResult = {
  readonly name: string;
  readonly output: unknown;
};

export interface CapabilityProvider {
  listCapabilities(): readonly CapabilityDescriptor[];
  invoke(request: CapabilityRequest): Promise<CapabilityResult>;
}

export function isKnownCapabilityName(name: string): name is CapabilityName {
  return (CAPABILITY_CATALOG as readonly string[]).includes(name);
}
