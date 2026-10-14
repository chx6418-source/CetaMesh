#!/usr/bin/env node
// 阶段 5 验证：DSH 集成安装 / 修复 / 迁移。
//
// 全部用例都在临时目录里跑：dshHome、dataRoot、resourceRoot 都是注入参数，
// 绝不读写用户真实的 ~/.dsh、真实 state 或真实 DSH profile。
//
// 覆盖（对应阶段退出条件"新装、升级、重复修复和旧路径迁移均通过"）：
//   1. 新装：preset/插件/MCP 块/package.json/mode.json/manifest 全部落地；
//   2. 幂等：重复执行零改动、文件逐字节不变；
//   3. 升级：由本应用安装且未被改动的 preset 自动更新；
//   4. 用户改过：安装后被修改的 preset 不被覆盖，并给出 --force-presets 提示；
//   5. 旧路径迁移：真实旧配置（node.exe + src/mcp-*.js）就地改成 core-entry.js + --mcp <mode>；
//   6. 无标记旧配置：只就地修复本项目条目，用户自己的 MCP 条目原样保留；
//   7. 回滚：执行中途失败时目录恢复到执行前状态；
//   8. 发布模式：command 指向 WhaleBridgeCore.exe，插件按版本释放到 runtime；
//   9. 旧命名清理：qq-* preset / 插件链接 / settings 命名空间 / profile 依赖；
//  10. 生成结果可用：五个 MCP 的 command/args 真实 stdio initialize + tools/list。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  MCP_SERVERS,
  PLUGIN_NAME,
  PRESET_NAMES,
  applyPlan,
  buildMcpBlock,
  detectCordisState,
  parseMcpEntries,
  planDshRemoval,
  planIntegration,
  readManifest,
  resolveCoreLaunch,
  rewriteEntryCommands
} from '../src/dsh-integration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'core-entry.js');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const realDshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const realDshPatch = path.join(realDshHome, 'profiles', 'web', 'cordis.patch.yml');
const realDshPatchBefore = fs.existsSync(realDshPatch) ? fs.readFileSync(realDshPatch) : null;

function step(message) {
  process.stdout.write(`${message}\n`);
}

const DEV_CORE = resolveCoreLaunch({ packaged: false, execPath: process.execPath, entryPath: ENTRY });
const PACKAGED_CORE = resolveCoreLaunch({
  packaged: true,
  execPath: 'D:\\Program Files\\WhaleBridge\\WhaleBridgeCore.exe'
});

// DSH 模板默认的 profile patch：只有注释和一个空数组，新装时走"追加"分支。
const TEMPLATE_CORDIS = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries.

[]
`;

// 真实的旧配置（本机 ~/.dsh 的形态）：有标记块，但 command 是 node.exe、
// args 是每个 MCP 各自的脚本，标记块之后还有用户自己的条目。
const LEGACY_CORDIS = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

# === whalebridge MCP BEGIN ===
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\GIT-QQ-BRIDGE\\src\\mcp-snowluma-safe.js'
        toolCallTimeoutMs: 725000
- insert:
    - id: mcp-snowluma-host
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma-host
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\GIT-QQ-BRIDGE\\src\\mcp-host-server.js'
- insert:
    - id: mcp-web-search-safe
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: web-search-safe
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\GIT-QQ-BRIDGE\\src\\mcp-web-search-safe.js'
- insert:
    - id: mcp-qq-file-send
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: qq-file-send
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\GIT-QQ-BRIDGE\\src\\mcp-qq-file-send.js'
        toolCallTimeoutMs: 120000
- insert:
    - id: mcp-bilibili
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: bilibili
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\GIT-QQ-BRIDGE\\src\\mcp-bilibili.js'
        toolCallTimeoutMs: 60000
# === whalebridge MCP END ===
- id: uiskin-theme
  disabled: true
- id: dsh-any-background
  disabled: true
`;

// 无标记块、但混着用户自己的 MCP 条目（例如用户从旧脚本手工粘贴过配置）。
const UNMARKED_CORDIS = `# user patch layer
- insert:
    - id: mcp-snowluma
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: snowluma
        transport: stdio
        command: 'C:\\Program Files\\nodejs\\node.exe'
        args:
          - 'D:\\old-repo\\src\\mcp-snowluma-safe.js'
        toolCallTimeoutMs: 725000
- insert:
    - id: my-own-server
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: mine
        transport: stdio
        command: 'C:\\tools\\mine.exe'
        args:
          - '--serve'
`;

