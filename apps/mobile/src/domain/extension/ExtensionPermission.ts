import type {CapabilityName, CapabilityScope} from '../capability/Capability';

export type ExtensionPermission = {readonly capability: CapabilityName; readonly scope: CapabilityScope};
