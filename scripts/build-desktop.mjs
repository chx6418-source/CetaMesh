#!/usr/bin/env node
// 构建桌面壳：包一层 cargo，注入 --remap-path-prefix。
//
// 为什么需要：cargo 会把路径信息写进二进制的调试信息与元数据段，release 产物里可能因此
// 留下构建机的仓库路径。--remap-path-prefix 把仓库根映射成 "."，减少本机路径痕迹并改善
// 构建可复现性。
//
// 注意：编译器生成的**字符串字面量**（例如 Tauri/Cargo 元数据里的 crate 目录）不受
// remap 影响——实测 release 桌面壳仍会带一处 `D:\...\desktop-shell`。该偏差已记录在
// scripts/build-release.mjs 的 release-manifest.json -> knownDeviations。
//
// 用法：
//   node scripts/build-desktop.mjs            # debug 构建
//   node scripts/build-desktop.mjs --release  # release 构建
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = process.argv.includes('--release');
const extra = process.argv.slice(2).filter((arg) => arg !== '--release');

// TOML 字面字符串（单引号）不需要转义 Windows 反斜杠。
// The installer itself must start on a clean Windows machine before any optional
// runtime installer can run. Do not assume a developer Visual C++ redistributable.
const staticCrt = process.platform === 'win32' ? ',"-C","target-feature=+crt-static"' : '';
const rustflags = `build.rustflags=["--remap-path-prefix",'${ROOT}=.'${staticCrt}]`;

const args = [
  'build',
  '--manifest-path',
  path.join('desktop-shell', 'Cargo.toml'),
  ...(release ? ['--release'] : []),
  '--config',
  rustflags,
  ...extra
];

const result = spawnSync('cargo', args, { cwd: ROOT, stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`[build-desktop] 无法执行 cargo：${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
