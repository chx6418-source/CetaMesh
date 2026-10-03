import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/** Public-only native boundary. See README.md for encoding and failure semantics. */
export interface Spec extends TurboModule {
  getIdentity(): Promise<string>;
  sign(data: string): Promise<string>;
  verify(publicKey: string, data: string, signature: string): Promise<boolean>;
  randomNonce(): Promise<string>;
  fingerprint(token: string): Promise<string>;
}

// Nullable lookup lets the runtime map a missing native build to `unsupported`.
export default TurboModuleRegistry.get<Spec>('CetaDeviceIdentity');
