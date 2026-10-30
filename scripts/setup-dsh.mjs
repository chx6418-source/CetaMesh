#!/usr/bin/env node
// setup-dsh.mjs — 安装 / 修复 / 迁移鲸桥的 DSH 端集成。
//
// 本文件只是命令行外壳；全部逻辑在 src/dsh-integration.js，因此
// `WhaleBridgeCore.exe --setup-dsh` 与源码模式走的是同一条代码路径。
//
// 用法：
//   node scripts/setup-dsh.mjs [profile] [--dry-run] [--force-presets] [--no-plugin-install] [--json]
//
// 环境变量：
//   DSH_HOME               DSH 根目录（默认 ~/.dsh）
//   WHALEBRIDGE_DATA_DIR   可写数据目录（默认仓库根）
//   WHALEBRIDGE_RESOURCE_DIR  只读资源目录（默认仓库根）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APP_PATHS } from '../src/app-paths.js';
import { resolveCoreLaunch, runSetupDsh } from '../src/dsh-integration.js';

const SOURCE_ROOT = APP_PATHS.sourceRoot;
const PRODUCT = readProductVersion();

function readProductVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SOURCE_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseArgs(argv) {
  const options = { profile: null, dryRun: false, force: false, installProfileBundles: true, json: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--force-presets' || arg === '--force') options.force = true;
    else if (arg === '--no-plugin-install') options.installProfileBundles = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else if (!options.profile) options.profile = arg;
    else throw new Error(`只接受一个 profile 参数（多余的：${arg}）`);
  }
  return options;
}

const USAGE = `鲸桥 DSH 集成安装/修复/迁移

用法：
  node scripts/setup-dsh.mjs [profile] [选项]

选项：
  --dry-run, -n          只打印计划，不写入任何文件
  --force-presets        即使 preset 已被修改也覆盖（默认不覆盖用户改动）
  --no-plugin-install    跳过 dsh plugin --profile <profile> install
  --json                 以 JSON 输出结果（供脚本消费）
  --help, -h             显示本帮助

环境变量：
  DSH_HOME                DSH 根目录（默认 ~/.dsh）
  WHALEBRIDGE_DATA_DIR    可写数据目录（默认仓库根）
  WHALEBRIDGE_RESOURCE_DIR 只读资源目录（默认仓库根）`;

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[setup-dsh] ${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const profile = options.profile || 'web';
  const lines = [];
  const core = resolveCoreLaunch({
    packaged: false,
    dataRoot: APP_PATHS.dataRoot,
    execPath: process.execPath,
    entryPath: path.join(SOURCE_ROOT, 'src', 'core-entry.js')
  });

  const result = await runSetupDsh({
    profile,
    resourceRoot: APP_PATHS.resourceRoot,
    dataRoot: APP_PATHS.dataRoot,
    sourceRoot: SOURCE_ROOT,
    version: PRODUCT,
    core,
    force: options.force,
    dryRun: options.dryRun,
    installProfileBundles: options.installProfileBundles && !options.dryRun,
    log: options.json ? (message) => lines.push(message) : (message) => console.log(message)
  });

  if (options.json) {
    console.log(JSON.stringify({
      profile,
      dryRun: Boolean(result.dryRun),
      applied: Boolean(result.applied),
      effectCount: result.plan.effects.length,
      cordisKind: result.plan.cordisKind,
      presets: result.plan.presets,
      warnings: result.plan.warnings,
      notes: result.plan.notes,
      output: lines
    }, null, 2));
  }
}

await main();
