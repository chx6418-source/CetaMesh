import type {ExtensionManifest} from '../../domain/extension/ExtensionManifest';
import type {ExtensionRepository, InstalledExtension} from '../../domain/extension/ExtensionRepository';
import type {ExtensionSource, ExtensionStatus, SecurityReport} from '../../domain/extension/SecurityReport';
import {CetaError} from '../../shared/errors/CetaError';
import {iso} from '../../protocol/PairingProtocol';
import type {SqliteConnection, SqliteValue} from '../database/SqliteConnection';
import {serializeConnection} from '../database/serializeConnection';

type Row = Record<string, SqliteValue>;

function extensionId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,95}$/.test(value)) {
    throw new CetaError('invalid_protocol', 'Invalid extension identifier');
  }
  return value;
}

function source(value: string): ExtensionSource {
  if (value !== 'base' && value !== 'user-overlay' && value !== 'import') {
    throw new CetaError('storage_error', 'Invalid stored extension source');
  }
  return value;
}

function status(value: string): ExtensionStatus {
  if (value !== 'installed' && value !== 'enabled' && value !== 'disabled') {
    throw new CetaError('storage_error', 'Invalid stored extension status');
  }
  return value;
}

function json(value: unknown, message: string): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new CetaError('invalid_protocol', message);
  }
  if (!encoded || encoded.length > 131_072) {
    throw new CetaError('invalid_protocol', message);
  }
  return encoded;
}

function decode(row: Row): InstalledExtension {
  const id = extensionId(String(row.extension_id));
  const extensionSource = source(String(row.source));
  const extensionStatus = status(String(row.status));
  const manifest = JSON.parse(String(row.manifest)) as ExtensionManifest;
  const securityReport = JSON.parse(String(row.security_report)) as SecurityReport;
  const installedAt = iso(row.installed_at);
  const updatedAt = iso(row.updated_at);
  return {
    id,
    manifest,
    contentHash: String(row.content_hash),
    source: extensionSource,
    status: extensionStatus,
    securityReport,
    installedAt,
    updatedAt,
    revision: Number(row.revision),
    ...(row.previous_manifest === null ? {} : {previousManifest: JSON.parse(String(row.previous_manifest)) as ExtensionManifest}),
    ...(row.previous_content_hash === null ? {} : {previousContentHash: String(row.previous_content_hash)}),
  };
}

export class SqliteExtensionRepository implements ExtensionRepository {
  private readonly db: SqliteConnection;

  constructor(db: SqliteConnection) {
    this.db = serializeConnection(db);
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof CetaError ? error : new CetaError('storage_error', 'Extension storage operation failed');
    }
  }

  async get(extensionIdValue: string, extensionSource: ExtensionSource): Promise<InstalledExtension | undefined> {
    const id = extensionId(extensionIdValue);
    const checkedSource = source(extensionSource);
    return this.safe(async () => {
      const row = (await this.db.executeAsync('SELECT * FROM extensions WHERE extension_id=? AND source=?', [id, checkedSource])).results[0];
      return row ? decode(row) : undefined;
    });
  }

  async save(extension: InstalledExtension): Promise<InstalledExtension> {
    const id = extensionId(extension.id);
    const extensionSource = source(extension.source);
    const extensionStatus = status(extension.status);
    if (!Number.isInteger(extension.revision) || extension.revision < 1) {
      throw new CetaError('invalid_protocol', 'Invalid extension revision');
    }
    iso(extension.installedAt);
    iso(extension.updatedAt);
    const manifest = json(extension.manifest, 'Extension manifest is too large');
    const securityReport = json(extension.securityReport, 'Extension security report is too large');
    const previousManifest = extension.previousManifest === undefined ? null : json(extension.previousManifest, 'Previous extension manifest is too large');
    return this.safe(async () => {
      await this.db.executeAsync(
        `INSERT INTO extensions(extension_id,source,manifest,content_hash,status,security_report,installed_at,updated_at,revision,previous_manifest,previous_content_hash)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(extension_id,source) DO UPDATE SET manifest=excluded.manifest,content_hash=excluded.content_hash,status=excluded.status,security_report=excluded.security_report,installed_at=excluded.installed_at,updated_at=excluded.updated_at,revision=excluded.revision,previous_manifest=excluded.previous_manifest,previous_content_hash=excluded.previous_content_hash`,
        [id, extensionSource, manifest, extension.contentHash, extensionStatus, securityReport, extension.installedAt, extension.updatedAt, extension.revision, previousManifest, extension.previousContentHash ?? null],
      );
      const stored = (await this.db.executeAsync('SELECT * FROM extensions WHERE extension_id=? AND source=?', [id, extensionSource])).results[0];
      if (!stored) {
        throw new CetaError('storage_error', 'Extension was not stored');
      }
      return decode(stored);
    });
  }

  async remove(extensionIdValue: string, extensionSource: ExtensionSource): Promise<void> {
    const id = extensionId(extensionIdValue);
    const checkedSource = source(extensionSource);
    await this.safe(async () => {
      await this.db.executeAsync('DELETE FROM extensions WHERE extension_id=? AND source=?', [id, checkedSource]);
    });
  }

  list(): Promise<InstalledExtension[]> {
    return this.safe(async () => (await this.db.executeAsync('SELECT * FROM extensions ORDER BY updated_at DESC,extension_id,source')).results.map(decode));
  }
}
