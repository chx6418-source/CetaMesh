export type CapabilityBoundary = {readonly kind: 'capability'};
export type {
  CapabilityDescriptor,
  CapabilityName,
  CapabilityPlatform,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
  CapabilityApprovalPolicy,
  CapabilityAvailability,
  CapabilityRisk,
  CapabilityScope,
  CapabilityScopeKind,
} from './Capability';
export {CAPABILITY_CATALOG, isKnownCapabilityName} from './Capability';
export type {MobileCapabilityDescriptor, MobileCapabilityManifest} from './CapabilityManifest';
export type {CapabilityAuditEvent, CapabilityAuditSink, CapabilityAuditType} from './CapabilityAudit';
export {InMemoryCapabilityAuditLog} from './CapabilityAudit';
export type {CameraCaptureNativeResult} from './CameraCapture';
export {parseCameraCaptureNativeResult} from './CameraCapture';
export type {
  MicrophoneRecordNativeResult,
  MicrophoneRecording,
} from './MicrophoneRecord';
export {parseMicrophoneRecordNativeResult} from './MicrophoneRecord';
export type {NotificationPayload} from './NotificationSend';
export {parseNotificationPayload} from './NotificationSend';
