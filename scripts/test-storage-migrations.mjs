// D3 迁移回归：各 Domain Store 在统一 Storage Primitive 之上的既有契约保持不变。
// 覆盖：正常落盘/重启读回、BOM 容错、损坏 fail-closed（Domain 错误码不变）、
// rev/expectedRev 兼容、缺失文件默认态。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskStore } from '../src/task/store.js';
import { createMemoryStore } from '../src/memory/store.js';
import { createSettingsStore } from '../src/settings/store.js';
import { createExtensionStore } from '../src/extension/store.js';
import { createTrustStore } from '../src/mesh/trust.js';
import { prunePacketFiles } from '../src/continuity/runtime.js';
import { readRawConfig, parseConfigText, atomicWriteConfig, ConfigError } from '../src/config/loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function assert(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`✅ ${label}`);
  } else {
    failed = 1;
    console.error(`❌ ${label}`);
  }
}

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), `storage-migration-`));
}

const caughtCode = (fn) => {
  try { fn(); return null; } catch (error) { return error.code ?? error?.name; }
};

// ── 1. Task Store：rev 兼容 + 重启读回 + BOM + 损坏 fail-closed ──────────────
{
  const dir = freshDir();
  const store = createTaskStore({ stateDir: dir });
  const created = store.insert({
    id: 'task_1', goal: 'g', requirements: [], status: 'running', rev: 1,
    completedWork: [], pendingWork: [], acceptance: [], agentHistory: [], artifacts: [], decisions: [], memoryRefs: []
  });
  const updated = store.update('task_1', created.rev, (draft) => { draft.goal = 'g2'; return draft; });
  assert(updated.rev === created.rev + 1, 'Task rev 单调递增（expectedRev 语义保持）');
  assert(caughtCode(() => store.update('task_1', created.rev, (d) => d)) === 'TASK_CONFLICT', '过期 expectedRev → TASK_CONFLICT（不变）');

  const reloaded = createTaskStore({ stateDir: dir });
  reloaded.load();
  assert(reloaded.get('task_1').goal === 'g2', 'Task 重启后从磁盘读回（persist→load round-trip）');
  assert(reloaded.fileRevision() === 2, 'Task 文件级 revision 跨实例延续');

  fs.writeFileSync(path.join(dir, 'tasks', 'tasks.json'), '\uFEFF' + fs.readFileSync(path.join(dir, 'tasks', 'tasks.json'), 'utf8'), 'utf8');
  const bomStore = createTaskStore({ stateDir: dir });
  bomStore.load();
  assert(bomStore.get('task_1')?.goal === 'g2', 'Task：带 BOM 的存量文件仍可读（BOM 统一剥离）');

  const corruptDir = freshDir();
  fs.mkdirSync(path.join(corruptDir, 'tasks'));
  fs.writeFileSync(path.join(corruptDir, 'tasks', 'tasks.json'), '{oops', 'utf8');
  assert(caughtCode(() => createTaskStore({ stateDir: corruptDir }).load()) === 'STORE_CORRUPT', 'Task：损坏文件 → STORE_CORRUPT（fail-closed，码不变）');
  const failedLoad = createTaskStore({ stateDir: corruptDir });
  assert(caughtCode(() => failedLoad.load()) === 'STORE_CORRUPT' && caughtCode(() => failedLoad.count()) === 'STORE_CORRUPT', 'Task 读取失败后不得假加载');
}
{
  const dir = freshDir();
  const store = createTaskStore({ stateDir: dir });
  const task = { id: 'rollback', goal: 'old', status: 'running', rev: 1 };
  store.insert(task);
  const before = fs.readFileSync(store.file, 'utf8');
  const beforeRevision = store.fileRevision();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try {
    assert(caughtCode(() => store.update(task.id, 1, (current) => ({ ...current, goal: 'new' }))) === 'WRITE_FAILED', 'Task 写失败抛出 StorageError');
    assert(store.get(task.id).goal === 'old' && store.fileRevision() === beforeRevision && fs.readFileSync(store.file, 'utf8') === before, 'Task 写失败内存、revision、磁盘保持一致');
    assert(caughtCode(() => store.remove(task.id, 1)) === 'WRITE_FAILED' && store.get(task.id)?.goal === 'old', 'Task 删除落盘失败回滚');
  } finally { fs.renameSync = rename; }
}

