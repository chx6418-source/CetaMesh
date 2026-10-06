// CetaMesh Workspace —— Controlled Test Runner（v2 hardening Phase E；final security 修正定位）。
//
// 文件名保持 isolated-runner.js（兼容），但产品语义是 **Controlled Test Runner
//（受控测试执行器）**，不是 Sandbox：
//
//   > This is not an OS sandbox.
//
// 本模块执行的是 Workspace 中**可被 Agent 经 filesystem.write 修改的项目代码**
// （package.json scripts / 测试 / 构建脚本）。命令 allowlist 只能防止直接命令注入，
// 防不了项目代码本身以当前 Windows 用户权限做任何事。因此：
//   - test.run risk = high：Agent 每一次执行都必须 Owner Approve Once
//     （即使 Agent 的 Task Grant 包含 test.run 也一样——grant = 可以请求，
//       approval = 这次可以执行）；
//   - 本模块只是审批之后的**纵深防御层**，不是安全边界本身。
//
// 目的：让 Managed Agent 的 `test.run` 在 Owner 显式批准后**受控执行**。安全包络
// （全部强制，缺一拒绝）：
//   - 固定 cwd：只能是指定 Workspace 的 root（经登记表解析，绝不接受调用方路径）；
//   - 命令 allowlist：仅 `npm test` / `npm run <script>` / `cargo test [name]`，
//     script/name 必须是有界 token（无空格、无 shell 元字符）；绝不执行调用方
//     自带的任意命令串；
//   - 不接受调用方 shell：argv 逐 token 白名单校验（无空白、无 & | < > ^ % ! ; " ' `）。
//     POSIX 直接 shell:false 执行；win32 上 npm 是 .cmd shim（Node CVE-2024-27980
//     后禁止 shell:false spawn .cmd），故显式 `cmd.exe /d /s /c` 包装——经 cmd 的
//     只有已通过 token 校验的参数，调用方输入没有任何 shell 元字符可解释；
//   - 最小 env：白名单变量（PATH/SYSTEMROOT/COMSPEC 等），不透传宿主其余环境
//     （凭据、token 不会进入测试进程）；
//   - stdin ignore：禁止交互；timeout 到点杀进程树（win32 用 taskkill /T /F）；
//   - output 有界（maxBuffer + 截断标记）；
//   - 不提供任何"其它 workspace / 宿主任意进程"路径——本模块没有构造它们的入口。
//
// OS 级隔离仍是后续阶段（与 ProcessExtensionHost 同属进程隔离工作）。

import { execFile } from 'node:child_process';
import path from 'node:path';
import { capabilityError } from '../capability/types.js';

const RUNNER_LIMITS = Object.freeze({
  maxOutputBytes: 2 * 1024 * 1024,   // execFile maxBuffer；超出即杀进程
  stdoutCapChars: 512 * 1024,        // 返回前再截断，避免 IPC 载荷过大
  stderrCapChars: 256 * 1024,
  defaultTimeoutMs: 10 * 60 * 1000,
  maxTimeoutMs: 15 * 60 * 1000,
  scriptMaxChars: 64,
  argMaxChars: 64,
  maxExtraArgs: 8
});

/** 单个 argv token 的白名单形状：无空白、无 shell 元字符、有界。 */
function safeToken(value, label) {
  const text = String(value ?? '');
  if (!text || text.length > RUNNER_LIMITS.argMaxChars
    || !/^[A-Za-z0-9@:._+\\/[=-]+$/.test(text)) {
    throw capabilityError('INVALID_PARAMS', `${label} 含非法字符或超长（只允许无空白的有限字符集）`);
  }
  return text;
}

/** 命令 allowlist：唯一入口。返回 { file, args }；不在 allowlist 即拒绝。 */
function resolveCommand(tool, args = []) {
  const list = Array.isArray(args) ? args : [];
  if (tool === 'npm') {
    if (list.length === 1 && list[0] === 'test') return { file: 'npm', args: ['test'] };
    if (list.length >= 2 && list[0] === 'run') {
      const script = safeToken(list[1], 'npm script 名');
      const extra = list.slice(2);
      if (extra.length === 0) return { file: 'npm', args: ['run', script] };
      if (extra[0] !== '--' || extra.length - 1 > RUNNER_LIMITS.maxExtraArgs) {
        throw capabilityError('INVALID_PARAMS', 'npm run 只允许 `--` 后跟有限个有界参数');
      }
      return { file: 'npm', args: ['run', script, '--', ...extra.slice(1).map((item) => safeToken(item, 'npm 参数'))] };
    }
    throw capabilityError('TEST_COMMAND_NOT_ALLOWED', 'npm 只允许 `test` 或 `run <script>`（allowlist）');
  }
  if (tool === 'cargo') {
    if (list.length === 1 && list[0] === 'test') return { file: 'cargo', args: ['test'] };
    if (list.length === 2 && list[0] === 'test') return { file: 'cargo', args: ['test', safeToken(list[1], '测试名')] };
    throw capabilityError('TEST_COMMAND_NOT_ALLOWED', 'cargo 只允许 `test [name]`（allowlist）');
  }
  throw capabilityError('TEST_COMMAND_NOT_ALLOWED', `测试工具不在 allowlist：${String(tool ?? '')}（仅 npm / cargo）`);
}

/** 最小环境变量：不透传宿主其余环境（凭据/token 不会进入测试进程）。 */
function minimalEnv() {
  const allow = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'COMSPEC', 'TEMP', 'TMP',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];
  const env = {};
  for (const key of allow) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.NO_COLOR = '1';
  env.CI = '1';
  return env;
}

