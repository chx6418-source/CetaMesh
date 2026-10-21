export const NODE_ROLES = [
  'mobile-node',
  'desktop-node',
  'server-node',
  'channel-adapter',
  'agent-provider',
] as const;

export type NodeRole = (typeof NODE_ROLES)[number];

export function isNodeRole(value: unknown): value is NodeRole {
  return typeof value === 'string' && (NODE_ROLES as readonly string[]).includes(value);
}
