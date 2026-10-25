// CetaMesh Workspace v1 —— 路径安全边界（阶段 05）。
//
// 这是本阶段的安全核心：所有 Agent / 工具文件访问都必须经过这里解析和裁决，
// 任何"看起来像路径"的输入都不得绕过。设计目标：
//
// 1. 词法裁决：resolve(root, input) 后必须落在 root 内（含 `..` 收敛、绝对路径
//    覆盖、盘符相对路径等一切 path.win32 能表达的形态）。
// 2. 文件系统裁决：对已存在的部分做 realpath（junction / symlink / 8.3 短名 /
//    大小写归一后）再校验一次，防止"root 内的链接指向 root 外"的逃逸。
// 3. Windows 特例显式拒绝：
//    - UNC / 设备路径输入（\\server\share、\\?\）——不属于本地工作区语义；
//    - 保留设备名（CON / NUL / COM1 ...，含带扩展名形式）——打开会挂起或语义错乱；
//    - 段首段尾的空白与点（'.. ' 会被 Win32 归一成 '..'，属真实穿越向量）；
//    - NUL 字节。
// 4. root 自身的危险形态拒绝：盘符根、Windows / Program Files、用户主目录
//    及其祖先——这些位置做 root 等于把边界开到整机。
//
// 已知限制（v1 如实记录，不冒称已解决）：
// - TOCTOU：realpath 校验与实际 open 之间存在窗口，拥有 root 内写权限的进程
//   理论上可在此窗口内替换链接。v1 通过"写入前重验父目录 realpath"收窄，
//   彻底解决需要 openat2 风格的内核支持，超出本阶段范围。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class WorkspaceBoundaryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
    this.code = code;
  }
}

// Win32 保留设备名（经典规则：名字本身或"名字.任意扩展名"都保留）。
const WIN_RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..+)?$/i;

function isWindows() {
  return process.platform === 'win32';
}

function fail(code, message) {
  throw new WorkspaceBoundaryError(code, message);
}

