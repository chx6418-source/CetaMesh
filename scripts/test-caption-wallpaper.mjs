import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../desktop-ui/', import.meta.url));
const require = createRequire(root + 'package.json');
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const vite = await createServer({ configFile: false, root, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { wallpaperCover, captionSampleSize, validCaptionFrame, encodeCaptionPixels } = await vite.ssrLoadModule('/src/theme/caption-backdrop.ts');
  assert.deepEqual(wallpaperCover(1000, 800, 1000, 800, 0), { x: 0, y: 0, width: 1000, height: 800 });
  assert.deepEqual(wallpaperCover(1000, 800, 2000, 800, 0), { x: -500, y: 0, width: 2000, height: 800 });
  assert.deepEqual(wallpaperCover(1000, 800, 800, 1600, 0), { x: 0, y: -600, width: 1000, height: 2000 });
  assert.deepEqual(wallpaperCover(1000, 800, 1000, 800), { x: -30, y: -24, width: 1060, height: 848 });
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => wallpaperCover(bad, 800, 1000, 800));
  assert.deepEqual(captionSampleSize(3840, 80), { width: 1024, height: 21 });
  assert.deepEqual(captionSampleSize(640, 120), { width: 512, height: 96 });
  assert.deepEqual(captionSampleSize(500, 40), { width: 500, height: 40 });
  assert.throws(() => captionSampleSize(0, 40));
  const frame = { id: '1280-840-40-96', width: 1280, height: 840, captionHeight: 40 };
  assert.equal(validCaptionFrame(frame), true);
  for (const bad of [null, {}, { ...frame, captionHeight: 0 }, { ...frame, captionHeight: 841 }, { ...frame, width: Infinity }, { ...frame, width: 1.5 }, { ...frame, id: 'https://example.invalid' }]) assert.equal(validCaptionFrame(bad), false);
  const bytes = new Uint8ClampedArray([12, 34, 56, 255, 210, 220, 230, 255]);
  assert.deepEqual([...Buffer.from(encodeCaptionPixels(bytes), 'base64')], [...bytes]);
  assert.throws(() => encodeCaptionPixels(new Uint8ClampedArray([1, 2, 3, 0])), /opaque/);
  assert.throws(() => encodeCaptionPixels(new Uint8ClampedArray(1024 * 96 * 4 + 4)), /budget/);
  assert.throws(() => encodeCaptionPixels(new Uint8ClampedArray(3)), /pixel/);
  console.log('PASS wallpaper cover/caption origin geometry, bounded sampling, frame validation and opaque pixel encoding');

  globalThis.window = { setTimeout, clearTimeout };
  const { hostClient } = await vite.ssrLoadModule('/src/bridge/typed-client.ts');
  const requests = [];
  window.ipc = { postMessage(raw) {
    const request = JSON.parse(raw); requests.push(request);
    queueMicrotask(() => window.__cetameshReceive({ id: request.id, ok: true, result: { applied: request.params.surface !== null } }));
  } };
  const surface = { frame: frame.id, width: 2, height: 1, pixels: encodeCaptionPixels(bytes) };
  assert.equal((await hostClient.captionBackdrop(surface)).applied, true);
  assert.deepEqual(requests.at(-1), { ...requests.at(-1), method: 'app.captionBackdrop', params: { surface } });
  assert.equal((await hostClient.captionBackdrop(null)).applied, false);
  assert.deepEqual(requests.at(-1).params, { surface: null }, 'removal is an explicit scoped clear');
  console.log('PASS exact presentation-only Host route and background removal request');
} finally { await vite.close(); delete globalThis.window; }