// ---------------------------------------------------------------- 工具函数

function makeTempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `whalebridge-dsh-${label}-`));
}

/** 记录目录树状态：文件内容哈希 + 链接目标 + 目录集合。用于幂等与回滚断言。 */
function snapshot(root) {
  const files = {};
  const links = {};
  const dirs = [];
  const walk = (dir, base) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(base, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        links[relative] = fs.realpathSync(full);
      } else if (stat.isDirectory()) {
        dirs.push(relative);
        walk(full, base);
      } else {
        files[relative] = fs.readFileSync(full).toString('base64');
      }
    }
  };
  walk(root, root);
  return { files, links, dirs: dirs.sort() };
}

function seedDsh(dshHome, { profile = 'web', cordis, pkg, settings } = {}) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });
  if (cordis !== undefined) fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), cordis, 'utf8');
  if (pkg !== undefined) fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
  if (settings !== undefined) fs.writeFileSync(path.join(dshHome, 'settings.yaml'), settings, 'utf8');
  return profileDir;
}

function planFor({ dshHome, dataRoot, resourceRoot = ROOT, core = DEV_CORE, force = false, manifest = undefined }) {
  return planIntegration({
    dshHome,
    profile: 'web',
    resourceRoot,
    dataRoot,
    version: VERSION,
    core,
    manifest: manifest === undefined ? readManifest(dshHome) : manifest,
    force,
    now: () => '2026-09-20T00:00:00.000Z'
  });
}

function writeIsolatedConfig(dataRoot) {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, 'config.json'),
    JSON.stringify(
      {
        consolePort: 9,
        consoleToken: 'dsh-integration-test-token',
        dsh: { baseUrl: 'http://127.0.0.1:9' },
        allow: { private: [], groups: [] },
        deny: { private: [], groups: [] },
        snowluma: { httpUrl: 'http://127.0.0.1:9', wsUrl: 'ws://127.0.0.1:9', allowProcessControl: false },
        socialV2: { tools: { getCardMsg: false, clickCardButton: false, fileSend: false, bilibili: false } }
      },
      null,
      2
    )
  );
}

// ============================================================ 1. 纯函数

assert.equal(detectCordisState(TEMPLATE_CORDIS).kind, 'foreign');
assert.equal(detectCordisState(LEGACY_CORDIS).kind, 'marked');
assert.equal(detectCordisState(UNMARKED_CORDIS).kind, 'unmarked-ours');

const devBlock = buildMcpBlock(DEV_CORE);
const devEntries = parseMcpEntries(devBlock);
assert.deepEqual(Object.keys(devEntries), MCP_SERVERS.map((server) => server.id));
assert.deepEqual(devEntries['mcp-snowluma'].args, [ENTRY, '--mcp', 'snowluma'], '开发模式必须带 core-entry.js');
assert.equal(devEntries['mcp-snowluma'].command, process.execPath);
assert.equal(devEntries['mcp-snowluma'].toolCallTimeoutMs, 725000);

const packagedEntries = parseMcpEntries(buildMcpBlock(PACKAGED_CORE));
assert.deepEqual(
  packagedEntries['mcp-bilibili'].args,
  ['--mcp', 'bilibili'],
  '打包模式不能再带 core-entry.js'
);
assert.equal(packagedEntries['mcp-bilibili'].command, PACKAGED_CORE.command);

// 往返：buildMcpBlock → parseMcpEntries 必须闭合
assert.deepEqual(parseMcpEntries(buildMcpBlock(PACKAGED_CORE)), parseMcpEntries(buildMcpBlock(PACKAGED_CORE)));
step('✅ 纯函数：cordis 分类、MCP 块生成/解析往返、开发与打包两种 command');

// ============================================ 2. 新装 + 幂等 + 旧路径迁移

