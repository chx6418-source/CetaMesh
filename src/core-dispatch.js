// 统一入口分派：worker 与全部 MCP 模式共用同一套参数解析和执行逻辑。
//
// 本模块只做分派，不判断“是否为主模块”。源码入口 src/core-entry.js 负责 Node 直接运行，
// 打包入口 src/core-sea.js 负责 SEA exe；两者都只 import 本模块，避免其中一方的
// 主模块守卫在另一方运行时被意外触发（SEA 中 import.meta.url 会等于 exe 自身路径）。
import { runCoreWorker } from './app/core-worker.js';
import { runMcpSnowLuma } from './mcp-snowluma-safe.js';
import { runMcpSnowLumaHost } from './mcp-host-server.js';
import { runMcpWebSearchSafe } from './mcp-web-search-safe.js';
import { runMcpQqFileSend } from './mcp-qq-file-send.js';
import { runMcpBilibili } from './mcp-bilibili.js';
import { runSelfTest } from './self-test.js';
import { runSetupDshFromApp, runDshRemovalFromApp } from './dsh-integration.js';
import { runExtensionWorker } from './extension/process-worker.js';
import { runQqConnectorWorker } from './channel/qq/connector-worker.js';

export const MCP_MODES = Object.freeze({
  snowluma: runMcpSnowLuma,
  'snowluma-host': runMcpSnowLumaHost,
  'web-search-safe': runMcpWebSearchSafe,
  'qq-file-send': runMcpQqFileSend,
  bilibili: runMcpBilibili
});

const MCP_ALIASES = Object.freeze({
  'mcp-snowluma': 'snowluma',
  'mcp-snowluma-host': 'snowluma-host',
  'mcp-web-search-safe': 'web-search-safe',
  'mcp-qq-file-send': 'qq-file-send',
  'mcp-bilibili': 'bilibili'
});

// --data-dir 由 src/app-paths.js 在模块加载期解析（必须在 APP_PATHS 建立之前生效），
// 这里只负责把它从参数列表中摘掉，好让它与任何模式共存而不被判为多余参数。
function stripDataDirArgs(args) {
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? '');
    if (arg === '--data-dir') {
      i += 1;
      continue;
    }
    if (arg.startsWith('--data-dir=')) continue;
    rest.push(args[i]);
  }
  return rest;
}

export const CORE_USAGE = `鲸桥 WhaleBridge Core

用法：
  WhaleBridgeCore.exe --worker [--data-dir <目录>]
  WhaleBridgeCore.exe --extension-worker
  WhaleBridgeCore.exe --qq-connector [--data-dir <目录>]
  WhaleBridgeCore.exe --bionic-runtime [--data-dir <目录>]
  WhaleBridgeCore.exe --mcp <${Object.keys(MCP_MODES).join('|')}> [--data-dir <目录>]
  WhaleBridgeCore.exe --setup-dsh [profile] [--dry-run] [--force-presets]
  WhaleBridgeCore.exe --uninstall-dsh [profile] [--dry-run]
  WhaleBridgeCore.exe --self-test [DSH_BASE_URL] [PROMPT]
  WhaleBridgeCore.exe --help

源码模式下把 WhaleBridgeCore.exe 换成 node src/core-entry.js。

路径：
  --data-dir <目录>            指定可写用户数据目录（优先于 WHALEBRIDGE_DATA_DIR）
  WHALEBRIDGE_DATA_DIR         可写用户数据目录；打包运行时默认 %LOCALAPPDATA%\\WhaleBridge
  WHALEBRIDGE_RESOURCE_DIR     只读资源目录；打包运行时默认 exe 同目录的 resources\\`;

