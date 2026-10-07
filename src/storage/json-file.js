// D3 Storage Primitive —— 统一的「JSON 文件可靠 I/O」原语。
//
// 定位（重要）：本模块只做文件层的事——UTF-8/BOM、ENOENT 语义、大小上限、
// 原子写（crypto 临时名 + fsync + rename + 失败清理）、Windows rename 兼容。
// 它不承载任何业务语义：不定义 Domain 错误码、不做默认值合并、不做 schema 校验、
// 不提供跨进程文件锁。Domain（config/task/memory/settings/extension/...）在自己的
// 边界里把 StorageError 映射为 STORE_CORRUPT / CONFIG_CORRUPT / REGISTRY_CORRUPT /
// ...—— 对外错误码兼容由 Domain 保证，UI 永远不应该看到 StorageError。
//
// Windows 语义（项目主要目标平台）：
// - rename 覆盖已存在目标：Node 在 Windows 上以 MOVEFILE_REPLACE_EXISTING 执行；
//   但杀毒 / 索引 / 备份类进程短暂持有目标句柄时会得到 EPERM/EBUSY —— 这里做有界重试；
// - 临时文件写在目标同目录（保证与目标同一卷，rename 才是原子的）；
// - 临时名含 pid + crypto 随机字节：并发进程/同进程交错写不会互相覆盖，
//   也不给「预测临时名 → 符号链接攻击」留面；
// - 失败路径一律尽力删除临时文件，不留 *.tmp 垃圾。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** 读路径的绝对上限：防御把异常巨大的文件整读进内存（正常 store 远小于此）。 */
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const RENAME_RETRY_LIMIT = 5;
const RENAME_RETRY_BASE_MS = 25;

export class StorageError extends Error {
  /**
   * code ∈ MISSING | CORRUPT | READ_FAILED | TOO_LARGE | WRITE_FAILED
   * MISSING=文件不存在；CORRUPT=JSON 解析失败（含空文件）；READ_FAILED=存在但读不了；
   * TOO_LARGE=超出 maxBytes；WRITE_FAILED=写/同步/替换失败。cause 保留底层错误。
   */
  constructor(code, message, { cause, file } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.file = file ?? null;
    if (cause !== undefined) this.cause = cause;
  }
}

function describeError(error) {
  return String(error?.message ?? error);
}

/** 同步休眠：rename 重试退避用。不可阻塞的环境退化为立即重试。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return true;
  } catch {
    return false; // SharedArrayBuffer/Atomics 不可用时无法同步休眠；重试仍成立，只是没有退避间隔。
  }
}

/** best-effort 删除：失败如实返回 false（temp 名唯一，残片不会覆盖任何数据）。 */
export function discardFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false; // 目标不存在/被占用等：调用方均为清理语义，无需上报。
  }
}

/** 尽力关闭 fd（收尾路径，失败没有可上报的额外信息）。 */
function closeBestEffort(fd) {
  try {
    fs.closeSync(fd);
    return true;
  } catch {
    return false; // fd 已由内核回收的场景；保留原始错误给调用方。
  }
}

/** 尽力 fsync：个别文件系统不支持；返回 false 表示持久化加固未完成（数据本身已写入）。 */
function fsyncBestEffort(fd) {
  try {
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false; // 平台/文件系统不支持时的降级：写路径本身仍然有效。
  }
}

/** rename + Windows 有界重试：EPERM/EBUSY/EACCES 常来自外部进程短暂持有目标句柄。 */
function renameWithRetry(from, to) {
  let lastError;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return true;
    } catch (error) {
      lastError = error;
      const retryable = error && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
      if (!retryable || attempt >= RENAME_RETRY_LIMIT) break;
      sleepSync(RENAME_RETRY_BASE_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

/** BOM 容错解析：Windows 编辑器常见的 \uFEFF 会令 JSON.parse 失败，统一在这里剥掉。 */
export function parseJsonText(text, { file = '<memory>' } = {}) {
  let working = String(text ?? '');
  if (working.charCodeAt(0) === 0xFEFF) working = working.slice(1);
  try {
    return JSON.parse(working);
  } catch (error) {
    throw new StorageError('CORRUPT', `${file}: JSON 解析失败（${describeError(error)}）`, { cause: error, file });
  }
}

/**
 * 读取并解析 JSON 文件。
 * - 文件不存在：options 显式提供 `missing` 时返回它，否则抛 StorageError('MISSING')
 *   （用 Object.hasOwn 区分「调用方没配 fallback」和「fallback 本身就是 undefined」）。
 * - 空文件 / 非 JSON：抛 CORRUPT。禁止偷偷降级成 {}——是否容忍损坏由 Domain 决策。
 * - maxBytes：超出即拒绝（TOO_LARGE），防止异常增长的状态文件拖垮进程。
 */
export function readJsonFile(file, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES } = options;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      if (Object.hasOwn(options, 'missing')) return options.missing;
      throw new StorageError('MISSING', `${file}: 文件不存在`, { cause: error, file });
    }
    throw new StorageError('READ_FAILED', `${file}: 读取失败（${describeError(error)}）`, { cause: error, file });
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new StorageError('TOO_LARGE', `${file}: 超过读取上限 ${maxBytes} 字节`, { file });
  }
  return parseJsonText(text, { file });
}

/**
 * 原子写 JSON：临时文件（同目录、pid+crypto 名、0600）→ 写入 → fsync → rename 替换。
 * 任何一步失败都会尽力清理临时文件，并把原始错误包进 StorageError('WRITE_FAILED')。
 */
export function writeJsonAtomic(file, value, { mode = 0o600, indent = 2 } = {}) {
  writeTextAtomic(file, JSON.stringify(value, null, indent) + '\n', { mode });
}

/** 原子写文本（设备身份 PEM、token 等非 JSON 持久化内容的同一套语义）。 */
export function writeTextAtomic(file, text, { mode = 0o600 } = {}) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(temp, 'w', mode);
    fs.writeFileSync(fd, String(text), 'utf8');
    fsyncBestEffort(fd);
    fs.closeSync(fd);
    fd = undefined;
    renameWithRetry(temp, file);
  } catch (error) {
    if (fd !== undefined) closeBestEffort(fd);
    discardFile(temp);
    throw new StorageError('WRITE_FAILED', `${file}: 原子写失败（${describeError(error)}）`, { cause: error, file });
  }
}

/**
 * 读-改-写 convenience：readJsonFile → mutate(current) → writeJsonAtomic。
 * 没有跨进程锁、也没有进程内互斥——并发语义（如 Task 的 expectedRev 冲突检测）
 * 仍由 Domain 层负责；本函数只保证「读到的要么是完整旧值，落盘的要么是完整新值」。
 */
export function updateJsonFile(file, mutate, options = {}) {
  const current = readJsonFile(file, options);
  const next = mutate(current);
  writeJsonAtomic(file, next, options);
  return next;
}
