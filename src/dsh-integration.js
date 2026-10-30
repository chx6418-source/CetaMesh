// 鲸桥的 DSH 端集成安装 / 修复 / 迁移。
//
// 职责（卸载不在本模块，属于交付阶段的独立流程）：
//   1. 按版本释放两套 agent preset（whale-chat / whale-chat-v2）与 whale-mode-console 插件；
//   2. 在 profile 的 cordis.patch.yml 里维护 5 个 MCP server，command 指向鲸桥 Core
//      （开发=node + src/core-entry.js；发布=WhaleBridgeCore.exe；两者都用 process.execPath）；
//   3. 迁移旧安装物：qq-* preset/插件/命名空间、指向 src/mcp-*.js 的旧 MCP 配置、
//      指向旧仓库或旧 Node 安装的绝对路径、失效或指向别处的插件链接；
//   4. 幂等：没有任何实际变化时不写文件（连同 manifest 一起保持原样）；
//   5. 失败回滚：任何一步失败都恢复到执行前状态。
//
// 设计约束：
//   - 只覆盖"本应用拥有"的文件。preset 是否可覆盖由 manifest 的内容哈希决定：
//     由本应用安装且此后未被改动才可升级；用户改过、或来源不明的一律保留并提示。
//   - 归属不明确的配置只报告、不删除（例如用户自建 preset、用户自己的 MCP 条目）。
//   - 路径全部由调用方注入（dshHome / resourceRoot / dataRoot），因此可以在临时目录里完整
//     测试，不会碰到用户真实的 ~/.dsh。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawnSync } from 'node:child_process';

import { APP_PATHS, isPackagedRuntime } from './app-paths.js';

export const MCP_SERVERS = Object.freeze([
  { id: 'mcp-snowluma', mode: 'snowluma', toolCallTimeoutMs: 725000 },
  { id: 'mcp-snowluma-host', mode: 'snowluma-host' },
  { id: 'mcp-web-search-safe', mode: 'web-search-safe' },
  { id: 'mcp-qq-file-send', mode: 'qq-file-send', toolCallTimeoutMs: 120000 },
  { id: 'mcp-bilibili', mode: 'bilibili', toolCallTimeoutMs: 60000 }
]);

export const MARKERS = Object.freeze({
  begin: '# === whalebridge MCP BEGIN ===',
  end: '# === whalebridge MCP END ==='
});

export const PRESET_NAMES = Object.freeze(['whale-chat', 'whale-chat-v2']);
export const PLUGIN_NAME = 'whale-mode-console';
export const MANIFEST_FILE = '.whalebridge-integration.json';
export const BACKUP_DIR = '.whalebridge-backup';
export const MANIFEST_SCHEMA = 2;

// 旧命名（qq-bridge / qq-*）与旧布局（每个 MCP 一个脚本文件）的识别规则。
export const LEGACY = Object.freeze({
  presets: ['qq-chat', 'qq-chat-v2'],
  plugin: 'qq-mode-console',
  settingsNamespace: 'qq-mode',
  newNamespace: 'whale-mode',
  markers: ['# === qq-bridge MCP', '# === qq-chat MCP'],
  scriptNames: [
    'mcp-snowluma-safe.js',
    'mcp-host-server.js',
    'mcp-web-search-safe.js',
    'mcp-qq-file-send.js',
    'mcp-bilibili.js'
  ]
});

// ------------------------------------------------------------------ 纯函数

export function yamlSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Core 的启动方式。开发模式与发布模式都用 process.execPath：
 * - 发布（SEA）：execPath 就是 WhaleBridgeCore.exe，args 里不能再带入口脚本；
 * - 开发：execPath 是 node.exe，args 必须带上 src/core-entry.js。
 */
export function resolveCoreLaunch({ packaged, execPath = process.execPath, entryPath, dataRoot }) {
  const command = path.resolve(execPath);
  const dataArgs = dataRoot ? ['--data-dir', path.resolve(dataRoot)] : [];
  if (packaged) {
    return { packaged: true, command, argsPrefix: dataArgs, description: `WhaleBridgeCore.exe（打包）：${command}` };
  }
  if (!entryPath) throw new Error('开发模式需要 src/core-entry.js 的绝对路径');
  const entry = path.resolve(entryPath);
  return {
    packaged: false,
    command,
    argsPrefix: [entry, ...dataArgs],
    description: `node + 源码入口：${command} ${entry}`
  };
}

export function mcpArgs(core, mode) {
  return [...core.argsPrefix, '--mcp', mode];
}

export function buildMcpBlock(core) {
  let out = `${MARKERS.begin}\n`;
  for (const server of MCP_SERVERS) {
    out += '- insert:\n';
    out += `    - id: ${server.id}\n`;
    out += "      name: '@deepseek-ai/dsh-mcp-client'\n";
    out += '      config:\n';
    out += `        serverName: ${server.id.replace('mcp-', '')}\n`;
    out += '        transport: stdio\n';
    out += `        command: ${yamlSingleQuote(core.command)}\n`;
    out += '        args:\n';
    for (const arg of mcpArgs(core, server.mode)) out += `          - ${yamlSingleQuote(arg)}\n`;
    if (server.toolCallTimeoutMs) out += `        toolCallTimeoutMs: ${server.toolCallTimeoutMs}\n`;
  }
  out += `${MARKERS.end}\n`;
  return out;
}

export function extractMarkedBlock(text) {
  const beginIndex = text.indexOf(MARKERS.begin);
  const endIndex = text.indexOf(MARKERS.end);
  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) return null;
  return { beginIndex, endIndex: endIndex + MARKERS.end.length };
}

/** 把旧注释标记（qq-bridge / qq-chat MCP）改名为当前标记，后续分支才能命中。 */
export function renameLegacyMarkers(text) {
  return text.replace(/^# === (?:qq-bridge|qq-chat) MCP (BEGIN|END) ===$/gm, (_all, word) => (
    word === 'BEGIN' ? MARKERS.begin : MARKERS.end
  ));
}

/** 用新块替换已有标记块，保留其它内容。 */
export function replaceMarkedBlock(text, core) {
  const range = extractMarkedBlock(text);
  if (!range) return { text, changed: false };
  const block = buildMcpBlock(core).trimEnd();
  const next = text.slice(0, range.beginIndex) + block + text.slice(range.endIndex);
  return { text: next, changed: next !== text };
}

