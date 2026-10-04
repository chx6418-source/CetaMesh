import type {HttpRequest, HttpTransport} from '../providers/network/HttpTransport';
import {GitHubReleaseUpdateService} from '../providers/update/GitHubReleaseUpdateService';

class StaticTransport implements HttpTransport {
  constructor(private readonly response: unknown) {}
  async json(_request: HttpRequest): Promise<unknown> {
    return this.response;
  }
  async *stream(_request: HttpRequest): AsyncIterable<string> {
    return;
  }
}

const release = {
  tag_name: 'v0.0.2',
  name: 'CetaMesh Mobile 0.0.2',
  body: '修复更新检查并改进关于应用。',
  published_at: '2026-10-02T15:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'cetamesh-mobile-0.0.2.apk',
      browser_download_url: 'https://github.com/chx6418-source/cetamesh-mobile/releases/download/v0.0.2/cetamesh-mobile-0.0.2.apk',
    },
  ],
};

test('GitHub release updater reports newer stable versions and APK assets', async () => {
  const service = new GitHubReleaseUpdateService(new StaticTransport([release]), '0.0.1', 'public-owner/mobile-releases');
  await expect(service.checkForUpdate()).resolves.toEqual({status: 'available', version: '0.0.2'});
  await expect(service.getLatestVersion()).resolves.toBe('0.0.2');
  await expect(service.downloadUpdate()).resolves.toContain('.apk');
  await expect(service.getReleaseNotes()).resolves.toEqual([
    expect.objectContaining({
      version: '0.0.2',
      title: 'CetaMesh Mobile 0.0.2',
      content: '修复更新检查并改进关于应用。',
      publishedAt: '2026-10-02',
    }),
  ]);
});

test('GitHub release updater reports current version and ignores drafts or prereleases', async () => {
  const current = new GitHubReleaseUpdateService(new StaticTransport([release]), '0.0.2', 'public-owner/mobile-releases');
  await expect(current.checkForUpdate()).resolves.toEqual({status: 'current'});
  await expect(current.downloadUpdate()).resolves.toBeUndefined();

  const unavailable = new GitHubReleaseUpdateService(new StaticTransport([
    {...release, draft: true},
    {...release, tag_name: 'v0.0.3-beta.1', draft: false, prerelease: true},
  ]), '0.0.1', 'public-owner/mobile-releases');
  await expect(unavailable.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  await expect(unavailable.getLatestVersion()).resolves.toBeUndefined();
});

test('GitHub release updater handles an empty release feed', async () => {
  const service = new GitHubReleaseUpdateService(new StaticTransport([]), '0.0.1', 'public-owner/mobile-releases');
  await expect(service.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  await expect(service.getReleaseNotes()).resolves.toEqual([]);
  await expect(service.downloadUpdate()).resolves.toBeUndefined();
});

test('GitHub release updater does not advertise a ZIP-only release as an installable update', async () => {
  const zipOnly = {...release, assets: [{
    name: 'cetamesh-mobile-android-standalone.zip',
    browser_download_url: 'https://github.com/chx6418-source/CetaMesh/releases/download/V1.1.0/mobile.zip',
  }]};
  const service = new GitHubReleaseUpdateService(new StaticTransport([zipOnly]), '0.0.1', 'chx6418-source/CetaMesh');
  await expect(service.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  await expect(service.getLatestVersion()).resolves.toBeUndefined();
  await expect(service.downloadUpdate()).resolves.toBeUndefined();
});
