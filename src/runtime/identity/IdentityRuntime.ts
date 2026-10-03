import { validateIdentity } from '../../domain/identity/DeviceIdentity';
import type { DeviceIdentity, IdentityProvider } from '../../domain/identity/DeviceIdentity';
import { CetaError } from '../../shared/errors/CetaError';
export class IdentityRuntime {
  private pending?: Promise<DeviceIdentity>;
  constructor(private readonly provider: IdentityProvider) {}
  async get(): Promise<DeviceIdentity> {
    if (!this.pending) {
      this.pending = this.load().catch(error => {this.pending = undefined; throw error;});
    }
    return {...await this.pending};
  }
  private async load(): Promise<DeviceIdentity> {
    try {
      const raw = await this.provider.getIdentity();
      if (raw.length>4096) {throw new Error('Invalid size');}
      return validateIdentity(JSON.parse(raw));
    } catch (error) {
      const code = error && typeof error==='object' && 'code' in error && error.code==='unsupported' ? 'unsupported' : 'storage_error';
      throw new CetaError(code,'Device identity is unavailable');
    }
  }
}