function killTree(child, platform) {
  if (platform === 'win32') {
    // execFile 的 timeout 只杀直接子进程；npm.cmd 会派生更深的 cmd/node，须杀树。
    try { execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {}); } catch { /* 已退出 */ }
  } else {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}

export function createIsolatedTestRunner({ resolveWorkspace, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof resolveWorkspace !== 'function') {
    throw capabilityError('INVALID_PARAMS', 'createIsolatedTestRunner 需要 resolveWorkspace');
  }
  let running = 0;

  /**
   * 执行一次受控测试。`tool/args` 只接受 allowlist 形态；返回真实退出码与有界输出。
   * 绝不把调用方输入交给 shell；绝不读取 Owner 配置的 testCommand（那是 Owner 的
   * workspace.test.run 路径，与本 runner 无关）。
   */
  async function run({ workspaceId, tool, args, timeoutMs } = {}) {
    const entry = await resolveWorkspace(workspaceId);
    if (!entry?.root) throw capabilityError('WORKSPACE_NOT_FOUND', String(workspaceId ?? ''));
    const { file, args: argv } = resolveCommand(tool, args);
    // win32：npm 是 .cmd shim，Node 禁止 shell:false 直接 spawn .cmd（CVE-2024-27980），
    // 用显式 cmd.exe /d /s /c 包装；所有 argv token 已通过 safeToken（无 shell 元字符）。
    let spawnFile = file;
    let spawnArgs = argv;
    if (process.platform === 'win32' && file === 'npm') {
      spawnFile = process.env.COMSPEC || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', 'npm.cmd', ...argv];
    }
    const timeout = Math.max(1000, Math.min(Number(timeoutMs) || RUNNER_LIMITS.defaultTimeoutMs, RUNNER_LIMITS.maxTimeoutMs));
    if (running >= 4) throw capabilityError('RUNNER_BUSY', '已有 4 个测试进程在运行，稍后再试');
    running += 1;
    const startedAt = now();
    try {
      return await new Promise((resolve) => {
        const child = execFile(spawnFile, spawnArgs, {
          cwd: path.resolve(entry.root),
          env: minimalEnv(),
          timeout,
          maxBuffer: RUNNER_LIMITS.maxOutputBytes,
          windowsHide: true,
          killSignal: 'SIGKILL'
        }, (error, stdout, stderr) => {
          const durationMs = now() - startedAt;
          const timedOut = Boolean(error) && (error.killed === true || error.signal === 'SIGKILL');
          if (timedOut) killTree(child, process.platform);
          const exitCode = error
            ? (typeof error.code === 'number' ? error.code : timedOut ? 124 : 1)
            : 0;
          resolve({
            exitCode,
            timedOut,
            command: `${file} ${argv.join(' ')}`,
            cwd: path.resolve(entry.root),
            stdout: String(stdout ?? '').slice(0, RUNNER_LIMITS.stdoutCapChars),
            stderr: String(stderr ?? '').slice(0, RUNNER_LIMITS.stderrCapChars),
            truncated: String(stdout ?? '').length > RUNNER_LIMITS.stdoutCapChars
              || String(stderr ?? '').length > RUNNER_LIMITS.stderrCapChars,
            durationMs
          });
        });
        // stdin 关闭：测试进程拿不到交互输入。
        try { child.stdin?.destroy(); } catch { /* 已退出 */ }
        void log;
      });
    } finally {
      running -= 1;
    }
  }

  return { run, limits: RUNNER_LIMITS };
}
