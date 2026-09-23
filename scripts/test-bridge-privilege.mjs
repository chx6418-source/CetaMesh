// 桥接双令牌（控制台令牌 / 服务令牌）权限分离自检：
// 1. resolvePrivilege：按令牌取值判级，空值/错值不得通过
// 2. loopback API 只通过明确令牌认证，不提供浏览器 session/cookie 登录
// 3. agentPrivilegeAllows：数据面白名单 + 归一化防绕过
// 4. 源码接入断言：桥接生成 state/agent-token、MCP 改读服务令牌、pid/端口不再拼进命令文本
// 5. 桥接运行且已加载双令牌时，做真实端到端验证（服务令牌打控制面必须 403）
// 运行：node scripts/test-bridge-privilege.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRIVILEGE_AGENT,
  PRIVILEGE_CONSOLE,
  agentPrivilegeAllows,
  describePrivilegeSurface,
  resolvePrivilege
} from '../src/bridge-privilege.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('✅ ' + name + (extra ? ' — ' + extra : '')); }
  else { failed += 1; console.error('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// ── 1. resolvePrivilege ───────────────────────────────────────────────────
const CT = 'console-token-abcdefghijklmnop';
const AT = 'agent-token-abcdefghijklmnopqr';
const base = { sessionValid: false, suppliedToken: '', consoleToken: CT, agentToken: AT };
check('控制台令牌 → console 级', resolvePrivilege({ ...base, suppliedToken: CT }) === PRIVILEGE_CONSOLE);
check('服务令牌 → agent 级', resolvePrivilege({ ...base, suppliedToken: AT }) === PRIVILEGE_AGENT);
check('两个令牌不会互相误判', resolvePrivilege({ ...base, suppliedToken: AT }) !== PRIVILEGE_CONSOLE);
check('错误令牌被拒', resolvePrivilege({ ...base, suppliedToken: 'nope' }) === '');
check('空令牌被拒', resolvePrivilege({ ...base, suppliedToken: '' }) === '' && resolvePrivilege(base) === '');
check('null/undefined 令牌被拒', resolvePrivilege({ ...base, suppliedToken: null }) === '' && resolvePrivilege({ ...base, suppliedToken: undefined }) === '');
check('配置为空时不得用空令牌通过', resolvePrivilege({ sessionValid: false, suppliedToken: '', consoleToken: '', agentToken: '' }) === '');

// ── 3. agentPrivilegeAllows ───────────────────────────────────────────────
const mustAllow = [
  ['GET', '/api/status'],
  ['POST', '/api/authorize/read'],
  ['GET', '/api/images/message'],
  ['POST', '/api/send/group'],
  ['POST', '/api/send/private'],
  ['POST', '/api/send/reply'],
  ['GET', '/api/socialV2/unread'],
  ['GET', '/api/socialV2/recent'],
  ['GET', '/api/socialV2/prompt'],
  ['POST', '/api/socialV2/send-message'],
  ['GET', '/api/socialV2/card-message'],
  ['POST', '/api/socialV2/card-button-click'],
  ['GET', '/api/socialV2/sticker-list'],
  ['POST', '/api/socialV2/feedback']
];
const mustDeny = [
  ['POST', '/api/terminal/open'],
  ['POST', '/api/terminal/write'],
  ['POST', '/api/terminal/close'],
  ['GET', '/api/terminal/stream'],
  ['POST', '/api/services/snowluma/start'],
  ['POST', '/api/services/dsh/start'],
  ['POST', '/api/services/snowluma/install'],
  ['GET', '/api/services'],
  ['POST', '/api/shutdown'],
  ['POST', '/api/restart'],
  ['POST', '/api/token'],
  ['POST', '/api/mode'],
  ['GET', '/api/socialV2/config'],
  ['POST', '/api/socialV2/config'],
  ['POST', '/api/socialV2/reset'],
  ['POST', '/api/socialV2/activity'],
  ['GET', '/api/socialV2/tool-log'],
  ['GET', '/api/socialV2/feedback'],
  ['GET', '/api/stickers'],
  ['POST', '/api/stickers'],
  ['GET', '/api/roles'],
  ['POST', '/api/role'],
  ['POST', '/api/roles/create'],
  ['GET', '/api/security'],
  ['POST', '/api/security'],
  ['POST', '/api/slang/config'],
  ['GET', '/api/sessions'],
  ['POST', '/api/social/state'],
  ['GET', '/api/fileSend']
];
const badAllows = mustAllow.filter(([m, p]) => !agentPrivilegeAllows(m, p)).map(([m, p]) => m + ' ' + p);
const badDenies = mustDeny.filter(([m, p]) => agentPrivilegeAllows(m, p)).map(([m, p]) => m + ' ' + p);
check('数据面白名单放行 MCP 实际使用的接口', badAllows.length === 0, badAllows.join('; '));
check('控制面接口（终端/服务/关机/配置/令牌）一律拒绝', badDenies.length === 0, badDenies.join('; '));
check('未列出的新接口默认拒绝（白名单收敛）', !agentPrivilegeAllows('POST', '/api/new-admin-op') && !agentPrivilegeAllows('GET', '/api/metrics') && !agentPrivilegeAllows('POST', '/api/config'));
check('前缀白名单不放过同前缀的管理接口', !agentPrivilegeAllows('POST', '/api/socialV2/config') && !agentPrivilegeAllows('POST', '/api/socialV2/reset'));
check('路径归一化防绕过（../ 与反斜杠）',
  !agentPrivilegeAllows('POST', '/api/socialV2/../terminal/open')
  && !agentPrivilegeAllows('POST', '/api/socialV2/..\\terminal\\open')
  && !agentPrivilegeAllows('POST', '/api/send/../terminal/open')
  && agentPrivilegeAllows('GET', '/api/socialV2/./unread'));
check('非绝对路径/非法输入一律拒绝', !agentPrivilegeAllows('GET', 'api/status') && !agentPrivilegeAllows('GET', null) && !agentPrivilegeAllows('GET', ''));
check('权限面自描述可枚举', (() => { const s = describePrivilegeSurface(); return Array.isArray(s.agentAllowedExact) && Array.isArray(s.agentAllowedPrefixes) && s.agentDeniedExact.length >= 6; })());

// ── 4. 源码接入断言 ───────────────────────────────────────────────────────
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
const safeSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-snowluma-safe.js'), 'utf8');
const hostSrc = fs.readFileSync(path.join(ROOT, 'src', 'mcp-host-server.js'), 'utf8');
check('bridge 引入双令牌策略模块', /from '\.\/bridge-privilege\.js'/.test(bridgeSrc) && bridgeSrc.includes('agentPrivilegeAllows(') && bridgeSrc.includes('resolvePrivilege('));
check('social state HTTP adapter dispatches through ControlService', bridgeSrc.includes('runControlCommand(CONTROL_METHODS.SET_SOCIAL_PHASE, body)') && bridgeSrc.includes('INVALID_SESSION_KEY: 400') && bridgeSrc.includes('INVALID_PHASE: 400'));
check('bridge 生成并持久化 state/agent-token', bridgeSrc.includes("'agent-token'") && /loadOrCreateAgentToken/.test(bridgeSrc));
check('loopback API 采用 token-only 鉴权（不消费 Cookie/session）',
  bridgeSrc.includes("const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];")
  && bridgeSrc.includes('resolvePrivilege({ sessionValid: false, suppliedToken, consoleToken, agentToken })')
  && !bridgeSrc.includes('shouldIssueConsoleSession')
  && !bridgeSrc.includes('consoleSession')
  && !bridgeSrc.includes('sessionValid ='));
check('移除网页登录与 session Cookie 签发/验证流程',
  !/Set-Cookie/i.test(bridgeSrc)
  && !/Cookie\s*:\s*consoleSession/i.test(bridgeSrc)
  && !bridgeSrc.includes('shouldIssueConsoleSession')
  && bridgeSrc.includes("网页控制台已移除；请使用 WhaleBridge 原生应用。"));
check('bridge 重置控制台令牌时同步轮换服务令牌', /loadOrCreateAgentToken\(true\)/.test(bridgeSrc));
check('bridge 暴露 tokenModel 自描述', bridgeSrc.includes("tokenModel: 'dual'"));
check('MCP 改读服务令牌（不再首选控制台令牌）', safeSrc.includes("'agent-token'") && hostSrc.includes("'agent-token'") && !safeSrc.includes('readConsoleToken') && !hostSrc.includes('readConsoleToken'));
check('MCP 读 agent-token 的位置早于 console-token', safeSrc.indexOf("'agent-token'") < safeSrc.indexOf("'console-token'") && hostSrc.indexOf("'agent-token'") < hostSrc.indexOf("'console-token'"));
check('pid/端口不再拼进 PowerShell 命令文本',
  !/ProcessId=\$\{/.test(hostSrc) && !/LocalPort -eq \$\{/.test(hostSrc)
  && hostSrc.includes('WHALEBRIDGE_PID') && hostSrc.includes('WHALEBRIDGE_ONEBOT_PORT'));

// ── 5. 真实端到端（桥接运行且已加载双令牌时） ─────────────────────────────
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const agentTokenFile = path.join(ROOT, 'state', 'agent-token');
let config = null;
try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch {}
const readToken = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const consoleToken = config?.consoleToken || readToken(consoleTokenFile);
const agentToken = readToken(agentTokenFile);
const PORT = config?.consolePort || 3100;

async function call(method, p, token, body) {
  const res = await fetch('http://127.0.0.1:' + PORT + p, {
    method,
    headers: { 'x-console-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed, setCookie: res.headers.get('set-cookie') || '', contentType: res.headers.get('content-type') || '' };
}

if (!consoleToken) {
  console.log('⚠️ 跳过真实端到端检查：缺少控制台令牌');
} else {
  try {
    const status = await call('GET', '/api/status', consoleToken);
    if (status.body?.tokenModel !== 'dual') {
      console.log('⚠️ 跳过真实端到端检查：运行中的桥接尚未加载双令牌（重启桥接后生效）');
    } else if (!agentToken) {
      console.log('⚠️ 跳过真实端到端检查：state/agent-token 缺失');
    } else {
      const s1 = await call('GET', '/api/status', agentToken);
      check('服务令牌可读数据面 /api/status', s1.status === 200, 'HTTP ' + s1.status);
      check('服务令牌响应不种会话 Cookie', !/consoleSession=/.test(s1.setCookie), s1.setCookie || '(无 Set-Cookie)');
      const s2 = await call('POST', '/api/terminal/open', agentToken, {});
      check('服务令牌访问 /api/terminal/open 被拒绝', s2.status === 403 && /服务令牌无权访问/.test(s2.body?.error || ''), 'HTTP ' + s2.status + ' ' + (s2.body?.error || ''));
      const s3 = await call('POST', '/api/services/snowluma/start', agentToken, {});
      check('服务令牌访问服务启停被拒绝', s3.status === 403, 'HTTP ' + s3.status + ' ' + (s3.body?.error || ''));
      const s4 = await call('GET', '/api/socialV2/config', agentToken);
      check('服务令牌访问 v2 管理端配置被拒绝', s4.status === 403, 'HTTP ' + s4.status + ' ' + (s4.body?.error || ''));
      const s5 = await call('GET', '/api/status', consoleToken);
      check('控制台令牌仍可正常访问', s5.status === 200, 'HTTP ' + s5.status);
      const page = await call('GET', '/', consoleToken);
      check('原控制台根路径不再提供登录页或 HTML 页面', page.status === 404 && /网页控制台已移除/.test(page.body?.error || '') && !/text\/html/i.test(page.contentType), 'HTTP ' + page.status + ' ' + (page.body?.error || ''));
      check('loopback API 响应不签发页面 session Cookie', !/consoleSession=/i.test(page.setCookie), page.setCookie || '(无 Set-Cookie)');
    }
  } catch (error) {
    console.log('⚠️ 真实端到端检查跳过：' + (error?.message ?? error));
  }
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) process.exitCode = 1;
