// CetaMesh Desktop Node —— 公共入口（阶段 11）。
export { createMeshService } from './service.js';
export { createMeshNode } from './node.js';
export { createTrustStore } from './trust.js';
export { loadOrCreateIdentity, deriveNodeId, signPayload, verifyPayload } from './identity.js';
export { allCapabilities, capabilityManifest, normalizeRemoteManifest } from './capabilities.js';
export {
  ENVELOPE_TYPES,
  authorizeCapabilityRequest,
  createEnvelope,
  signingString,
  validateEnvelope
} from './protocol.js';
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
