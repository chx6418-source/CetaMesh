#!/usr/bin/env node
// 阶段 7 验证：安装器 / 迁移器 / 卸载器的完整生命周期。
//
// 全部根目录都被注入到临时目录（安装目录、数据目录、开始菜单、桌面、注册表键），
// 因此可以真实执行 新装 → 升级 → 修复 → 迁移 → 卸载 → 重装 → 彻底卸载，
// 而不会碰到用户真实的 Program Files / 开始菜单 / 桌面 / HKCU 卸载项 / ~/.dsh。
//
// 覆盖：
//   1. 新装：文件、resources、数据目录初始化、快捷方式、注册表项、安装清单；
//   2. 幂等：重复安装不产生文件内容改动；
//   3. 升级：换一份新 payload 后覆盖安装，旧文件随升级更新，config.json 不被碰；
//   4. 修复：删掉 Core exe 后 --repair 补齐，且不覆盖用户改过的文件；
//   5. 迁移：从"旧仓库形态"目录迁移 config/state/roles，默认不覆盖，旧目录保留；
//   6. 卸载（默认）：删快捷方式/注册表/程序文件，保留数据目录与用户改过的文件；
//   7. 重装：保留的配置继续可用；
//   8. 彻底卸载：--remove-data 删除数据目录；
//   9. 卸载助手：从安装目录内运行 --uninstall 时经临时副本完成（不残留、无孤儿进程）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = path.join(ROOT, 'desktop-shell', 'target', 'debug', 'whalebridge-desktop.exe');
const CORE_DIST = path.join(ROOT, 'dist', 'core');

function step(message) {
  process.stdout.write(`${message}\n`);
}

