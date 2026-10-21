import type {HttpRequest, HttpTransport} from '../providers/network/HttpTransport';
import {createUpdateService} from '../app/bootstrap/updateSource';

// 分发运行时 v1：GitCode 中国区优先源 → GitHub 备用源。
// 两个源都不可用时 checkForUpdate 返回 unavailable（诚实语义）；合法「无更新」返回 current
// 且不会访问备用源（见 gitcode-update-source.test.ts 的编排回归）。

test('the app checks the GitCode primary source then the public GitHub fallback by default', async () => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    json: async request => {requests.push(request); return [];},
    stream: async function* () {return;},
  };
  const updates = createUpdateService(transport, '1.0');
  await expect(updates.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  expect(requests.map(request => request.url)).toEqual([
    // 1) GitCode 优先源（实测端点：官方 raw API 拉取仓库内版本化清单）
    'https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main',
    // 2) GitCode 不可用（此处返回的不是合法清单）→ 降级到公开 GitHub Releases
    'https://api.github.com/repos/chx6418-source/CetaMesh/releases?per_page=10',
  ]);
});

test('the release source can be replaced without changing the updater', async () => {
  const urls: string[] = [];
  const transport: HttpTransport = {
    json: async request => {urls.push(request.url); return [];},
    stream: async function* () {return;},
  };
  const updates = createUpdateService(transport, '1.0', 'public-owner/mobile-releases');
  await updates.checkForUpdate();
  expect(urls).toEqual([
    'https://api.gitcode.com/api/v5/repos/ygdnn/CetaMesh/raw/releases/stable.json?ref=main',
    'https://api.github.com/repos/public-owner/mobile-releases/releases?per_page=10',
  ]);
});

test('an empty release source disables anonymous update requests', async () => {
  const transport: HttpTransport = {
    json: async () => {throw new Error('unexpected request');},
    stream: async function* () {return;},
  };
  await expect(createUpdateService(transport, '1.0', '').checkForUpdate())
    .resolves.toEqual({status: 'unconfigured'});
});
