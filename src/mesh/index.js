// CetaMesh Desktop Node —— 公共入口（阶段 11）。
export { createMeshService } from './service.js';
export { createMeshNode } from './node.js';
export { createTrustStore } from './trust.js';
export {
  IDENTITY_SCHEMA_VERSION,
  deriveNodeId,
  loadOrCreateIdentity,
  publicKeyAlgorithm,
  publicKeyPemToX963,
  signPayload,
  verifyPayload,
  x963ToPublicKeyPem
} from './identity.js';
export { allCapabilities, capabilityManifest, normalizeRemoteManifest } from './capabilities.js';
export {
  ENVELOPE_TYPES,
  authorizeCapabilityRequest,
  createEnvelope,
  signingString,
  validateEnvelope
} from './protocol.js';
export {
  PAIRING_LIMITS,
  PAIRING_PROTOCOL_TAG,
  REFUSAL_CODES,
  createInvitationEnvelope,
  createMeshEnvelope,
  isPairingRefusal,
  meshSigningString,
  normalizeEndpointOrigin,
  parseInvitation,
  payloadHash,
  tokenFingerprint,
  transcript,
  validateCetameshEnvelope,
  validateMeshEnvelope
} from './pairing/protocol.js';
export { createInvitationStore } from './pairing/invitations.js';
export { createMeshPairingServer } from './pairing/server.js';
export { MESH_ENVELOPE_PATH, httpsPostPinned, requestPeerMesh } from './pairing/client.js';
export { certificateFingerprint, listLanAddresses, loadOrCreatePairingTls, pickLanAddress } from './pairing/tls.js';
export { invitationQr } from './pairing/qr.js';
export {
  CAPABILITY_NAMES,
  MESH_LIMITS,
  MESH_PROTOCOL_VERSION,
  NODE_CAPABILITIES,
  NODE_ROLES,
  PRESENCE_STATES,
  TRANSPORT_KINDS,
  TRUST_STATES,
  capabilityRequiresApproval,
  isKnownCapability,
  meshError,
  normalizeNodeId,
  presenceOf
} from './types.js';
