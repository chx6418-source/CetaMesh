import type { CredentialReader } from '../domain/model/ModelProvider';
export interface SecureStorage extends CredentialReader {
  set(reference: string, secret: string): Promise<void>;
  delete(reference: string): Promise<void>;
}
