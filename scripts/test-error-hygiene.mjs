#!/usr/bin/env node
// 静默失败红线（D13）：禁止产品代码新增「裸 catch {}」、以及 lifecycle 外的
// process.exit / setInterval 增长。
//
// 规则（与 HANDOFF_TECHDEBT_SESSION_1.md / RULES 一致）：
//   1. catch 块允许为空，但必须带说明注释（为什么吞掉是安全的：best-effort cleanup /
//      expected optional probe / already-gone resource）。完全裸的 `catch {}`
//      只允许维持历史基线数量 —— 任何文件**新增**裸 catch 即 FAIL。
//   2. process.exit / setInterval 的每文件出现次数不得超过基线：
//      它们只属于 entrypoint / lifecycle / legacy runtime；业务 Runtime 不得新增。
//      本轮接触的生命周期 timer（data IPC / legacy HTTP / UI IPC）已满足
//      start 幂等、stop 清理、unref（适用处）。
//
// 基线更新方式（仅允许在显式清理后使用）：
//   node scripts/test-error-hygiene.mjs --update-baseline
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const BASELINE_FILE = path.join(ROOT, 'scripts', 'error-hygiene-baseline.json');
const UPDATE = process.argv.includes('--update-baseline');

/** 递归收集 src 下的 .js 文件（src 即产品代码；scripts/self-test 不在红线范围）。 */
function listSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 去掉字符串字面量与注释后再数裸 catch，避免把 `catch {}` 出现在字符串里的情况算进去。
// 粗粒度即可：宁可把字符串情形误判为“有注释的 catch”，也不会漏掉真正的裸 catch。
function stripNoise(code) {
  return code
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function analyzeFile(file) {
  const code = stripNoise(fs.readFileSync(file, 'utf8'));
  const relative = path.relative(ROOT, file).split(path.sep).join('/');
  // 裸 catch：catch 后的块内（忽略空白）直接就是 `}` —— 没有任何注释或语句。
  const bareCatch = [...code.matchAll(/catch\s*(?:\([^)]*\))?\s*\{\s*\}/g)].length;
  const annotatedCatch = [...code.matchAll(/catch\s*(?:\([^)]*\))?\s*\{(?!\s*\})/g)].length;
  const processExit = [...code.matchAll(/\bprocess\.exit\s*\(/g)].length;
  const setIntervalCount = [...code.matchAll(/\bsetInterval\s*\(/g)].length;
  return { file: relative, bareCatch, annotatedCatch, processExit, setIntervalCount };
}

const analyses = listSourceFiles(SRC).map(analyzeFile);
const current = {};
for (const item of analyses) {
  current[item.file] = {
    bareCatch: item.bareCatch,
    processExit: item.processExit,
    setInterval: item.setIntervalCount
  };
}

if (UPDATE) {
  const payload = {
    _comment: '静默失败红线基线（scripts/test-error-hygiene.mjs）。数值 = 允许存在的上限；只许减少，不许增加。',
    generatedAt: new Date().toISOString().slice(0, 10),
    files: current
  };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`基线已更新：${BASELINE_FILE}（${Object.keys(current).length} 个文件）`);
  process.exit(0);
}

const baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).files ?? {};
let failures = 0;
for (const item of analyses) {
  const recorded = baseline[item.file] ?? { bareCatch: 0, processExit: 0, setInterval: 0 };
  const checks = [
    ['bareCatch', item.bareCatch, recorded.bareCatch ?? 0, '裸 catch {}（无注释吞错）'],
    ['processExit', item.processExit, recorded.processExit ?? 0, 'process.exit（生命周期外新增）'],
    ['setInterval', item.setIntervalCount, recorded.setInterval ?? 0, 'setInterval（lifecycle 外新增）']
  ];
  for (const [kind, value, limit, label] of checks) {
    if (value > limit) {
      failures += 1;
      console.error(`✗ ${item.file}: ${label} 出现 ${value} 次，超过基线 ${limit} —— 新增的静默失败/生命周期出口必须给出注释或移除。`);
    }
  }
}

const totalBare = analyses.reduce((sum, item) => sum + item.bareCatch, 0);
const baseTotalBare = Object.values(baseline).reduce((sum, item) => sum + (item.bareCatch ?? 0), 0);
console.log(`静默失败红线：${analyses.length} 个文件，裸 catch ${totalBare}（基线 ${baseTotalBare}），process.exit ${analyses.reduce((s, i) => s + i.processExit, 0)}，setInterval ${analyses.reduce((s, i) => s + i.setIntervalCount, 0)}`);
if (totalBare < baseTotalBare) console.log('（基线可以收紧：node scripts/test-error-hygiene.mjs --update-baseline）');
assert.equal(failures, 0, `静默失败红线被违反：${failures} 处（见上）`);
console.log('✅ 静默失败红线通过：无新增裸 catch / process.exit / setInterval');
