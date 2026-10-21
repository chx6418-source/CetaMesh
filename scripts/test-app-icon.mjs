#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = path.join(root, 'desktop-shell', 'icons');
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngSize(file) {
  const bytes = fs.readFileSync(file);
  assert.deepEqual(bytes.subarray(0, 8), pngSignature, `${file} 不是 PNG`);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR', `${file} 缺少 IHDR`);
  assert.equal(bytes[24], 8, `${file} 必须为 8-bit PNG`);
  assert.equal(bytes[25], 6, `${file} 必须为 RGBA PNG`);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function icoDimensions(ico, label) {
  assert.equal(ico.readUInt16LE(0), 0, `${label} ICO reserved 字段错误`);
  assert.equal(ico.readUInt16LE(2), 1, `${label} 应为 ICO 类型`);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 9, `${label} ICO 应包含 9 个尺寸`);
  const dimensions = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = ico[entry] || 256;
    const height = ico[entry + 1] || 256;
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(width, height, `${label} ICO 图层必须为正方形`);
    assert.equal(ico.readUInt16LE(entry + 6), 32, `${label} ICO 图层必须为 32bpp`);
    assert.ok(offset + bytes <= ico.length, `${label} ICO 图层越界`);
    assert.deepEqual(ico.subarray(offset, offset + 8), pngSignature, `${label} ICO 图层必须为 PNG 编码`);
    dimensions.push(width);
  }
  assert.deepEqual(dimensions, [16, 20, 24, 32, 40, 48, 64, 128, 256], `${label} ICO 图层尺寸错误`);
  return dimensions;
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
icoDimensions(ico, '提交的');

// Keep the legacy C4 provenance check reproducible in a clean checkout, too.
const legacy = fs.readFileSync(path.join(icons, 'source-c4.png'));
assert.equal(createHash('sha256').update(legacy).digest('hex'),
  '50f4f510502ea0dfee14abdbc4c318cd3d14a352ef24e8ff1e2ad111a89ed98b', '原 C4 主图必须保留');
const selectedPath = path.join(root, 'output', 'imagegen', 'whalebridge-icons-20260921-c-simple', 'c4-simple-light.png');
if (fs.existsSync(selectedPath)) {
  assert.deepEqual(legacy, fs.readFileSync(selectedPath), '原 C4 主图应与选定素材一致');
}
const [masterWidth, masterHeight] = pngSize(path.join(icons, 'source-logo-05.png'));
assert.equal(masterWidth, masterHeight, 'Logo-05 主图必须为正方形');
assert.ok(masterWidth >= 1024, 'Logo-05 主图需要足够分辨率');
const publicIcon = fs.readFileSync(path.join(root, 'public', 'whalebridge-icon.png'));
assert.deepEqual(publicIcon, fs.readFileSync(path.join(icons, '128x128@2x.png')), '各入口必须使用同一图标');

if (process.platform === 'win32') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-icon-test-'));
  try {
    fs.mkdirSync(path.join(temporary, 'scripts'));
    fs.mkdirSync(path.join(temporary, 'desktop-shell', 'icons'), { recursive: true });
    fs.mkdirSync(path.join(temporary, 'public'));
    const generator = path.join(temporary, 'scripts', 'build-app-icons.ps1');
    fs.copyFileSync(path.join(root, 'scripts', 'build-app-icons.ps1'), generator);
    // Only the new master is staged: a default still pointing at C4 must fail.
    fs.copyFileSync(path.join(icons, 'source-logo-05.png'), path.join(temporary, 'desktop-shell', 'icons', 'source-logo-05.png'));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', generator], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generatedIcons = path.join(temporary, 'desktop-shell', 'icons');
    for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
      const generated = path.join(generatedIcons, name);
      assert.deepEqual(pngSize(generated), [size, size], `${name} 必须由默认 Logo-05 主图生成`);
      assert.ok(fs.statSync(generated).size > 100, `${name} 不能是空白 PNG`);
    }
    icoDimensions(fs.readFileSync(path.join(generatedIcons, 'icon.ico')), '生成的');
    const generatedPublicIcon = path.join(temporary, 'public', 'whalebridge-icon.png');
    assert.deepEqual(pngSize(generatedPublicIcon), [256, 256], 'UI 图标必须由默认主图生成');
    assert.ok(fs.statSync(generatedPublicIcon).size > 100, 'UI 图标不能是空白 PNG');
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('cetamesh-icon-test-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

const build = fs.readFileSync(path.join(root, 'desktop-shell', 'build.rs'), 'utf8');
assert.match(build, /icons.*icon\.ico/s);
assert.doesNotMatch(build, /prototype_icon|prototype\.ico/);
const installerPackager = fs.readFileSync(path.join(root, 'scripts', 'package-installer.mjs'), 'utf8');
assert.match(installerPackager, /set-exe-icon\.ps1/);
assert.match(installerPackager, /desktop-shell.*icons.*icon\.ico/s);
const installerIconWriter = fs.readFileSync(path.join(root, 'scripts', 'set-exe-icon.ps1'), 'utf8');
assert.match(installerIconWriter, /RT_GROUP_ICON/);
assert.match(installerIconWriter, /UpdateResourceW/);

for (const relative of [
  'public/console.html',
  'public/token-login.html'
]) {
  assert.match(fs.readFileSync(path.join(root, relative), 'utf8'), /whalebridge-icon\.png/, `${relative} 未接入品牌图`);
}

process.stdout.write('✅ Logo-05 PNG/ICO 尺寸、默认生成链路与各入口图标一致，原 C4 来源校验保留。\n');