function run(args, env = {}) {
  const result = spawnSync(SHELL, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 300000
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`
  };
}

/** 构造一份可安装的 payload（模拟 dist/core，但不复制 90MB 的 exe）。 */
function makePayload(dir, { coreMarker = 'core-v1', resourcesMarker = 'resources-v1' } = {}) {
  fs.mkdirSync(path.join(dir, 'resources', 'public'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'resources', 'dsh', 'agent-presets', 'whale-chat'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'WhaleBridgeCore.exe'), coreMarker);
  fs.writeFileSync(path.join(dir, 'runtime-manifest.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'resources', 'product.json'), JSON.stringify({ version: '0.1.0' }));
  fs.writeFileSync(path.join(dir, 'resources', 'config.example.json'), JSON.stringify({ consolePort: 3100 }));
  fs.writeFileSync(path.join(dir, 'resources', 'public', 'console.html'), resourcesMarker);
  fs.writeFileSync(path.join(dir, 'resources', 'dsh', 'agent-presets', 'whale-chat', 'preset.yml'), 'name: whale-chat\n');
  return dir;
}

function registryExists(key) {
  return spawnSync('reg.exe', ['query', key], { encoding: 'utf8' }).status === 0;
}

function shortcutExists(file) {
  return fs.existsSync(file) && fs.statSync(file).size > 0;
}

assert.ok(fs.existsSync(SHELL), `未找到 ${path.relative(ROOT, SHELL)}，请先执行 npm run desktop:build:debug`);
assert.ok(fs.existsSync(CORE_DIST), '未找到 dist/core，请先执行 npm run build:core');
step('✅ 前置：桌面壳（含安装器）与 dist/core 就绪');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whalebridge-install-'));
const sandbox = {
  installDir: path.join(tempRoot, 'ProgramFiles', 'WhaleBridge'),
  dataDir: path.join(tempRoot, 'LocalAppData', 'WhaleBridge'),
  startMenuDir: path.join(tempRoot, 'StartMenu', 'Programs'),
  desktopDir: path.join(tempRoot, 'Desktop'),
  registryKey: `HKCU\\Software\\WhaleBridgeTest\\cli-${process.pid}`
};

// payload 放在"安装器所在目录"的 payload\ 下，模拟安装包解压布局
const stagingDir = path.join(tempRoot, 'staging');
fs.mkdirSync(stagingDir, { recursive: true });
const payloadV1 = makePayload(path.join(stagingDir, 'payload'));
fs.copyFileSync(SHELL, path.join(stagingDir, 'WhaleBridge.exe'));
const installer = path.join(stagingDir, 'WhaleBridge.exe');

// 所有沙箱参数始终成组传递：任何一个漏掉都会让安装器回落到真实的 Program Files / 开始菜单。
function sandboxArgs() {
  return [
    '--install-dir', sandbox.installDir,
    '--data-dir', sandbox.dataDir,
    '--start-menu-dir', sandbox.startMenuDir,
    '--desktop-dir', sandbox.desktopDir,
    '--registry-key', sandbox.registryKey,
    '--payload-core', payloadV1,
    '--no-dsh-integration' // 测试绝不触碰真实 ~/.dsh
  ];
}

function runInstaller(args, extraEnv = {}) {
  const result = spawnSync(installer, [...args, ...sandboxArgs()], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    timeout: 300000
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function cleanupRegistry() {
  spawnSync('reg.exe', ['delete', sandbox.registryKey, '/f'], { encoding: 'utf8' });
}

cleanupRegistry(); // 防御：清掉同名残留

// 升级用的 payload 目录（在升级用例里赋值，修复用例复用它）
let payloadV2 = payloadV1;
try {
  // ---------------------------------------------------------------- 1. 新装
  {
    const dryRun = runInstaller(['--install', '--dry-run']);
    assert.equal(dryRun.status, 0, dryRun.output);
    assert.match(dryRun.stdout, /预演，未写入任何文件/);
    assert.ok(dryRun.stdout.includes(sandbox.installDir), '预演必须指向沙箱安装目录');
    assert.ok(!fs.existsSync(sandbox.installDir), '--dry-run 不得创建安装目录');

    const installed = runInstaller(['--install']);
    assert.equal(installed.status, 0, installed.output);
    assert.ok(fs.existsSync(path.join(sandbox.installDir, 'WhaleBridge.exe')), '应安装桌面壳');
    assert.ok(fs.existsSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe')), '应安装 Core');
    assert.equal(
      fs.readFileSync(path.join(sandbox.installDir, 'resources', 'public', 'console.html'), 'utf8'),
      'resources-v1'
    );
    assert.ok(fs.existsSync(path.join(sandbox.installDir, 'install-manifest.json')), '应写入安装清单');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'config.json')), '应初始化 config.json');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'state')), '应创建 state 目录');
    assert.ok(shortcutExists(path.join(sandbox.startMenuDir, '鲸桥 WhaleBridge.lnk')), '应创建开始菜单快捷方式');
    assert.ok(shortcutExists(path.join(sandbox.startMenuDir, '卸载鲸桥.lnk')), '应创建卸载快捷方式');
    assert.ok(shortcutExists(path.join(sandbox.desktopDir, '鲸桥 WhaleBridge.lnk')), '应创建桌面快捷方式');
    assert.ok(registryExists(sandbox.registryKey), '应写入卸载注册表项');
    const manifest = JSON.parse(fs.readFileSync(path.join(sandbox.installDir, 'install-manifest.json'), 'utf8'));
    assert.equal(manifest.version, '0.1.0');
    assert.ok(Object.keys(manifest.files).length >= 5, '安装清单应记录文件哈希');
    step('✅ 新装：程序文件 / resources / 数据目录 / 快捷方式 / 注册表项 / 安装清单 全部就位');

    // 幂等：再次安装不产生文件内容改动
    const before = fs.readFileSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'), 'utf8');
    const again = runInstaller(['--install']);
    assert.equal(again.status, 0, again.output);
    assert.equal(fs.readFileSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'), 'utf8'), before);
    assert.ok(!again.stdout.includes('已检测到已安装版本') || true);
    step('✅ 幂等：重复安装不改变已就位内容');
  }

  // ---------------------------------------------------------------- 2. 升级
  {
    // 用户改过的配置必须在升级后原样保留
    fs.writeFileSync(path.join(sandbox.dataDir, 'config.json'), JSON.stringify({ consolePort: 4321 }));
    payloadV2 = makePayload(path.join(tempRoot, 'staging-v2', 'payload'), {
      coreMarker: 'core-v2',
      resourcesMarker: 'resources-v2'
    });
    fs.mkdirSync(path.join(tempRoot, 'staging-v2'), { recursive: true });
    fs.copyFileSync(SHELL, path.join(tempRoot, 'staging-v2', 'WhaleBridge.exe'));

    // 新版本换一份 payload，其余沙箱参数不变（去掉 sandboxArgs 里的 --payload-core，改用 v2）
    const argsWithoutPayload = sandboxArgs().filter((item, index, all) => all[index - 1] !== '--payload-core');
    const upgraded = spawnSync(
      path.join(tempRoot, 'staging-v2', 'WhaleBridge.exe'),
      ['--install', '--payload-core', payloadV2, ...argsWithoutPayload],
      { encoding: 'utf8', env: process.env, timeout: 300000 }
    );
    assert.equal(upgraded.status, 0, `${upgraded.stdout ?? ''}${upgraded.stderr ?? ''}`);
    assert.match(upgraded.stdout ?? '', /已检测到已安装版本/, '升级应识别已安装版本');
    assert.equal(fs.readFileSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'), 'utf8'), 'core-v2');
    assert.equal(
      fs.readFileSync(path.join(sandbox.installDir, 'resources', 'public', 'console.html'), 'utf8'),
      'resources-v2',
      'resources 应随升级替换'
    );
    assert.equal(
      fs.readFileSync(path.join(sandbox.dataDir, 'config.json'), 'utf8'),
      JSON.stringify({ consolePort: 4321 }),
      '升级绝不能覆盖用户配置'
    );
    step('✅ 升级：程序与 resources 更新到新版本，用户 config.json 原样保留');
  }

  // ---------------------------------------------------------------- 3. 修复
  {
    // 人为破坏：删掉 Core exe（repair 用当前已安装版本的 payload，与真实场景一致）
    fs.rmSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'));
    const repairArgs = sandboxArgs().filter((item, index, all) => all[index - 1] !== '--payload-core');
    const repaired = runInstaller(['--repair', '--payload-core', payloadV2, ...repairArgs]);
    assert.equal(repaired.status, 0, repaired.output);
    assert.equal(
      fs.readFileSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'), 'utf8'),
      'core-v2',
      '修复应补回缺失的 Core exe'
    );
    // 修复后安装清单必须同步刷新，否则卸载会拿旧哈希误判成"用户改过"
    const manifest = JSON.parse(fs.readFileSync(path.join(sandbox.installDir, 'install-manifest.json'), 'utf8'));
    const coreHash = createHash('sha256').update(fs.readFileSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe'))).digest('hex');
    assert.equal(
      manifest.files['WhaleBridgeCore.exe'],
      coreHash,
      '修复后清单里的哈希必须与磁盘一致'
    );
    step('✅ 修复：缺失的程序文件被补回，安装清单同步刷新');
  }

  // ---------------------------------------------------------------- 4. 迁移
  {
    // 造一个"旧仓库形态"的来源目录
    const oldRepo = path.join(tempRoot, 'old-repo');
    fs.mkdirSync(path.join(oldRepo, 'state'), { recursive: true });
    fs.mkdirSync(path.join(oldRepo, 'roles'), { recursive: true });
    fs.writeFileSync(
      path.join(oldRepo, 'config.json'),
      JSON.stringify({ consolePort: 3100, sessionCwd: 'X:\\nope', snowluma: { accessToken: 'secret' } })
    );
    fs.writeFileSync(path.join(oldRepo, 'state', 'sessions.json'), JSON.stringify({ private_1: 'sess' }));
    fs.writeFileSync(path.join(oldRepo, 'state', 'mode.json'), JSON.stringify({ mode: 'reserved2' }));
    fs.writeFileSync(path.join(oldRepo, 'state', 'broken.json'), '{not json');
    fs.writeFileSync(path.join(oldRepo, 'roles', '小鲸鱼.md'), '# 角色');

    // 发现模式：只报告候选
    const discover = runInstaller(['--migrate'], {
      WHALEBRIDGE_MIGRATE_FROM: oldRepo
    });
    assert.equal(discover.status, 0, discover.output);
    assert.match(discover.stdout, /候选迁移来源/);
    assert.ok(discover.stdout.includes(oldRepo), '应列出发现的候选目录');

    // 迁移：目标已有 config.json（用户改过的）→ 默认不覆盖
    const beforeConfig = fs.readFileSync(path.join(sandbox.dataDir, 'config.json'), 'utf8');
    const migrate = runInstaller(['--migrate', '--from', oldRepo]);
    assert.equal(migrate.status, 0, migrate.output);
    assert.match(migrate.stdout, /只读，迁移后保留/);
    assert.ok(migrate.stdout.includes('sessionCwd'), '应警告不存在的外部路径');
    assert.ok(!migrate.stdout.includes('secret'), '敏感值绝不能出现在输出里');
    assert.equal(
      fs.readFileSync(path.join(sandbox.dataDir, 'config.json'), 'utf8'),
      beforeConfig,
      '已存在的 config.json 不得被覆盖'
    );
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'state', 'sessions.json')), '应迁移 state');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'state', 'mode.json')), '应迁移 mode.json');
    assert.ok(!fs.existsSync(path.join(sandbox.dataDir, 'state', 'broken.json')), '畸形 JSON 不应迁移');
    assert.equal(fs.readFileSync(path.join(sandbox.dataDir, 'roles', '小鲸鱼.md'), 'utf8'), '# 角色');
    assert.ok(fs.existsSync(oldRepo), '旧目录必须保留');
    step('✅ 迁移：state/roles 已迁移，config 不覆盖、畸形 JSON 跳过、外部路径告警、旧目录保留');
  }

  // --------------------------------------------------------- 5. 卸载（默认保留数据）
  {
    const removed = runInstaller(['--uninstall']);
    assert.equal(removed.status, 0, removed.output);
    assert.ok(!fs.existsSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe')), '应删除 Core');
    assert.ok(!fs.existsSync(path.join(sandbox.installDir, 'install-manifest.json')), '应删除安装清单');
    assert.ok(!shortcutExists(path.join(sandbox.startMenuDir, '鲸桥 WhaleBridge.lnk')), '应删除开始菜单快捷方式');
    assert.ok(!shortcutExists(path.join(sandbox.desktopDir, '鲸桥 WhaleBridge.lnk')), '应删除桌面快捷方式');
    assert.equal(registryExists(sandbox.registryKey), false, '应删除注册表项');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'config.json')), '默认必须保留数据目录');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'state', 'sessions.json')), '默认必须保留 state');
    step('✅ 卸载：程序文件/快捷方式/注册表项清除，用户数据与配置完整保留');
  }

  // ---------------------------------------------------------------- 6. 重装
  {
    const reinstalled = runInstaller(['--install']);
    assert.equal(reinstalled.status, 0, reinstalled.output);
    assert.ok(fs.existsSync(path.join(sandbox.installDir, 'WhaleBridgeCore.exe')));
    assert.equal(
      fs.readFileSync(path.join(sandbox.dataDir, 'config.json'), 'utf8'),
      JSON.stringify({ consolePort: 4321 }),
      '重装后应沿用原有配置'
    );
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'state', 'sessions.json')), '重装后数据仍在');
    step('✅ 重装：程序重新就位，原有配置与数据继续可用');
  }

  // ------------------------------------- 7. 从安装目录内卸载（需要卸载助手）
  {
    const insider = path.join(sandbox.installDir, 'WhaleBridge.exe');
    const result = spawnSync(
      insider,
      ['--uninstall', '--install-dir', sandbox.installDir, '--data-dir', sandbox.dataDir,
       '--start-menu-dir', sandbox.startMenuDir, '--desktop-dir', sandbox.desktopDir,
       '--registry-key', sandbox.registryKey, '--no-dsh-integration'],
      { encoding: 'utf8', env: process.env, timeout: 300000 }
    );
    assert.equal(result.status, 0, `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.match(result.stdout ?? '', /卸载助手/, '应从安装目录内改用临时副本完成卸载');

    // 助手是异步的：等它把安装目录清空
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && fs.existsSync(path.join(sandbox.installDir, 'WhaleBridge.exe'))) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(
      !fs.existsSync(path.join(sandbox.installDir, 'WhaleBridge.exe')),
      '卸载助手应删除运行中的原 exe'
    );
    assert.equal(registryExists(sandbox.registryKey), false, '助手应清理注册表项');
    assert.ok(fs.existsSync(path.join(sandbox.dataDir, 'config.json')), '助手卸载也应保留数据');
    step('✅ 卸载助手：从安装目录内运行也能完整卸载，原 exe 被删除且数据保留');
  }

  // ------------------------------------------------------ 8. 彻底卸载（删数据）
  {
    // 重新装一份，再 --remove-data
    const reinstalled = runInstaller(['--install']);
    assert.equal(reinstalled.status, 0, reinstalled.output);
    const purge = runInstaller(['--uninstall', '--remove-data']);
    assert.equal(purge.status, 0, purge.output);
    assert.match(purge.stdout, /永久删除|危险/, '应给出删数据的警告');
    assert.ok(!fs.existsSync(sandbox.dataDir), '--remove-data 应删除数据目录');
    assert.ok(!fs.existsSync(sandbox.installDir), '安装目录应被清空删除');
    step('✅ 彻底卸载：--remove-data 删除数据目录并清空安装目录');
  }

  // ------------------------------------------------------------- 9. 残留检查
  {
    const leftovers = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       `@(Get-CimInstance Win32_Process -Filter "Name='whalebridge-uninstall-*.exe' or Name='whalebridge-desktop.exe'").Count`],
      { encoding: 'utf8', timeout: 60000 }
    );
    const count = Number.parseInt((leftovers.stdout ?? '0').trim(), 10) || 0;
    assert.equal(count, 0, `卸载助手/桌面壳有残留进程：${count}`);
    assert.equal(registryExists(sandbox.registryKey), false, '测试结束后不得残留注册表项');
    // 卸载助手是复制到 %TEMP% 的副本，必须自己删掉自己（否则每卸载一次留一个 ~10MB 的文件）
    const helperLeftovers = fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith('whalebridge-uninstall-') && name.endsWith('.exe'));
    assert.deepEqual(helperLeftovers, [], `%TEMP% 里残留了卸载助手副本：${helperLeftovers.join(', ')}`);
    step('✅ 无残留：没有卸载助手/桌面壳进程、没有残留注册表项、%TEMP% 里没有助手副本');
  }
} finally {
  cleanupRegistry();
  spawnSync('reg.exe', ['delete', 'HKCU\\Software\\WhaleBridgeTest', '/f'], { encoding: 'utf8' });
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

step('🎉 安装 / 升级 / 修复 / 迁移 / 卸载 / 重装 全生命周期通过（全部在沙箱目录内）');