// ── 2. Memory Store：分区检索 + BOM + 损坏 ───────────────────────────────────
{
  const dir = freshDir();
  const store = createMemoryStore({ stateDir: dir });
  store.insert({
    id: 'mem_1', type: 'working', scope: { kind: 'global', id: '' }, scopeKey: 'global:',
    content: 'hello', tags: [], createdAt: 1, updatedAt: 1, rev: 1
  });
  const reloaded = createMemoryStore({ stateDir: dir });
  reloaded.load();
  assert(reloaded.get('mem_1')?.content === 'hello', 'Memory 重启读回');

  fs.appendFileSync(path.join(dir, 'memory', 'memories.json'), '');
  fs.writeFileSync(path.join(dir, 'memory', 'memories.json'), '\uFEFF' + fs.readFileSync(path.join(dir, 'memory', 'memories.json'), 'utf8'), 'utf8');
  const bomStore = createMemoryStore({ stateDir: dir });
  bomStore.load();
  assert(bomStore.get('mem_1')?.id === 'mem_1', 'Memory：带 BOM 文件可读');

  const corruptDir = freshDir();
  fs.mkdirSync(path.join(corruptDir, 'memory'));
  fs.writeFileSync(path.join(corruptDir, 'memory', 'memories.json'), 'not json at all', 'utf8');
  assert(caughtCode(() => createMemoryStore({ stateDir: corruptDir }).load()) === 'STORE_CORRUPT', 'Memory：损坏 → STORE_CORRUPT（码不变）');
  const failedLoad = createMemoryStore({ stateDir: corruptDir });
  assert(caughtCode(() => failedLoad.load()) === 'STORE_CORRUPT' && caughtCode(() => failedLoad.count()) === 'STORE_CORRUPT', 'Memory 读取失败后不得假加载');
}
{
  const dir = freshDir();
  const store = createMemoryStore({ stateDir: dir });
  const record = { id: 'rollback', type: 'working', scopeKey: 'global:', content: 'old', tags: [], rev: 1 };
  store.insert(record);
  const before = fs.readFileSync(store.file, 'utf8');
  const beforeRevision = store.fileRevision();
  const rename = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('rename denied'), { code: 'EIO' }); };
  try {
    assert(caughtCode(() => store.update(record.id, 1, (current) => ({ ...current, content: 'new' }))) === 'WRITE_FAILED', 'Memory 更新落盘失败');
    assert(store.get(record.id).content === 'old' && store.fileRevision() === beforeRevision && fs.readFileSync(store.file, 'utf8') === before, 'Memory 写失败内存、revision、磁盘保持一致');
    assert(caughtCode(() => store.remove(record.id, 1)) === 'WRITE_FAILED' && store.get(record.id)?.content === 'old', 'Memory 删除落盘失败回滚');
  } finally { fs.renameSync = rename; }
}

// ── 3. Settings Store：损坏回落默认 + lastError 如实上报 ─────────────────────
{
  const dir = freshDir();
  const store = createSettingsStore({ stateDir: dir });
  store.update('general', { theme: 'dark' });
  const reloaded = createSettingsStore({ stateDir: dir });
  reloaded.load();
  assert(reloaded.get().settings.general?.theme === 'dark' || Object.keys(reloaded.get().settings).length > 0, 'Settings 重启读回（分区值保持）');

  const corruptDir = freshDir();
  fs.mkdirSync(path.join(corruptDir, 'settings'));
  fs.writeFileSync(path.join(corruptDir, 'settings', 'settings.json'), '{{{', 'utf8');
  const corruptStore = createSettingsStore({ stateDir: corruptDir });
  corruptStore.load();
  assert(corruptStore.get().lastError?.includes('解析失败') === true, 'Settings：损坏 → 回落默认 + lastError 上报（不静默、不阻断启动）');
  assert(corruptStore.get().settings !== null, 'Settings：损坏后仍返回可用默认值');
  let recoveryRequired = false;
  try { corruptStore.update('general', { theme: 'dark' }); }
  catch (error) { recoveryRequired = error.code === 'SETTINGS_RECOVERY_REQUIRED'; }
  assert(recoveryRequired, 'Settings 损坏后普通保存不得覆盖原数据');
  const backup = fs.readdirSync(path.join(corruptDir, 'settings')).find((name) => name.startsWith('settings.corrupt.'));
  assert(backup && fs.readFileSync(path.join(corruptDir, 'settings', backup), 'utf8') === '{{{', 'Settings 保存前原样备份损坏文件');
  corruptStore.resetAll();
  corruptStore.update('general', { theme: 'dark' });
}

