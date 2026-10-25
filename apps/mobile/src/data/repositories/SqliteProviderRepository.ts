import type { ProviderConfigRepository } from '../../domain/model/ProviderConfigRepository';
import type { ProviderConfig } from '../../domain/model/ModelProvider';
import type { SqliteConnection } from '../database/SqliteConnection';
import { serializeConnection } from '../database/serializeConnection';
import { CetaError } from '../../shared/errors/CetaError';
export class SqliteProviderRepository implements ProviderConfigRepository {
  private readonly db: SqliteConnection;
  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }
  async list(): Promise<ProviderConfig[]> {
    try {
      return (
        await this.db.executeAsync(
          'SELECT * FROM model_providers ORDER BY name,id',
        )
      ).results.map(r => ({
        id: String(r.id),
        name: String(r.name),
        baseUrl: String(r.base_url),
        credentialRef: String(r.credential_ref),
        supportsReasoning: r.supports_reasoning === 1,
      }));
    } catch {
      throw new CetaError(
        'storage_error',
        'Provider settings could not be read',
      );
    }
  }
  async save(config: ProviderConfig): Promise<void> {
    try {
      await this.db.executeAsync(
        'INSERT INTO model_providers(id,name,base_url,credential_ref,supports_reasoning) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,credential_ref=excluded.credential_ref,supports_reasoning=excluded.supports_reasoning',
        [
          config.id,
          config.name,
          config.baseUrl,
          config.credentialRef,
          config.supportsReasoning ? 1 : 0,
        ],
      );
    } catch {
      throw new CetaError(
        'storage_error',
        'Provider settings could not be saved',
      );
    }
  }
}
