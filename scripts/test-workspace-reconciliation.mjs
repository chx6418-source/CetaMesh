// 会话 2 / TASK-S2-007 验收：Workspace Reconciliation。
//
// 核验规则：真实 Workspace > 旧 Agent 摘要；不一致必须记录 discrepancy，
// 绝不静默篡改 Task State；收集不到事实时如实 unknown（null），不编造。
//
// 覆盖：
//   1. 真实 git 仓库事实收集：branch / HEAD SHA / dirty / diff 摘要 / 相关文件存在性
//      （tools.gitStatus / gitHead / gitDiff{statOnly} 真实执行）
//   2. checkpoint 与工作区一致 → consistent:true，无 discrepancy
//   3. 分支不一致 / HEAD 不一致 / 文件缺失 → discrepancy 逐项记录，consistent:false
//   4. 非 git 目录 → no-git-repo discrepancy；空仓库 HEAD → null（不伪造）
//   5. 工作区不存在 / 未绑定 → facts unavailable / consistent:null（无法核验）
//   6. rollover 全链路：packet 带 workspaceFacts + reconciliation 落盘 + history 记录
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTaskRuntime } from '../src/task/runtime.js';
import { createAgentProviderRegistry } from '../src/agent/registry.js';
import { createAgentBroker } from '../src/agent/broker.js';
import { createContinuityService } from '../src/continuity/service.js';
import { createWorkspaceReconciler } from '../src/continuity/reconcile.js';
import { gitDiff, gitHead, gitStatus } from '../src/workspace/tools.js';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-reconcile-test-'));

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** 建一个真实 git 仓库：初始提交 + 一个未提交修改（dirty）。 */
function makeRealRepo() {
  const dir = fs.mkdtempSync(path.join(temp, 'repo-'));
  runGit(dir, ['init', '-b', 'main']);
  runGit(dir, ['config', 'user.email', 'reconcile-test@example.com']);
  runGit(dir, ['config', 'user.name', 'Reconcile Test']);
  fs.writeFileSync(path.join(dir, 'exporter.js'), 'export const schema = 1;\n');
  runGit(dir, ['add', '--all']);
  runGit(dir, ['commit', '-m', 'init']);
  fs.writeFileSync(path.join(dir, 'exporter.js'), 'export const schema = 2;\n');
  const headSha = runGit(dir, ['rev-parse', 'HEAD']).trim();
  return { dir, headSha };
}

/** 组装 reconciler：真实 workspace 工具 + 注入的登记表。 */
function makeReconciler({ entries = {} } = {}) {
  return createWorkspaceReconciler({
    resolveWorkspace: async (id) => entries[id] ?? null,
    gitStatus: (rootDir) => gitStatus(rootDir),
    gitHead: (rootDir) => gitHead(rootDir),
    gitDiffSummary: async (rootDir) => {
      const diff = await gitDiff(rootDir, { statOnly: true });
      return diff?.output ?? null;
    },
    fileExists: (rootDir, relPath) => {
      const resolvedRoot = path.resolve(rootDir);
      const target = path.resolve(resolvedRoot, String(relPath ?? ''));
      if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) return false;
      return fs.existsSync(target);
    }
  });
}

// ── 1. 真实 git 仓库事实收集 ─────────────────────────────────────────────────
{
  const repo = makeRealRepo();
  const reconciler = makeReconciler({ entries: { ws1: { id: 'ws1', name: '导出器', root: repo.dir } } });
  const facts = await reconciler.collectFacts({ workspaceId: 'ws1', relevantFiles: ['exporter.js', 'missing.js'] });
  assert.equal(facts.available, true);
  assert.equal(facts.workspaceId, 'ws1');
  assert.equal(facts.git.isRepo, true);
  assert.equal(facts.git.branch, 'main');
  assert.equal(facts.git.headSha, repo.headSha, 'HEAD SHA 来自真实 rev-parse');
  assert.equal(facts.git.dirty, true, '未提交修改 → dirty');
  assert.ok(facts.git.diffSummary.includes('exporter.js'), 'diff 摘要（--stat）含改动文件');
  assert.deepEqual(facts.files.map((f) => [f.path, f.exists]), [['exporter.js', true], ['missing.js', false]]);
  ok('事实收集：真实 git branch/HEAD/dirty/diff 摘要 + 文件存在性（真实仓库）');
}

