import * as Keychain from 'react-native-keychain';
import type { SecureStorage } from '../../security/SecureStorage';
import { CetaError } from '../../shared/errors/CetaError';
type Driver = {
  setGenericPassword(
    username: string,
    password: string,
    options: { service: string; accessible?: Keychain.ACCESSIBLE },
  ): Promise<unknown>;
  getGenericPassword(options: {
    service: string;
  }): Promise<false | { password: string }>;
  resetGenericPassword(options: { service: string }): Promise<unknown>;
};
export class KeychainStorage implements SecureStorage {
  constructor(private readonly driver: Driver = Keychain) {}
  private service(reference: string): string {
    if (!/^provider:[a-zA-Z0-9_-]{1,64}$/.test(reference)) {
      throw new CetaError('invalid_protocol', 'Invalid credential reference');
    }
    return 'com.cetamesh.mobile.' + reference;
  }
  async set(reference: string, secret: string): Promise<void> {
    const service = this.service(reference);
    try {
      const saved = await this.driver.setGenericPassword('model-api', secret, {
        service,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      if (!saved) {
        throw new CetaError('storage_error', 'Secure storage write failed');
      }
    } catch {
      throw new CetaError('storage_error', 'Secure storage write failed');
    }
  }
  async get(reference: string): Promise<string | null> {
    const service = this.service(reference);
    try {
      const result = await this.driver.getGenericPassword({ service });
      return result ? result.password : null;
    } catch {
      throw new CetaError('storage_error', 'Secure storage read failed');
    }
  }
  async delete(reference: string): Promise<void> {
    const service = this.service(reference);
    try {
      await this.driver.resetGenericPassword({ service });
      if (await this.driver.getGenericPassword({ service })) {
        throw new CetaError('storage_error', 'Secure storage deletion failed');
      }
    } catch {
      throw new CetaError('storage_error', 'Secure storage deletion failed');
    }
  }
}
