#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'desktop-shell', 'icons');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bytes.subarray(0, 8), pngSignature, `${file} 不是 PNG`);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${file} 缺少 IHDR`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512]
]) {
  assert.deepEqual(pngSize(path.join(icons, name)), [size, size], `${name} 尺寸错误`);
}

const ico = fs.readFileSync(path.join(icons, 'icon.ico'));
assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved 字段错误');
assert.equal(ico.readUInt16LE(2), 1, '应为 ICO 类型');
const count = ico.readUInt16LE(4);
assert.equal(count, 9, 'ICO 应包含 9 个尺寸');
const dimensions = [];
for (let index = 0; index < count; index += 1) {
  const entry = 6 + index * 16;
  const width = ico[entry] || 256;
  const height = ico[entry + 1] || 256;
  const bytes = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.equal(width, height, 'ICO 图层必须为正方形');
  assert.equal(ico.readUInt16LE(entry + 6), 32, 'ICO 图层必须为 32bpp');
  assert.ok(offset + bytes <= ico.length, 'ICO 图层越界');
  assert.deepEqual(ico.subarray(offset, offset + 8), pngSignature, 'ICO 图层必须为 PNG 编码');
  dimensions.push(width);
}
assert.deepEqual(dimensions, [16, 20, 24, 32, 40, 48, 64, 128, 256]);

const selected = fs.readFileSync(path.join(root, 'output', 'imagegen', 'whalebridge-icons-20260921-c-simple', 'c4-simple-light.png'));
assert.deepEqual(fs.readFileSync(path.join(icons, 'source-c4.png')), selected, '正式源图必须对应选定的 C4');
assert.deepEqual(
  fs.readFileSync(path.join(root, 'desktop-shell', 'ui', 'whalebridge-icon.png')),
  fs.readFileSync(path.join(root, 'public', 'whalebridge-icon.png')),
  '桌面内页与控制台应使用同一品牌图'
);

const build = fs.readFileSync(path.join(root, 'desktop-shell', 'build.rs'), 'utf8');
assert.match(build, /icons.*icon\.ico/s);
assert.doesNotMatch(build, /prototype_icon|prototype\.ico/);
const tauri = JSON.parse(fs.readFileSync(path.join(root, 'desktop-shell', 'tauri.conf.json'), 'utf8'));
assert.ok(tauri.bundle.icon.includes('icons/icon.ico'));
const installerPackager = fs.readFileSync(path.join(root, 'scripts', 'package-installer.mjs'), 'utf8');
assert.match(installerPackager, /set-exe-icon\.ps1/);
assert.match(installerPackager, /desktop-shell.*icons.*icon\.ico/s);
const installerIconWriter = fs.readFileSync(path.join(root, 'scripts', 'set-exe-icon.ps1'), 'utf8');
assert.match(installerIconWriter, /RT_GROUP_ICON/);
assert.match(installerIconWriter, /UpdateResourceW/);

for (const relative of [
  'desktop-shell/ui/installer.html',
  'desktop-shell/ui/status.html',
  'public/console.html',
  'public/token-login.html'
]) {
  assert.match(fs.readFileSync(path.join(root, relative), 'utf8'), /whalebridge-icon\.png/, `${relative} 未接入品牌图`);
}

process.stdout.write('✅ C4 已接入多尺寸 ICO、桌面壳、单文件安装器、安装向导、状态页、控制台与令牌登录页。\n');
