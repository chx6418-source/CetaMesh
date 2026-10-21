import type {HttpRequest, HttpTransport} from '../providers/network/HttpTransport';
import {FallbackUpdateService} from '../providers/update/FallbackUpdateService';
import {
  GitCodeManifestUpdateService,
  defaultGitCodeManifestUrl,
} from '../providers/update/GitCodeManifestUpdateService';
import {GitHubReleaseUpdateService} from '../providers/update/GitHubReleaseUpdateService';

// CetaMesh Mobile —— 分发运行时：GitCode 主源 + GitHub 备用源编排回归。
// 覆盖：GitCode 成功（含 source 标注、不触达 GitHub）/ 合法无更新不触达 GitHub / 版本回退 /
//       网络失败降级 / 清单损坏或缺 APK 降级 / 两源都失败 → unavailable / 只认 APK 安装包。

class RecordingTransport implements HttpTransport {
  readonly calls: string[] = [];
  constructor(private readonly routes: Array<[string, () => unknown]>) {}
  async json(request: HttpRequest): Promise<unknown> {
    const url = String(request.url);
    this.calls.push(url);
    const hit = this.routes.find(([match]) => url.includes(match));
    if (!hit) {
      throw new Error(`no route for ${url}`);
    }
    return hit[1]();
  }
  async *stream(_request: HttpRequest): AsyncIterable<string> {
    return;
  }
}

const manifest = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  product: 'CetaMesh',
  channel: 'stable',
  version: '0.0.2',
  publishedAt: '2026-10-08T12:00:00Z',
  sourceCommit: 'e8a122af6b70cef73ac1b5dd559e14f9e5f5e60f',
  notes: ['GitCode 首发：中国区更新源上线'],
  artifacts: {
    android: {
      filename: 'cetamesh-mobile-0.0.2.apk',
      url: 'https://gitcode.com/ygdnn/CetaMesh/releases/download/v0.0.2/cetamesh-mobile-0.0.2.apk',
      sha256: 'a'.repeat(64),
      bytes: 30485760,
    },
  },
  ...over,
});

const githubRelease = {
  tag_name: 'v0.0.3',
  name: 'CetaMesh Mobile 0.0.3',
  body: 'GitHub 备用源发布。',
  published_at: '2026-10-09T09:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    {
      name: 'cetamesh-mobile-0.0.3.apk',
      browser_download_url:
        'https://github.com/chx6418-source/CetaMesh/releases/download/v0.0.3/cetamesh-mobile-0.0.3.apk',
    },
  ],
};

const service = (transport: HttpTransport, currentVersion = '0.0.1') =>
  new FallbackUpdateService(
    new GitCodeManifestUpdateService(transport, currentVersion, defaultGitCodeManifestUrl),
    new GitHubReleaseUpdateService(transport, currentVersion, 'chx6418-source/CetaMesh'),
  );

test('GitCode 清单成功：报新版本并标注来源，不访问 GitHub', async () => {
  const transport = new RecordingTransport([
    ['gitcode.com', () => manifest()],
    ['api.github.com', () => [githubRelease]],
  ]);
  const updates = service(transport);
  await expect(updates.checkForUpdate()).resolves.toEqual({
    status: 'available',
    version: '0.0.2',
    source: 'gitcode',
  });
  expect(transport.calls).toHaveLength(1);
  await expect(updates.downloadUpdate()).resolves.toContain('.apk');
  expect(transport.calls).toHaveLength(2);
});

test('GitCode 合法「无更新」不访问 GitHub', async () => {
  const transport = new RecordingTransport([
    ['gitcode.com', () => manifest({version: '0.0.1'})],
    ['api.github.com', () => [githubRelease]],
  ]);
  const updates = service(transport);
  await expect(updates.checkForUpdate()).resolves.toEqual({status: 'current'});
  expect(transport.calls).toHaveLength(1);
  await expect(updates.downloadUpdate()).resolves.toBeUndefined();
  expect(transport.calls).toHaveLength(2);
});

