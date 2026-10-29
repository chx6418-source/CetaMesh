// CetaMesh Workspace v1 验收测试（阶段 05）。
//
// 覆盖：
// 1. 正常文件访问（read / write / createDirs / 截断 / 二进制）；
// 2. 全部 escape case（../、绝对路径、junction 逃逸、'.. ' 尾部空格、UNC、
//    NUL、保留设备名、盘符根 / 系统目录 root）；
// 3. Windows 路径行为（大小写不敏感、正斜杠、junction 内部跟随）；
// 4. 清单生命周期（create/open/rename/remove，remove 不删目录）；
// 5. git 工具（status/diff/commit）与 commit 审批策略（allow/approval/deny）；
// 6. test.run（登记命令执行、失败退出码、未登记拒绝）。
//
// 运行：node scripts/test-workspace-runtime.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkspaceService } from '../src/workspace/index.js';
import { createWorkspaceRegistry } from '../src/workspace/registry.js';
import { canonicalizeRoot, resolveInside, isInsideRoot } from '../src/workspace/boundary.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-ws-'));
let pass = 0;
let failCount = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      failCount += 1;
      failures.push({ name, error });
      console.log(`FAIL ${name} — ${error?.message ?? error}`);
    });
}

function makeService() {
  const stateDir = fs.mkdtempSync(path.join(TEMP, 'state-'));
  return createWorkspaceService({ stateDir });
}

function wsPath(...parts) {
  return path.join(TEMP, ...parts);
}

async function expectError(name, promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `${name}：期望 ${code}，实际 ${error.code}（${error.message}）`);
    return;
  }
  assert.fail(`${name}：期望抛出 ${code}，但没有抛错`);
}

// ── 夹具：一个标准工作区 + 一个外部禁区 ─────────────────────────────────────
const outsideDir = wsPath('outside');
fs.mkdirSync(path.join(outsideDir, 'deep'), { recursive: true });
fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'top secret outside');
fs.writeFileSync(path.join(outsideDir, 'deep', 'leak.txt'), 'leak');

const service = makeService();
const created = await service.execute({
  method: 'workspace.create',
  params: { name: 'Demo', root: wsPath('demo-root'), createIfMissing: true }
});
const WS = created.workspace.id;
const WS_ROOT = created.workspace.root;
fs.writeFileSync(path.join(WS_ROOT, 'hello.txt'), 'hello workspace');
fs.mkdirSync(path.join(WS_ROOT, 'sub'), { recursive: true });
fs.writeFileSync(path.join(WS_ROOT, 'sub', 'file.txt'), 'nested content');

// ── 1. 正常访问 ──────────────────────────────────────────────────────────────
await check('read 正常访问', async () => {
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'hello.txt' } });
  assert.equal(result.content, 'hello workspace');
  assert.equal(result.binary, false);
});

await check('read 支持正斜杠与子目录', async () => {
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'sub/file.txt' } });
  assert.equal(result.content, 'nested content');
});

await check('read 根内绝对路径允许（等价相对）', async () => {
  const inside = path.join(WS_ROOT, 'hello.txt');
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: inside } });
  assert.equal(result.content, 'hello workspace');
});

await check('write + createDirs 正常', async () => {
  const result = await service.execute({
    method: 'workspace.write',
    params: { id: WS, path: 'a/b/c/out.txt', content: 'created' }
  });
  assert.ok(result.size > 0);
  assert.equal(fs.readFileSync(path.join(WS_ROOT, 'a', 'b', 'c', 'out.txt'), 'utf8'), 'created');
});

await check('read maxBytes 截断', async () => {
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'hello.txt', maxBytes: 4 } });
  assert.equal(result.truncated, true);
  assert.equal(result.content, 'hell');
});

await check('read 二进制内容返回 base64', async () => {
  const bin = path.join(WS_ROOT, 'blob.bin');
  fs.writeFileSync(bin, Buffer.from([1, 0, 2, 0, 3]));
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'blob.bin' } });
  assert.equal(result.binary, true);
  assert.ok(Buffer.from(result.base64, 'base64').includes(0));
});

await check('read 目录拒绝（FILE_IS_DIRECTORY）', async () => {
  await expectError('read dir', service.execute({ method: 'workspace.read', params: { id: WS, path: 'sub' } }), 'FILE_IS_DIRECTORY');
});

