// Smart Router v1 —— 确定性分类器（会话 1 / TASK-S1-005）。
//
// 设计约束（本阶段）：
//   - 不调用 LLM 预判；只用规则、用户显式选择、任务特征（附件/工程上下文）。
//   - 普通聊天/翻译/总结/解释/简单写作 → model（绝不产生 agent-intent）。
//   - 明显工程任务（改仓库/开发插件/开发 MCP/跑测试/git/多文件/长项目）→ project。
//   - 需要能力工具但不改工程的任务（搜索/天气/计算/时间/发送）→ tool。
//   - Cost Policy 只调阈值与 route，不改变信号本身（TASK-S1-006）。

import { COST_POLICIES, DEFAULT_COST_POLICY, normalizeCostPolicy } from './types.js';

// ── 工程信号（Tier A：命中即算直接工程动作）──────────────────────────────────
const PROJECT_SIGNALS = Object.freeze([
  { name: 'run-tests', tier: 'A', pattern: /(跑(一下)?测试)|(运行测试)|(测试套件)|(test suite)|(run (the )?tests)/i },
  { name: 'git', tier: 'A', pattern: /(\bgit\b)|(\bgit 提交)|(提交代码)|(git commit)|(git push)|(git checkout)/i },
  { name: 'refactor', tier: 'A', pattern: /(重构)|(改造代码)|(refactor)/i },
  { name: 'multi-file', tier: 'A', pattern: /(多文件)|(多个文件)|(multi-file)|(across (multiple )?files)/i },
  { name: 'bugfix', tier: 'A', pattern: /(修\s?bug)|(修复.{0,8}(bug|缺陷|报错))|(fix (the )?bug)/i },
  { name: 'code-modify', tier: 'A', pattern: /(修改代码)|(改代码)|(改一下代码)|(modify the code)|(change the code)|(update the code)/i },
  { name: 'implement', tier: 'A', pattern: /(开发)|(实现.{0,10}(功能|模块|接口))|(新增功能)|(implement)|(add (a )?feature)/i },
  { name: 'build', tier: 'A', pattern: /(编译)|(构建)|(npm run)|(cargo (build|test|check))|(make the build)|(\bbuild the project\b)/i }
]);

// ── 工程对象（Tier B：需要与动作动词同现才算工程任务）────────────────────────
const PROJECT_NOUNS = Object.freeze([
  { name: 'repository', pattern: /(仓库)|(repository)|(\brepo\b)/i },
  { name: 'plugin', pattern: /(插件)|(plugin)/i },
  { name: 'mcp', pattern: /\bmcp\b/i },
  { name: 'project-noun', pattern: /(项目)|(工程)|(project)/i },
  { name: 'module', pattern: /(模块)|(module)/i },
  { name: 'code-ext', pattern: /(\.js\b)|(\.ts\b)|(\.py\b)|(\.rs\b)|(\.go\b)|(\.java\b)|(\.json 文件)|(源码)/i }
]);

const ACTION_VERB = /(修改|改动|变更|开发|实现|创建|新增|添加|删除|去掉|重构|修复|运行|执行|构建|编译|部署|提交|扩展|升级|迁移|接入|合并|调整|写一|做个|加一|modify|change|create|implement|add|remove|delete|refactor|fix|run|build|extend|upgrade|migrate|merge|write)/i;

const TOOL_SIGNALS = Object.freeze([
  { name: 'search', pattern: /(搜索)|(查一下)|(查一查)|(查询)|(搜一下)|(帮我查)|(search)|(look ?up)/i },
  { name: 'weather', pattern: /(天气)|(weather)/i },
  { name: 'calculate', pattern: /(计算)|(算一下)|(换算)|(汇率)|(calculate)|(convert)|(exchange rate)/i },
  { name: 'time', pattern: /(几点)|(几号)|(什么时间)|(当前时间)|(今天日期)|(what time)|(today'?s date)/i },
  { name: 'send-message', pattern: /(发消息)|(发送到)|(帮我发)|(send (a )?message)/i },
  { name: 'image', pattern: /(画图)|(画一张)|(生成图)|(draw(ing)?\b)|(generate .{0,12}image)/i },
  { name: 'checklist', pattern: /(待办)|(清单)|(todo list)|(checklist)/i },
  { name: 'document', pattern: /(整理成文档)|(写个文档)|(导出.{0,6}(文档|word|pdf))|(document conversion)/i }
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rs', '.go', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.rb', '.php', '.kt', '.swift', '.json',
  '.toml', '.yaml', '.yml', '.sql', '.sh', '.ps1', '.vue', '.svelte'
]);

function matchSignals(text, table) {
  return table.filter((entry) => entry.pattern.test(text)).map((entry) => entry.name);
}

function hasCodeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).some((name) => {
    const text = String(name ?? '').toLowerCase();
    const dot = text.lastIndexOf('.');
    return dot >= 0 && CODE_EXTENSIONS.has(text.slice(dot));
  });
}