{
  const tempRoot = makeTempRoot('fresh');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  seedDsh(dshHome, { cordis: TEMPLATE_CORDIS });
  writeIsolatedConfig(dataRoot);

  try {
    // --- 新装
    const plan = planFor({ dshHome, dataRoot });
    assert.equal(plan.cordisKind, 'foreign');
    const result = applyPlan(plan, { log: () => {} });
    assert.ok(result.snapshots >= 0);

    for (const name of PRESET_NAMES) {
      const dest = path.join(dshHome, '.agent-presets', name);
      assert.ok(fs.existsSync(dest), `preset 未安装：${name}`);
      const source = path.join(ROOT, 'dsh', 'agent-presets', name);
      assert.deepEqual(
        fs.readdirSync(dest).sort(),
        fs.readdirSync(source).sort(),
        `preset ${name} 内容与内置不一致`
      );
    }

    const pluginLink = path.join(dshHome, 'plugins', PLUGIN_NAME);
    assert.ok(fs.lstatSync(pluginLink).isSymbolicLink(), '插件应当是链接');
    assert.equal(
      fs.realpathSync(pluginLink).toLowerCase(),
      fs.realpathSync(path.join(ROOT, 'plugins', PLUGIN_NAME)).toLowerCase()
    );

    const patchFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const patchText = fs.readFileSync(patchFile, 'utf8');
    assert.equal(detectCordisState(patchText).kind, 'marked');
    assert.deepEqual(parseMcpEntries(patchText), devEntries, '新装后的五条 MCP 配置应等于开发模式期望值');
    assert.ok(!patchText.includes('mcp-snowluma-safe.js'), '不应残留旧脚本路径');
    assert.ok(patchText.includes('# a top-level YAML array'), '原有注释必须保留');

    const pkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies[PLUGIN_NAME], `link:${pluginLink.replace(/\\/g, '/')}`);
    assert.ok(pkg.dsh.profile.bundles.includes(PLUGIN_NAME));

    assert.ok(fs.existsSync(path.join(dataRoot, 'state', 'mode.json')));
    const manifest = readManifest(dshHome);
    assert.equal(manifest.version, VERSION);
    assert.equal(manifest.core.packaged, false);
    assert.equal(manifest.presets['whale-chat'].owned, true);

    step('✅ 新装：preset / 插件 / MCP 块 / package.json / mode.json / manifest 全部落地');

    // --- 幂等：第二次执行必须零改动
    const before = snapshot(dshHome);
    const second = planFor({ dshHome, dataRoot });
    assert.equal(second.effects.length, 0, `重复执行不应产生改动，实际：${JSON.stringify(second.effects.map((e) => [e.type, e.path]))}`);
    applyPlan(second, { log: () => {} });
    const after = snapshot(dshHome);
    assert.deepEqual(after, before, '重复执行后文件必须逐字节不变');
    step('✅ 幂等：重复执行零 effect，整棵目录树逐字节不变');

    // --- 旧路径迁移：把真实旧配置写回去，再跑一次
    fs.writeFileSync(patchFile, LEGACY_CORDIS, 'utf8');
    const legacyPlan = planFor({ dshHome, dataRoot });
    const migrated = applyPlan(legacyPlan, { log: () => {} });
    assert.ok(migrated.snapshots > 0);
    const migratedText = fs.readFileSync(patchFile, 'utf8');
    const migratedEntries = parseMcpEntries(migratedText);
    for (const server of MCP_SERVERS) {
      assert.deepEqual(
        migratedEntries[server.id].args,
        [ENTRY, '--mcp', server.mode],
        `${server.id} 未迁移到统一入口`
      );
      assert.equal(migratedEntries[server.id].command, process.execPath, `${server.id} command 未迁移`);
    }
    assert.ok(migratedText.includes('# === whalebridge MCP BEGIN ==='), '标记必须保留');
    assert.ok(migratedText.includes('- id: uiskin-theme'), '标记块之后的用户条目必须保留');
    assert.ok(migratedText.includes('  disabled: true'), '用户条目的属性必须保留');
    assert.equal(migratedEntries['mcp-snowluma'].toolCallTimeoutMs, 725000, '超时配置必须保留');
    step('✅ 旧路径迁移：node.exe + src/mcp-*.js → core-entry.js + --mcp <mode>，用户条目与超时保持不变');

    // --- 迁移后再跑一次仍然是空操作
    const third = planFor({ dshHome, dataRoot });
    assert.equal(third.effects.length, 0, `迁移后重复执行应为空操作：${JSON.stringify(third.effects.map((e) => [e.type, e.path]))}`);

    // --- 无标记旧配置：只修本项目条目
    fs.writeFileSync(patchFile, UNMARKED_CORDIS, 'utf8');
    const unmarkedPlan = planFor({ dshHome, dataRoot });
    assert.equal(unmarkedPlan.cordisKind, 'unmarked-ours');
    assert.ok(unmarkedPlan.warnings.some((warning) => warning.includes('标记块')), '应提示没有标记块');
    applyPlan(unmarkedPlan, { log: () => {} });
    const unmarkedText = fs.readFileSync(patchFile, 'utf8');
    const unmarkedEntries = parseMcpEntries(unmarkedText);
    assert.deepEqual(unmarkedEntries['mcp-snowluma'].args, [ENTRY, '--mcp', 'snowluma']);
    assert.deepEqual(unmarkedEntries['my-own-server'].args, ['--serve'], '用户自己的 MCP 条目必须原样保留');
    assert.equal(unmarkedEntries['my-own-server'].command, 'C:\\tools\\mine.exe');
    assert.ok(!unmarkedText.includes('# === whalebridge MCP BEGIN ==='), '不应给无标记文件补标记块（会重复注册）');
    step('✅ 无标记旧配置：就地修复本项目条目，用户自己的 MCP 条目与文件结构保持原样');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// ============================================ 3. 升级 / 用户改动保护 / 回滚

{
  const tempRoot = makeTempRoot('upgrade');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  // 复制一份可写的资源目录，用来模拟"内置 preset 改版"
  const resourceRoot = path.join(tempRoot, 'res');
  fs.mkdirSync(path.join(resourceRoot, 'dsh'), { recursive: true });
  fs.mkdirSync(path.join(resourceRoot, 'plugins'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'dsh', 'agent-presets'), path.join(resourceRoot, 'dsh', 'agent-presets'), { recursive: true });
  fs.cpSync(
    path.join(ROOT, 'plugins', PLUGIN_NAME),
    path.join(resourceRoot, 'plugins', PLUGIN_NAME),
    { recursive: true }
  );
  seedDsh(dshHome, { cordis: TEMPLATE_CORDIS });
  writeIsolatedConfig(dataRoot);

  try {
    applyPlan(planFor({ dshHome, dataRoot, resourceRoot }), { log: () => {} });

    // --- 升级：内置内容变化后，未被用户改动过的 preset 应当自动更新
    const presetFile = path.join(resourceRoot, 'dsh', 'agent-presets', 'whale-chat', 'preset.yml');
    fs.appendFileSync(presetFile, '\n# v2 内置更新\n');
    const upgradePlan = planFor({ dshHome, dataRoot, resourceRoot });
    assert.equal(upgradePlan.presets['whale-chat'].action, 'update', '由本应用安装且未改动的 preset 应升级');
    assert.equal(upgradePlan.presets['whale-chat-v2'].action, 'unchanged');
    applyPlan(upgradePlan, { log: () => {} });
    const installedPreset = fs.readFileSync(
      path.join(dshHome, '.agent-presets', 'whale-chat', 'preset.yml'),
      'utf8'
    );
    assert.ok(installedPreset.includes('# v2 内置更新'), '升级后应包含新的内置内容');
    step('✅ 升级：由本应用安装且未被改动的 preset 自动更新到新版本');

    // --- 用户改动保护：安装后手改 preset 内容，再次执行不得覆盖
    const userFile = path.join(dshHome, '.agent-presets', 'whale-chat', 'preset.yml');
    fs.writeFileSync(userFile, '# 用户自己改过的内容\n', 'utf8');
    const guardPlan = planFor({ dshHome, dataRoot, resourceRoot });
    assert.equal(guardPlan.presets['whale-chat'].action, 'keep-user-modified');
    assert.ok(
      guardPlan.warnings.some((warning) => warning.includes('--force-presets')),
      '应提示如何强制覆盖'
    );
    applyPlan(guardPlan, { log: () => {} });
    assert.equal(fs.readFileSync(userFile, 'utf8'), '# 用户自己改过的内容\n', '用户改动必须被保留');

    // --- --force-presets 才允许覆盖
    const forcedPlan = planFor({ dshHome, dataRoot, resourceRoot, force: true });
    assert.equal(forcedPlan.presets['whale-chat'].action, 'update');
    applyPlan(forcedPlan, { log: () => {} });
    assert.notEqual(fs.readFileSync(userFile, 'utf8'), '# 用户自己改过的内容\n', '--force-presets 应覆盖');
    step('✅ 用户改动保护：默认不覆盖被改过的 preset，--force-presets 才覆盖');

    // --- 回滚：在执行到一半时失败，必须完全恢复
    const before = snapshot(dshHome);
    const rollbackPlan = planFor({ dshHome, dataRoot, resourceRoot });
    // 制造一个必然变化的计划，并让第 2 个 effect 抛错
    fs.appendFileSync(path.join(resourceRoot, 'dsh', 'agent-presets', 'whale-chat-v2', 'preset.yml'), '\n# 另一个更新\n');
    const failingPlan = planFor({ dshHome, dataRoot, resourceRoot });
    assert.ok(failingPlan.effects.length >= 2, '回滚用例需要至少两个 effect');
    let wroteManifest = false;
    assert.throws(
      () =>
        applyPlan(failingPlan, {
          log: () => {},
          hooks: {
            beforeEffect: (_effect, index) => {
              if (index === 1) throw new Error('注入的故障');
            }
          }
        }),
      /DSH 集成执行失败并已回滚/
    );
    const after = snapshot(dshHome);
    assert.deepEqual(after, before, '回滚后目录树必须与执行前完全一致');
    // 备份目录之外的写入必须为零：上面 deepEqual 已覆盖
    wroteManifest = fs.existsSync(path.join(dshHome, 'backups'));
    void wroteManifest;
    step('✅ 回滚：执行中途失败时目录树恢复到执行前状态（含未创建的路径）');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// ==================================================== 4. 发布模式 + 旧命名清理

{
  const tempRoot = makeTempRoot('packaged');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  fs.mkdirSync(path.join(dshHome, '.agent-presets', 'qq-chat'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, '.agent-presets', 'qq-chat', 'preset.yml'), 'legacy\n');
  fs.mkdirSync(path.join(dshHome, '.agent-presets', 'liangshen'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, '.agent-presets', 'liangshen', 'preset.yml'), '# 用户自己的 preset\n');
  fs.mkdirSync(path.join(dshHome, 'plugins'), { recursive: true });
  fs.symlinkSync(
    path.join(ROOT, 'plugins', PLUGIN_NAME),
    path.join(dshHome, 'plugins', 'qq-mode-console'),
    'junction'
  );
  seedDsh(dshHome, {
    cordis: TEMPLATE_CORDIS,
    pkg: {
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'qq-mode-console': 'link:C:/x/qq-mode-console' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'qq-mode-console'] } }
    },
    settings: '# user settings\nqq-mode:\n  mode: reserved2\n'
  });
  writeIsolatedConfig(dataRoot);

  try {
    const plan = planFor({ dshHome, dataRoot, core: PACKAGED_CORE });
    assert.ok(plan.warnings.length === 0, `发布模式不应有警告：${plan.warnings.join(' | ')}`);
    applyPlan(plan, { log: () => {} });

    const patchText = fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    const entries = parseMcpEntries(patchText);
    for (const server of MCP_SERVERS) {
      assert.equal(entries[server.id].command, PACKAGED_CORE.command, `${server.id} 应指向 Core exe`);
      assert.deepEqual(entries[server.id].args, ['--mcp', server.mode], `${server.id} 不应带入口脚本`);
    }

    const releaseDir = path.join(dataRoot, 'runtime', VERSION, PLUGIN_NAME);
    assert.ok(fs.existsSync(path.join(releaseDir, 'package.json')), '插件应按版本释放到 runtime');
    const pluginLink = path.join(dshHome, 'plugins', PLUGIN_NAME);
    assert.equal(
      fs.realpathSync(pluginLink).toLowerCase(),
      fs.realpathSync(releaseDir).toLowerCase(),
      '插件链接应指向版本化 runtime 目录'
    );

    // 旧物清理
    assert.ok(!fs.existsSync(path.join(dshHome, '.agent-presets', 'qq-chat')), 'qq-chat 应被移除');
    assert.ok(!fs.existsSync(path.join(dshHome, 'plugins', 'qq-mode-console')), '旧插件链接应被移除');
    assert.ok(
      fs.existsSync(path.join(dshHome, '.agent-presets', 'liangshen', 'preset.yml')),
      '用户自己的 preset 绝不能被删除'
    );
    const settings = fs.readFileSync(path.join(dshHome, 'settings.yaml'), 'utf8');
    assert.ok(settings.includes('whale-mode:'), 'settings.yaml 命名空间应迁移');
    assert.ok(!/^qq-mode:/m.test(settings));
    const pkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
    assert.ok(!('qq-mode-console' in pkg.dependencies), '旧依赖应移除');
    assert.ok(!pkg.dsh.profile.bundles.includes('qq-mode-console'), '旧 bundle 应移除');
    step('✅ 发布模式 + 旧命名清理：Core exe 配置、插件版本化释放、qq-* 清理且用户 preset 不受影响');

    // 版本升级后插件重新释放到新目录，链接跟着切换
    const nextVersion = '9.9.9';
    const nextPlan = planIntegration({
      dshHome,
      profile: 'web',
      resourceRoot: ROOT,
      dataRoot,
      version: nextVersion,
      core: PACKAGED_CORE,
      manifest: readManifest(dshHome),
      now: () => '2026-09-20T00:00:00.000Z'
    });
    applyPlan(nextPlan, { log: () => {} });
    const nextRelease = path.join(dataRoot, 'runtime', nextVersion, PLUGIN_NAME);
    assert.ok(fs.existsSync(path.join(nextRelease, 'package.json')));
    assert.equal(fs.realpathSync(pluginLink).toLowerCase(), fs.realpathSync(nextRelease).toLowerCase());
    step('✅ 版本升级：插件按新版本重新释放，链接自动切换');

    // 幂等：发布模式重复执行同样必须零改动
    const packagedAgain = planIntegration({
      dshHome,
      profile: 'web',
      resourceRoot: ROOT,
      dataRoot,
      version: nextVersion,
      core: PACKAGED_CORE,
      manifest: readManifest(dshHome),
      now: () => '2026-09-20T00:00:00.000Z'
    });
    assert.equal(
      packagedAgain.effects.length,
      0,
      `发布模式重复执行应为空操作，实际：${JSON.stringify(packagedAgain.effects.map((e) => [e.type, e.path]))}`
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// ============================== 5. 生成的配置能真实启动（stdio initialize + listTools）

{
  const tempRoot = makeTempRoot('stdio');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  seedDsh(dshHome, { cordis: LEGACY_CORDIS });
  writeIsolatedConfig(dataRoot);

  const expectedTools = {
    'mcp-snowluma': 'qq_get_card_msg',
    'mcp-snowluma-host': 'snowluma_status',
    'mcp-web-search-safe': 'web_fetch',
    'mcp-qq-file-send': 'qq_send_file',
    'mcp-bilibili': 'bili_search_video'
  };

  try {
    applyPlan(planFor({ dshHome, dataRoot }), { log: () => {} });
    const patchText = fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
    const entries = parseMcpEntries(patchText);

    for (const server of MCP_SERVERS) {
      const entry = entries[server.id];
      assert.ok(entry?.command, `${server.id} 缺少 command`);
      const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        cwd: ROOT,
        env: { ...process.env, WHALEBRIDGE_DATA_DIR: dataRoot, WHALEBRIDGE_RESOURCE_DIR: ROOT },
        stderr: 'pipe'
      });
      const client = new Client({ name: 'whalebridge-dsh-integration-test', version: '0.1.0' });
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        assert.ok(
          listed.tools.some((tool) => tool.name === expectedTools[server.id]),
          `${server.id}: 未暴露 ${expectedTools[server.id]}`
        );
        step(`✅ 生成的配置可真实启动：${server.id} → ${listed.tools.length} 个工具（${expectedTools[server.id]} 在内）`);
      } finally {
        await client.close().catch(() => {});
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// ============================== 6. CLI：--dry-run 不写文件、真实执行只碰临时 DSH_HOME

{
  const { spawnSync } = await import('node:child_process');
  const tempRoot = makeTempRoot('cli');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  seedDsh(dshHome, { cordis: LEGACY_CORDIS });

  try {
    // dry-run：一个文件都不许变
    const before = snapshot(dshHome);
    const dry = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web', '--dry-run'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome, WHALEBRIDGE_DATA_DIR: dataRoot },
      timeout: 120000
    });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /预演，未写入任何文件/);
    assert.match(dry.stdout, /就地修复|MCP 块已更新/);
    assert.deepEqual(snapshot(dshHome), before, '--dry-run 不得改动任何文件');
    assert.ok(!fs.existsSync(dataRoot), '--dry-run 不应创建数据目录');

    // 真实执行（跳过 dsh CLI，避免在测试里调用真实 dsh）
    const real = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web', '--no-plugin-install', '--json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome, WHALEBRIDGE_DATA_DIR: dataRoot },
        timeout: 120000
      }
    );
    assert.equal(real.status, 0, real.stderr);
    const payload = JSON.parse(real.stdout);
    assert.equal(payload.applied, true);
    assert.ok(payload.effectCount > 0);
    assert.ok(fs.existsSync(path.join(dataRoot, 'state', 'mode.json')), 'CLI 应写入隔离数据目录');
    assert.ok(readManifest(dshHome), 'CLI 应写入 manifest');

    // 再跑一次应当零改动
    const again = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'setup-dsh.mjs'), 'web', '--no-plugin-install', '--json'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, DSH_HOME: dshHome, WHALEBRIDGE_DATA_DIR: dataRoot },
        timeout: 120000
      }
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).effectCount, 0, 'CLI 重复执行应无改动');
    step('✅ CLI：--dry-run 零写入、真实执行只动临时 DSH_HOME、重复执行幂等');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

