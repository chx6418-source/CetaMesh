#!/usr/bin/env node
/**
 * 正式控制台组装脚本（替代裸 cat，带完整性断言）
 * 用法: node design-demos/src/console/assemble.mjs
 * 结构: part1(head+css) + part2(body) + <script>Mock数据</script> + part3(应用逻辑)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(dir, p), 'utf8');

const part1 = read('part1.html');
const part2 = read('part2.html');
const part3 = read('part3.html');
const dataJs = readFileSync(join(dir, '../data.js'), 'utf8');

// ---- 完整性断言：part3(JS) 引用的所有 id 必须存在于 part2(HTML) ----
const ids = new Set();
for (const m of part3.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(m[1]);
for (const m of part3.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) ids.add(m[1]);
const missing = [...ids].filter((id) => !part2.includes(`id="${id}"`));
if (missing.length) {
  console.error('✗ 缺少 id:', missing.join(', '));
  process.exit(1);
}

// ---- 关键功能标记 ----
const mustHave = [
  'window.MOCK', 'LOG_POOL', 'id="modelList"', 'id="modeBind"', 'id="presetRows"', 'id="roleList"',
  'id="sessionList"', 'id="pendingList"', 'id="v2Tools"', 'id="modeRow"', 'id="closedPreset"',
  'id="v2ConfigSave"', 'id="roleSet"', 'id="restartBtn"', 'id="kugouQrLogin"', 'id="authOverlay"', 'id="themeSwitch"', 'id="toasts"', 'id="authOverlay"',
  'data-arm=', 'moduleIn', 'theme-anim'
];
const html = part1 + part2 + '\n<script>\n' + dataJs + '\n</script>\n' + part3;
const lost = mustHave.filter((k) => !html.includes(k));
if (lost.length) {
  console.error('✗ 组装产物缺少关键标记:', lost.join(', '));
  process.exit(1);
}


// ---- 守卫：单个 $(...) 不得链式 forEach（历史转义事故防回归） ----
{
  const badLines = part3.split(String.fromCharCode(10))
    .map((l, i) => [l, i])
    .filter(([l]) => {
      const k = l.indexOf(".forEach");
      if (k < 0) return false;
      const call = l.lastIndexOf("('", k);
      if (call < 2) return false;
      const head = l.slice(call - 2, call);
      if (head !== '$(' && head !== '$$') return false; // 非收集调用（如 querySelectorAll）放行
      return head.length === 1; // 单 $ → 坏；$$ → 好
      if (call < 2) return false;
      return l.slice(call - 2, call) !== "$$";
    });
  if (badLines.length) {
    console.error('✗ part3 存在单 $ forEach:', badLines.map(([l, i]) => 'L' + (i + 1)).join(', '));
    process.exit(1);
  }
}

// ---- 语法检查（所有 script 块） ----
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const [i, b] of blocks.entries()) {
  try { new Function(b[1]); } catch (e) {
    console.error(`✗ script #${i + 1} 语法错误:`, e.message);
    process.exit(1);
  }
}

const out = join(dir, '../../../public/console.html');
writeFileSync(out, html, 'utf8');
console.log(`✓ 组装完成: ${blocks.length} 个脚本块 | ${ids.size} 个引用 id 全部就位 | ${Buffer.byteLength(html)} 字节`);
console.log('→ ' + out);
