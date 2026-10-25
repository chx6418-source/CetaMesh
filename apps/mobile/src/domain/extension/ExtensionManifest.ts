import type {CapabilityPlatform, CapabilityScope} from '../capability/Capability';

export const EXTENSION_TYPES = ['declarative-tool', 'memory-pack', 'remote-plugin', 'workflow', 'ui-extension'] as const;
export type ExtensionType = (typeof EXTENSION_TYPES)[number];
export type ExtensionRuntime = 'declarative' | 'remote';
export type ExtensionNetworkAccess = 'none' | 'declared' | 'remote-declared';

export type ExtensionManifest = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly type: ExtensionType;
  readonly publisher: string;
  readonly platforms: readonly CapabilityPlatform[];
  readonly runtime: ExtensionRuntime;
  readonly permissions: readonly {readonly capability: string; readonly scope: CapabilityScope}[];
  readonly capabilities: readonly string[];
  readonly networkAccess: {readonly mode: ExtensionNetworkAccess};
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly minimumProtocolVersion: number;
};
