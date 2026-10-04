// SnowLuma 进程管理 MCP server（stdio）。
// 由 DSH 的 MCP 客户端 spawn（cordis.patch.yml 里 mcp-snowluma-host 行），
// 给 agent 提供 SnowLuma 网关的状态查询与启停工具。
//
// 工具：
//   snowluma_status   —— 检查网关是否在线（HTTP get_login_info）
//   start_snowluma    —— 未运行时启动 launcher.bat 并等待网关就绪（最长 90s）
//   stop_snowluma     —— 停止 SnowLuma（按安装目录匹配进程）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { APP_PATHS } from './app-paths.js';
import { isMainModule, reportEntrypointError } from './entrypoint.js';
import { readRawConfigOrEmpty } from './config/loader.js';

// 统一配置读取（TASK-D1-001）：BOM 容错与 fail-closed 语义集中在 src/config/loader.js。
// 读不到 / 损坏按“未配置”空对象处理，allowProcessControl 在使用点以 !== true 自行关闭。
function loadConfig() {
  return readRawConfigOrEmpty(APP_PATHS.configFile);
}

function getConfig() {
  return loadConfig();
}

function getHostConfig() {
  const c = getConfig();
  const httpUrl = (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const launcher = c.snowluma?.launcherPath ?? '';
  return {
    httpUrl,
    httpPort: new URL(httpUrl).port || '80',
    token: c.snowluma?.accessToken ?? '',
    launcher,
    homeDir: c.snowluma?.homeDir ?? (launcher ? path.dirname(launcher) : ''),
    // 进程控制默认关闭：只有 config.json 显式设置 snowluma.allowProcessControl=true 才允许启停
    allowProcessControl: c.snowluma?.allowProcessControl === true
  };
}

function getConsolePort() {
  try {
    const c = getConfig();
    return Number(c.consolePort) || 3100;
  } catch {
    return 3100;
  }
}

// 与控制台分离的「服务令牌」：本 MCP 只读 /api/status，走数据面白名单即可，
// 不需要（也不应该）持有控制台令牌。
function readBridgeToken() {
  try {
    const token = fs.readFileSync(path.join(APP_PATHS.stateDir, 'agent-token'), 'utf8').trim();
    if (token) return token;
  } catch {}
  try {
    const c = getConfig();
    if (c.agentToken) return String(c.agentToken);
  } catch {}
  try {
    const c = getConfig();
    if (c.consoleToken) return String(c.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(APP_PATHS.stateDir, 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

// 进程控制只允许在 closed-agent（仅管理员私聊）模式下使用，防止 chat/reserved 的 agent 被群友诱导启停 SnowLuma。
async function bridgeModeAllowsProcessControl() {
  try {
    const token = readBridgeToken();
    const res = await fetch(`http://127.0.0.1:${getConsolePort()}/api/status`, {
      headers: token ? { 'x-console-token': token } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.mode === 'closed-agent';
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gatewayInfo() {
  const { httpUrl, token } = getHostConfig();
  try {
    const res = await fetch(`${httpUrl}/get_login_info`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请改为 OneBot HTTP API 地址）' : '';
      return { reachable: false, httpStatus: res.status, ...(hint ? { hint } : {}) };
    }
    const body = await res.json();
    if (body?.status === 'ok' && body?.retcode === 0) {
      return { reachable: true, online: true, user_id: body.data?.user_id, nickname: body.data?.nickname };
    }
    return { reachable: true, online: false, retcode: body?.retcode, wording: body?.wording };
  } catch (error) {
    return { reachable: false, error: String(error?.message ?? error) };
  }
}

function findSnowLumaPids() {
  // 先按 OneBot HTTP 端口找监听进程，再用安装目录过滤命令行，
  // 避免误杀恰好占用同一端口的其他进程。
  const { httpPort, homeDir } = getHostConfig();
  const portNum = Number(httpPort);
  if (!Number.isInteger(portNum) || portNum <= 0 || portNum > 65535) return [];
  const pids = new Set();
  try {
    // 端口经环境变量传入脚本，不拼进命令文本：避免字符串插值成为注入面。
    const byPort = 'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq [int]$env:WHALEBRIDGE_ONEBOT_PORT } | Select-Object -ExpandProperty OwningProcess -Unique';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', byPort], {
      timeout: 15000, windowsHide: true, encoding: 'utf8',
      env: { ...process.env, WHALEBRIDGE_ONEBOT_PORT: String(portNum) }
    });
    for (const s of out.split(/\s+/)) {
      const n = Number(s.trim());
      if (Number.isInteger(n) && n > 0) pids.add(n);
    }
  } catch {}
  const home = String(homeDir || '').toLowerCase().replace(/\\/g, '/');
  const result = [];
  for (const pid of pids) {
    try {
      // 同理：pid 也经环境变量传入，绝不拼进 PowerShell 命令文本。
      const cmd = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$env:WHALEBRIDGE_PID)).CommandLine'], {
        timeout: 10000, windowsHide: true, encoding: 'utf8',
        env: { ...process.env, WHALEBRIDGE_PID: String(pid) }
      }).trim();
      const cmdLower = String(cmd || '').toLowerCase().replace(/\\/g, '/');
      if (home && cmdLower.includes(home)) result.push(pid);
    } catch {
      // 拿不到命令行时宁可不杀，避免误伤
    }
  }
  return result;
}

const server = new McpServer({ name: 'snowluma-host', version: '0.1.0' });

server.tool(
  'snowluma_status',
  '检查 SnowLuma OneBot 网关是否在线（HTTP 探活 get_login_info）。返回网关可达性、QQ 在线状态与账号信息。',
  {},
  async () => {
    const hc = getHostConfig();
    const info = await gatewayInfo();
    // 只有显式开启进程控制且当前为 closed-agent 时，才暴露本机路径/PID 这类敏感信息。
    const admin = hc.allowProcessControl && await bridgeModeAllowsProcessControl();
    const extra = admin ? { launcher: hc.launcher, homeDir: hc.homeDir, processPids: findSnowLumaPids() } : {};
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...info, ...extra }, null, 2) }]
    };
  }
);