test('GitCode 清单版本回退/同版本 → current（不提示旧版本）', async () => {
  const transport = new RecordingTransport([['gitcode.com', () => manifest({version: '0.0.1'})]]);
  await expect(service(transport, '0.0.5').checkForUpdate()).resolves.toEqual({status: 'current'});
});

test('GitCode 网络失败 → GitHub 备用源（并标注来源）', async () => {
  const transport = new RecordingTransport([
    ['gitcode.com', () => {
      throw new Error('timeout');
    }],
    ['api.github.com', () => [githubRelease]],
  ]);
  const updates = service(transport);
  await expect(updates.checkForUpdate()).resolves.toEqual({
    status: 'available',
    version: '0.0.3',
    source: 'github',
  });
  expect(transport.calls.some((url) => url.includes('api.github.com'))).toBe(true);
  await expect(updates.downloadUpdate()).resolves.toContain('.apk');
});

test('GitCode 清单损坏或缺 APK → GitHub 备用源', async () => {
  const broken = [
    manifest({artifacts: {}}),
    manifest({artifacts: {android: {filename: 'x.zip', url: 'https://gitcode.com/x.zip', sha256: 'a'.repeat(64), bytes: 10}}}),
    manifest({artifacts: {android: {filename: 'x.apk', url: 'https://gitcode.com/x.apk', sha256: 'not-a-sha', bytes: 10}}}),
    {...manifest(), schemaVersion: 2},
  ];
  for (const value of broken) {
    const transport = new RecordingTransport([
      ['gitcode.com', () => value],
      ['api.github.com', () => [githubRelease]],
    ]);
    await expect(service(transport).checkForUpdate()).resolves.toEqual({
      status: 'available',
      version: '0.0.3',
      source: 'github',
    });
    expect(transport.calls.some((url) => url.includes('api.github.com'))).toBe(true);
  }
});

test('两个源都失败 → unavailable（不是「已是最新」）', async () => {
  const transport = new RecordingTransport([
    ['gitcode.com', () => {
      throw new Error('timeout');
    }],
    ['api.github.com', () => {
      throw new Error('offline');
    }],
  ]);
  const updates = service(transport);
  await expect(updates.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  await expect(updates.getLatestVersion()).resolves.toBeUndefined();
  await expect(updates.getReleaseNotes()).resolves.toEqual([]);
  await expect(updates.downloadUpdate()).resolves.toBeUndefined();
});

test('缺 APK 的 GitHub release 不算 installable update（备用源同样只认 APK）', async () => {
  const zipOnly = {...githubRelease, assets: [{name: 'x.zip', browser_download_url: 'https://github.com/x.zip'}]};
  const transport = new RecordingTransport([
    ['gitcode.com', () => {
      throw new Error('timeout');
    }],
    ['api.github.com', () => [zipOnly]],
  ]);
  await expect(service(transport).checkForUpdate()).resolves.toEqual({status: 'unavailable'});
});

test('GitCode 更新说明（notes）可读', async () => {
  const transport = new RecordingTransport([['gitcode.com', () => manifest()]]);
  await expect(service(transport).getReleaseNotes()).resolves.toEqual([
    expect.objectContaining({
      version: '0.0.2',
      content: 'GitCode 首发：中国区更新源上线',
      publishedAt: '2026-10-08',
    }),
  ]);
});

test('GitCode 源单独使用时对失败如实抛错（由编排层决定是否降级）', async () => {
  const transport = new RecordingTransport([
    ['gitcode.com', () => {
      throw new Error('offline');
    }],
  ]);
  const gitcode = new GitCodeManifestUpdateService(transport, '0.0.1', defaultGitCodeManifestUrl);
  await expect(gitcode.checkForUpdate()).rejects.toMatchObject({code: 'network'});
});
