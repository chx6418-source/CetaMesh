export const CETAMESH_PROTOCOL = 'cetamesh' as const;
export const CETAMESH_PROTOCOL_VERSION = 1 as const;

export type ProtocolEnvelope = {
  protocol: typeof CETAMESH_PROTOCOL;
  version: typeof CETAMESH_PROTOCOL_VERSION;
  id: string;
  type: string;
  timestamp: string;
  payload: unknown;
};
