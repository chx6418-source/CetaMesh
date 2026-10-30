// CetaMesh Workspace v1 —— 工作区工具（阶段 05；会话 2 增补只读 HEAD/diff 摘要）。
//
// 所有文件访问都经 boundary.resolveInto 裁决，工具自身绝不接收/使用绝对路径。
// git 只暴露 status / diff / commit 三个动词与只读的 head 检查（rev-parse HEAD，
// 供 Continuity Workspace Reconciliation 核对 checkpoint 与真实工作区）；
// reset --hard、clean、push 类破坏性操作在本模块没有任何构造路径。
// test.run 只执行工作区设置里登记的测试命令（owner 配置），不接受调用方自带命令串。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec, execFile } from 'node:child_process';
import { resolveInside } from './boundary.js';
import {prepareScopedCommit,commitScopedPaths} from './scoped-git-commit.js';
import { applyWorkspaceTransaction } from './transaction.js';

export class WorkspaceToolError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message);
    this.name = 'WorkspaceToolError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function fail(code, message) {
  throw new WorkspaceToolError(code, message);
}

const READ_MAX_BYTES_HARD_CAP = 10 * 1024 * 1024;
const WRITE_MAX_CHARS_HARD_CAP = 5 * 1024 * 1024;
const SEARCH_LIMIT_CAP = 500;
const SEARCH_MAX_DEPTH = 12;
const SEARCH_MAX_ENTRIES = 50000;
const SEARCH_RESTRICTED_NAME = /^(?:\.git|\.ssh|\.aws|\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

// ── 文件读取 / 写入 ─────────────────────────────────────────────────────────

export function readFile(rootReal, relPath, { maxBytes = 1024 * 1024, offset = 0 } = {}) {
  const cap = Math.max(1, Math.min(READ_MAX_BYTES_HARD_CAP, Number(maxBytes) || 0));
  if (!Number.isSafeInteger(offset) || offset < 0) fail('READ_OFFSET_INVALID', 'File read offset must be a nonnegative integer');
  const { real } = resolveInside(rootReal, relPath, { forWrite: false });
  let stat;
  try {
    stat = fs.statSync(real);
  } catch (error) {
    fail('FILE_NOT_FOUND', `文件不存在：${relPath}（${error?.code ?? error}）`);
  }
  if (stat.isDirectory()) fail('FILE_IS_DIRECTORY', `目标是目录，不是文件：${relPath}`);
  if (offset > stat.size) fail('READ_OFFSET_INVALID', 'File read offset exceeds file size');
  const truncated = stat.size > offset + cap;
  const handle = fs.openSync(real, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(cap, stat.size - offset));
    fs.readSync(handle, buffer, 0, buffer.length, offset);
    const header = Buffer.alloc(Math.min(64, stat.size));
    if (offset) fs.readSync(handle, header, 0, header.length, 0);
    const headerText = offset ? decodeWorkspaceText(header, true) : null;
    const decoded = offset && !headerText ? null : decodeWorkspaceText(buffer, truncated, headerText?.encoding ?? null);
    if (decoded === null) {
      return {
        path: relPath, size: stat.size, offset, nextOffset: truncated ? offset + buffer.length : null, truncated, binary: true,
        base64: buffer.toString('base64')
      };
    }
    const nextOffset = offset + decoded.consumed;
    return { path: relPath, size: stat.size, offset, nextOffset: nextOffset < stat.size ? nextOffset : null,
      truncated: nextOffset < stat.size, binary: false, content: decoded.content, encoding: decoded.encoding };
  } finally {
    fs.closeSync(handle);
  }
}