/**
 * 确定性分类。输入：
 *   text                用户消息文本（必填字符串）
 *   attachments         附件名数组（可选，代码扩展名计入工程上下文）
 *   hasWorkspaceContext 是否带工程/工作区上下文（可选）
 *   agentEnabled        用户是否允许 Agent（Agent=Disabled 时为 false，绝不产生 agent 路由）
 *   costPolicy          economy | balanced | quality | agent-first（默认 balanced）
 */
export function classifyTask({
  text,
  attachments = [],
  hasWorkspaceContext = false,
  agentEnabled = true,
  costPolicy = DEFAULT_COST_POLICY
} = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    const error = new Error('text 不能为空');
    error.code = 'INVALID_PARAMS';
    throw error;
  }
  const policy = normalizeCostPolicy(costPolicy);
  const reasons = [];
  const projectHits = matchSignals(text, PROJECT_SIGNALS);
  const nounHits = matchSignals(text, PROJECT_NOUNS);
  const toolHits = matchSignals(text, TOOL_SIGNALS);
  const verbHit = ACTION_VERB.test(text);
  const codeContext = hasWorkspaceContext === true || hasCodeAttachments(attachments);
  if (projectHits.length) reasons.push(`工程信号：${projectHits.join('、')}`);
  if (nounHits.length) reasons.push(`工程对象：${nounHits.join('、')}${verbHit ? '（含动作动词）' : ''}`);
  if (codeContext) reasons.push('工程上下文：代码附件/工作区');
  if (toolHits.length) reasons.push(`工具信号：${toolHits.join('、')}`);

  // project 判定（阈值随 Cost Policy 收紧/放宽）：
  const strongHits = projectHits.length;
  const weakHits = nounHits.length;
  let isProject;
  if (policy === 'economy') {
    // Economy → 尽量 Model：只有"直接工程动作 + 佐证"才算 project。
    isProject = strongHits >= 1 && verbHit && (strongHits >= 2 || weakHits >= 1 || codeContext);
  } else {
    isProject = strongHits >= 1
      || (weakHits >= 1 && (verbHit || codeContext))
      || (codeContext && verbHit);
  }
  if (isProject) {
    const route = agentEnabled ? 'agent' : 'model';
    if (!agentEnabled) reasons.push('用户已禁用 Agent → 保持 Model');
    return {
      class: 'project',
      route,
      agentIntent: route === 'agent',
      capabilityIntent: false,
      costPolicy: policy,
      agentEnabled: agentEnabled === true,
      signals: { project: [...projectHits, ...nounHits], tool: toolHits },
      reasons
    };
  }

  // tool 判定：需要能力工具，但默认仍由 Model 执行（capability-intent 供后续 Capability 网关）。
  if (toolHits.length > 0) {
    const route = agentEnabled && policy === 'agent-first' ? 'agent' : 'model';
    if (route === 'agent') reasons.push('Agent First → tool 升级 Agent');
    return {
      class: 'tool',
      route,
      agentIntent: route === 'agent',
      capabilityIntent: true,
      costPolicy: policy,
      agentEnabled: agentEnabled === true,
      signals: { project: [...projectHits, ...nounHits], tool: toolHits },
      reasons
    };
  }

  return {
    class: 'simple',
    route: 'model',
    agentIntent: false,
    capabilityIntent: false,
    costPolicy: policy,
    agentEnabled: agentEnabled === true,
    signals: { project: [...projectHits, ...nounHits], tool: toolHits },
    reasons
  };
}

/** 策略列表透出（供 IPC/UI），防止散落字符串。 */
export function costPolicies() {
  return [...COST_POLICIES];
}
