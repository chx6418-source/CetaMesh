import type { ProviderConfig } from './ModelProvider';
export interface ProviderConfigRepository {
  list(): Promise<ProviderConfig[]>;
  save(config: ProviderConfig): Promise<void>;
}
