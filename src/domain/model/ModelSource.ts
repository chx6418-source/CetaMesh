export const MODEL_SOURCES = ['cloud', 'desktop-node', 'local-network', 'on-device'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];