function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 就地修复单个条目的 command/args（用于没有标记块、但可确认是本项目的旧配置）。
 * 只改 command、args 与缺失的 toolCallTimeoutMs，不删除同一文件里用户的其它条目。
 */
export function rewriteOneEntry(text, server, core) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const idPattern = new RegExp(`^(\\s*)-\\s*id:\\s*${escapeRegExp(server.id)}\\s*$`);
  let idIndex = -1;
  let idIndent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = idPattern.exec(lines[i]);
    if (match) {
      idIndex = i;
      idIndent = match[1].length;
      break;
    }
  }
  if (idIndex < 0) return { text, changed: false, found: false };

  // 条目范围：id 行之后，第一条缩进不比 "- insert:" 更深的非空行。
  let end = lines.length;
  for (let j = idIndex + 1; j < lines.length; j += 1) {
    if (!lines[j].trim()) continue;
    if (indentOf(lines[j]) <= Math.max(idIndent - 2, 0)) {
      end = j;
      break;
    }
  }

  let commandIndex = -1;
  let commandIndent = 0;
  let argsIndex = -1;
  let argsIndent = 0;
  let hasTimeout = false;
  for (let j = idIndex; j < end; j += 1) {
    if (commandIndex < 0 && /^\s*command:\s*/.test(lines[j])) {
      commandIndex = j;
      commandIndent = indentOf(lines[j]);
    } else if (argsIndex < 0 && /^\s*args:\s*$/.test(lines[j])) {
      argsIndex = j;
      argsIndent = indentOf(lines[j]);
    } else if (/^\s*toolCallTimeoutMs:\s*\d+\s*$/.test(lines[j])) {
      hasTimeout = true;
    }
  }
  if (commandIndex < 0) return { text, changed: false, found: true };

  const listIndent = argsIndex >= 0 ? argsIndent : commandIndent;
  const argLines = mcpArgs(core, server.mode).map(
    (arg) => `${' '.repeat(listIndent + 2)}- ${yamlSingleQuote(arg)}`
  );
  const replacements = new Map();
  const commandLines = [`${' '.repeat(commandIndent)}command: ${yamlSingleQuote(core.command)}`];
  if (argsIndex < 0) commandLines.push(`${' '.repeat(listIndent)}args:`, ...argLines);
  if (server.toolCallTimeoutMs && !hasTimeout) {
    commandLines.push(`${' '.repeat(listIndent)}toolCallTimeoutMs: ${server.toolCallTimeoutMs}`);
  }
  replacements.set(commandIndex, commandLines);

  if (argsIndex >= 0) {
    let argsEnd = argsIndex + 1;
    while (argsEnd < end && lines[argsEnd].trim() && indentOf(lines[argsEnd]) > argsIndent) argsEnd += 1;
    replacements.set(argsIndex, [`${' '.repeat(argsIndent)}args:`, ...argLines]);
    for (let j = argsIndex + 1; j < argsEnd; j += 1) replacements.set(j, []);
  }

  const out = [];
  for (let j = 0; j < lines.length; j += 1) {
    if (replacements.has(j)) out.push(...replacements.get(j));
    else out.push(lines[j]);
  }
  const next = out.join(eol);
  return { text: next, changed: next !== text, found: true };
}

export function rewriteEntryCommands(text, core) {
  const repaired = [];
  const present = [];
  let current = text;
  for (const server of MCP_SERVERS) {
    const result = rewriteOneEntry(current, server, core);
    if (result.found) present.push(server.id);
    if (result.changed) {
      current = result.text;
      repaired.push(server.id);
    }
  }
  return { text: current, changed: repaired.length > 0, repaired, present };
}

function unquoteYamlSingle(value) {
  const text = String(value).trim();
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/**
 * 解析出各 MCP 条目的 command/args（buildMcpBlock 的逆操作）。
 * 用于验证生成的配置，也是后续"卸载只处理本项目区块"的基础。
 */
export function parseMcpEntries(text) {
  const entries = {};
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = /^(\s*)-\s*id:\s*(\S+)\s*$/.exec(lines[i]);
    if (!idMatch) continue;
    const id = idMatch[2];
    const idIndent = idMatch[1].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= Math.max(idIndent - 2, 0)) {
        end = j;
        break;
      }
    }
    let command = null;
    let args = null;
    let toolCallTimeoutMs = null;
    for (let j = i; j < end; j += 1) {
      const commandMatch = /^\s*command:\s*(.+?)\s*$/.exec(lines[j]);
      if (commandMatch && command === null) {
        command = unquoteYamlSingle(commandMatch[1]);
        continue;
      }
      const argsMatch = /^(\s*)args:\s*$/.exec(lines[j]);
      if (argsMatch && args === null) {
        const argsIndent = argsMatch[1].length;
        args = [];
        for (let k = j + 1; k < end; k += 1) {
          if (!lines[k].trim()) break;
          if (indentOf(lines[k]) <= argsIndent) break;
          const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(lines[k]);
          if (!itemMatch) break;
          args.push(unquoteYamlSingle(itemMatch[1]));
        }
        continue;
      }
      const timeoutMatch = /^\s*toolCallTimeoutMs:\s*(\d+)\s*$/.exec(lines[j]);
      if (timeoutMatch && toolCallTimeoutMs === null) toolCallTimeoutMs = Number(timeoutMatch[1]);
    }
    entries[id] = { command, args, toolCallTimeoutMs };
  }
  return entries;
}

/** 判断 cordis.patch.yml 属于哪种情况。 */export function detectCordisState(text) {
  const renamed = renameLegacyMarkers(text);
  const hasMarkers = Boolean(extractMarkedBlock(renamed));
  const hasServerIds = MCP_SERVERS.some((server) =>
    new RegExp(`^\\s*-\\s*id:\\s*${escapeRegExp(server.id)}\\s*$`, 'm').test(renamed)
  );
  const hasLegacyScripts = LEGACY.scriptNames.some((name) => renamed.includes(name));
  const hadLegacyMarker = renamed !== text;
  if (hasMarkers) return { kind: 'marked', hasServerIds, hasLegacyScripts, hadLegacyMarker };
  if (hasServerIds || hasLegacyScripts) {
    return { kind: 'unmarked-ours', hasServerIds, hasLegacyScripts, hadLegacyMarker };
  }
  if (hadLegacyMarker) return { kind: 'legacy-marker', hasServerIds, hasLegacyScripts, hadLegacyMarker };
  return { kind: 'foreign', hasServerIds, hasLegacyScripts, hadLegacyMarker };
}

