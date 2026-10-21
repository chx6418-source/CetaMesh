import type {UpdateAnnouncement, UpdateCheck, UpdateService} from '../../domain/update/UpdateService';
import type {HttpTransport} from '../network/HttpTransport';

// CetaMesh Mobile —— GitCode 更新源（中国区优先源，分发运行时 v1）。
//
// 发现入口：GitCode 仓库 ygdnn/CetaMesh 中的版本化清单 `releases/stable.json`，
// 经官方 raw API 拉取（实测端点，2026-10-08 本机匿名验证：
//   GET https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/<path> -> 200 原始文件字节）。
// 大体积 APK 仍走 Release Asset：清单 artifacts.android.url 指向它。
//
// 安全逻辑（与既有 GitHub updater 对齐，不重写已有 Updater）：
//   - 只有**真正带 .apk 安装包**（artifacts.android，https、sha256 为 64 位十六进制）才算 installable update；
//   - 合法「无更新」直接返回 current —— 调用方（FallbackUpdateService）据此**不**访问 GitHub；
//   - 任何失败（网络 / 超时 / 非 2xx / 清单损坏 / 缺 APK）抛出 UpdateSourceError，
//     由 FallbackUpdateService 捕获后降级到 GitHub，绝不把失败静默当作「无更新」。

export const defaultGitCodeManifestUrl =
  'https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main';

export type UpdateSourceId = 'gitcode' | 'github';

export class UpdateSourceError extends Error {
  constructor(
    readonly code:
      | 'network'
      | 'http'
      | 'invalid-manifest'
      | 'no-artifact'
      | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'UpdateSourceError';
  }
}

type ArtifactEntry = {filename: string; url: string; sha256: string; bytes: number};
type UnifiedManifest = {
  schemaVersion: number;
  product?: string;
  channel: string;
  version: string;
  publishedAt?: string;
  sourceCommit?: string;
  notes?: string[];
  artifacts: Record<string, ArtifactEntry>;
};

function versionParts(value: string): number[] {
  const normalized = value.trim().replace(/^[vV]/, '').split('-')[0];
  return normalized.split('.').map(part => {
    const match = part.match(/^\d+/);
    return match ? Number(match[0]) : 0;
  });
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function asArtifact(value: unknown): ArtifactEntry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.filename === 'string' &&
    entry.filename.toLowerCase().endsWith('.apk') &&
    typeof entry.url === 'string' &&
    entry.url.startsWith('https://') &&
    typeof entry.sha256 === 'string' &&
    SHA256_RE.test(entry.sha256) &&
    typeof entry.bytes === 'number' &&
    Number.isInteger(entry.bytes) &&
    entry.bytes > 0
  ) {
    return {filename: entry.filename, url: entry.url, sha256: entry.sha256.toLowerCase(), bytes: entry.bytes};
  }
  return undefined;
}

function asManifest(value: unknown): UnifiedManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UpdateSourceError('invalid-manifest', 'GitCode 清单不是对象');
  }
  const raw = value as Record<string, unknown>;
  if (Number(raw.schemaVersion) !== 1) {
    throw new UpdateSourceError('invalid-manifest', `不支持的清单版本：${String(raw.schemaVersion)}`);
  }
  if (typeof raw.channel !== 'string' || !raw.channel) {
    throw new UpdateSourceError('invalid-manifest', '清单缺少 channel');
  }
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) {
    throw new UpdateSourceError('invalid-manifest', `非法版本号：${String(raw.version)}`);
  }
  if (!raw.artifacts || typeof raw.artifacts !== 'object' || Array.isArray(raw.artifacts)) {
    throw new UpdateSourceError('invalid-manifest', '清单缺少 artifacts');
  }
  const artifacts: Record<string, ArtifactEntry> = {};
  for (const [key, entry] of Object.entries(raw.artifacts as Record<string, unknown>)) {
    const parsed = asArtifact(entry);
    if (parsed) {
      artifacts[key] = parsed;
    }
  }
  const notes = Array.isArray(raw.notes) ? raw.notes.map(item => String(item)).slice(0, 100) : [];
  return {
    schemaVersion: 1,
    product: typeof raw.product === 'string' ? raw.product : undefined,
    channel: raw.channel,
    version: raw.version,
    publishedAt: typeof raw.publishedAt === 'string' ? raw.publishedAt : undefined,
    sourceCommit: typeof raw.sourceCommit === 'string' ? raw.sourceCommit : undefined,
    notes,
    artifacts,
  };
}

export class GitCodeManifestUpdateService implements UpdateService {
  constructor(
    private readonly transport: HttpTransport,
    private readonly currentVersion: string,
    private readonly manifestUrl: string = defaultGitCodeManifestUrl,
  ) {}

  /** 拉取并校验清单；失败抛 UpdateSourceError（由 FallbackUpdateService 决定是否降级）。 */
  private async manifest(): Promise<UnifiedManifest> {
    let value: unknown;
    try {
      value = await this.transport.json({
        url: this.manifestUrl,
        headers: {Accept: 'application/json'},
        timeoutMs: 6000,
      });
    } catch (error) {
      throw new UpdateSourceError('network', `GitCode 更新源不可用：${String((error as Error)?.message ?? error)}`);
    }
    return asManifest(value);
  }

  private async installable(): Promise<{manifest: UnifiedManifest; apk: ArtifactEntry}> {
    const manifest = await this.manifest();
    const apk = manifest.artifacts.android;
    if (!apk) {
      throw new UpdateSourceError('no-artifact', 'GitCode 清单没有可安装的 APK 安装包');
    }
    return {manifest, apk};
  }

  async checkForUpdate(): Promise<UpdateCheck> {
    const installable = await this.installable();
    return compareVersions(installable.manifest.version, this.currentVersion) > 0
      ? {status: 'available', version: installable.manifest.version, source: 'gitcode'}
      : {status: 'current'};
  }

  async getLatestVersion(): Promise<string | undefined> {
    return (await this.manifest()).version;
  }

  async getReleaseNotes(): Promise<UpdateAnnouncement[]> {
    const manifest = await this.manifest();
    return (manifest.notes ?? []).map(note => ({
      version: manifest.version,
      title: `CetaMesh ${manifest.version}`,
      publishedAt: manifest.publishedAt?.slice(0, 10) || '',
      content: note,
      importance: 'feature',
    }));
  }

  async downloadUpdate(): Promise<string | undefined> {
    const installable = await this.installable();
    if (compareVersions(installable.manifest.version, this.currentVersion) <= 0) {
      return undefined;
    }
    return installable.apk.url;
  }
}
