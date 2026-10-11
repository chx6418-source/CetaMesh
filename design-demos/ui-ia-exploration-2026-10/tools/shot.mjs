// 截图工具：为 5 套 UI 探索方案生成 1280×800 截图。
// 用法：node tools/shot.mjs
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'screenshots');
mkdirSync(outDir, { recursive: true });

const VIEWS = [
  ['home', 'chat-home'],
  ['thread', 'chat-thread'],
  ['work', 'work'],
  ['memory', 'memory'],
  ['agents', 'agents'],
  ['plugins', 'plugins'],
  ['plugin', 'plugin-detail'],
  ['settings', 'settings'],
  ['about', 'about'],
];
const PROPOSALS = ['p01', 'p02', 'p03', 'p04', 'p05'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const p of PROPOSALS) {
  const url = pathToFileURL(join(root, `${p}.html`)).href;
  for (const [hash, name] of VIEWS) {
    await page.goto(`${url}#/${hash}`);
    await page.waitForTimeout(250);
    const file = join(outDir, `${p}-${name}.png`);
    await page.screenshot({ path: file });
    console.log('shot', `${p}-${name}`);
  }
}
await browser.close();
console.log('done');