// ── 2. 一致核验 ──────────────────────────────────────────────────────────────
{
  const repo = makeRealRepo();
  const reconciler = makeReconciler({ entries: { ws1: { id: 'ws1', name: '导出器', root: repo.dir } } });
  const facts = await reconciler.collectFacts({ workspaceId: 'ws1', relevantFiles: ['exporter.js'] });
  const packet = {
    taskId: 't1', workspace: 'ws1',
    coding: { branch: 'main', headSha: repo.headSha, gitStatus: '1 file dirty', testsRun: [], knownFailures: [] },
    relevantFiles: ['exporter.js']
  };
  const result = reconciler.reconcile({ packet, facts });
  assert.equal(result.consistent, true, 'checkpoint 与真实工作区一致');
  assert.deepEqual(result.discrepancies, []);
  ok('一致核验：branch/HEAD/文件全部吻合 → consistent:true');
}

// ── 3. 不一致核验：分支 / HEAD / 文件缺失逐项记录 ─────────────────────────────
{
  const repo = makeRealRepo();
  const reconciler = makeReconciler({ entries: { ws1: { id: 'ws1', name: '导出器', root: repo.dir } } });
  const facts = await reconciler.collectFacts({ workspaceId: 'ws1', relevantFiles: ['exporter.js', 'ghost.js'] });
  const packet = {
    taskId: 't1', workspace: 'ws1',
    coding: { branch: 'feature-wrong', headSha: 'f'.repeat(40) },
    relevantFiles: []
  };
  const result = reconciler.reconcile({ packet, facts });
  assert.equal(result.consistent, false);
  const kinds = result.discrepancies.map((d) => d.kind);
  assert.ok(kinds.includes('branch'), '分支不一致被发现');
  assert.ok(kinds.includes('headSha'), 'HEAD 不一致被发现');
  assert.ok(kinds.includes('missing-file'), 'ghost.js 缺失被发现');
  const branch = result.discrepancies.find((d) => d.kind === 'branch');
  assert.equal(branch.checkpoint, 'feature-wrong');
  assert.equal(branch.workspace, 'main', 'discrepancy 双侧如实记录（真实 Workspace 优先）');
  assert.ok(result.note.includes('不一致'));
  ok('不一致核验：branch/HEAD/missing-file discrepancy 记录，不静默篡改');
}

// ── 4. 非 git 目录 / 空仓库 HEAD ─────────────────────────────────────────────
{
  const plainDir = fs.mkdtempSync(path.join(temp, 'plain-'));
  fs.writeFileSync(path.join(plainDir, 'a.txt'), 'hello');
  const reconciler = makeReconciler({ entries: { ws2: { id: 'ws2', name: '非git', root: plainDir } } });
  const facts = await reconciler.collectFacts({ workspaceId: 'ws2', relevantFiles: ['a.txt'] });
  assert.equal(facts.available, true);
  assert.equal(facts.git.isRepo, false);
  assert.equal(facts.git.headSha, null);
  const result = reconciler.reconcile({ packet: { coding: { branch: 'main' }, relevantFiles: [] }, facts });
  assert.equal(result.consistent, false);
  assert.ok(result.discrepancies.some((d) => d.kind === 'no-git-repo'));

  // 空仓库（init 未提交）：分支存在但 HEAD 不可得 → null，不伪造
  const emptyRepo = fs.mkdtempSync(path.join(temp, 'empty-'));
  runGit(emptyRepo, ['init', '-b', 'main']);
  const r2 = makeReconciler({ entries: { ws3: { id: 'ws3', name: '空仓库', root: emptyRepo } } });
  const facts2 = await r2.collectFacts({ workspaceId: 'ws3', relevantFiles: [] });
  assert.equal(facts2.git.isRepo, true);
  assert.equal(facts2.git.headSha, null, '无提交 → headSha:null（不编造 SHA）');
  const result2 = r2.reconcile({ packet: { coding: { branch: null, headSha: null }, relevantFiles: [] }, facts: facts2 });
  assert.equal(result2.consistent, true, 'checkpoint 无声明 + 工作区无提交 → 无可判不一致');
  ok('边界：非 git 目录 no-git-repo；空仓库 HEAD 如实 null');
}