function decodeWorkspaceText(buffer, truncated = false, encodingHint = null) {
  if (!buffer.length) return { content: '', encoding: encodingHint ?? 'utf-8', consumed: 0 };
  let encoding = encodingHint ?? 'utf-8';
  let bytes = buffer;
  if (!encodingHint && buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = 'utf-16le'; bytes = buffer.subarray(2); }
  else if (!encodingHint && buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = 'utf-16be'; bytes = buffer.subarray(2); }
  else if (!encodingHint && buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) bytes = buffer.subarray(3);
  else if (!encodingHint && buffer.includes(0)) {
    const pairs = Math.floor(buffer.length / 2);
    let evenZeros = 0; let oddZeros = 0;
    for (let index = 0; index < pairs * 2; index += 2) {
      if (buffer[index] === 0) evenZeros++;
      if (buffer[index + 1] === 0) oddZeros++;
    }
    if (pairs >= 4 && oddZeros > pairs * 0.3 && evenZeros < pairs * 0.1) encoding = 'utf-16le';
    else if (pairs >= 4 && evenZeros > pairs * 0.3 && oddZeros < pairs * 0.1) encoding = 'utf-16be';
    else return null;
  }
  const prefixBytes = buffer.length - bytes.length;
  if (encoding.startsWith('utf-16') && bytes.length % 2 && !truncated) return null;
  if (encoding.startsWith('utf-16')) bytes = bytes.subarray(0, bytes.length - bytes.length % 2);
  const decode = (candidate, charset) => new TextDecoder(charset, { fatal: true }).decode(candidate);
  for (const charset of encoding === 'utf-8' ? ['utf-8', 'gb18030'] : [encoding]) {
    for (let trim = 0; trim <= (truncated ? 3 : 0); trim++) {
      try {
        const content = decode(bytes.subarray(0, bytes.length - trim), charset);
        if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) return null;
        return { content, encoding: charset, consumed: prefixBytes + bytes.length - trim };
      } catch {
        // A truncated multibyte sequence may end inside the final character.
        continue;
      }
    }
  }
  return null;
}