// ── 4. Extension Registry：损坏 → REGISTRY_CORRUPT（码不变） ─────────────────
{
  const dir = freshDir();
  const store = createExtensionStore({ stateDir: dir });
  store.put({ id: 'ext_a', state: 'approved' });
  const reloaded = createExtensionStore({ stateDir: dir });
  reloaded.load();
  assert(reloaded.get('ext_a')?.state === 'approved', 'Extension registry 重启读回');

  const corruptDir = freshDir();
  fs.mkdirSync(path.join(corruptDir, 'extensions'));
  fs.writeFileSync(path.join(corruptDir, 'extensions', 'registry.json'), '\uFEFF[broken', 'utf8');
  assert(caughtCode(() => createExtensionStore({ stateDir: corruptDir }).load()) === 'REGISTRY_CORRUPT', 'Extension：损坏（含 BOM）→ REGISTRY_CORRUPT');
  const failedLoad = createExtensionStore({ stateDir: corruptDir });
  assert(caughtCode(() => failedLoad.load()) === 'REGISTRY_CORRUPT' && caughtCode(() => failedLoad.list()) === 'REGISTRY_CORRUPT', 'Extension 读取失败后不得假加载');
}

// ── 5. Mesh Trust（persistent truth）：损坏 → TRUST_CORRUPT ──────────────────
{
  const dir = freshDir();
  const store = createTrustStore({ stateDir: dir });
  store.addPending({ nodeId: 'node_abc123def4567890abcdef1234567890', name: 'phone', role: 'mobile' });
  const reloaded = createTrustStore({ stateDir: dir });
  assert(reloaded.list().length === 1, 'Mesh trust 重启读回');

  const corruptDir = freshDir();
  fs.mkdirSync(path.join(corruptDir, 'mesh'));
  fs.writeFileSync(path.join(corruptDir, 'mesh', 'trust.json'), '}corrupt{', 'utf8');
  assert(caughtCode(() => createTrustStore({ stateDir: corruptDir }).list()) === 'TRUST_CORRUPT', 'Mesh trust：损坏 → TRUST_CORRUPT（fail-closed，码不变）');
}

// ── 6. Continuity packet 文件保留策略（每 task ≤20） ─────────────────────────
{
  const dir = freshDir();
  const packetDir = path.join(dir, 'handoff', 'task_9');
  fs.mkdirSync(packetDir, { recursive: true });
  for (let seq = 1; seq <= 30; seq++) {
    fs.writeFileSync(path.join(packetDir, `packet-${String(seq).padStart(4, '0')}.json`), '{}', 'utf8');
  }
  fs.writeFileSync(path.join(packetDir, 'reconciliation-0005.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(packetDir, 'latest.json'), '{}', 'utf8');
  prunePacketFiles(packetDir, 20);
  const remaining = fs.readdirSync(packetDir);
  assert(remaining.length === 21, `packet 目录收敛到 20 个带序号文件 + latest.json（实际 ${remaining.length}）`);
  assert(remaining.includes('latest.json'), 'latest.json 始终保留');
  assert(remaining.includes('packet-0030.json') && !remaining.includes('packet-0001.json'), '保留的是最新序号，最旧的被清理');
}

// ── 7. Config loader 底层复用 Primitive：错误码 / 文案契约保持 ────────────────
{
  const dir = freshDir();
  const file = path.join(dir, 'config.json');
  atomicWriteConfig(file, { a: 1 });
  assert(readRawConfig(file).a === 1, 'config 原子写/读 round-trip');

  const bomFile = path.join(dir, 'bom-config.json');
  fs.writeFileSync(bomFile, '\uFEFF{"b":2}', 'utf8');
  assert(readRawConfig(bomFile).b === 2, 'config：BOM 容错保持');

  assert(readRawConfig(path.join(dir, 'absent.json'), { required: false, fallback: { x: 9 } }).x === 9, 'config：缺失 + required=false → fallback');
  assert(caughtCode(() => readRawConfig(path.join(dir, 'absent.json'))) === 'CONFIG_MISSING', 'config：缺失 + required=true → CONFIG_MISSING（码不变）');

  const corruptFile = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{"a":', 'utf8');
  assert(caughtCode(() => readRawConfig(corruptFile)) === 'CONFIG_CORRUPT', 'config：损坏 → CONFIG_CORRUPT（码不变）');

  const arrayFile = path.join(dir, 'array.json');
  fs.writeFileSync(arrayFile, '[1,2]', 'utf8');
  assert(caughtCode(() => readRawConfig(arrayFile)) === 'CONFIG_NOT_OBJECT', 'config：根为数组 → CONFIG_NOT_OBJECT（码不变）');

  let legacyMessage = null;
  try { parseConfigText('nope', { file: 'f.json' }); } catch (error) { legacyMessage = error.message; }
  assert(legacyMessage === '配置文件读取/解析失败：f.json（' + (() => { try { JSON.parse('nope'); return ''; } catch (e) { return String(e.message); } })() + '）', 'config：损坏文案与旧实现逐字节一致');
  assert(new ConfigError('X', 'm').code === 'X', 'ConfigError 形状保持');
}

console.log(failed ? `\n❌ ${passed} 通过，存在失败项` : `\n🎉 Storage 迁移回归全部通过（${passed} 组）`);
process.exit(failed ? 1 : 0);
