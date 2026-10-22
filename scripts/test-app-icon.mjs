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
if (process.env.CETAMESH_ICON_EXECUTABLE) {
  const executable = fs.readFileSync(process.env.CETAMESH_ICON_EXECUTABLE);
  assert.equal(executable.toString('ascii', 0, 2), 'MZ', '图标检查目标必须是 PE 程序');
  for (let index = 0; index < ico.readUInt16LE(4); index++) {
    const entry = 6 + index * 16;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(executable.includes(ico.subarray(offset, offset + length)), '实际编译程序必须包含新 ICO 的每个图层');
  }
  assert.ok(executable.includes(fs.readFileSync(path.join(icons, '128x128.png'))), '实际程序须含标题栏的新 PNG');
  console.log('✅ 实际 Windows 程序包含全部新 ICO 图层及标题栏 PNG');
}

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
const supplied = new Map([
  [180, 'ebb0d2f55223dc443fcaa94b5e65b1cfb3085121a161ac4de87b08d86c833a13'],
  [256, '4602ed24608389c88b809deb13c131497788b21a72fa6a448821c955debad5e9'],
  [512, '2fddef83c6ead38de991c7beb3f603f26cb36b5460406a7ee122d1c7ab6794e9'],
  [1024, '86ffe07042373741cadc28e1422cf90d4bceb6a8bb6a5cd642261d19d77b445c']
]);
for (const [size, hash] of supplied) {
  const file = path.join(icons, `cetamesh-icon-${size}.png`);
  assert.deepEqual(pngSize(file), [size, size]);
  assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash, 'Owner 图标原图应保持不变');
}
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
    // Only the Owner's new images are staged: an old default must fail.
    for (const size of supplied.keys()) fs.copyFileSync(path.join(icons, `cetamesh-icon-${size}.png`), path.join(temporary, 'desktop-shell', 'icons', `cetamesh-icon-${size}.png`));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', generator], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generatedIcons = path.join(temporary, 'desktop-shell', 'icons');
    for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512]]) {
      const generated = path.join(generatedIcons, name);
      assert.deepEqual(pngSize(generated), [size, size], `${name} 必须由 Owner 主图生成`);
      assert.ok(fs.statSync(generated).size > 100, `${name} 不能是空白 PNG`);
      assert.deepEqual(fs.readFileSync(generated), fs.readFileSync(path.join(icons, name)), '提交资源与默认生成器必须一致');
    }
    icoDimensions(fs.readFileSync(path.join(generatedIcons, 'icon.ico')), '生成的');
    assert.deepEqual(fs.readFileSync(path.join(generatedIcons, 'icon.ico')), ico, 'ICO 不得残留旧资源');
    assert.deepEqual(fs.readFileSync(path.join(generatedIcons, '128x128@2x.png')), fs.readFileSync(path.join(icons, 'cetamesh-icon-256.png')), '已有 256 图应原样使用，不额外裁切');
    assert.deepEqual(fs.readFileSync(path.join(generatedIcons, 'icon.png')), fs.readFileSync(path.join(icons, 'cetamesh-icon-512.png')), '已有 512 图应原样使用，不额外裁切');
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

process.stdout.write('✅ Owner 绿色 CetaMesh PNG/ICO、生成一致性及原图 Hash 通过；历史来源保留。\n');