await check('write 目录自身拒绝保留设备名之外的段检查仍放行普通点文件', async () => {
  // '.hidden' 默认允许写入（搜索默认跳过隐藏文件是另一回事）。
  await service.execute({ method: 'workspace.write', params: { id: WS, path: '.hidden', content: 'x' } });
});

await check('write 二进制拒绝非字符串内容', async () => {
  await expectError(
    'write non-string',
    service.execute({ method: 'workspace.write', params: { id: WS, path: 'x.txt', content: 123 } }),
    'CONTENT_INVALID'
  );
});

// ── 2. escape cases ─────────────────────────────────────────────────────────
await check('escape: ../ 穿越', async () => {
  await expectError(
    'traversal',
    service.execute({ method: 'workspace.read', params: { id: WS, path: '../outside/secret.txt' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('escape: 多级 ../ 穿越到盘符外', async () => {
  await expectError(
    'deep traversal',
    service.execute({ method: 'workspace.read', params: { id: WS, path: '../../../../../../../../Windows/win.ini' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('escape: 绝对路径指向系统文件', async () => {
  await expectError(
    'absolute escape',
    service.execute({ method: 'workspace.read', params: { id: WS, path: process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('escape: junction 逃逸（目录链接指向外部）', async () => {
  fs.symlinkSync(outsideDir, path.join(WS_ROOT, 'escape-junction'), 'junction');
  await expectError(
    'junction escape',
    service.execute({ method: 'workspace.read', params: { id: WS, path: 'escape-junction/secret.txt' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('escape: junction 逃逸（写路径同样拒绝）', async () => {
  await expectError(
    'junction write escape',
    service.execute({ method: 'workspace.write', params: { id: WS, path: 'escape-junction/planted.txt', content: 'x' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('内部 junction 指向 root 内允许', async () => {
  fs.symlinkSync(path.join(WS_ROOT, 'sub'), path.join(WS_ROOT, 'inner-link'), 'junction');
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'inner-link/file.txt' } });
  assert.equal(result.content, 'nested content');
});

await check("escape: '.. '（尾部空格，Win32 会改写为 '..'）", async () => {
  // 边界层直接裁决：'.. ' 作为段名必须被拒（防 Win32 归一化穿越向量）。
  await expectError(
    'raw boundary trailing-space',
    Promise.resolve().then(() => resolveInside(WS_ROOT, 'sub/.. ')),
    'PATH_INVALID'
  );
  await expectError(
    'raw boundary trailing-space 2',
    Promise.resolve().then(() => resolveInside(WS_ROOT, '.. ')),
    'PATH_INVALID'
  );
  // 服务层对整串 path 做首尾 trim（输入卫生），'.. ' 会被收敛为 '..' 再 resolve，
  // 结果必须仍被包含在 root 内（读到根目录→EISDIR），绝不产生 root 外内容。
  await expectError(
    'service trailing-space contained',
    service.execute({ method: 'workspace.read', params: { id: WS, path: 'sub/.. ' } }),
    'FILE_IS_DIRECTORY'
  );
  await expectError(
    'service trailing-space contained 2',
    service.execute({ method: 'workspace.read', params: { id: WS, path: '.. ' } }),
    'BOUNDARY_ESCAPE'
  );
});

await check('escape: UNC 路径拒绝', async () => {
  await expectError(
    'unc read',
    service.execute({ method: 'workspace.read', params: { id: WS, path: '\\\\server\\share\\file.txt' } }),
    'PATH_UNC'
  );
  await expectError(
    'unc device',
    service.execute({ method: 'workspace.read', params: { id: WS, path: '\\\\?\\C:\\Windows\\win.ini' } }),
    'PATH_UNC'
  );
});

await check('escape: NUL 字节拒绝', async () => {
  await expectError(
    'nul byte',
    service.execute({ method: 'workspace.read', params: { id: WS, path: 'hello.txt\0.txt' } }),
    'PATH_INVALID'
  );
});

await check('escape: 保留设备名（con / nul / com1，读与写）', async () => {
  for (const name of ['con', 'nul.txt', 'com1']) {
    await expectError(
      `reserved read ${name}`,
      service.execute({ method: 'workspace.read', params: { id: WS, path: name } }),
      'PATH_RESERVED'
    );
    await expectError(
      `reserved write ${name}`,
      service.execute({ method: 'workspace.write', params: { id: WS, path: name, content: 'x' } }),
      'PATH_RESERVED'
    );
  }
});

await check('escape: 盘符相对路径（C:foo）不越界即受控', async () => {
  // 'C:file' 是盘符相对路径：resolve 结果受 contain 校验——不在 root 内即拒绝；
  // 若 resolve 落在 root 内（语义随 CWD 变化），也只会读到 root 内文件。
  try {
    const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'C:Windows' } });
    assert.ok(result.path !== undefined, '若成功，必须经过边界裁决返回结构化结果');
  } catch (error) {
    assert.ok(
      ['BOUNDARY_ESCAPE', 'PATH_INVALID', 'FILE_NOT_FOUND', 'PATH_RESERVED', 'PATH_UNC'].includes(error.code),
      `意外错误：${error.code}`
    );
  }
});

// ── 3. Windows 路径行为 ─────────────────────────────────────────────────────
await check('native filesystem: case-sensitive or case-insensitive access', async () => {
  if (process.platform !== 'win32') {
    await expectError('case-sensitive missing file', service.execute({ method: 'workspace.read', params: { id: WS, path: 'SUB/FILE.TXT' } }), 'FILE_NOT_FOUND');
    assert.equal(isInsideRoot(WS_ROOT + '\\', path.join(WS_ROOT, 'secret.txt')), false, 'a POSIX trailing backslash is a filename character, not a separator');
    const sibling = WS_ROOT.toUpperCase();
    assert.equal(resolveInside(WS_ROOT, 'sub/file.txt').real, path.join(WS_ROOT, 'sub', 'file.txt'));
    await expectError('case-distinct sibling escape', Promise.resolve().then(() => resolveInside(WS_ROOT, path.join(sibling, 'secret.txt'))), 'BOUNDARY_ESCAPE');
    return;
  }
  const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: 'SUB/FILE.TXT' } });
  assert.equal(result.content, 'nested content');
});

await check('Windows: 8.3 短名经 realpath 归一（不逃逸）', async () => {
  // 目录名带空格的长名 → 8.3 短名指向同一目录；不允许借助短名逃逸。
  const longDir = path.join(WS_ROOT, 'Long Directory Name For Shortname');
  fs.mkdirSync(longDir, { recursive: true });
  fs.writeFileSync(path.join(longDir, 'leaf.txt'), 'long-name content');
  const { real } = resolveInside(WS_ROOT, '.');
  assert.ok(real.length > 0);
  // 长目录名的 8.3 形式（如 LONGDI~1）若存在，必须解析回 root 内：
  const entries = fs.readdirSync(WS_ROOT);
  const short = entries.find((n) => /^LONGDI~\d+$/.test(n));
  if (short) {
    const result = await service.execute({ method: 'workspace.read', params: { id: WS, path: `${short}/leaf.txt` } });
    assert.equal(result.content, 'long-name content');
  }
});

await check('native root 危险形态拒绝（系统根 / 系统目录 / 用户主目录 / 祖先）', async () => {
  await expectError(
    'drive root',
    service.execute({ method: 'workspace.create', params: { name: 'C', root: path.parse(WS_ROOT).root } }),
    'ROOT_FORBIDDEN'
  );
  await expectError(
    'windows dir',
    service.execute({
      method: 'workspace.create',
      params: { name: 'Win', root: process.platform === 'win32' ? (process.env.SystemRoot || 'C:\\Windows') : '/etc' }
    }),
    'ROOT_FORBIDDEN'
  );
  await expectError(
    'home dir',
    service.execute({ method: 'workspace.create', params: { name: 'Home', root: os.homedir() } }),
    'ROOT_FORBIDDEN'
  );
  await expectError(
    'users ancestor',
    service.execute({ method: 'workspace.create', params: { name: 'Users', root: path.join(os.homedir(), '..') } }),
    'ROOT_FORBIDDEN'
  );
});

await check('boundary: canonicalizeRoot 对不存在目录报 ROOT_NOT_FOUND', async () => {
  await expectError('missing root', Promise.resolve().then(() => canonicalizeRoot(wsPath('no-such-dir-xyz'))), 'ROOT_NOT_FOUND');
});

// ── 4. 清单生命周期 ─────────────────────────────────────────────────────────
await check('registry: 损坏清单必须保留且拒绝空清单写入', async () => {
  const stateDir = fs.mkdtempSync(path.join(TEMP, 'corrupt-registry-'));
  const file = path.join(stateDir, 'workspaces.json');
  const damaged = '{"version":1,"workspaces":[';
  fs.writeFileSync(file, damaged);
  assert.throws(() => createWorkspaceRegistry({ file }), { code: 'REGISTRY_CORRUPT' });
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
});
await check('registry: create 去重（同一 root 二次登记拒绝）', async () => {
  await expectError(
    'dup root',
    service.execute({ method: 'workspace.create', params: { name: 'Dup', root: WS_ROOT } }),
    'ROOT_ALREADY_REGISTERED'
  );
});

await check('registry: rename 只改元数据', async () => {
  const result = await service.execute({ method: 'workspace.rename', params: { id: WS, name: 'Demo Renamed' } });
  assert.equal(result.workspace.name, 'Demo Renamed');
  assert.equal(result.workspace.root, WS_ROOT);
});

await check('registry: open 设为当前工作区', async () => {
  const result = await service.execute({ method: 'workspace.open', params: { id: WS } });
  assert.equal(result.workspace.active, true);
  // 未指定 id 的工具调用使用当前工作区：
  const read = await service.execute({ method: 'workspace.read', params: { path: 'hello.txt' } });
  assert.equal(read.content, 'hello workspace');
});

await check('registry: list 按最近打开倒序（Recent Workspaces）', async () => {
  const newer = await service.execute({
    method: 'workspace.create',
    params: { name: 'Newer', root: wsPath('newer-root'), createIfMissing: true }
  });
  const listedBefore = await service.execute({ method: 'workspace.list', params: {} });
  assert.equal(listedBefore.workspaces[0].id, WS, '刚打开的 WS 应排最前');
  await service.execute({ method: 'workspace.open', params: { id: newer.workspace.id } });
  const listedAfter = await service.execute({ method: 'workspace.list', params: {} });
  assert.equal(listedAfter.workspaces[0].id, newer.workspace.id, '最近打开的工作区应排最前');
  // 还原当前工作区，避免影响后续用例。
  await service.execute({ method: 'workspace.open', params: { id: WS } });
  await service.execute({ method: 'workspace.remove', params: { id: newer.workspace.id } });
});

await check('registry: remove 只移除登记，目录保留', async () => {
  const temp2 = await service.execute({
    method: 'workspace.create',
    params: { name: 'Temp', root: wsPath('temp-root'), createIfMissing: true }
  });
  fs.writeFileSync(path.join(temp2.workspace.root, 'keepme.txt'), 'still here');
  const removed = await service.execute({ method: 'workspace.remove', params: { id: temp2.workspace.id } });
  assert.equal(removed.directoryPreserved, true);
  assert.ok(fs.existsSync(path.join(temp2.workspace.root, 'keepme.txt')), 'remove 后目录必须原样保留');
  await expectError(
    'removed ws gone',
    service.execute({ method: 'workspace.read', params: { id: temp2.workspace.id, path: 'keepme.txt' } }),
    'WORKSPACE_NOT_FOUND'
  );
});

await check('service: 未知方法拒绝', async () => {
  await expectError(
    'unknown method',
    service.execute({ method: 'workspace.shell', params: {} }),
    'METHOD_NOT_FOUND'
  );
});

await check('service: workspace.info 聚合（recentFiles / activity / taskRelation）', async () => {
  const info = await service.execute({ method: 'workspace.info', params: { id: WS } });
  assert.ok(info.recentFiles.length > 0);
  assert.ok(info.activity.length > 0);
  assert.equal(info.taskRelation.enabled, false);
  assert.ok(info.workspace.git.isRepo === false || info.workspace.git.isRepo === true);
});

// ── 5. 文件搜索 ─────────────────────────────────────────────────────────────
await check('file.search 子串匹配且跳过 node_modules / .git', async () => {
  fs.mkdirSync(path.join(WS_ROOT, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(WS_ROOT, 'node_modules', 'pkg', 'needly.txt'), 'dep');
  fs.mkdirSync(path.join(WS_ROOT, '.git'), { recursive: true });
  fs.writeFileSync(path.join(WS_ROOT, '.git', 'needly.txt'), 'git-internal');
  fs.writeFileSync(path.join(WS_ROOT, 'needly.txt'), 'top');
  const result = await service.execute({
    method: 'workspace.file.search',
    params: { id: WS, query: 'needly' }
  });
  const paths = result.results.map((item) => item.path);
  assert.deepEqual(paths.sort(), ['needly.txt'].sort());
});

await check('file.search glob（**/*.txt）', async () => {
  const result = await service.execute({
    method: 'workspace.file.search',
    params: { id: WS, glob: '**/*.txt', limit: 500 }
  });
  assert.ok(result.results.some((item) => item.path === 'sub/file.txt'));
  assert.ok(result.results.every((item) => item.path.endsWith('.txt')));
});

await check('file.search 不跟随逃逸 junction', async () => {
  fs.mkdirSync(path.join(WS_ROOT, 'inner'), { recursive: true });
  fs.writeFileSync(path.join(WS_ROOT, 'inner', 'leaky.txt'), 'inside copy');
  const result = await service.execute({
    method: 'workspace.file.search',
    params: { id: WS, query: 'leak' }
  });
  const paths = result.results.map((item) => item.path);
  assert.ok(paths.includes('inner/leaky.txt'));
  assert.ok(!paths.some((item) => item.startsWith('escape-junction/')), 'junction 外部内容不得出现在结果里');
});

await check('file.search 空 query/glob 拒绝', async () => {
  await expectError(
    'empty search',
    service.execute({ method: 'workspace.file.search', params: { id: WS, query: '' } }),
    'SEARCH_EMPTY'
  );
});

// ── 6. Git 工具与审批策略 ───────────────────────────────────────────────────
const repoWs = await service.execute({
  method: 'workspace.create',
  params: { name: 'Repo', root: wsPath('repo-root'), createIfMissing: true }
});
const REPO = repoWs.workspace.id;
const REPO_ROOT = repoWs.workspace.root;
function commitSelection(root, paths) {
  let expectedHead=null;
  try{expectedHead=execFileSync('git',['rev-parse','--verify','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
  return {paths,expectedHead,expectedHashes:Object.fromEntries(paths.map(rel=>[rel,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,rel))).digest('hex')]))};
}
execFileSync('git', ['init', '-q'], { cwd: REPO_ROOT });
execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: REPO_ROOT });
execFileSync('git', ['config', 'user.name', 'Workspace Test'], { cwd: REPO_ROOT });

await check('git.status: 非 repo 工作区 isRepo=false', async () => {
  const result = await service.execute({ method: 'workspace.git.status', params: { id: WS } });
  assert.equal(result.git.isRepo, false);
});

await check('git.status + commit(allow) 全流程', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: REPO, patch: { policies: { gitCommit: 'allow' } } }
  });
  fs.writeFileSync(path.join(REPO_ROOT, 'first.txt'), 'first');
  const status0 = await service.execute({ method: 'workspace.git.status', params: { id: REPO } });
  assert.equal(status0.git.isRepo, true);
  assert.equal(status0.git.dirty, true, '存在未跟踪文件应为 dirty');
  const commit = await service.execute({
    method: 'workspace.git.commit',
    params: { id: REPO, message: 'initial commit', ...commitSelection(REPO_ROOT,["first.txt"]) }
  });
  assert.equal(commit.status, 'committed');
  assert.ok(commit.sha, '应有 commit sha（含 root-commit 形态）');
  const status1 = await service.execute({ method: 'workspace.git.status', params: { id: REPO } });
  assert.equal(status1.git.dirty, false, '提交后应 clean');
  assert.ok(status1.git.branch.length > 0);
});

await check('git.diff: 工作区有改动时 hasChanges=true', async () => {
  fs.writeFileSync(path.join(REPO_ROOT, 'tracked.txt'), 'v1');
  await service.execute({ method: 'workspace.git.commit', params: { id: REPO, message: 'add tracked', ...commitSelection(REPO_ROOT,["tracked.txt"]) } });
  fs.writeFileSync(path.join(REPO_ROOT, 'tracked.txt'), 'v2');
  const diff = await service.execute({ method: 'workspace.git.diff', params: { id: REPO } });
  assert.equal(diff.hasChanges, true);
  assert.ok(diff.output.includes('tracked.txt'));
});

await check('git.commit: 默认 approval 策略进入待审批', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: REPO, patch: { policies: { gitCommit: 'approval' } } }
  });
  fs.writeFileSync(path.join(REPO_ROOT, 'approved.txt'), 'pending');
  const pending = await service.execute({
    method: 'workspace.git.commit',
    params: { id: REPO, message: 'needs approval', ...commitSelection(REPO_ROOT,["approved.txt"]) }
  });
  assert.equal(pending.status, 'pending');
  assert.ok(pending.requestId);
  const list = await service.execute({ method: 'workspace.pending.list', params: { workspaceId: REPO } });
  assert.equal(list.pending.length, 1);
  const decided = await service.execute({
    method: 'workspace.pending.decide',
    params: { requestId: pending.requestId, approve: true }
  });
  assert.equal(decided.status, 'committed');
  assert.ok(decided.sha);
});

await check('git.commit: 审批拒绝后不落盘', async () => {
  fs.writeFileSync(path.join(REPO_ROOT, 'rejected.txt'), 'nope');
  const pending = await service.execute({
    method: 'workspace.git.commit',
    params: { id: REPO, message: 'should be rejected', ...commitSelection(REPO_ROOT,["rejected.txt"]) }
  });
  const decided = await service.execute({
    method: 'workspace.pending.decide',
    params: { requestId: pending.requestId, approve: false }
  });
  assert.equal(decided.status, 'rejected');
  const status = await service.execute({ method: 'workspace.git.status', params: { id: REPO } });
  assert.equal(status.git.dirty, true, '拒绝后文件仍未提交');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'rejected.txt')));
});

await check('git.commit: deny 策略直接拒绝', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: REPO, patch: { policies: { gitCommit: 'deny' } } }
  });
  await expectError(
    'deny policy',
    service.execute({ method: 'workspace.git.commit', params: { id: REPO, message: 'denied' } }),
    'GIT_COMMIT_DENIED'
  );
  await service.execute({
    method: 'workspace.settings',
    params: { id: REPO, patch: { policies: { gitCommit: 'approval' } } }
  });
});

await check('git.commit: 非法策略设置被拒', async () => {
  await expectError(
    'bad policy',
    service.execute({
      method: 'workspace.settings',
      params: { id: REPO, patch: { policies: { gitCommit: 'sometimes' } } }
    }),
    'SETTING_INVALID'
  );
});

await check('workspace.remove 同步清理待审批请求', async () => {
  const temp3 = await service.execute({
    method: 'workspace.create',
    params: { name: 'Temp3', root: wsPath('temp3-root'), createIfMissing: true }
  });
  execFileSync('git', ['init', '-q'], { cwd: temp3.workspace.root });
  await service.execute({
    method: 'workspace.settings',
    params: { id: temp3.workspace.id, patch: { policies: { gitCommit: 'approval' } } }
  });
  fs.writeFileSync(path.join(temp3.workspace.root, 'x.txt'), 'x');
  const pending = await service.execute({
    method: 'workspace.git.commit',
    params: { id: temp3.workspace.id, message: 'will be removed', ...commitSelection(temp3.workspace.root,['x.txt']) }
  });
  await service.execute({ method: 'workspace.remove', params: { id: temp3.workspace.id } });
  await expectError(
    'pending gone',
    service.execute({ method: 'workspace.pending.decide', params: { requestId: pending.requestId, approve: true } }),
    'PENDING_NOT_FOUND'
  );
});

// ── 7. test.run ─────────────────────────────────────────────────────────────
await check('test.run: 未登记命令拒绝', async () => {
  await expectError(
    'no test command',
    service.execute({ method: 'workspace.test.run', params: { id: WS } }),
    'TEST_NOT_CONFIGURED'
  );
});

await check('test.run: 登记命令成功执行', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: WS, patch: { testCommand: 'node -e "console.log(\'tests-ok\')"' } }
  });
  const result = await service.execute({ method: 'workspace.test.run', params: { id: WS } });
  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.includes('tests-ok'));
  assert.equal(result.timedOut, false);
});

await check('test.run: 失败命令返回退出码', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: WS, patch: { testCommand: 'node -e "process.exit(3)"' } }
  });
  const result = await service.execute({ method: 'workspace.test.run', params: { id: WS } });
  assert.equal(result.exitCode, 3);
});

await check('test.run: cwd 是工作区根目录', async () => {
  await service.execute({
    method: 'workspace.settings',
    params: { id: WS, patch: { testCommand: 'node -e "console.log(process.cwd())"' } }
  });
  const result = await service.execute({ method: 'workspace.test.run', params: { id: WS } });
  assert.equal(path.resolve(result.stdout.trim()).toLowerCase(), path.resolve(WS_ROOT).toLowerCase());
});

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n通过 ${pass} 项，失败 ${failCount} 项`);
if (failCount > 0) {
  for (const item of failures) {
    console.log(`- ${item.name}: ${item.error?.stack ?? item.error}`);
  }
  process.exitCode = 1;
} else {
  console.log('Workspace Runtime 验收全部通过（阶段 05）');
}
