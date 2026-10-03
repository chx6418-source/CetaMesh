import type { ModelProvider } from '../../domain/model/ModelProvider';
import { CetaError } from '../../shared/errors/CetaError';
export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new CetaError('provider_error', 'Provider already registered');
    }
    this.providers.set(provider.id, provider);
  }
  replace(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }
  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new CetaError('provider_error', 'Configure this provider first');
    }
    return provider;
  }
}
