import type {HttpRequest, HttpTransport} from '../providers/network/HttpTransport';
import {createUpdateService} from '../app/bootstrap/updateSource';

test('the app checks the public release repository by default', async () => {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    json: async request => {requests.push(request); return [];},
    stream: async function* () {return;},
  };
  const updates = createUpdateService(transport, '1.0');
  await expect(updates.checkForUpdate()).resolves.toEqual({status: 'unavailable'});
  expect(requests.map(request => request.url)).toEqual([
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
  expect(urls).toEqual(['https://api.github.com/repos/public-owner/mobile-releases/releases?per_page=10']);
});

test('an empty release source disables anonymous update requests', async () => {
  const transport: HttpTransport = {
    json: async () => {throw new Error('unexpected request');},
    stream: async function* () {return;},
  };
  await expect(createUpdateService(transport, '1.0', '').checkForUpdate())
    .resolves.toEqual({status: 'unconfigured'});
});