export function writeFile(rootReal, relPath, content, { createDirs = true, append = false, expectedHash } = {}) {
  if (typeof content !== 'string') fail('CONTENT_INVALID', 'write 需要 string 内容');
  if (content.length > WRITE_MAX_CHARS_HARD_CAP) {
    fail('CONTENT_TOO_LARGE', `内容过大（>${WRITE_MAX_CHARS_HARD_CAP} 字符）`);
  }
  const { absolute } = resolveInside(rootReal, relPath, { forWrite: true });
  const parentLexical = path.dirname(absolute);
  if (createDirs && parentLexical !== path.resolve(rootReal)) {
    try {
      fs.mkdirSync(parentLexical, { recursive: true });
    } catch (error) {
      fail('WRITE_FAILED', `创建父目录失败：${error?.message ?? error}`);
    }
  }
  // 目录建好后重新 realpath 校验一次父目录，收窄 mkdir 与 open 之间的链接替换窗口。
  const { real: realParent } = resolveInside(rootReal, path.dirname(relPath) || '.', { forWrite: false });
  const target = path.join(realParent, path.basename(absolute));
  let original = null;
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('WRITE_TARGET_INVALID', 'Workspace write requires a regular file');
    original = fs.readFileSync(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const originalHash = original === null ? null : crypto.createHash('sha256').update(original).digest('hex');
  if (expectedHash !== undefined && expectedHash !== originalHash) fail('WORKSPACE_CONFLICT', 'Workspace file changed since it was read');
  const output = append && original !== null ? Buffer.concat([original, Buffer.from(content, 'utf8')]) : Buffer.from(content, 'utf8');
  const temp = path.join(realParent, `.${path.basename(target)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, output); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Recheck before replacement. A linked target or changed preimage must never be followed or overwritten.
    const current = fs.existsSync(target) ? fs.lstatSync(target) : null;
    if (current && (!current.isFile() || current.isSymbolicLink())) fail('WRITE_TARGET_INVALID', 'Workspace target changed to a non-file');
    const liveHash = current ? crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') : null;
    if (liveHash !== originalHash) fail('WORKSPACE_CONFLICT', 'Workspace file changed during write');
    fs.renameSync(temp, target);
  } catch (error) {
    if (error instanceof WorkspaceToolError) throw error;
    fail('WRITE_FAILED', `写入失败：${error?.message ?? error}`);
  } finally {
    try { fs.unlinkSync(temp); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {}
  return { path: relPath, size, bytes: Buffer.byteLength(content, 'utf8') };
}

/** Apply a prevalidated staging import. Callers must authorize the complete batch first. */
export function applyWorkspaceChanges(rootReal, changes, options = {}) {
  return applyWorkspaceTransaction(rootReal, changes, { ...options, writeFile });
}

// ── 文件搜索 ────────────────────────────────────────────────────────────────

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // '**/' 可匹配零层
      } else {
        source += '[^\\\\/]*';
      }
    } else if (ch === '?') {
      source += '[^\\\\/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

/** 相对 root 的 posix 风格路径（UI / Agent 统一用 / 分隔）。 */
function toRelPosix(rootReal, absolute) {
  return path.relative(rootReal, absolute).split('\\').join('/');
}

export function fileSearch(rootReal, { query = '', glob = '', searchPath = '.', offset = 0, restricted = false, includeHidden = false, skipNames, limit = 200, maxDepth = SEARCH_MAX_DEPTH } = {}) {
  const cap = Math.max(1, Math.min(SEARCH_LIMIT_CAP, Number(limit) || 0));
  const depthCap = Math.max(1, Math.min(SEARCH_MAX_DEPTH, Number(maxDepth) || 0));
  const skip = new Set(['.git', 'node_modules', ...(Array.isArray(skipNames) ? skipNames.map(String) : [])]);
  const needle = String(query ?? '').trim().toLowerCase();
  const globRe = String(glob ?? '').trim() ? globToRegExp(String(glob).trim()) : null;
  if (!needle && !globRe) fail('SEARCH_EMPTY', 'file.search 需要 query 或 glob');

  const start = resolveInside(rootReal, searchPath, { forWrite: false }).real;
  if (restricted && path.relative(rootReal, start).split(path.sep).some(segment => SEARCH_RESTRICTED_NAME.test(segment))) {
    fail('SENSITIVE_RESOURCE_DENIED', 'Search cannot read protected Workspace resources');
  }
  if (!fs.statSync(start).isDirectory()) fail('SEARCH_PATH_INVALID', 'file.search path must be a directory');
  const skipRows = Math.max(0, Math.min(SEARCH_MAX_ENTRIES, Number(offset) || 0));

  const results = [];
  let scanned = 0;
  let matchedRows = 0;
  let contentTruncated = false;
  const add = row => { if (matchedRows++ >= skipRows && results.length < cap) results.push(row); };
  const walk = (dir, depth) => {
    if (results.length >= cap || scanned >= SEARCH_MAX_ENTRIES || depth > depthCap) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return; // 无权限 / 已消失：跳过子树，不让单点失败中断搜索
    }
    for (const entry of entries) {
      if (results.length >= cap || scanned >= SEARCH_MAX_ENTRIES) return;
      scanned += 1;
      const name = entry.name;
      if (!includeHidden && name.startsWith('.')) continue;
      if (skip.has(name)) continue;
      if (restricted && SEARCH_RESTRICTED_NAME.test(name)) continue;
      const childPath = path.join(dir, name);
      const relPosix = toRelPosix(rootReal, childPath);
      const inGlob = !globRe || globRe.test(relPosix) || globRe.test(name);
      const matched = inGlob && (!needle || name.toLowerCase().includes(needle));
      if (entry.isDirectory()) {
        if (matched && !needle && !globRe) add(makeRow(entry, childPath, relPosix, true));
        // 符号链接 / junction 目录：只跟随 real 路径仍在 root 内的（防止 walk 逃逸）。
        if (entry.isSymbolicLink()) {
          try {
            const real = fs.realpathSync.native(childPath);
            if (!relPosixInside(rootReal, real)) continue;
          } catch {
            continue;
          }
        }
        walk(childPath, depth + 1);
      } else if (entry.isFile() && inGlob) {
        try {
          resolveInside(rootReal, relPosix, { forWrite: false });
          if (matched) add(makeRow(entry, childPath, relPosix, false));
          if (needle) {
            const data = readFile(rootReal, relPosix, { maxBytes: 1024 * 1024 });
            if (data.truncated) contentTruncated = true;
            if (!data.binary) {
              const lines = data.content.split(/\r?\n/);
              for (let index = 0; index < lines.length && results.length < cap; index++) {
                if (lines[index].toLowerCase().includes(needle)) add({ path: relPosix, name, dir: false,
                  line: index + 1, snippet: lines[index].slice(0, 500), encoding: data.encoding });
              }
            }
          }
        } catch {
          // An unreadable or replaced file is omitted from search results.
          continue;
        }
      }
    }
  };
  walk(start, 0);
  return { results, scanned, truncated: contentTruncated || scanned >= SEARCH_MAX_ENTRIES || results.length >= cap,
    nextOffset: matchedRows > skipRows + results.length ? skipRows + results.length : results.length >= cap ? skipRows + results.length : null };

  function relPosixInside(root, realPath) {
    const rel = path.relative(root, realPath);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  function makeRow(entry, childPath, relPosix, isDir) {
    let size = 0;
    let mtime = 0;
    if (!isDir) {
      try {
        const stat = fs.statSync(childPath);
        size = stat.size;
        mtime = stat.mtimeMs;
      } catch {}
    }
    return { path: relPosix, name: entry.name, dir: isDir, size, mtime };
  }
}

// ── Git（只读直接执行；commit 由 service 层按策略审批后调用） ────────────────

export async function gitRun(cwd, args, { timeoutMs = GIT_TIMEOUT_MS, indexFile, literalPaths = false } = {}) {
  const env={...process.env};for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
  env.GIT_OPTIONAL_LOCKS='0';if(indexFile)env.GIT_INDEX_FILE=indexFile;
  // Git's clean/process filters execute commands even for status/diff. Enumerate
  // configuration without running worktree conversions, then disable every driver.
  const keys = await new Promise((resolve, reject) => {
    execFile('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
      { cwd, env, windowsHide: true, timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
        if (error && error.code !== 1) { reject(error); return; }
        resolve(String(stdout ?? '').split('\0').filter(Boolean));
      });
  });
  const filters = keys.flatMap(key => ['-c', key + (key.endsWith('.required') ? '=false' : '=')]);
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...(literalPaths?['--literal-pathspecs']:[]), '-c', 'commit.gpgSign=false', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...filters, ...args],
      {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
        env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.exitCode = typeof error.code === 'number' ? error.code : null;
          error.gitStderr = String(stderr ?? '');
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    );
  });
}

function gitUnavailable(error) {
  return error?.code === 'ENOENT';
}

export async function gitStatus(rootReal, {completeFiles=false}={}) {
  let out;
  try {
    out = await gitRun(rootReal, ['status', '--porcelain=v1', '--branch',...(completeFiles?['-z','--untracked-files=all']:[]), '--', '.']);
  } catch (error) {
    if (gitUnavailable(error)) fail('GIT_UNAVAILABLE', 'git 不可用（未安装或不在 PATH）');
    if (/not a git repository/i.test(error.gitStderr ?? '')) {
      return { isRepo: false, branch: '', dirty: false, entries: [] };
    }
    fail('GIT_FAILED', `git status 失败：${error.gitStderr || error.message}`);
  }
  const repoRoot=fs.realpathSync.native((await gitRun(rootReal,['rev-parse','--show-toplevel'])).stdout.trim());
  const {headSha}=await gitHead(rootReal);
  if(completeFiles) {
    const records=out.stdout.split('\0').filter(Boolean),entries=[];let branch='';
    for(let index=0;index<records.length;index++) {
      const line=records[index];
      if(line.startsWith('## ')){branch=line.slice(3).split('...')[0].replace('No commits yet on ','').replace('HEAD (no branch)','(detached)');continue;}
      const x=line[0],y=line[1],filePath=line.slice(3),origPath=x==='R'||x==='C'||y==='R'||y==='C'?records[++index]??null:null;
      entries.push({x,y,path:filePath,origPath});
    }
    return {isRepo:true,branch,headSha,repoRoot,dirty:entries.length>0,entries};
  }
  const lines = out.stdout.split(/\r?\n/).filter(Boolean);
  let branch = '';
  const entries = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0].replace('No commits yet on ', '').replace('HEAD (no branch)', '(detached)');
      continue;
    }
    const x = line[0];
    const y = line[1];
    let filePath = line.slice(3);
    let origPath = null;
    const rename = /^(.+?) -> (.+)$/.exec(filePath);
    if (rename) {
      origPath = rename[1];
      filePath = rename[2];
    }
    entries.push({ x, y, path: filePath, origPath });
  }
  return { isRepo: true, branch, headSha, repoRoot, dirty: entries.length > 0, entries };
}

export async function gitDiff(rootReal, { cached = false, context = 3, statOnly = false, excludeSensitive = false } = {}) {
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
  if (statOnly) {
    // 摘要模式（--stat）：给 Continuity / Handoff Packet 的 diff 摘要用，不携带全文。
    args.push('--stat');
  } else {
    args.push(`-U${Math.max(0, Math.min(64, Number(context) || 0))}`);
  }
  if (cached) args.push('--cached');
  if (excludeSensitive) args.push('--', '.', ...[
    '**/.env', '**/.env.*', '**/.env/**',
    '**/.git/**', '**/.ssh/**', '**/.aws/**',
    '**/credentials', '**/credentials.*', '**/credentials/**',
    '**/secret', '**/secret.*', '**/secret/**',
    '**/secrets', '**/secrets.*', '**/secrets/**',
    '**/id_rsa', '**/id_ed25519'
  ].map(pattern => `:(exclude,icase,glob)${pattern}`));
  if(!excludeSensitive)args.push('--','.');
  let out;
  try {
    out = await gitRun(rootReal, args);
  } catch (error) {
    if (gitUnavailable(error)) fail('GIT_UNAVAILABLE', 'git 不可用（未安装或不在 PATH）');
    fail('GIT_FAILED', `git diff 失败：${error.gitStderr || error.message}`);
  }
  const output = out.stdout;
  const cap = statOnly ? 16 * 1024 : 512 * 1024;
  return {
    isRepo: true,
    cached: cached === true,
    statOnly: statOnly === true,
    output: output.length > cap ? output.slice(0, cap) : output,
    truncated: output.length > cap,
    hasChanges: output.length > 0
  };
}

/** 只读 HEAD 检查：`git rev-parse HEAD`。空仓库（无提交）→ headSha:null，不伪造。 */
export async function gitHead(rootReal) {
  try {
    const out = await gitRun(rootReal, ['rev-parse', 'HEAD']);
    const headSha = String(out.stdout ?? '').trim();
    return { isRepo: true, headSha: /^[0-9a-f]{40}$/i.test(headSha) ? headSha : null };
  } catch (error) {
    if (gitUnavailable(error)) fail('GIT_UNAVAILABLE', 'git 不可用（未安装或不在 PATH）');
    if (/not a git repository/i.test(error.gitStderr ?? '')) {
      return { isRepo: false, headSha: null };
    }
    // 无提交的空仓库 rev-parse HEAD 报错：如实返回 null（分支存在但没有 HEAD）。
    if (/ambiguous argument 'HEAD'|unknown revision|bad revision/i.test(error.gitStderr ?? '')) {
      return { isRepo: true, headSha: null };
    }
    fail('GIT_FAILED', `git rev-parse HEAD 失败：${error.gitStderr || error.message}`);
  }
}

/** Exact approved paths and hashes are mandatory; no stage-all fallback. */
export const prepareGitCommit=(root,request)=>prepareScopedCommit(root,request,{gitRun,gitStatus});
export const gitCommit=(root,request)=>commitScopedPaths(root,request,{gitRun:(cwd,args,options)=>gitRun(cwd,args,{...options,literalPaths:true}),gitStatus});

// ── 测试执行（仅限工作区设置登记的命令） ────────────────────────────────────

export function testRun(rootReal, testCommand, { timeoutMs = 10 * 60 * 1000 } = {}) {
  const command = String(testCommand ?? '').trim();
  if (!command) fail('TEST_NOT_CONFIGURED', '该工作区未登记测试命令（workspace.settings.testCommand）');
  const cap = Math.max(1000, Math.min(15 * 60 * 1000, Number(timeoutMs) || 0));
  const started = Date.now();
  // 用 exec（cmd /d /s /c 语义）而非 execFile + 参数数组：命令串是 owner 在工作区
  // 设置里登记的整串命令，exec 的 verbatim 传递才不会破坏内嵌引号。
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd: rootReal, windowsHide: true, timeout: cap, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && error.code === 'ENOENT') fail('TEST_FAILED', `无法启动测试进程：${error.message}`);
        resolve({
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          timedOut: error?.killed === true || error?.signal === 'SIGTERM',
          stdout: String(stdout ?? '').slice(0, 512 * 1024),
          stderr: String(stderr ?? '').slice(0, 512 * 1024),
          durationMs: Date.now() - started
        });
      }
    );
  });
}
