import type {ExtensionManifest} from './ExtensionManifest';

export type RemotePluginRequest = {readonly pluginId: string; readonly version: string; readonly input: unknown};
export interface RemotePluginTransport { invoke(request: RemotePluginRequest): Promise<unknown>; }
export type RemotePluginManifest = ExtensionManifest & {readonly type: 'remote-plugin'; readonly runtime: 'remote'};