function realpathNative(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

/** 归一化用于比较：Windows 转小写 + 去尾部分隔符（保留盘符根的 'x:' 形态）。 */
function normalizeForCompare(p) {
  const resolved = path.resolve(String(p ?? ''));
  return isWindows() ? resolved.toLowerCase().replace(/[\\/]+$/, '') : resolved.replace(/\/+$/, '');
}

/** candidate 是否为 root 本身或 root 之内（仅 Windows 使用大小写不敏感语义）。 */
export function isInsideRoot(root, candidate) {
  const a = normalizeForCompare(root);
  const b = normalizeForCompare(candidate);
  if (a === b) return true;
  return b.startsWith(a + path.sep);
}

/** danger 是否等于 root 或位于 root 之下（用于拒绝把危险目录选为工作区）。 */
function isAncestorOrSelf(root, target) {
  return isInsideRoot(root, target);
}

function assertSafeSegmentName(segment, { forWrite }) {
  if (segment.includes('\0')) fail('PATH_INVALID', `路径包含 NUL 字节：${JSON.stringify(segment)}`);
  if (/\s$/.test(segment) || /\.$/.test(segment)) {
    fail('PATH_INVALID', `路径段含尾部空白或点（Win32 会改写语义）：${JSON.stringify(segment)}`);
  }
  if (WIN_RESERVED_DEVICE.test(segment)) {
    fail('PATH_RESERVED', `保留设备名不可访问（读/写均拒绝）：${segment}`);
  }
}

/**
 * 把 root 内的 target 解析为真实路径（存在的部分经 realpath，不存在的尾部按
 * 真实父目录拼接并 normalize——join 的 normalize 语义恰好把 '..' 尾巴收敛掉，
 * 这正是 '.. '（尾部空格）这类 Win32 改写向量的第二道防线）。
 */
function realResolve(rootReal, lexicalPath) {
  const { real, suffix } = deepestExisting(lexicalPath);
  return path.normalize(path.join(real, suffix));

  function deepestExisting(candidate) {
    let tail = [];
    let cursor = candidate;
    for (;;) {
      try {
        return { real: realpathNative(cursor), suffix: tail.length ? path.join(...tail) : '' };
      } catch {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('PATH_INVALID', `无法定位已存在的父目录：${candidate}`);
        tail.unshift(path.basename(cursor));
        cursor = parent;
      }
    }
  }
}

/**
 * 校验输入并将其约束在 root 内。
 * 返回 { absolute, real }：
 * - absolute：词法解析后的绝对路径（可能尚不存在）；
 * - real：存在的部分经 realpath 后的真实路径（junction/symlink/大小写已归一）。
 * root 必须已经过 canonicalizeRoot（真实存在的目录）。
 */
export function resolveInside(rootReal, userInput, { forWrite = false } = {}) {
  const input = String(userInput ?? '');
  if (input.includes('\0')) fail('PATH_INVALID', '路径包含 NUL 字节');
  if (input.length > 1024) fail('PATH_INVALID', '路径过长（>1024 字符）');
  if (/^[\\/]{2}/.test(input)) {
    fail('PATH_UNC', '不接受 UNC / 设备路径（\\\\server\\share、\\\\?\\）');
  }

  const lexical = path.resolve(rootReal, input);
  if (!isInsideRoot(rootReal, lexical)) {
    fail('BOUNDARY_ESCAPE', `路径越界：${input} 解析后位于工作区之外`);
  }

  // 逐段检查（相对 root 的部分）：覆盖 '.. ' / 'con' / 段尾点空等 Win32 特例。
  const rel = path.relative(rootReal, lexical);
  if (rel && rel !== '.') {
    for (const segment of rel.split(/[\\/]+/)) {
      if (!segment || segment === '.' || segment === '..') continue; // resolve 已收敛，防御性跳过
      assertSafeSegmentName(segment, { forWrite });
    }
  }

  const real = realResolve(rootReal, lexical);
  if (!isInsideRoot(rootReal, real)) {
    fail('BOUNDARY_ESCAPE', `路径越界（realpath）：${input} 经文件系统解析后位于工作区之外`);
  }
  return { absolute: lexical, real };
}

/**
 * 危险 root 形态检查（不需要目录已存在）：盘符根 / 系统 / 全局目录及其祖先。
 * canonicalizeRoot 与"新建工作区目录"流程都必须先过这一步，避免把目录
 * 先建进系统位置再拒绝。
 */
export function assertSafeRootForm(rootInput, { env = process.env, home = os.homedir() } = {}) {
  const raw = String(rootInput ?? '').trim();
  if (!raw) fail('ROOT_INVALID', '工作区根目录不能为空');
  if (raw.includes('\0')) fail('ROOT_INVALID', '工作区根目录包含 NUL 字节');
  if (/^[\\/]{2}/.test(raw)) fail('ROOT_INVALID', '不接受 UNC / 设备路径作为工作区根目录');
  const resolved = path.resolve(raw);
  if (!isWindows() && [path.parse(resolved).root, '/etc', '/usr', home].some(danger => isAncestorOrSelf(resolved, danger))) {
    fail('ROOT_FORBIDDEN', `不允许把系统 / 全局目录（或其祖先）作为工作区：${resolved}`);
  }
  if (isWindows()) {
    if (/^[a-zA-Z]:\\?$/.test(resolved)) fail('ROOT_FORBIDDEN', `不允许把盘符根作为工作区：${resolved}`);
    const dangers = [
      env.SystemRoot || env.windir || 'C:\\Windows',
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.ProgramData ? env.ProgramData : null,
      home
    ].filter(Boolean);
    for (const danger of dangers) {
      if (isAncestorOrSelf(resolved, danger)) {
        fail('ROOT_FORBIDDEN', `不允许把系统 / 全局目录（或其祖先）作为工作区：${resolved}`);
      }
    }
  }
  return resolved;
}

/**
 * 把用户选择的工作区 root 规范化为真实绝对路径，并拒绝危险 root。
 * 返回真实路径字符串（后续所有解析都以它为基准）。
 */
export function canonicalizeRoot(rootInput, { env = process.env, home = os.homedir() } = {}) {
  const raw = String(rootInput ?? '').trim();
  if (!raw) fail('ROOT_INVALID', '工作区根目录不能为空');
  if (raw.includes('\0')) fail('ROOT_INVALID', '工作区根目录包含 NUL 字节');
  if (/^[\\/]{2}/.test(raw)) fail('ROOT_INVALID', '不接受 UNC / 设备路径作为工作区根目录');

  let resolved;
  try {
    resolved = path.resolve(raw);
  } catch (error) {
    fail('ROOT_INVALID', `工作区根目录无法解析：${error?.message ?? error}`);
  }
  assertSafeRootForm(resolved, { env, home });

  let real;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) fail('ROOT_INVALID', `工作区根目录必须是目录：${resolved}`);
    real = realpathNative(resolved);
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) throw error;
    fail('ROOT_NOT_FOUND', `工作区根目录不存在或不可访问：${resolved}`);
  }

  assertSafeRootForm(real, { env, home });
  if (isWindows()) {
    // 盘符根（C:\ 等）：作为工作区等于放弃边界。realpath 后可能改写形态，复检。
    if (/^[a-zA-Z]:\\?$/.test(real)) fail('ROOT_FORBIDDEN', `不允许把盘符根作为工作区：${real}`);
    const dangers = [
      env.SystemRoot || env.windir || 'C:\\Windows',
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      env.ProgramData ? env.ProgramData : null,
      home
    ].filter(Boolean);
    for (const danger of dangers) {
      if (isAncestorOrSelf(real, danger)) {
        fail('ROOT_FORBIDDEN', `不允许把系统 / 全局目录（或其祖先）作为工作区：${real}`);
      }
    }
  }
  return real;
}

/** 候选 root 的危险性预检（供 UI 在创建前给出可读错误，语义与 canonicalizeRoot 一致）。 */
export function explainRootProblem(rootInput) {
  try {
    canonicalizeRoot(rootInput);
    return null;
  } catch (error) {
    return error instanceof WorkspaceBoundaryError ? error : null;
  }
}