if (getHostConfig().allowProcessControl) {
  server.tool(
    'start_snowluma',
    '启动 SnowLuma（launcher.bat，独立窗口）并等待 OneBot 网关就绪，最长 90 秒。已在运行时直接返回当前状态。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.launcher) {
        return { content: [{ type: 'text', text: '拒绝：未配置 snowluma.launcherPath。' }], isError: true };
      }
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const before = await gatewayInfo();
      if (before.reachable && before.online) {
        return { content: [{ type: 'text', text: JSON.stringify({ started: false, alreadyOnline: true, info: before }) }] };
      }
      let spawnError = null;
      const child = spawn('cmd.exe', ['/c', 'start', '', `"${hc.launcher}"`], { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => { spawnError = err; });
      child.unref();
      let info = null;
      for (let i = 0; i < 45; i += 1) {
        if (spawnError) {
          return { content: [{ type: 'text', text: `启动失败：${spawnError?.message ?? spawnError}` }], isError: true };
        }
        await sleep(2000);
        info = await gatewayInfo();
        if (info.reachable && info.online) {
          return { content: [{ type: 'text', text: JSON.stringify({ started: true, readyAfterMs: (i + 1) * 2000, info }) }] };
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ started: false, timeout: true, lastInfo: info ?? before }) }] };
    }
  );

  server.tool(
    'stop_snowluma',
    '停止 SnowLuma 进程（按安装目录匹配 node 进程后 taskkill）。谨慎使用：会断开当前 QQ 连接。',
    {},
    async () => {
      const hc = getHostConfig();
      if (!hc.allowProcessControl) {
        return { content: [{ type: 'text', text: '拒绝：进程控制未开启（config.json 需设置 snowluma.allowProcessControl=true）。' }], isError: true };
      }
      if (!(await bridgeModeAllowsProcessControl())) {
        return { content: [{ type: 'text', text: '拒绝：进程控制仅允许在 closed-agent（管理员私聊）模式下使用。' }], isError: true };
      }
      const pids = findSnowLumaPids();
      if (pids.length === 0) {
        return { content: [{ type: 'text', text: JSON.stringify({ stopped: false, reason: 'no process found' }) }] };
      }
      const killed = [];
      for (const pid of pids) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' });
          killed.push(pid);
        } catch (error) {
          // 进程可能已退出
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true, killed }) }] };
    }
  );
}

export async function runMcpSnowLumaHost(transport = new StdioServerTransport()) {
  await server.connect(transport);
  return server;
}

if (isMainModule(import.meta.url)) {
  runMcpSnowLumaHost().catch((error) => reportEntrypointError('mcp-snowluma-host', error));
}
