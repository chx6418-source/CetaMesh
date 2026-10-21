// 会话 1 验收：Smart Router v1（src/router/）——确定性分类 + Cost Policy。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTask } from '../src/router/smart-router.js';
import { createRouterService } from '../src/router/service.js';

const root = path.resolve(import.meta.dirname, '..');
const tempRoot = process.env.WHALEBRIDGE_TEST_TMPDIR || os.tmpdir();
fs.mkdirSync(tempRoot, { recursive: true });
const temp = fs.mkdtempSync(path.join(tempRoot, 'smart-router-test-'));

let step = 0;
function ok(label) { step += 1; console.log(`✅ [${step}] ${label}`); }

function classify(text, params = {}) {
  return classifyTask({ text, ...params });
}

// ── 1. 普通聊天 → model（绝不 agent）─────────────────────────────────────────
{
  for (const text of ['你好', '在吗？', '谢谢！', '给我讲个笑话', 'Python 和 Golang 有什么区别？', '帮我想一句生日祝福']) {
    const decision = classify(text);
    assert.equal(decision.class, 'simple', text);
    assert.equal(decision.route, 'model', text);
    assert.equal(decision.agentIntent, false, text);
  }
  ok('普通聊天/问答 → simple → model（无 agent 意图）');
}

// ── 2. 总结/翻译/解释/简单写作 → model ───────────────────────────────────────
{
  for (const text of ['总结这段文字', '帮我总结一下这篇文章', '把这段话翻译成英文', '解释一下什么是递归', '帮我写一段自我介绍']) {
    const decision = classify(text);
    assert.equal(decision.class, 'simple', text);
    assert.equal(decision.route, 'model', text);
  }
  ok('总结/翻译/解释/简单写作 → model');
}

// ── 3. 工程任务 → project → agent-intent ─────────────────────────────────────
{
  const cases = [
    '修改这个项目并跑测试',
    '帮我在仓库里新增一个模块',
    '开发一个 MCP 服务器插件',
    '开发一个 CetaMesh 插件',
    '运行测试套件',
    '用 git 提交代码',
    'git commit 然后 push',
    '重构 src/bridge.js，多文件修改',
    '修一下这个 bug，然后运行测试',
    '编译一下项目，npm run build',
    'run the tests and fix the bug',
    'implement a new feature in the plugin'
  ];
  for (const text of cases) {
    const decision = classify(text);
    assert.equal(decision.class, 'project', text);
    assert.equal(decision.route, 'agent', text);
    assert.equal(decision.agentIntent, true, text);
    assert.ok(decision.reasons.length > 0, `${text} 应给出路由理由`);
  }
  ok('工程修改/插件/MCP/测试/git/重构 → project → agent-intent');
}

// ── 4. 简单工具请求 → tool → model + capability-intent ───────────────────────
{
  const cases = [
    '帮我查一下北京今天的天气',
    '搜索一下 CetaMesh 是什么',
    '计算 3.7 的 4.2 次方',
    '现在几点了',
    '帮我把 100 美元换算成人民币',
    '画一张猫的图'
  ];
  for (const text of cases) {
    const decision = classify(text);
    assert.equal(decision.class, 'tool', text);
    assert.equal(decision.route, 'model', text, 'tool 默认仍由 Model 执行');
    assert.equal(decision.capabilityIntent, true, text);
    assert.equal(decision.agentIntent, false, text);
  }
  ok('搜索/天气/计算/时间/画图 → tool → model + capability-intent');
}

// ── 5. 用户显式禁用 Agent → 不得 agent ───────────────────────────────────────
{
  for (const text of ['修改这个项目并跑测试', '重构整个仓库', 'git commit 提交代码']) {
    const decision = classify(text, { agentEnabled: false });
    assert.equal(decision.route, 'model', text);
    assert.equal(decision.agentIntent, false, text);
    assert.equal(decision.agentEnabled, false, text);
    assert.ok(decision.reasons.some((reason) => reason.includes('禁用 Agent')), text);
  }
  ok('Agent=Disabled：工程任务也不产生 agent 路由');
}