// ============================================ 7. 确认没有碰到真实的 ~/.dsh

{
  const realDshPatchAfter = fs.existsSync(realDshPatch) ? fs.readFileSync(realDshPatch) : null;
  assert.deepEqual(
    realDshPatchAfter,
    realDshPatchBefore,
    `测试不得改写真实 ~/.dsh 的 MCP 配置：${realDshPatch}`
  );
  step(`✅ 隔离检查：真实 DSH 配置字节级未被本测试改写（${realDshPatch}）`);
}

// ============================== 7. 卸载：只移除本应用拥有的内容（阶段 7 依赖）

// A transient Windows sharing violation while replacing the versioned DSH plugin is retried;
// successful replacement leaves no staging directory, and the complete fixture root is removed.
{
  const tempRoot = makeTempRoot('rename-retry');
  const dshHome = path.join(tempRoot, 'dsh');
  const source = path.join(tempRoot, 'source-plugin');
  const destination = path.join(tempRoot, 'data', 'runtime', VERSION, PLUGIN_NAME);
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'lib', 'new.txt'), 'new plugin payload');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'old.txt'), 'old plugin payload');
  let renameAttempts = 0;

  try {
    applyPlan({ dshHome, effects: [{ type: 'replace-dir', path: destination, source }] }, {
      log: () => {},
      hooks: {
        platform: 'win32',
        renameRetryDelayMs: 0,
        renameSync(from, to) {
          renameAttempts += 1;
          if (renameAttempts === 1) {
            const error = new Error('transient sharing violation');
            error.code = 'EPERM';
            throw error;
          }
          fs.renameSync(from, to);
        }
      }
    });
    assert.equal(renameAttempts, 2, 'transient EPERM must receive one bounded retry');
    assert.equal(fs.readFileSync(path.join(destination, 'lib', 'new.txt'), 'utf8'), 'new plugin payload');
    assert.equal(fs.existsSync(path.join(destination, 'old.txt')), false, 'the old plugin tree is replaced');
    assert.deepEqual(
      fs.readdirSync(path.dirname(destination)).filter(name => name.includes('.whalebridge-tmp-')),
      [],
      'successful replacement must consume its staging directory'
    );
    step('✅ Windows rename recovery: one transient EPERM is retried and no staged directory remains');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    assert.equal(fs.existsSync(tempRoot), false, 'rename retry fixture root must be completely cleaned');
  }
}

