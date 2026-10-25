import type {UpdateAnnouncement, UpdateCheck, UpdateService} from '../../domain/update/UpdateService';
import type {HttpTransport} from '../network/HttpTransport';

type GitHubAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubAsset[];
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

function versionFromTag(tag: string): string {
  return tag.trim().replace(/^[vV]/, '');
}

function validRelease(value: unknown): value is GitHubRelease {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.tag_name === 'string' && item.draft !== true && item.prerelease !== true;
}

function validAsset(value: unknown): value is GitHubAsset {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.name === 'string' &&
    typeof item.browser_download_url === 'string' &&
    item.browser_download_url.startsWith('https://');
}

export class GitHubReleaseUpdateService implements UpdateService {
  constructor(
    private readonly transport: HttpTransport,
    private readonly currentVersion: string,
    private readonly repository: string,
  ) {}

  private async releases(): Promise<GitHubRelease[]> {
    const value = await this.transport.json({
      url: `https://api.github.com/repos/${this.repository}/releases?per_page=10`,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeoutMs: 15000,
    });
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(validRelease).map(release => ({
      ...release,
      assets: Array.isArray(release.assets) ? release.assets.filter(validAsset) : [],
    }));
  }

  private async latest(): Promise<GitHubRelease | undefined> {
    return (await this.releases()).find(release =>
      release.assets?.some(asset => asset.name.toLowerCase().endsWith('.apk')),
    );
  }

  async checkForUpdate(): Promise<UpdateCheck> {
    const release = await this.latest();
    if (!release) {
      return {status: 'unavailable'};
    }
    const version = versionFromTag(release.tag_name);
    return compareVersions(version, this.currentVersion) > 0
      ? {status: 'available', version}
      : {status: 'current'};
  }

  async getLatestVersion(): Promise<string | undefined> {
    const release = await this.latest();
    return release ? versionFromTag(release.tag_name) : undefined;
  }

  async getReleaseNotes(): Promise<UpdateAnnouncement[]> {
    return (await this.releases()).map(release => ({
      version: versionFromTag(release.tag_name),
      title: release.name?.trim() || `CetaMesh ${versionFromTag(release.tag_name)}`,
      publishedAt: release.published_at?.slice(0, 10) || '',
      content: release.body?.trim() || '此版本未提供更新说明。',
      importance: 'feature',
    }));
  }

  async downloadUpdate(): Promise<string | undefined> {
    const release = await this.latest();
    if (!release) {
      return undefined;
    }
    const version = versionFromTag(release.tag_name);
    if (compareVersions(version, this.currentVersion) <= 0) {
      return undefined;
    }
    return release.assets?.find(asset => asset.name.toLowerCase().endsWith('.apk'))?.browser_download_url;
  }
}