// ── 5. 工作区不存在 / 未绑定 → unknown（不判定真伪） ──────────────────────────
{
  const reconciler = makeReconciler({ entries: {} });
  const missing = await reconciler.collectFacts({ workspaceId: 'ghost-ws', relevantFiles: [] });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'workspace-not-found');
  const result = reconciler.reconcile({ packet: { coding: {} }, facts: missing });
  assert.equal(result.consistent, null, '事实不可得 → 无法核验（null），不判定真伪');

  const unbound = await reconciler.collectFacts({ workspaceId: null, relevantFiles: [] });
  assert.equal(unbound.available, false);
  assert.equal(unbound.reason, 'no-workspace-bound');
  ok('unknown 语义：工作区不存在/未绑定 → available:false + consistent:null');
}

// ── 6. rollover 全链路：packet 事实 + reconciliation 落盘 + history 记录 ──────
{
  const repo = makeRealRepo();
  const dir = fs.mkdtempSync(path.join(temp, 'state-'));
  const taskRuntime = createTaskRuntime({ stateDir: dir });
  const rev = (id) => taskRuntime.get({ id }).task.rev;
  const task = taskRuntime.create({ goal: '重写导出器', workspaceId: 'ws1' });
  taskRuntime.addWork({ id: task.id, expectedRev: rev(task.id), kind: 'completed', text: 'schema 设计' });
  taskRuntime.attachAgent({ id: task.id, expectedRev: rev(task.id), provider: 'alpha', sessionId: 'alpha-s1' });

  const reconciler = makeReconciler({ entries: { ws1: { id: 'ws1', name: '导出器', root: repo.dir } } });
  const registry = createAgentProviderRegistry({ providers: [] });
  const alpha = {
    id: 'alpha', label: 'Alpha',
    capabilities: () => ({ id: 'alpha', label: 'Alpha', eventProtocol: null, supported: {}, unsupported: [], workspaceBoundary: 'capability-broker' }),
    async createSession() { return { sessionId: 'alpha-s2', provider: 'alpha' }; },
    async send() { return { accepted: true }; },
    async status() { return { running: false, queued: 0, waitingForApproval: false }; },
    async cancel() { return { cancelled: true }; },
    async archiveSession() { return { archived: true, supported: true }; },
    async *follow({ sessionId }) { yield { type: 'turn/end', seq: 1, data: { sessionId, reason: { kind: 'completed' } } }; }
  };
  registry.register(alpha);
  const broker = createAgentBroker({ registry });
  const service = createContinuityService({ taskRuntime, stateDir: dir, agentBroker: broker, reconciler });
  const result = await service.runtime.rollover({ taskId: task.id, reason: 'context-threshold', relevantFiles: ['exporter.js'] });

  assert.equal(result.taskId, task.id, 'rollover 后 Task ID 不变');
  // 本 packet 的 coding 为空（未声明 branch/headSha），相关文件 exporter.js 存在 → 无不一致。
  assert.equal(result.reconciliation.consistent, true, 'coding 无声明 + 相关文件存在 → 一致');
  assert.deepEqual(result.reconciliation.discrepancies, []);

  const { packet } = service.runtime.latestPacket({ taskId: task.id });
  assert.equal(packet.workspaceFacts.available, true);
  assert.equal(packet.workspaceFacts.git.branch, 'main');
  assert.equal(packet.workspaceFacts.git.headSha, repo.headSha);
  assert.equal(packet.workspaceFacts.files[0].path, 'exporter.js');

  const history = service.runtime.history({ taskId: task.id }).rollovers[0];
  assert.equal(history.workspaceReconciled, true, 'history 记录核验结论');
  assert.ok(history.reconciliation, 'history 携带 reconciliation 明细');
  const sidecar = path.join(service.runtime._dir, 'handoff', task.id, 'reconciliation-0001.json');
  assert.equal(fs.existsSync(sidecar), true, 'reconciliation 侧车文件落盘');
  ok('rollover 全链路：workspace facts 进 packet + reconciliation 落盘 + history 记录');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 Workspace Reconciliation 全部通过（${step} 组）`);
