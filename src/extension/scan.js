// CetaMesh Desktop Extension v1 —— 入口源码静态预检（阶段 10）。
//
// 这是**纵深防御**，不是唯一防线：真正的限制来自 host.js 的 vm 上下文（没有 require /
// process / fs / child_process）。静态预检的价值在于「意图可见」：如果扩展试图引入
// 宿主能力，我们在安装阶段就拒绝，而不是等运行期才发现。
//
// 命中即拒绝安装（不提供"警告后继续"），因为本阶段的立场是默认禁止。

const RULES = Object.freeze([
  { id: 'require', re: /(^|[^.\w])require\s*\(/, reason: '禁止 require()：扩展不能加载宿主模块' },
  { id: 'esm-import', re: /(^|\n)\s*import\s+[\s\S]{0,120}?from\s+['"]/, reason: '禁止 ESM import：扩展不能加载宿主模块' },
  { id: 'dynamic-import', re: /(^|[^.\w])import\s*\(/, reason: '禁止动态 import()' },
  { id: 'child_process', re: /child_process|execSync|spawnSync|execFileSync/, reason: '禁止进程/Shell 能力' },
  { id: 'shell-words', re: /(?:^|[^.\w])(?:exec|spawn)\s*\(/, reason: '禁止进程/Shell 能力' },
  { id: 'process', re: /(^|[^.\w])process\s*[.[]/, reason: '禁止访问宿主进程对象' },
  { id: 'fs', re: /(^|[^.\w])(?:fs|node:fs|node:child_process|node:net|node:http|node:https)\b/, reason: '禁止直接访问文件系统/网络模块' },
  { id: 'eval', re: /(^|[^.\w])eval\s*\(/, reason: '禁止 eval' },
  { id: 'function-ctor', re: /new\s+Function\s*\(/, reason: '禁止 new Function 动态构造代码' },
  { id: 'wasm', re: /WebAssembly/, reason: '禁止 WebAssembly' },
  { id: 'native', re: /\.node['"]|\.dll['"]|process\.dlopen|ffi/i, reason: '禁止 Native DLL / .node 加载' },
  { id: 'download', re: /downloadAndRun|evalRemote|execRemote/, reason: '禁止下载后执行' }
]);

/**
 * 把注释内容替换成空格（保留换行），从而：
 *   1) 注释里出现 require / process / fs 这类词不会误报（否则正常的文档注释无法通过）；
 *   2) 每个字符一一对应，行号与原文完全一致，便于把问题定位回源码。
 * 字符串字面量保持不变 —— 否则会漏掉 import 'node:fs' 这类真实违规。
 */
export function blankOutComments(source) {
  const input = String(source === null || source === undefined ? '' : source);
  let out = '';
  let state = 'code';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; out += '  '; i += 1; continue; }
      if (ch === '/' && next === '*') { state = 'block'; out += '  '; i += 1; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { state = ch; out += ch; continue; }
      out += ch;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += ch; } else { out += ' '; }
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; out += '  '; i += 1; continue; }
      out += ch === '\n' ? ch : ' ';
      continue;
    }
    // 字符串内部：原样保留（含转义）
    out += ch;
    if (ch === '\\') { out += next === undefined ? '' : next; i += 1; continue; }
    if (ch === state) state = 'code';
  }
  return out;
}

export function scanEntrySource(source) {
  const text = blankOutComments(source);
  const findings = [];
  for (const rule of RULES) {
    const match = rule.re.exec(text);
    if (match) {
      const before = text.slice(0, match.index);
      const line = before.split('\n').length;
      findings.push({ rule: rule.id, reason: rule.reason, line });
    }
    rule.re.lastIndex = 0;
  }
  return { ok: findings.length === 0, findings };
}
