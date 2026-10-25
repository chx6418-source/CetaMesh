import type {ExtensionManifest} from './ExtensionManifest';
import type {SecurityReport, ExtensionSource, ExtensionStatus} from './SecurityReport';

export type InstalledExtension = {
  readonly id: string;
  readonly manifest: ExtensionManifest;
  readonly contentHash: string;
  readonly source: ExtensionSource;
  readonly status: ExtensionStatus;
  readonly securityReport: SecurityReport;
  readonly installedAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly previousManifest?: ExtensionManifest;
  readonly previousContentHash?: string;
};

export interface ExtensionRepository {
  get(extensionId: string, source: ExtensionSource): Promise<InstalledExtension | undefined>;
  save(extension: InstalledExtension): Promise<InstalledExtension>;
  remove(extensionId: string, source: ExtensionSource): Promise<void>;
  list(): Promise<InstalledExtension[]>;
}

export type {ExtensionSource, ExtensionStatus} from './SecurityReport';