// ── 6. Cost Policy：Economy 收紧 / Agent First 升级 ──────────────────────────
{
  // Economy：单个强信号无佐证（无工程对象/动作动词/代码上下文）→ 降级，保持 Model 执行
  const economySingle = classify('跑一下测试', { costPolicy: 'economy' });
  assert.notEqual(economySingle.class, 'project');
  assert.equal(economySingle.route, 'model');
  // Economy：直接工程动作 + 佐证（工程对象/多信号）→ 仍 project
  const economyStrong = classify('修改这个项目并跑测试', { costPolicy: 'economy' });
  assert.equal(economyStrong.class, 'project');
  assert.equal(economyStrong.route, 'agent');
  // Agent First：tool 也升级 agent
  const agentFirstTool = classify('帮我查一下天气', { costPolicy: 'agent-first' });
  assert.equal(agentFirstTool.class, 'tool');
  assert.equal(agentFirstTool.route, 'agent');
  // Balanced：tool 保持 model
  const balancedTool = classify('帮我查一下天气', { costPolicy: 'balanced' });
  assert.equal(balancedTool.route, 'model');
  // Quality 与 Balanced 路由一致（v1 只影响策略记录）
  const quality = classify('帮我查一下天气', { costPolicy: 'quality' });
  assert.equal(quality.class, balancedTool.class);
  assert.equal(quality.route, balancedTool.route);
  ok('Cost Policy：Economy 收紧 / Agent First 升级 tool / Quality=Balanced 路由');
}

// ── 7. 工程上下文：代码附件 / 工作区提升判定 ─────────────────────────────────
{
  const withCode = classify('把这几个文件里的函数合并一下', { attachments: ['utils.js', 'index.ts'] });
  assert.equal(withCode.class, 'project', '代码附件 + 动作动词 → project');
  const plainAttachment = classify('总结这段文字', { attachments: ['notes.txt'] });
  assert.equal(plainAttachment.class, 'simple', '纯文本附件不触发工程判定');
  const workspace = classify('调整模块结构', { hasWorkspaceContext: true });
  assert.equal(workspace.class, 'project');
  ok('工程上下文：代码附件/工作区参与判定，纯文本附件不误判');
}

// ── 8. Service：策略持久化 + IPC + classify ──────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(temp, 'svc-'));
  const service = createRouterService({ stateDir: dir, log: () => {} });
  const initial = await service.execute({ method: 'router.policy.get' });
  assert.equal(initial.costPolicy, 'balanced', '默认 Balanced');
  assert.deepEqual(initial.options, ['economy', 'balanced', 'quality', 'agent-first']);
  const updated = await service.execute({ method: 'router.policy.set', params: { costPolicy: 'agent-first' } });
  assert.equal(updated.costPolicy, 'agent-first');
  await assert.rejects(
    service.execute({ method: 'router.policy.set', params: { costPolicy: 'turbo' } }),
    (error) => error.code === 'INVALID_PARAMS'
  );
  const classifyResult = await service.execute({ method: 'router.classify', params: { text: '修改这个项目并跑测试' } });
  assert.equal(classifyResult.decision.class, 'project');
  const toolClassify = await service.execute({ method: 'router.classify', params: { text: 'what time is it?' } });
  assert.deepEqual(toolClassify.decision.signals?.tool, ['time'], 'Smart runtime needs the classified signal to select a registered Capability');
  assert.equal(classifyResult.decision.costPolicy, 'agent-first', '未显式传策略时使用持久化策略');
  const explicit = await service.execute({ method: 'router.classify', params: { text: '你好', costPolicy: 'economy' } });
  assert.equal(explicit.decision.costPolicy, 'economy');
  await assert.rejects(service.execute({ method: 'router.classify', params: { text: '' } }), (error) => error.code === 'INVALID_PARAMS');
  await assert.rejects(service.execute({ method: 'router.nope' }), (error) => error.code === 'METHOD_NOT_FOUND');
  // 重启后策略保留
  const revived = createRouterService({ stateDir: dir, log: () => {} });
  assert.equal((await revived.execute({ method: 'router.policy.get' })).costPolicy, 'agent-first');
  ok('Service：策略持久化/校验/classify IPC/重启保留');
}

// ── 9. 策略文件损坏 → 回落默认（策略非关键数据，不阻塞聊天）──────────────────
{
  const dir = fs.mkdtempSync(path.join(temp, 'corrupt-'));
  const fs2 = await import('node:fs');
  fs2.mkdirSync(path.join(dir, 'router'), { recursive: true });
  fs2.writeFileSync(path.join(dir, 'router', 'policy.json'), '{ broken json', 'utf8');
  const service = createRouterService({ stateDir: dir, log: () => {} });
  assert.equal((await service.execute({ method: 'router.policy.get' })).costPolicy, 'balanced');
  ok('策略文件损坏 → 回落默认 Balanced');
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n🎉 Smart Router v1 全部通过（${step} 组）`);