export function parseCoreArgs(argv = process.argv.slice(2)) {
  if (argv[0] === '--agent-sdk-runner') {
    if (argv.length !== 2 || argv[1] !== 'claude') throw new Error('Invalid private Agent SDK runner arguments');
    return { mode: 'agent-sdk-runner', provider: 'claude' };
  }
  const args = stripDataDirArgs([...argv]);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return { mode: 'help' };
  if (args[0] === '--worker') {
    if (args.length !== 1) throw new Error(`--worker 不接受额外参数\n\n${CORE_USAGE}`);
    return { mode: 'worker' };
  }
  if (args[0] === '--qq-connector') {
    if (args.length !== 1) throw new Error('--qq-connector does not accept additional arguments');
    return { mode: 'qq-connector' };
  }
  if (args[0] === '--bionic-runtime') {
    if (args.length !== 1) throw new Error('--bionic-runtime does not accept additional arguments');
    return { mode: 'bionic-runtime' };
  }
  if (args[0] === '--extension-worker') {
    if (args.length !== 1) throw new Error(`--extension-worker 不接受额外参数\n\n${CORE_USAGE}`);
    return { mode: 'extension-worker' };
  }
  if (args[0] === '--setup-dsh') {
    const options = { mode: 'setup-dsh', profile: undefined, dryRun: false, force: false };
    for (const arg of args.slice(1)) {
      if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
      else if (arg === '--force-presets' || arg === '--force') options.force = true;
      else if (arg.startsWith('-')) throw new Error(`--setup-dsh 未知参数：${arg}\n\n${CORE_USAGE}`);
      else if (!options.profile) options.profile = arg;
      else throw new Error(`--setup-dsh 只接受一个 profile 参数（多余的：${arg}）\n\n${CORE_USAGE}`);
    }
    return options;
  }
  if (args[0] === '--uninstall-dsh') {
    const options = { mode: 'uninstall-dsh', profile: undefined, dryRun: false };
    for (const arg of args.slice(1)) {
      if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
      else if (arg.startsWith('-')) throw new Error(`--uninstall-dsh 未知参数：${arg}\n\n${CORE_USAGE}`);
      else if (!options.profile) options.profile = arg;
      else throw new Error(`--uninstall-dsh 只接受一个 profile 参数（多余的：${arg}）\n\n${CORE_USAGE}`);
    }
    return options;
  }
  if (args[0] === '--self-test') {
    if (args.length > 3) throw new Error(`--self-test 最多接受 DSH_BASE_URL 和 PROMPT 两个参数\n\n${CORE_USAGE}`);
    return { mode: 'self-test', baseUrl: args[1], promptText: args[2] };
  }

  let requested = null;
  if (args[0] === '--mcp') {
    if (args.length !== 2) throw new Error(`--mcp 必须且只能指定一个模式\n\n${CORE_USAGE}`);
    requested = args[1];
  } else if (args[0].startsWith('--mcp=')) {
    if (args.length !== 1) throw new Error(`--mcp=<模式> 不接受额外参数\n\n${CORE_USAGE}`);
    requested = args[0].slice('--mcp='.length);
  }

  if (requested !== null) {
    const normalized = MCP_ALIASES[requested] ?? requested;
    if (!Object.hasOwn(MCP_MODES, normalized)) {
      throw new Error(`未知 MCP 模式：${requested}\n\n${CORE_USAGE}`);
    }
    return { mode: 'mcp', mcp: normalized };
  }
  throw new Error(`未知参数：${args.join(' ')}\n\n${CORE_USAGE}`);
}

export async function runCore(argv = process.argv.slice(2)) {
  const command = parseCoreArgs(argv);
  if (command.mode === 'agent-sdk-runner') return (await import('./agent/claude-sdk-runner.js')).runClaudeSdkRunner();
  if (command.mode === 'help') {
    process.stdout.write(`${CORE_USAGE}\n`);
    return;
  }
  if (command.mode === 'worker') return runCoreWorker();
  if (command.mode === 'qq-connector') return runQqConnectorWorker();
  if (command.mode === 'bionic-runtime') return (await import('./bionic/worker.js')).runBionicWorker();
  if (command.mode === 'extension-worker') return runExtensionWorker();
  if (command.mode === 'setup-dsh') {
    return runSetupDshFromApp({
      profile: command.profile,
      dryRun: command.dryRun,
      force: command.force
    });
  }
  if (command.mode === 'uninstall-dsh') {
    return runDshRemovalFromApp({ profile: command.profile, dryRun: command.dryRun });
  }
  if (command.mode === 'self-test') {
    return runSelfTest({ baseUrl: command.baseUrl, promptText: command.promptText });
  }
  return MCP_MODES[command.mcp]();
}