export function hashText(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// profile 名会直接进入目录名与 shell 命令行，必须是受限字符集。
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function assertValidProfile(profile) {
  if (!PROFILE_PATTERN.test(String(profile ?? ''))) {
    throw new Error(`profile 名不合法：${JSON.stringify(profile)}（只允许字母、数字、点、下划线和短横线，最长 64）`);
  }
  return String(profile);
}

export function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** 目录内容哈希：只看相对路径与文件内容，与时间戳、遍历顺序无关。 */
export function hashTree(dir) {
  const hash = crypto.createHash('sha256');
  for (const relative of listFiles(dir)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// ------------------------------------------------------------ 计划与执行

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 删除路径，但**绝不跟随**符号链接 / junction：
 * Windows junction 用 rmdir；POSIX 符号链接用 unlink；两者都只摘掉链接本身。
 */
export function removePath(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    let pointsToDirectory = true;
    try {
      pointsToDirectory = fs.statSync(target).isDirectory();
    } catch {
      /* 断链：按目录链接处理 */
    }
    if (pointsToDirectory && process.platform === 'win32') fs.rmdirSync(target);
    else fs.unlinkSync(target);
    return;
  }
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.rmSync(target, { force: true });
}

export function readManifest(dshHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dshHome, MANIFEST_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 从 cordis.patch.yml 里删掉本项目的 MCP 条目（无标记文件用；有标记块时整块删除）。 */
export function removeMcpEntries(text) {
  const removed = [];
  const lines = String(text).split(/\r?\n/);
  const drop = new Set();
  for (const server of MCP_SERVERS) {
    const idPattern = new RegExp(`^(\\s*)-\\s*id:\\s*${escapeRegExp(server.id)}\\s*$`);
    let idIndex = -1;
    let idIndent = 0;
    for (let i = 0; i < lines.length; i += 1) {
      if (drop.has(i)) continue;
      const match = idPattern.exec(lines[i]);
      if (match) {
        idIndex = i;
        idIndent = match[1].length;
        break;
      }
    }
    if (idIndex < 0) continue;
    // 条目范围：id 行之后第一条缩进不比 "- insert:" 更深的非空行。
    let end = lines.length;
    for (let j = idIndex + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      if (indentOf(lines[j]) <= Math.max(idIndent - 2, 0)) {
        end = j;
        break;
      }
    }
    // 连同其外层的 `- insert:` 外壳一起删除
    let start = idIndex;
    for (let j = idIndex - 1; j >= 0; j -= 1) {
      if (!lines[j].trim()) continue;
      if (/^\s*-\s*insert:\s*$/.test(lines[j]) && indentOf(lines[j]) <= Math.max(idIndent - 2, 0)) {
        start = j;
      }
      break;
    }
    for (let j = start; j < end; j += 1) drop.add(j);
    removed.push(server.id);
  }
  if (removed.length === 0) return { text, changed: false, removed };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const next = lines.filter((_line, index) => !drop.has(index)).join(eol);
  return { text: next, changed: next !== text, removed };
}

/** 去掉标记块（含其前后多余空行）。 */
export function removeMarkedBlock(text) {
  const range = extractMarkedBlock(text);
  if (!range) return { text, changed: false };
  let start = range.beginIndex;
  let end = range.endIndex;
  // 连带吃掉块前后紧邻的空行，避免留下大片空白
  while (start > 0 && (text[start - 1] === '\n' || text[start - 1] === '\r')) start -= 1;
  while (end < text.length && (text[end] === '\n' || text[end] === '\r')) end += 1;
  const next = text.slice(0, start) + text.slice(end);
  return { text: next, changed: next !== text };
}

/**
 * 卸载计划：只移除"本应用拥有"的东西（manifest 记录 + 标记块），
 * 用户自建 preset、用户自己的 MCP 条目、用户改过的文件一律保留。
 * 与安装共用 applyPlan 的快照/回滚机制。
 */
export function planDshRemoval(options) {
  const {
    dshHome,
    profile = 'web',
    dataRoot,
    manifest = null,
    removePresets = true,
    now = () => new Date().toISOString()
  } = options;
  if (!dshHome) throw new Error('planDshRemoval 需要 dshHome');
  assertValidProfile(profile);

  const effects = [];
  const warnings = [];
  const notes = [];
  const record = manifest;
  if (!record) {
    warnings.push(
      `未找到 ${MANIFEST_FILE}：无法确认哪些文件由本应用安装，只清理可确认的标记块与旧链接。`
    );
  }

  // 1) preset：只删"由本应用安装且此后未被改过"的
  if (removePresets) {
    for (const name of PRESET_NAMES) {
      const dir = path.join(dshHome, '.agent-presets', name);
      if (!exists(dir)) continue;
      const entry = record?.presets?.[name];
      if (!entry?.owned) {
        notes.push(`保留 preset ${name}（manifest 未记录为本应用安装）`);
        continue;
      }
      const current = hashTree(dir);
      if (current !== entry.hash) {
        warnings.push(`preset ${name} 在安装后已被修改，卸载时保留：${dir}`);
        continue;
      }
      effects.push({ type: 'remove', path: dir });
      notes.push(`移除 preset ${name}`);
    }
  }

  // 2) 插件链接与按版本释放的 runtime 目录
  const pluginLink = path.join(dshHome, 'plugins', PLUGIN_NAME);
  const pluginTarget = record?.plugin?.target ?? null;
  if (exists(pluginLink) && fs.lstatSync(pluginLink).isSymbolicLink()) {
    if (pluginTarget && samePath(realpathOrNull(pluginLink), pluginTarget)) {
      effects.push({ type: 'remove', path: pluginLink });
      notes.push(`移除插件链接 ${pluginLink}`);
    } else {
      warnings.push(`插件链接指向的不是本应用记录的路径，未移除：${pluginLink}`);
    }
  }
  if (pluginTarget && dataRoot) {
    const runtimeRoot = path.join(dataRoot, 'runtime');
    const relative = path.relative(runtimeRoot, pluginTarget);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && exists(pluginTarget)) {
      effects.push({ type: 'remove', path: pluginTarget });
      notes.push(`移除按版本释放的插件副本 ${pluginTarget}`);
      // 顺带清掉空掉的 <dataRoot>/runtime/<版本>/ 与 <dataRoot>/runtime/（只在为空时）
      effects.push({ type: 'remove-empty-dir', path: path.dirname(pluginTarget) });
      effects.push({ type: 'remove-empty-dir', path: runtimeRoot });
    }
  }

  // 3) cordis.patch.yml：优先整块删除标记块；无标记时逐条删除本项目条目
  const patchFile = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml');
  if (exists(patchFile)) {
    const text = fs.readFileSync(patchFile, 'utf8');
    const block = removeMarkedBlock(text);
    if (block.changed) {
      effects.push({ type: 'write-file', path: patchFile, content: block.text, reason: '移除 MCP 标记块' });
      notes.push('cordis.patch.yml：已移除 whalebridge MCP 标记块');
    } else {
      const entries = removeMcpEntries(text);
      if (entries.changed) {
        effects.push({ type: 'write-file', path: patchFile, content: entries.text, reason: '移除 MCP 条目' });
        notes.push(`cordis.patch.yml：已逐条移除 ${entries.removed.join('、')}`);
        warnings.push('该文件没有标记块，只删除了本项目的 MCP 条目，用户其它配置未改动。');
      } else {
        notes.push('cordis.patch.yml：未发现本项目的 MCP 配置');
      }
    }
  }

  // 4) profile package.json：只摘掉 whale-mode-console 依赖与 bundle
  const pkgFile = path.join(dshHome, 'profiles', profile, 'package.json');
  if (exists(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      let changed = false;
      if (pkg?.dependencies && Object.prototype.hasOwnProperty.call(pkg.dependencies, PLUGIN_NAME)) {
        delete pkg.dependencies[PLUGIN_NAME];
        changed = true;
      }
      const bundles = pkg?.dsh?.profile?.bundles;
      if (Array.isArray(bundles)) {
        const index = bundles.indexOf(PLUGIN_NAME);
        if (index >= 0) {
          bundles.splice(index, 1);
          changed = true;
        }
      }
      if (changed) {
        effects.push({
          type: 'write-file',
          path: pkgFile,
          content: `${JSON.stringify(pkg, null, 2)}\n`,
          reason: '移除 whale-mode-console 注册'
        });
        notes.push('profile package.json：已移除 whale-mode-console 依赖与 bundle');
      } else {
        notes.push('profile package.json：没有本应用的注册项');
      }
    } catch (error) {
      warnings.push(`profile package.json 解析失败，未改动：${pkgFile}（${error.message}）`);
    }
  }

  // 5) manifest 自身
  if (exists(path.join(dshHome, MANIFEST_FILE))) {
    effects.push({ type: 'remove', path: path.join(dshHome, MANIFEST_FILE) });
    notes.push(`移除 ${MANIFEST_FILE}`);
  }

  return {
    dshHome,
    profile,
    effects,
    warnings,
    notes,
    changed: effects.length > 0,
    removedAt: now()
  };
}

export function formatRemovalReport(plan, { dryRun = false } = {}) {
  const lines = [`鲸桥 DSH 集成卸载${dryRun ? '（预演，未写入）' : ''}`];
  lines.push(`  DSH_HOME ：${plan.dshHome}`);
  lines.push(`  profile  ：${plan.profile}`);
  if (plan.notes.length > 0) {
    lines.push('  计划：');
    for (const note of plan.notes) lines.push(`    - ${note}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('  需要人工确认：');
    for (const warning of plan.warnings) lines.push(`    ! ${warning}`);
  }
  if (plan.effects.length === 0) lines.push('  结果：没有需要移除的内容');
  return lines.join('\n');
}

/** 卸载 DSH 集成（供桌面卸载器调用）。只动本应用拥有的内容，默认保留用户数据。 */
export async function runDshRemoval(options = {}) {
  const {
    dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    profile = 'web',
    dataRoot,
    dryRun = false,
    log = (message) => console.log(message)
  } = options;

  const plan = planDshRemoval({ dshHome, profile, dataRoot, manifest: readManifest(dshHome) });
  log(formatRemovalReport(plan, { dryRun }));
  if (dryRun || plan.effects.length === 0) return { plan, applied: false };
  const result = applyPlan(plan, { log });
  log(`  已移除 ${plan.effects.length} 项（备份：${result.backupDir}）`);
  return { plan, applied: true, ...result };
}

/** 应用内入口：卸载 DSH 集成，识别开发/打包两种布局。 */
export async function runDshRemovalFromApp(options = {}) {
  return runDshRemoval({
    ...options,
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    dataRoot: options.dataRoot ?? APP_PATHS.dataRoot
  });
}

/**
 * 生成集成计划。不写任何文件——所有修改都以 effects 返回，交给 applyPlan 执行，
 * 这样 --dry-run、测试与故障注入共用同一条代码路径。
 */
export function planIntegration(options) {
  const {
    dshHome,
    profile = 'web',
    resourceRoot,
    dataRoot,
    version = '0.0.0',
    core,
    manifest = null,
    force = false,
    now = () => new Date().toISOString()
  } = options;

  if (!dshHome) throw new Error('planIntegration 需要 dshHome');
  if (!resourceRoot) throw new Error('planIntegration 需要 resourceRoot');
  if (!dataRoot) throw new Error('planIntegration 需要 dataRoot');
  if (!core) throw new Error('planIntegration 需要 core');
  assertValidProfile(profile);

  const effects = [];
  const warnings = [];
  const notes = [];
  const presets = {};

  // 1) 旧命名清理：qq-* preset 与插件链接
  for (const name of LEGACY.presets) {
    const dir = path.join(dshHome, '.agent-presets', name);
    if (!exists(dir)) continue;
    effects.push({ type: 'remove', path: dir });
    notes.push(`移除旧 preset：${name}`);
  }
  const legacyPluginLink = path.join(dshHome, 'plugins', LEGACY.plugin);
  if (exists(legacyPluginLink)) {
    if (fs.lstatSync(legacyPluginLink).isSymbolicLink()) {
      effects.push({ type: 'remove', path: legacyPluginLink });
      notes.push(`移除旧插件链接：${LEGACY.plugin}`);
    } else {
      warnings.push(`旧插件路径不是链接而是真实目录，未删除，请人工确认：${legacyPluginLink}`);
    }
  }

  // 2) settings.yaml 命名空间迁移
  const settingsFile = path.join(dshHome, 'settings.yaml');
  if (exists(settingsFile)) {
    const text = fs.readFileSync(settingsFile, 'utf8');
    const pattern = new RegExp(`^${LEGACY.settingsNamespace}:`, 'm');
    if (pattern.test(text)) {
      effects.push({
        type: 'write-file',
        path: settingsFile,
        content: text.replace(pattern, `${LEGACY.newNamespace}:`),
        reason: 'settings.yaml 命名空间迁移'
      });
      notes.push(`settings.yaml：${LEGACY.settingsNamespace} → ${LEGACY.newNamespace}`);
    }
  }

  // 3) preset 释放与归属判定
  for (const name of PRESET_NAMES) {
    const source = path.join(resourceRoot, 'dsh', 'agent-presets', name);
    const dest = path.join(dshHome, '.agent-presets', name);
    if (!fs.existsSync(source)) {
      warnings.push(`内置 preset 缺失，跳过：${source}`);
      continue;
    }
    const shippedHash = hashTree(source);
    const record = manifest?.presets?.[name] ?? null;
    const installed = exists(dest) ? hashTree(dest) : null;

    let action;
    if (installed === null) action = 'install';
    else if (installed === shippedHash) action = 'unchanged';
    else if (force) action = 'update';
    else if (record?.owned === true && record.hash === installed) action = 'update';
    else if (record?.owned === true) action = 'keep-user-modified';
    else action = 'keep-unknown';

    if (action === 'install' || action === 'update') {
      effects.push({ type: 'replace-dir', path: dest, source, reason: `preset ${name}` });
      presets[name] = { hash: shippedHash, owned: true, action };
      notes.push(`preset ${name}：${action === 'install' ? '安装' : '升级'}`);
    } else if (action === 'unchanged') {
      presets[name] = { hash: installed, owned: true, action };
      notes.push(`preset ${name}：已是最新`);
    } else {
      presets[name] = { hash: installed, owned: false, action };
      warnings.push(
        action === 'keep-user-modified'
          ? `preset ${name} 在安装后已被修改，本次未覆盖（确定要覆盖请加 --force-presets）`
          : `preset ${name} 已存在且与内置版本不同，来源无法确认，本次未覆盖（确定要覆盖请加 --force-presets）`
      );
    }
  }

  // 4) 插件：开发模式链接回仓库；发布模式按版本释放到 runtime 再链接
  const pluginSource = path.join(resourceRoot, 'plugins', PLUGIN_NAME);
  const pluginLink = path.join(dshHome, 'plugins', PLUGIN_NAME);
  let pluginTarget = null;
  if (!fs.existsSync(pluginSource)) {
    warnings.push(`内置插件缺失，跳过：${pluginSource}`);
  } else {
    if (core.packaged) {
      pluginTarget = path.join(dataRoot, 'runtime', version, PLUGIN_NAME);
      // 按版本释放；版本目录属于本应用管理，内容一致时不产生 effect（保证重复执行是空操作）。
      const releasedHash = exists(pluginTarget) ? hashTree(pluginTarget) : null;
      const shippedHash = hashTree(pluginSource);
      if (releasedHash === shippedHash) {
        notes.push(`插件：runtime 已是最新 ${pluginTarget}`);
      } else {
        effects.push({ type: 'replace-dir', path: pluginTarget, source: pluginSource, reason: '插件按版本释放' });
        notes.push(
          releasedHash === null
            ? `插件：按版本释放到 ${pluginTarget}`
            : `插件：runtime 内容与内置不一致，已重新释放 ${pluginTarget}`
        );
      }
    } else {
      pluginTarget = pluginSource;
      notes.push(`插件：开发模式链接到仓库 ${pluginSource}`);
    }
    const stat = exists(pluginLink) ? fs.lstatSync(pluginLink) : null;
    if (stat && !stat.isSymbolicLink()) {
      warnings.push(
        `插件路径已存在且不是链接（可能是用户自己的目录），未覆盖：${pluginLink}；` +
          '请先移开该目录再重新运行'
      );
      pluginTarget = null;
    } else if (stat && samePath(realpathOrNull(pluginLink), pluginTarget)) {
      // 链接已指向正确目标：不产生 effect，保证重复执行是完整的空操作。
      notes.push('插件链接：已指向正确位置');
    } else {
      effects.push({
        type: 'ensure-link-or-copy',
        path: pluginLink,
        target: pluginTarget,
        fallbackSourceDir: pluginSource
      });
      notes.push('插件链接：将（重新）创建');
    }
  }

  // 5) profile cordis.patch.yml 的 MCP 配置
  const profileDir = path.join(dshHome, 'profiles', profile);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  let cordisKind = 'missing';
  if (exists(patchFile)) {
    const raw = fs.readFileSync(patchFile, 'utf8');
    const text = renameLegacyMarkers(raw);
    const state = detectCordisState(raw);
    cordisKind = state.kind;
    if (state.hadLegacyMarker) notes.push('cordis.patch.yml：旧注释标记已改名');

    if (state.kind === 'marked') {
      const result = replaceMarkedBlock(text, core);
      if (result.changed) {
        effects.push({ type: 'write-file', path: patchFile, content: result.text, reason: 'MCP 块更新' });
        notes.push('cordis.patch.yml：MCP 块已更新为当前 Core 启动方式');
      } else {
        notes.push('cordis.patch.yml：MCP 块已是最新');
      }
    } else if (state.kind === 'unmarked-ours') {
      const result = rewriteEntryCommands(text, core);
      if (result.changed) {
        effects.push({ type: 'write-file', path: patchFile, content: result.text, reason: 'MCP 条目就地修复' });
        notes.push(`cordis.patch.yml：就地修复无标记的旧 MCP 条目（${result.repaired.join('、')}）`);
        warnings.push('该文件没有 whalebridge 标记块，本次只就地改了 command/args，未重排其它配置。');
      } else {
        // 条目内容已正确，只是没有标记块：**不补标记块**——补了会与既有条目重复注册同一批
        // MCP server。就地上改（rewriteEntryCommands）本身足以支撑后续升级。
        notes.push('cordis.patch.yml：无标记，但 MCP 条目已指向当前 Core');
        const missing = MCP_SERVERS.filter((server) => !result.present?.includes(server.id));
        if (result.present && result.present.length < MCP_SERVERS.length) {
          warnings.push(
            `该文件只找到 ${result.present.length}/${MCP_SERVERS.length} 个 whalebridge MCP 条目` +
              `（缺：${missing.map((server) => server.id).join('、')}），未自动补齐——` +
              '补齐会启用可能被有意去掉的服务，需要时请手工添加。'
          );
        }
      }
    } else {
      const stripped = text.replace(/^[ \t]*\[\][ \t]*(?:\r?\n|$)/gm, '');
      const base = stripped.trim().length > 0 ? (stripped.endsWith('\n') ? stripped : `${stripped}\n`) : '';
      const next = base.length > 0 ? `${base}\n${buildMcpBlock(core)}` : buildMcpBlock(core);
      effects.push({ type: 'write-file', path: patchFile, content: next, reason: 'MCP 块追加' });
      notes.push('cordis.patch.yml：已追加 whalebridge MCP 块');
    }
  } else {
    effects.push({ type: 'write-file', path: patchFile, content: buildMcpBlock(core), reason: 'MCP 块新建' });
    notes.push('cordis.patch.yml：新建并写入 MCP 块');
  }

  // 6) profile package.json 注册 whale-mode-console
  const pkgFile = path.join(profileDir, 'package.json');
  let pkg = { name: `dsh-profile-${profile}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  const pkgExisted = exists(pkgFile);
  let originalPkgText = null;
  if (pkgExisted) {
    originalPkgText = fs.readFileSync(pkgFile, 'utf8');
    try {
      pkg = JSON.parse(originalPkgText);
    } catch (error) {
      throw new Error(`profile package.json 解析失败：${pkgFile}（${error.message}）`);
    }
  }
  pkg.name = pkg.name || `dsh-profile-${profile}`;
  pkg.private = pkg.private !== false;
  if (!pkg.dependencies || typeof pkg.dependencies !== 'object' || Array.isArray(pkg.dependencies)) pkg.dependencies = {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  if (Object.prototype.hasOwnProperty.call(pkg.dependencies, LEGACY.plugin)) {
    delete pkg.dependencies[LEGACY.plugin];
    notes.push(`profile package.json：移除旧依赖 ${LEGACY.plugin}`);
  }
  const legacyBundleIndex = pkg.dsh.profile.bundles.indexOf(LEGACY.plugin);
  if (legacyBundleIndex >= 0) {
    pkg.dsh.profile.bundles.splice(legacyBundleIndex, 1);
    notes.push(`profile package.json：移除旧 bundle ${LEGACY.plugin}`);
  }
  const linkValue = `link:${pluginLink.replace(/\\/g, '/')}`;
  if (pkg.dependencies[PLUGIN_NAME] !== linkValue) {
    pkg.dependencies[PLUGIN_NAME] = linkValue;
    notes.push(`profile package.json：依赖 ${PLUGIN_NAME} → ${linkValue}`);
  }
  if (!pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
    pkg.dsh.profile.bundles.push(PLUGIN_NAME);
    notes.push(`profile package.json：新增 bundle ${PLUGIN_NAME}`);
  }
  const pkgContent = `${JSON.stringify(pkg, null, 2)}\n`;
  // 只按"结构是否变化"判断，避免因用户自己的缩进/键顺序不同而反复重写文件。
  let pkgChanged = !pkgExisted;
  if (pkgExisted) {
    try {
      pkgChanged = JSON.stringify(JSON.parse(originalPkgText)) !== JSON.stringify(pkg);
    } catch {
      pkgChanged = true;
    }
  }
  if (pkgChanged) {
    effects.push({ type: 'write-file', path: pkgFile, content: pkgContent, reason: 'profile package.json' });
  } else {
    notes.push('profile package.json：已是最新');
  }

  // 7) state/mode.json 兜底默认模式（只在缺失时创建）
  const modeFile = path.join(dataRoot, 'state', 'mode.json');
  if (!exists(modeFile)) {
    effects.push({
      type: 'write-file',
      path: modeFile,
      content: `${JSON.stringify({ mode: 'social', closedAgentPreset: 'router-standard' }, null, 2)}\n`,
      reason: 'state/mode.json 兜底'
    });
    notes.push('state/mode.json：创建（mode=social）');
  } else {
    notes.push('state/mode.json：已存在，保持不变（可能是用户选择的模式）');
  }

  // 8) manifest：只记录"持久事实"（归属与内容哈希），不记录本次动作，
  //    否则重复执行会因为 action 从 install 变成 unchanged 而重写 manifest。
  const existingManifestText = readManifestText(dshHome);
  const changed = effects.length > 0;
  const manifestPresets = {};
  for (const [name, record] of Object.entries(presets)) {
    manifestPresets[name] = { hash: record.hash, owned: record.owned === true };
  }
  const ownedFiles = { ...(manifest?.ownedFiles ?? {}) };
  for (const effect of effects) {
    if (effect.type !== 'write-file') continue;
    const relative = path.relative(dshHome, effect.path);
    // dataRoot 下的文件（如 state/mode.json）不属于 DSH_HOME 的归属清单。
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    ownedFiles[relative.split(path.sep).join('/')] = hashText(effect.content);
  }
  const nextManifest = {
    schemaVersion: MANIFEST_SCHEMA,
    product: '鲸桥 WhaleBridge',
    version,
    updatedAt: changed ? now() : (manifest?.updatedAt ?? now()),
    profile,
    core: { packaged: core.packaged, command: core.command, argsPrefix: core.argsPrefix },
    presets: manifestPresets,
    plugin: { name: PLUGIN_NAME, link: pluginLink, target: pluginTarget },
    ownedFiles
  };
  const manifestText = `${JSON.stringify(nextManifest, null, 2)}\n`;
  if (changed || existingManifestText !== manifestText) {
    effects.push({ type: 'write-file', path: path.join(dshHome, MANIFEST_FILE), content: manifestText, reason: '集成 manifest' });
  }

  return {
    dshHome,
    profile,
    version,
    core,
    resourceRoot,
    dataRoot,
    effects,
    warnings,
    notes,
    presets,
    cordisKind,
    manifest: nextManifest,
    changed
  };
}

function readManifestText(dshHome) {
  try {
    return fs.readFileSync(path.join(dshHome, MANIFEST_FILE), 'utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ 执行与回滚

function snapshotPath(target, backupDir, label) {
  if (!exists(target)) return { path: target, existed: false };
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    return { path: target, existed: true, link: true, linkTarget: fs.readlinkSync(target) };
  }
  const backup = path.join(backupDir, label);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.cpSync(target, backup, { recursive: true, force: true });
  return { path: target, existed: true, link: false, backup };
}

function restoreSnapshot(snapshot) {
  removePath(snapshot.path);
  if (!snapshot.existed) return;
  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
  if (snapshot.link) {
    fs.symlinkSync(snapshot.linkTarget, snapshot.path, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  fs.cpSync(snapshot.backup, snapshot.path, { recursive: true, force: true });
}

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function renameWithRetrySync(from, to, {
  renameSync = fs.renameSync,
  platform = process.platform,
  retryDelayMs = 40,
  maxRetries = 4
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return renameSync(from, to);
    } catch (error) {
      if (platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= maxRetries) throw error;
      const delayMs = Math.max(0, Number(retryDelayMs) || 0) * (2 ** attempt);
      if (delayMs > 0) Atomics.wait(RENAME_RETRY_WAIT, 0, 0, delayMs);
    }
  }
}

function applyEffect(effect, hooks = {}) {
  switch (effect.type) {
    case 'write-file':
      fs.mkdirSync(path.dirname(effect.path), { recursive: true });
      fs.writeFileSync(effect.path, effect.content, 'utf8');
      return;
    case 'replace-dir': {
      // 先复制到同目录暂存名再原子替换，避免中途失败留下半个目录。
      const staging = `${effect.path}.whalebridge-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
      fs.mkdirSync(path.dirname(effect.path), { recursive: true });
      try {
        fs.cpSync(effect.source, staging, { recursive: true, force: true });
        removePath(effect.path);
        renameWithRetrySync(staging, effect.path, {
          renameSync: hooks.renameSync ?? fs.renameSync,
          platform: hooks.platform ?? process.platform,
          retryDelayMs: hooks.renameRetryDelayMs ?? 40
        });
      } catch (error) {
        try {
          fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (cleanupError) {
          throw new Error(
            `${error?.message ?? error}; staged directory cleanup failed: ${cleanupError?.message ?? cleanupError}`,
            { cause: error }
          );
        }
        throw error;
      }
      return;
    }
    case 'ensure-link-or-copy': {
      removePath(effect.path);
      fs.mkdirSync(path.dirname(effect.path), { recursive: true });
      try {
        fs.symlinkSync(effect.target, effect.path, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        // 权限不足无法创建链接时退化为直接复制：DSH 只要求该路径可解析。
        fs.cpSync(effect.fallbackSourceDir, effect.path, { recursive: true, force: true });
        effect.degraded = `创建链接失败（${error.code ?? error.message}），已改为直接复制文件`;
      }
      return;
    }
    case 'remove':
      removePath(effect.path);
      return;
    case 'remove-empty-dir':
      // 只删空目录：非空时 rmdir 会失败，正好保护用户/其它版本留下的内容。
      try {
        fs.rmdirSync(effect.path);
      } catch {
        /* 非空或不存在：保持原样 */
      }
      return;
    default:
      throw new Error(`未知的 effect 类型：${effect.type}`);
  }
}

/**
 * 顺序执行 effects，任何一步失败都回滚到执行前状态。
 * hooks.beforeEffect(effect, index) 供测试注入故障。
 */
export function applyPlan(plan, { hooks = {}, log = () => {}, backupRoot } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let backupDir = backupRoot ?? path.join(plan.dshHome, BACKUP_DIR, stamp);
  // Reserve one transaction-owned directory atomically before rollback can
  // delete it. Timestamps alone collide; existing caller paths are not ours.
  // A zero-effect plan remains a true filesystem no-op.
  if (plan.effects.length) {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    if (backupRoot != null) fs.mkdirSync(backupDir);
    else backupDir = fs.mkdtempSync(backupDir + '-');
  }
  const snapshots = [];
  const seen = new Set();

  try {
    for (const effect of plan.effects) {
      if (seen.has(effect.path)) continue;
      seen.add(effect.path);
      snapshots.push(snapshotPath(effect.path, backupDir, `snap-${snapshots.length}`));
    }
    for (let i = 0; i < plan.effects.length; i += 1) {
      const effect = plan.effects[i];
      if (hooks.beforeEffect) hooks.beforeEffect(effect, i);
      applyEffect(effect, hooks);
      if (effect.degraded) log(`警告：${effect.degraded}（${effect.path}）`);
    }
  } catch (error) {
    log(`执行失败，正在回滚：${error.message}`);
    const rollbackErrors = [];
    for (const snapshot of [...snapshots].reverse()) {
      try {
        restoreSnapshot(snapshot);
      } catch (rollbackError) {
        rollbackErrors.push(`${snapshot.path}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length === 0) {
      // 回滚干净：系统已回到执行前状态，这次失败的尝试不留痕迹。
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
      } catch {
        /* 备份目录删不掉不影响正确性 */
      }
      throw new Error(`DSH 集成执行失败并已回滚：${error.message}`);
    }
    throw new Error(
      `DSH 集成执行失败，且部分回滚失败：${error.message}；` +
        `回滚问题：${rollbackErrors.join('；')}；备份保留在 ${backupDir}`
    );
  }

  return { backupDir, snapshots: snapshots.length };
}

// ------------------------------------------------------------ 编排

export function resolveProductVersion({ resourceRoot, sourceRoot } = {}) {
  const candidates = [
    resourceRoot && path.join(resourceRoot, 'product.json'),
    resourceRoot && path.join(resourceRoot, '..', 'runtime-manifest.json'),
    resourceRoot && path.join(resourceRoot, 'runtime-manifest.json'),
    sourceRoot && path.join(sourceRoot, 'package.json')
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed?.version) return String(parsed.version);
    } catch {
      /* 换下一个候选 */
    }
  }
  return '0.0.0';
}

/** 探测 DSH 是否在监听，用于给出"必须重启 DSH"的提示。 */
export function probeDshRunning(port = 3080, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export function formatPlanReport(plan, { dryRun = false, dshRunning = null } = {}) {
  const lines = [];
  lines.push(`鲸桥 DSH 集成${dryRun ? '（预演，未写入任何文件）' : ''}`);
  lines.push(`  DSH_HOME ：${plan.dshHome}`);
  lines.push(`  profile  ：${plan.profile}`);
  lines.push(`  Core     ：${plan.core.description}`);
  lines.push(`  资源目录 ：${plan.resourceRoot}`);
  lines.push(`  数据目录 ：${plan.dataRoot}`);
  lines.push(`  MCP 配置 ：cordis.patch.yml（${plan.cordisKind}）`);
  if (plan.notes.length > 0) {
    lines.push('  计划：');
    for (const note of plan.notes) lines.push(`    - ${note}`);
  }
  if (plan.warnings.length > 0) {
    lines.push('  需要人工确认：');
    for (const warning of plan.warnings) lines.push(`    ! ${warning}`);
  }
  if (plan.effects.length === 0) lines.push('  结果：无需改动，已是目标状态');
  if (dshRunning === true) {
    lines.push('  ⚠️ 检测到 DSH 正在运行：新 preset / MCP 配置必须**重启 DSH** 后才会生效。');
  }
  return lines.join('\n');
}

/**
 * 完整流程：探测 → 规划 →（可选）预演 → 执行 → 注册 profile bundle → 报告。
 * 供 `WhaleBridgeCore.exe --setup-dsh` 与 scripts/setup-dsh.mjs 共用。
 */
export async function runSetupDsh(options = {}) {
  const {
    profile = 'web',
    dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    resourceRoot,
    dataRoot,
    sourceRoot,
    version,
    core,
    force = false,
    dryRun = false,
    probeDsh = true,
    dshPort = 3080,
    installProfileBundles = true,
    log = (message) => console.log(message)
  } = options;

  if (!resourceRoot || !dataRoot) throw new Error('runSetupDsh 需要 resourceRoot 与 dataRoot');
  const resolvedCore = core ?? resolveCoreLaunch({
    packaged: false,
    dataRoot,
    entryPath: path.join(sourceRoot ?? resourceRoot, 'src', 'core-entry.js')
  });
  const manifest = readManifest(dshHome);
  const plan = planIntegration({
    dshHome,
    profile,
    resourceRoot,
    dataRoot,
    version: version ?? resolveProductVersion({ resourceRoot, sourceRoot }),
    core: resolvedCore,
    manifest,
    force
  });

  const dshRunning = probeDsh && !dryRun ? await probeDshRunning(dshPort) : null;
  log(formatPlanReport(plan, { dryRun, dshRunning }));

  if (dryRun) return { plan, dryRun: true, applied: false };
  if (plan.effects.length === 0) {
    log('  结果：没有需要写入的改动（幂等）');
    if (installProfileBundles) installProfileBundle(profile, log);
    return { plan, dryRun: false, applied: false };
  }

  const result = applyPlan(plan, { log });
  log(`  已写入 ${plan.effects.length} 项改动（备份：${result.backupDir}）`);
  if (installProfileBundles) installProfileBundle(profile, log);
  if (dshRunning) {
    log('  ⚠️ 请重启 DSH：当前 DSH 进程仍在使用旧配置。');
  } else {
    log('  下一步：启动（或重启）DSH 使新 preset / MCP 生效。');
  }
  return { plan, dryRun: false, applied: true, ...result };
}

/**
 * whale-mode-console 以 link: 依赖注册进 profile package.json 后，DSH 首次启动需要先安装一次
 * 才能解析该 bundle，否则冷启动报 "cannot resolve profile bundle"。dsh CLI 可用时自动执行。
 */
export function installProfileBundle(profile, log = () => {}) {
  assertValidProfile(profile);
  const isWindows = process.platform === 'win32';
  // Windows 上 dsh 是 dsh.cmd 批处理，直接 spawn 会 EINVAL；用 cmd /c 显式调用，
  // 比 shell:true 更可控（不经 shell 展开，也不用 Node 的 shell 参数拼接）。
  const result = isWindows
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'dsh.cmd', 'plugin', '--profile', profile, 'install'],
        { encoding: 'utf8', timeout: 180000, windowsHide: true }
      )
    : spawnSync('dsh', ['plugin', '--profile', profile, 'install'], { encoding: 'utf8', timeout: 180000 });
  if (result.error) {
    log(`  跳过 profile bundle 安装：未找到 dsh CLI（${result.error.code || result.error.message}）。`);
    log(`  若 DSH 启动报 "cannot resolve profile bundle \\"${PLUGIN_NAME}\\""，请手动执行：dsh plugin --profile ${profile} install`);
    return { ok: false, skipped: true };
  }
  // cmd / PowerShell 找不到命令时是本地化文案（中英都要认），退出码与真实失败无法区分。
  const stderr = String(result.stderr ?? '');
  if (/not recognized|not found|不是内部或外部命令|cannot find/i.test(stderr)) {
    log('  跳过 profile bundle 安装：PATH 中没有 dsh CLI。');
    log(`  若 DSH 启动报 "cannot resolve profile bundle \\"${PLUGIN_NAME}\\""，请手动执行：dsh plugin --profile ${profile} install`);
    return { ok: false, skipped: true };
  }
  if (result.status === 0) {
    log(`  dsh plugin --profile ${profile} install：OK`);
    return { ok: true };
  }
  log(`  dsh plugin --profile ${profile} install 退出码 ${result.status}；若 DSH 报 bundle 解析失败请手动重跑。`);
  return { ok: false, status: result.status };
}

/** 应用内入口：用 APP_PATHS 与运行模式推导出全部参数。 */
export async function runSetupDshFromApp(options = {}) {
  const core = resolveCoreLaunch({
    packaged: isPackagedRuntime(),
    dataRoot: options.dataRoot ?? APP_PATHS.dataRoot,
    execPath: process.execPath,
    entryPath: path.join(APP_PATHS.sourceRoot, 'src', 'core-entry.js')
  });
  return runSetupDsh({
    ...options,
    dshHome: options.dshHome ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    resourceRoot: options.resourceRoot ?? APP_PATHS.resourceRoot,
    dataRoot: options.dataRoot ?? APP_PATHS.dataRoot,
    sourceRoot: options.sourceRoot ?? APP_PATHS.sourceRoot,
    core
  });
}
