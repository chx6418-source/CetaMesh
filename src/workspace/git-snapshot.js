import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ignore from 'ignore';

export const gitPathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

// Freeze ignore semantics independently of mutable source/staged .gitignore files.
// Initial files always remain visible; new outputs use the original rules.
export function selectGitSnapshot(root, fail) {
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(base => path.join(base, 'Git', 'cmd', 'git.exe')) : ['/usr/bin/git'];
  const executable = candidates.find(file => fs.existsSync(file)) || 'git';
  const gitEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  // Ambient shell Git overrides must not redirect the registered Workspace.
  for (const key of Object.keys(gitEnv)) if (/^GIT_(?:DIR|COMMON_DIR|WORK_TREE|INDEX_FILE)$/i.test(key)) delete gitEnv[key];
  const run = args => spawnSync(executable, ['-c', 'core.fsmonitor=false', '-C', root, ...args], {
    cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    env: gitEnv
  });
  const probe = run(['rev-parse', '--is-inside-work-tree']);
  if (probe.error?.code === 'ENOENT' && !fs.existsSync(path.join(root, '.git'))) return null;
  if (probe.status !== 0 && /not a git repository/i.test(probe.stderr || '')) return null;
  const read = args => {
    const result = run(args);
    if (result.error || result.status !== 0) fail('STAGING_READ_FAILED', '无法读取项目 Git 信息；请确认 Git 可用且当前用户有权访问此仓库。', result.error);
    return result.stdout;
  };
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== 'true') fail('STAGING_READ_FAILED', '无法读取项目 Git 信息。', probe.error);
  const repo = fs.realpathSync.native(read(['rev-parse', '--show-toplevel']).trim());
  const prefix = path.relative(repo, root).split(path.sep).filter(Boolean).join('/');
  if (prefix.split('/').includes('..')) fail('STAGING_PATH_ESCAPE', 'Git 工作区根目录不匹配。');
  const files = new Set(); const directories = new Set(); const opaqueDirectories = new Set();
  for (const rel of read(['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']).split('\0').filter(Boolean)) {
    if (rel.endsWith('/')) { opaqueDirectories.add(gitPathKey(rel.slice(0, -1))); continue; }
    const parts = rel.split('/');
    if (path.isAbsolute(rel) || parts.some(part => !part || part === '.' || part === '..')) fail('STAGING_PATH_ESCAPE', 'Git 文件清单包含越界路径。');
    files.add(gitPathKey(rel));
    for (let index = 1; index < parts.length; index++) directories.add(gitPathKey(parts.slice(0, index).join('/')));
  }
  for (const entry of read(['ls-files', '--cached', '--stage', '-z', '--', '.']).split('\0')) {
    const match = /^160000 [a-f0-9]+ [0-3]\t([\s\S]+)$/.exec(entry);
    if (match) opaqueDirectories.add(gitPathKey(match[1]));
  }
  const rules = new Map(); const captured = new Set();
  let orderedRules = null;
  const add = (file, base, followSymlink = false) => {
    let stat;
    try { stat = followSymlink ? fs.statSync(file) : fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) return; // Only project .gitignore files must not follow symlinks.
    if (stat.size > 1024 * 1024) fail('STAGING_READ_FAILED', '项目忽略规则文件过大。');
    const matcher = rules.get(gitPathKey(base)) || ignore({ ignorecase: process.platform === 'win32' });
    matcher.add(fs.readFileSync(file, 'utf8')); rules.set(gitPathKey(base), matcher); orderedRules = null;
  };
  const global = run(['config', '--path', '--get', 'core.excludesFile']);
  if (global.error || ![0, 1].includes(global.status)) fail('STAGING_READ_FAILED', '无法读取 Git 忽略配置。');
  const globalFile = global.status === 0 ? path.resolve(root, global.stdout.trim())
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
  add(globalFile, '', true);
  add(path.resolve(root, read(['rev-parse', '--git-path', 'info/exclude']).trim()), '', true);
  const captureDirectory = dir => {
    const base = path.relative(repo, dir).split(path.sep).filter(Boolean).join('/');
    if (captured.has(base)) return;
    captured.add(base); add(path.join(dir, '.gitignore'), base);
  };
  let ancestor = repo;
  captureDirectory(ancestor);
  for (const part of prefix.split('/').filter(Boolean)) { ancestor = path.join(ancestor, part); captureDirectory(ancestor); }
  const evaluate = target => {
    let ignored = false;
    target = gitPathKey(target);
    const ordered = orderedRules ??= [...rules].sort(([a], [b]) => a.length - b.length);
    for (const [base, matcher] of ordered) {
      if (base && !target.startsWith(base + '/')) continue;
      const relative = base ? target.slice(base.length + 1) : target;
      if (!relative) continue;
      const result = matcher.test(relative);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    }
    return ignored;
  };
  const ignored = (rel, directory) => {
    const segments = gitPathKey(rel).split('/');
    for (let index = 1; index <= segments.length; index++) if (opaqueDirectories.has(segments.slice(0, index).join('/'))) return true;
    if (directory ? directories.has(gitPathKey(rel)) : files.has(gitPathKey(rel))) return false;
    const full = prefix ? prefix + '/' + rel : rel;
    const parts = full.split('/');
    // A nested negation cannot reinclude a file whose parent directory is ignored.
    for (let index = 1; index < parts.length; index++) if (evaluate(parts.slice(0, index).join('/') + '/')) return true;
    return evaluate(full + (directory ? '/' : ''));
  };
  return { files, directories, captureDirectory, ignored };
}