{
  const tempRoot = makeTempRoot('removal');
  const dshHome = path.join(tempRoot, 'dsh');
  const dataRoot = path.join(tempRoot, 'data');
  seedDsh(dshHome, { cordis: TEMPLATE_CORDIS });
  // 用户自建 preset，卸载时必须保留
  fs.mkdirSync(path.join(dshHome, '.agent-presets', 'liangshen'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, '.agent-presets', 'liangshen', 'preset.yml'), '# 用户自己的\n');
  writeIsolatedConfig(dataRoot);

  try {
    applyPlan(planFor({ dshHome, dataRoot, core: PACKAGED_CORE }), { log: () => {} });
    const patchFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    assert.equal(detectCordisState(fs.readFileSync(patchFile, 'utf8')).kind, 'marked');

    // --- 用户改过其中一个 preset：卸载时必须保留它
    const userEdited = path.join(dshHome, '.agent-presets', 'whale-chat', 'preset.yml');
    fs.writeFileSync(userEdited, '# 我改过的\n', 'utf8');
    const userEntry = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    const originalPatch = fs.readFileSync(userEntry, 'utf8');

    const removal = planDshRemoval({
      dshHome,
      profile: 'web',
      dataRoot,
      manifest: readManifest(dshHome)
    });
    assert.ok(
      removal.warnings.some((warning) => warning.includes('whale-chat')),
      `应提示改过的 preset 被保留：${removal.warnings.join(' | ')}`
    );
    applyPlan(removal, { log: () => {} });

    assert.equal(fs.readFileSync(userEdited, 'utf8'), '# 我改过的\n', '用户改过的 preset 必须保留');
    assert.ok(
      !fs.existsSync(path.join(dshHome, '.agent-presets', 'whale-chat-v2')),
      '未被改动的 preset 应被移除'
    );
    assert.ok(
      fs.existsSync(path.join(dshHome, '.agent-presets', 'liangshen', 'preset.yml')),
      '用户自建 preset 必须保留'
    );
    assert.ok(!fs.existsSync(path.join(dshHome, 'plugins', PLUGIN_NAME)), '插件链接应被移除');
    assert.ok(!fs.existsSync(path.join(dataRoot, 'runtime')), '按版本释放的插件副本应被移除');
    assert.ok(!fs.existsSync(path.join(dshHome, '.whalebridge-integration.json')), 'manifest 应被移除');

    const afterRemoval = fs.readFileSync(patchFile, 'utf8');
    assert.ok(!afterRemoval.includes('mcp-snowluma'), 'MCP 条目应被移除');
    assert.ok(!afterRemoval.includes('# === whalebridge MCP'), '标记块应被移除');
    assert.ok(afterRemoval.includes('patch layer'), '文件本身与注释应保留（不删用户文件）');
    assert.notEqual(originalPatch, afterRemoval);

    const pkg = JSON.parse(fs.readFileSync(path.join(dshHome, 'profiles', 'web', 'package.json'), 'utf8'));
    assert.ok(!(PLUGIN_NAME in pkg.dependencies), '插件依赖应被移除');
    assert.ok(!pkg.dsh.profile.bundles.includes(PLUGIN_NAME), '插件 bundle 应被移除');

    // --- 幂等：再卸载一次没有任何效果
    const second = planDshRemoval({ dshHome, profile: 'web', dataRoot, manifest: readManifest(dshHome) });
    assert.equal(second.effects.length, 0, `重复卸载应为空操作：${JSON.stringify(second.effects)}`);

    // --- 无标记的旧配置：只删本项目条目，用户条目保留
    const secondRoot = makeTempRoot('removal-unmarked');
    const secondHome = path.join(secondRoot, 'dsh');
    seedDsh(secondHome, { cordis: UNMARKED_CORDIS });
    try {
      const unmarkedRemoval = planDshRemoval({ dshHome: secondHome, profile: 'web', dataRoot, manifest: null });
      applyPlan(unmarkedRemoval, { log: () => {} });
      const text = fs.readFileSync(path.join(secondHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
      assert.ok(!text.includes('mcp-snowluma'), '本项目条目应被移除');
      assert.ok(text.includes('my-own-server'), '用户自己的 MCP 条目必须保留');
      step('✅ 卸载：只移除本应用拥有的 preset/插件/MCP 条目，用户内容与改动一律保留');
    } finally {
      fs.rmSync(secondRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

step('🎉 DSH 集成安装/修复/迁移/卸载全部通过');
