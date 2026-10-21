// 桥接「控制台令牌 / 服务令牌」双令牌的权限判定（纯函数，无副作用）。
//
// 背景：桥接只有一个令牌时，MCP server（agent 侧）也持有它，于是——
// 一旦该凭据泄漏（prompt injection、日志、被诱导的本地读取等），攻击者就能访问
// /api/terminal/*（在桥接进程内执行任意命令）、/api/services/*（启停/安装服务）、
// /api/shutdown 等控制面接口，等于拿到本机控制权。
//
// 因此拆成两种凭据、同一套鉴权闸门按*取值*区分权限：
//   · 控制台令牌（state/console-token 或 config.consoleToken）→ 人操作的浏览器，全部权限
//   · 服务令牌（state/agent-token）→ MCP server / agent 侧，仅数据面权限
// 服务令牌采用**白名单**：未列出的接口一律拒绝，将来新增控制面接口也不会被顺带拿到。

export const PRIVILEGE_CONSOLE = 'console';
export const PRIVILEGE_AGENT = 'agent';

// 服务令牌允许的精确路径：只读状态 / 授权打点 / 按消息取图
const ALLOWED_EXACT = new Set([
  '/api/status',
  '/api/authorize/read',
  '/api/images/message'
]);

// 服务令牌允许的前缀：发送与会话数据面（MCP 工具的读写都落在这两块）
const ALLOWED_PREFIXES = ['/api/send/', '/api/socialV2/'];

// 前缀白名单中的例外——这些是控制台专用的管理端接口，服务令牌一律拒绝。
// 与 bridge.js 里「带 x-agent-token 的会话级令牌」那套 adminOnlyV2Paths 保持同一份清单语义。
const DENIED_EXACT = new Set([
  '/api/socialV2/config',
  '/api/socialV2/activity',
  '/api/socialV2/reset',
  '/api/socialV2/states',
  '/api/socialV2/wake',
  '/api/socialV2/tool-log'
]);

// MCP 的 qq_report_feedback 需要 POST /api/socialV2/feedback；但 GET 是管理员读全量反馈，必须拒绝。
const FEEDBACK_PATH = '/api/socialV2/feedback';

export function agentPrivilegeAllows(method, pathname) {
  const verb = String(method ?? 'GET').toUpperCase();
  // 先用 URL 规则归一化（折叠 ../、把 \ 视作 /），再做前缀匹配：
  // 即使调用方传入未归一化的原始路径，也不会被 /api/socialV2/../terminal/open 之类绕过。
  // 先要求是绝对路径，再按 URL 规则归一化（折叠 ../、把反斜杠视作 /）后做前缀匹配：
  // 既不会被 /api/socialV2/../terminal/open 之类绕过，也不会把相对路径补成合法路径放行。
  const raw = String(pathname ?? '');
  if (!raw.startsWith('/')) return false;
  let target = '';
  try {
    target = new URL(raw, 'http://127.0.0.1').pathname;
  } catch {
    return false;
  }
  if (!target.startsWith('/')) return false;
  if (target === FEEDBACK_PATH) return verb === 'POST';
  if (DENIED_EXACT.has(target)) return false;
  if (ALLOWED_EXACT.has(target)) return true;
  return ALLOWED_PREFIXES.some((prefix) => target.startsWith(prefix));
}

// 由请求凭据判定权限级别。
// 会话 Cookie 与「控制台令牌」等价（都是人在浏览器里操作的）；服务令牌只给数据面。
export function resolvePrivilege({ sessionValid = false, suppliedToken = '', consoleToken = '', agentToken = '' } = {}) {
  if (sessionValid) return PRIVILEGE_CONSOLE;
  const supplied = String(suppliedToken ?? '');
  if (!supplied) return '';
  // 比较顺序固定，且要求两侧都非空：空令牌不得匹配空配置
  if (consoleToken && supplied === consoleToken) return PRIVILEGE_CONSOLE;
  if (agentToken && supplied === agentToken) return PRIVILEGE_AGENT;
  return '';
}

// 只有控制台级别才签发会话 Cookie。
// 若服务令牌也能换来 Cookie，等于把数据面凭据一步升级成控制面（Cookie 走的是全权通道）。
export function shouldIssueConsoleSession(privilege) {
  return privilege === PRIVILEGE_CONSOLE;
}

// 便于运维/自检判断某个接口属于哪一侧（只读用途，不参与鉴权判定）。
export function describePrivilegeSurface() {
  return {
    agentAllowedExact: [...ALLOWED_EXACT],
    agentAllowedPrefixes: [...ALLOWED_PREFIXES],
    agentDeniedExact: [...DENIED_EXACT, FEEDBACK_PATH + ' (GET)']
  };
}
