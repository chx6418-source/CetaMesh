import type {CapabilityRuntime} from '../../runtime/capability/CapabilityRuntime';

export interface AppServices {
  readonly capabilityRuntime: CapabilityRuntime;
}

