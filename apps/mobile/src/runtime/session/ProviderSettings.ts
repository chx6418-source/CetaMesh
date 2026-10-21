import type { ProviderConfig } from '../../domain/model/ModelProvider';
import type { ProviderConfigRepository } from '../../domain/model/ProviderConfigRepository';
import type { SecureStorage } from '../../security/SecureStorage';
import { CetaError } from '../../shared/errors/CetaError';
import { validateEndpoint } from '../../shared/utils/endpoint';
import { newId } from '../../shared/utils/id';
export class ProviderSettings {
  private tail: Promise<unknown> = Promise.resolve();
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
  constructor(
    private readonly storage: SecureStorage,
    private readonly repository: ProviderConfigRepository,
  ) {}
  list(): Promise<ProviderConfig[]> {
    return this.repository.list();
  }
  save(
    input: Omit<ProviderConfig, 'credentialRef'>,
    secret: string,
  ): Promise<ProviderConfig> {
    return this.serialized(() => this.saveConfig(input, secret));
  }
  private async saveConfig(
    input: Omit<ProviderConfig, 'credentialRef'>,
    secret: string,
  ): Promise<ProviderConfig> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.id) || !input.name.trim()) {
      throw new CetaError(
        'invalid_protocol',
        'Provider ID and name are required',
      );
    }
    const endpoint = validateEndpoint(input.baseUrl.trim());
    const existing = (await this.repository.list()).find(
      p => p.id === input.id,
    );
    const previous = existing
      ? await this.storage.get(existing.credentialRef)
      : null;
    if (!secret.trim() && !previous) {
      throw new CetaError('unauthorized', 'An API key is required');
    }
    const reference = secret.trim()
      ? existing
        ? 'provider:' + newId('credential')
        : 'provider:' + input.id
      : existing!.credentialRef;
    const config: ProviderConfig = {
      id: input.id,
      name: input.name.trim(),
      baseUrl: endpoint,
      supportsReasoning: input.supportsReasoning,
      credentialRef: reference,
    };
    // A replacement is written under a new reference before atomically publishing
    // metadata. Failure cannot pair the old secret with a newly edited endpoint.
    let staged = false;
    try {
      if (secret.trim()) {
        await this.storage.set(reference, secret.trim());
        staged = true;
      }
      await this.repository.save(config);
    } catch (error) {
      if (staged) {
        await this.storage.delete(reference).catch(() => undefined);
      }
      throw error instanceof CetaError
        ? error
        : new CetaError(
            'storage_error',
            'Provider configuration could not be saved',
          );
    }
    if (existing && existing.credentialRef !== reference) {
      await this.storage.delete(existing.credentialRef).catch(() => undefined);
    }
    return config;
  }
  removeSecret(id: string): Promise<void> {
    return this.serialized(async () => {
      const config = (await this.repository.list()).find(p => p.id === id);
      if (config) {
        await this.storage.delete(config.credentialRef);
      }
    });
  }
}
