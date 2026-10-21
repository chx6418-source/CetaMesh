// D3 Storage Primitive 行为测试（src/storage/json-file.js）。
// 覆盖：原子写/覆盖替换、BOM、损坏、空文件、缺失、maxBytes、temp 清理、
// rename 失败（目标为目录）、并发 update、Windows 路径（空格/中文/深目录）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  StorageError,
  readJsonFile,
  writeJsonAtomic,
  writeTextAtomic,
  updateJsonFile,
  parseJsonText
} from '../src/storage/json-file.js';

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

function tmpRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `json-storage-${label}-`));
  return dir;
}

function listTmp(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

// ── 1. 基础读写 round-trip + 覆盖替换（Windows rename 语义核心场景） ─────────
{
  const dir = tmpRoot('basic');
  const file = path.join(dir, 'a', 'b', 'store.json');
  writeJsonAtomic(file, { n: 1 });
  assert(readJsonFile(file).n === 1, '原子写后可读回（自动创建多级目录）');
  writeJsonAtomic(file, { n: 2 });
  assert(readJsonFile(file).n === 2, '目标已存在时 rename 覆盖替换成功');
  const text = fs.readFileSync(file, 'utf8');
  assert(text.endsWith('\n'), '落盘 JSON 以换行结尾');
  assert(!listTmp(dir).some((name) => name.endsWith('.tmp')), '成功路径不残留 .tmp');
}

// ── 2. BOM / 损坏 / 空文件 / 缺失 ────────────────────────────────────────────
{
  const dir = tmpRoot('bom');
  const file = path.join(dir, 'bom.json');
  fs.writeFileSync(file, '\uFEFF{"ok":true}', 'utf8');
  assert(readJsonFile(file).ok === true, '带 BOM 的 JSON 正常解析');

  assert(parseJsonText('\uFEFF[1,2]')[1] === 2, 'parseJsonText 统一剥 BOM');

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{"n":', 'utf8');
  let caught = null;
  try { readJsonFile(corrupt); } catch (error) { caught = error; }
  assert(caught instanceof StorageError && caught.code === 'CORRUPT', '损坏 JSON → StorageError CORRUPT');

  const empty = path.join(dir, 'empty.json');
  fs.writeFileSync(empty, '   \n', 'utf8');
  caught = null;
  try { readJsonFile(empty); } catch (error) { caught = error; }
  assert(caught instanceof StorageError && caught.code === 'CORRUPT', '空文件按损坏处理（不偷偷降级为 {}）');

  caught = null;
  try { readJsonFile(path.join(dir, 'absent.json')); } catch (error) { caught = error; }
  assert(caught instanceof StorageError && caught.code === 'MISSING', '缺失且未配 missing → StorageError MISSING');

  assert(readJsonFile(path.join(dir, 'absent.json'), { missing: { d: 1 } }).d === 1, '缺失且配置 missing → 返回 fallback');
  assert(readJsonFile(path.join(dir, 'absent.json'), { missing: null }) === null, 'fallback 显式为 null 时返回 null');
}

// ── 3. maxBytes 上限 ─────────────────────────────────────────────────────────
{
  const dir = tmpRoot('maxbytes');
  const file = path.join(dir, 'big.json');
  fs.writeFileSync(file, JSON.stringify({ blob: 'x'.repeat(1024) }));
  let caught = null;
  try { readJsonFile(file, { maxBytes: 16 }); } catch (error) { caught = error; }
  assert(caught instanceof StorageError && caught.code === 'TOO_LARGE', '超出 maxBytes → TOO_LARGE，不整读');
}

// ── 4. 写失败：临时文件清理 + rename 失败语义（目标为目录 → 非 POSIX 假设） ────
{
  const dir = tmpRoot('writefail');
  const blocker = path.join(dir, 'blocked.json');
  fs.mkdirSync(blocker); // 目标位置被目录占用 → rename 无法替换
  let caught = null;
  try { writeJsonAtomic(blocker, { n: 1 }); } catch (error) { caught = error; }
  assert(caught instanceof StorageError && caught.code === 'WRITE_FAILED', 'rename 失败 → StorageError WRITE_FAILED（fail-closed，不静默）');
  assert(!listTmp(dir).some((name) => name.endsWith('.tmp')), '失败路径清理临时文件（temp cleanup）');

  const dir2 = tmpRoot('writefail2');
  try { writeJsonAtomic(path.join(dir2, 'no-such', 'deep', 'f.json'), { n: 1 }); } catch (error) { caught = error; }
  assert(caught instanceof StorageError || caught === null, '极端失败路径仍是 StorageError 或成功创建');
}

// ── 5. updateJsonFile：读改写 + 并发下文件始终完整 ────────────────────────────
{
  const dir = tmpRoot('update');
  const file = path.join(dir, 'counter.json');
  const next = updateJsonFile(file, (current) => ({ n: (current?.n ?? 0) + 1 }), { missing: {} });
  assert(next.n === 1, '缺失文件用 missing 兜底完成首次 update');
  updateJsonFile(file, (current) => ({ n: current.n + 1 }));
  assert(readJsonFile(file).n === 2, '已有文件 update 读改写正确');

  const race = path.join(dir, 'race.json');
  fs.writeFileSync(race, '{"n":0}', 'utf8');
  await Promise.all(Array.from({ length: 24 }, () => updateJsonFile(race, (current) => ({ n: (current?.n ?? 0) + 1 }))));
  const finalValue = readJsonFile(race);
  assert(Number.isFinite(finalValue.n) && finalValue.n >= 1 && finalValue.n <= 24, '并发 update 后文件仍是完整 JSON（无锁语义：允许丢更新，不允许损坏）');
  assert(!listTmp(dir).some((name) => name.endsWith('.tmp')), '并发 update 后无 .tmp 残留');
}

// ── 6. Windows 路径形态：空格 / 中文 / 深目录 ────────────────────────────────
{
  const dir = tmpRoot('winpath');
  const file = path.join(dir, '带 空格 目录', '中文名 状态.json', '..', '中文名 状态.json');
  writeJsonAtomic(file, { 平台: 'windows' });
  assert(readJsonFile(file).平台 === 'windows', '空格/中文路径读写正常');
}

// ── 7. writeTextAtomic（PEM / token 类持久化） ───────────────────────────────
{
  const dir = tmpRoot('text');
  const file = path.join(dir, 'identity.key');
  writeTextAtomic(file, '-----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----\n');
  assert(fs.readFileSync(file, 'utf8').startsWith('-----BEGIN'), 'writeTextAtomic round-trip');
  writeTextAtomic(file, '-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----\n');
  assert(fs.readFileSync(file, 'utf8').includes('BBB'), 'writeTextAtomic 覆盖替换成功');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert(mode === 0o600, `持久化文件权限 0600（实际 ${mode.toString(8)}）`);
  } else {
    console.log('ℹ️ Windows 下 0600 由用户 profile ACL 承担，跳过 POSIX mode 断言');
  }
}

// ── 8. 唯一临时名 + 连续失败不残留（并发不互踩的前提） ────────────────────────
{
  const dir = tmpRoot('uniquetmp');
  const blocker = path.join(dir, 'target.json');
  fs.mkdirSync(blocker); // 目标是目录：每次写入都失败，但每次失败都必须即时清理自己的临时文件
  for (let i = 0; i < 5; i++) {
    try { writeJsonAtomic(blocker, { i }); } catch { /* 预期失败：目标是目录 */ }
  }
  assert(!listTmp(dir).some((name) => name.endsWith('.tmp')), '连续失败也不残留临时文件（temp 名唯一 + 即时清理）');
}

console.log(failed ? `\n❌ ${passed} 通过，存在失败项` : `\n🎉 Storage Primitive 全部通过（${passed} 组）`);
process.exit(failed ? 1 : 0);
