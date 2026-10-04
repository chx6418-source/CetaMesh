// CetaMesh Desktop — 统一 Memory Runtime 验收测试（阶段 04 / TASK 阶段 04）。
// 用法：node scripts/test-memory-runtime.mjs
//
// 覆盖验收项：
//   CRUD、search、scope、pinned、revision/conflict、
//   chat candidate confirmation、restart persistence，
//   外加"授权先于检索"的可证明性与旧 QQ 记忆 Adapter 的只读 / 幂等性质。
//
// 本测试只使用隔离临时目录，不触碰真实 state/、不访问网络 / DSH / QQ。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryRuntime, createMemoryService, createQqMemoryAdapter } from '../src/memory/index.js';

let passed = 0;
let failed = 0;
const check = (name, condition, extra = '') => {
  if (condition) {
    passed += 1;
    console.log('PASS ' + name + (extra ? ' — ' + extra : ''));
  } else {
    failed += 1;
    console.log('FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
};
const equal = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(name, a === b, a === b ? '' : 'got ' + a + ' want ' + b);
};
const capture = (fn) => {
  try {
    return { threw: false, value: fn() };
  } catch (error) {
    return { threw: true, code: error && error.code, message: String(error && error.message) };
  }
};
const asyncCapture = async (fn) => {
  try {
    return { threw: false, value: await fn() };
  } catch (error) {
    return { threw: true, code: error && error.code, message: String(error && error.message) };
  }
};

let clock = 1700000000000;
const now = () => clock;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-memory-test-'));
const user = { kind: 'user', id: 'desktop' };
const agentA = { kind: 'agent', id: 'chat-a', grants: { scopes: ['chat:c1'] } };
const agentNone = { kind: 'agent', id: 'chat-none', grants: { scopes: [] } };

try {
  // ── 1. CRUD ────────────────────────────────────────────────────────────
  const runtime = createMemoryRuntime({ stateDir: root, now });

  const made = runtime.create({
    principal: user, type: 'chat', scope: 'chat:c1', content: 'CetaMesh 采用 Task 独立于 Agent Session 的原则',
    tags: ['架构', 'task'], source: 'user'
  });
  check('create 返回记录', Boolean(made.id) && made.rev === 1, 'rev=' + made.rev);
  equal('create 归一化 scope', made.scope, 'chat:c1');
  equal('create 保留 tags', made.tags, ['架构', 'task']);
  equal('create 记录来源', made.source, 'user');

  const fetched = runtime.get({ principal: user, id: made.id });
  equal('get 读回同一内容', fetched.memory.content, 'CetaMesh 采用 Task 独立于 Agent Session 的原则');

  const listed = runtime.list({ principal: user });
  check('list 包含新建记录', listed.memories.some((m) => m.id === made.id));

  const updated = runtime.update({
    principal: user, id: made.id, expectedRev: 1, content: 'CetaMesh 的 Task 可以比任何 Agent Session 活得更久'
  });
  check('update 递增 rev', updated.rev === 2, 'rev=' + updated.rev);
  equal('update 生效', runtime.get({ principal: user, id: made.id }).memory.content,
    'CetaMesh 的 Task 可以比任何 Agent Session 活得更久');

  const removed = runtime.remove({ principal: user, id: made.id, expectedRev: 2 });
  check('delete 成功', removed.deleted === true);
  const afterDelete = capture(() => runtime.get({ principal: user, id: made.id }));
  check('delete 后 get 报 MEMORY_NOT_FOUND', afterDelete.threw && afterDelete.code === 'MEMORY_NOT_FOUND', String(afterDelete.code));

  // ── 2. revision / conflict ─────────────────────────────────────────────
  const base = runtime.create({ principal: user, type: 'chat', scope: 'chat:c1', content: '冲突基线' });
  const first = runtime.update({ principal: user, id: base.id, expectedRev: base.rev, content: '第一次编辑' });
  check('并发编辑第一次成功', first.rev === base.rev + 1);

  const stale = capture(() => runtime.update({ principal: user, id: base.id, expectedRev: base.rev, content: '基于旧版本的编辑' }));
  check('过期 rev 更新报 MEMORY_CONFLICT', stale.threw && stale.code === 'MEMORY_CONFLICT', String(stale.code));

  const staleDelete = capture(() => runtime.remove({ principal: user, id: base.id, expectedRev: base.rev }));
  check('过期 rev 删除报 MEMORY_CONFLICT', staleDelete.threw && staleDelete.code === 'MEMORY_CONFLICT', String(staleDelete.code));

  const noRev = capture(() => runtime.update({ principal: user, id: base.id, content: '没有 rev' }));
  check('缺少 expectedRev 报 REVISION_REQUIRED', noRev.threw && noRev.code === 'REVISION_REQUIRED', String(noRev.code));

  check('冲突后数据未被破坏', runtime.get({ principal: user, id: base.id }).memory.content === '第一次编辑');

  // ── 3. search / pinned / rank ──────────────────────────────────────────
  clock += 1000;
  const pinMe = runtime.create({
    principal: user, type: 'working', scope: 'chat:c1', content: '向量数据库平台化被明确排除', pinned: true
  });
  clock += 1000;
  runtime.create({ principal: user, type: 'user', scope: 'chat:c1', content: '所有者偏好小阶段提交' });
  clock += 1000;
  runtime.create({ principal: user, type: 'task', scope: 'chat:c1', content: '无关的第三条记忆' });

  const searchHit = runtime.search({ principal: user, query: '向量' });
  check('search 命中', searchHit.memories.length >= 1 && searchHit.memories[0].id === pinMe.id,
    'hits=' + searchHit.memories.length);
  check('search 排除未命中', searchHit.memories.every((m) => m.content.includes('向量')));
  check('pinned 排在前面', searchHit.memories[0].pinned === true);

  const empty = runtime.search({ principal: user, query: '绝对不存在的关键词zzz' });
  equal('search 无结果返回空数组', empty.memories.length, 0);

  const typeFiltered = runtime.list({ principal: user, types: ['task'] });
  check('types 过滤生效', typeFiltered.memories.length >= 1 && typeFiltered.memories.every((m) => m.type === 'task'));

  const pinnedOnly = runtime.list({ principal: user, pinned: true });
  check('pinned 过滤生效', pinnedOnly.memories.length === 1 && pinnedOnly.memories[0].id === pinMe.id);

  // ── 4. scope：授权先于检索（可证明） ────────────────────────────────────
  runtime.create({ principal: user, type: 'chat', scope: 'chat:c2', content: '另一个会话才看得到的秘密' });
  runtime.create({ principal: user, type: 'chat', scope: 'workspace:w1', content: '工作区里的记录' });

  const c1Total = runtime.list({ principal: user, scope: 'chat:c1' }).memories.length;
  const allTotal = runtime.list({ principal: user, limit: 200 }).memories.length;
  check('scope 过滤生效', c1Total > 0 && c1Total < allTotal, 'c1=' + c1Total + ' all=' + allTotal);

  const agentList = runtime.list({ principal: agentA });
  check('Agent 只看到被授权 Scope', agentList.memories.every((m) => m.scope === 'chat:c1'));
  check('Agent 看不到 chat:c2', agentList.memories.every((m) => !m.content.includes('秘密')));
  equal('检索只扫描已授权分区（未授权分区未读取）', agentList.meta.scanned, c1Total);

  const forbidden = capture(() => runtime.list({ principal: agentA, scope: 'chat:c2' }));
  check('请求未授权 Scope 报 SCOPE_NOT_AUTHORIZED', forbidden.threw && forbidden.code === 'SCOPE_NOT_AUTHORIZED', String(forbidden.code));

  const noGrant = capture(() => runtime.list({ principal: agentNone }));
  check('无授予的 Agent 被拒绝', noGrant.threw && noGrant.code === 'SCOPE_NOT_AUTHORIZED', String(noGrant.code));

  const unknownType = capture(() => runtime.create({ principal: user, type: 'telepathy', scope: 'chat:c1', content: 'x' }));
  check('未知类型被拒绝', unknownType.threw && unknownType.code === 'INVALID_MEMORY_TYPE', String(unknownType.code));

  const badScope = capture(() => runtime.create({ principal: user, type: 'chat', scope: 'galaxy:zzz', content: 'x' }));
  check('未知 Scope 被拒绝', badScope.threw && badScope.code === 'INVALID_SCOPE', String(badScope.code));

  // ── 5. 长期记忆不得被静默写入 ──────────────────────────────────────────
  const silentLongTerm = capture(() => runtime.create({
    principal: agentA, type: 'user', scope: 'chat:c1', content: 'Agent 想偷偷记住的东西'
  }));
  check('Agent 直接写长期记忆被拒绝',
    silentLongTerm.threw && silentLongTerm.code === 'LONG_TERM_REQUIRES_CONFIRMATION', String(silentLongTerm.code));

  const silentChat = capture(() => runtime.create({
    principal: user, type: 'user', scope: 'chat:c1', content: 'x', source: 'chat-candidate'
  }));
  check('候选来源缺少确认被拒绝',
    silentChat.threw && silentChat.code === 'MEMORY_CONFIRMATION_REQUIRED', String(silentChat.code));

  const agentWorking = capture(() => runtime.create({
    principal: agentA, type: 'working', scope: 'chat:c1', content: 'Agent 可以写短期工作记忆'
  }));
  check('Agent 允许写短期 working 记忆', agentWorking.threw === false);

  const agentDelete = capture(() => runtime.remove({ principal: agentA, id: pinMe.id, expectedRev: pinMe.rev }));
  check('Agent 不能删除记忆', agentDelete.threw && agentDelete.code === 'UNAUTHORIZED', String(agentDelete.code));

  // ── 6. chat candidate confirmation ─────────────────────────────────────
  const countBeforeCandidate = runtime.countAll();
  const proposed = runtime.proposeCandidate({
    principal: agentA, type: 'user', scope: 'chat:c1',
    content: '所有者喜欢先验证再提交', reason: '对话中多次出现'
  });
  check('候选创建成功且状态 pending', proposed.candidate.status === 'pending', proposed.candidate.status);
  equal('候选尚未写入长期记忆', runtime.countAll(), countBeforeCandidate);

  const agentConfirm = capture(() => runtime.confirmCandidate({
    principal: agentA, id: proposed.candidate.id, decision: 'accept'
  }));
  check('Agent 不能自行确认候选', agentConfirm.threw && agentConfirm.code === 'UNAUTHORIZED', String(agentConfirm.code));

  const pendingList = runtime.listCandidates({ principal: user, status: 'pending' });
  check('用户能看到待确认候选', pendingList.candidates.some((c) => c.id === proposed.candidate.id));
  const agentPending = runtime.listCandidates({ principal: agentA });
  check('Agent 不能看到未授权 Scope 的候选', agentPending.candidates.every((c) => c.scope === 'chat:c1'));

  const firstCandidate = runtime.proposeCandidate({
    principal: agentA, type: 'user', scope: 'chat:c1', content: '会被拒绝的候选', reason: '测试拒绝路径'
  });
  const rejected = runtime.confirmCandidate({ principal: user, id: firstCandidate.candidate.id, decision: 'reject' });
  equal('拒绝候选后状态为 rejected', rejected.candidate.status, 'rejected');
  equal('拒绝候选不写入记忆', rejected.memory, null);

  const accepted = runtime.confirmCandidate({ principal: user, id: proposed.candidate.id, decision: 'accept' });
  check('确认候选后写入长期记忆', Boolean(accepted.memory && accepted.memory.id));
  equal('写入来源标记为 chat-candidate', accepted.memory.source, 'chat-candidate');
  check('写入带确认时间与确认人', Boolean(accepted.memory.confirmedAt) && accepted.memory.confirmedBy === 'user:desktop');
  equal('候选状态更新为 accepted', accepted.candidate.status, 'accepted');
  equal('候选记录关联到记忆 id', accepted.candidate.memoryId, accepted.memory.id);
  equal('确认后记忆总数 +1', runtime.countAll(), countBeforeCandidate + 1);

  const twice = capture(() => runtime.confirmCandidate({ principal: user, id: proposed.candidate.id, decision: 'accept' }));
  check('候选不能被重复确认', twice.threw && twice.code === 'CANDIDATE_DECIDED', String(twice.code));

  // ── 7. restart persistence ─────────────────────────────────────────────
  const beforeRestart = runtime.list({ principal: user, limit: 200 }).memories;
  const revOfFirst = beforeRestart[0].rev;
  const restartRuntime = createMemoryRuntime({ stateDir: root, now });
  const afterRestart = restartRuntime.list({ principal: user, limit: 200 }).memories;
  equal('重启后记录数量一致', afterRestart.length, beforeRestart.length);
  equal('重启后 id 集合一致', afterRestart.map((m) => m.id).sort(), beforeRestart.map((m) => m.id).sort());
  equal('重启后 rev 保持', afterRestart.find((m) => m.id === beforeRestart[0].id).rev, revOfFirst);
  const persistedCandidate = restartRuntime.listCandidates({ principal: user }).candidates;
  check('重启后候选状态保持', persistedCandidate.some((c) => c.id === proposed.candidate.id && c.status === 'accepted'));

  const persistedFile = path.join(root, 'memory', 'memories.json');
  check('记忆文件已落盘', fs.existsSync(persistedFile));
  const fileData = JSON.parse(fs.readFileSync(persistedFile, 'utf8'));
  check('落盘文件带 schemaVersion 与 revision',
    fileData.schemaVersion === 1 && Number.isSafeInteger(fileData.revision) && fileData.revision > 0,
    'revision=' + fileData.revision);

  // ── 8. 旧 QQ 记忆 Adapter：只读 + 幂等 ──────────────────────────────────
  const qqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-memory-qq-'));
  const socialV2File = path.join(qqDir, 'social-v2.json');
  fs.writeFileSync(socialV2File, JSON.stringify({
    paused: false,
    conversations: {
      'group:1125016053': {
        activeTopics: [
          { text: '讨论记忆架构', lastMentionAt: 1700000000000, participants: ['甲', '乙'], pendingQuestion: '要不要上向量库' },
          { text: '第二个话题', lastMentionAt: 1700000100000, participants: [] }
        ],
        pendingThoughts: [
          { text: '想问问他为什么', createdAt: 1700000200000, expiresAt: 4102444800000, motivation: 'curiosity' }
        ],
        memberImpressions: { '甲': { traits: ['话少', '技术强'], interactionCount: 3 } }
      },
      'private:3273753820': { activeTopics: [], pendingThoughts: [], memberImpressions: {} }
    }
  }, null, 2), 'utf8');
  const qqBytesBefore = fs.readFileSync(socialV2File);

  const adapter = createQqMemoryAdapter({ socialV2File, now });
  const read = adapter.read();
  equal('Adapter 读出 4 条旧记忆', read.entries.length, 4);
  check('Adapter 映射类型正确',
    read.entries.filter((e) => e.type === 'chat').length === 2
    && read.entries.filter((e) => e.type === 'working').length === 1
    && read.entries.filter((e) => e.type === 'user').length === 1);
  equal('Adapter 会话键映射为 chat Scope',
    read.entries[0].scope, 'chat:qq-group-1125016053');

  const qqRuntime = createMemoryRuntime({ stateDir: qqDir, now });
  const dry = adapter.importInto({ runtime: qqRuntime, principal: user, dryRun: true });
  equal('dryRun 报告可导入数量', dry.imported, 4);
  equal('dryRun 不落库', qqRuntime.countAll(), 0);

  const imported = adapter.importInto({ runtime: qqRuntime, principal: user });
  equal('导入 4 条', imported.imported, 4);
  equal('首次导入无跳过', imported.skipped, 0);

  const reimported = adapter.importInto({ runtime: qqRuntime, principal: user });
  equal('重复导入幂等（全部跳过）', reimported.imported, 0);
  equal('重复导入跳过 4 条', reimported.skipped, 4);
  equal('重复导入后总数不变', qqRuntime.countAll(), 4);

  check('Adapter 绝不修改 social-v2.json',
    Buffer.compare(qqBytesBefore, fs.readFileSync(socialV2File)) === 0);

  const importedList = qqRuntime.list({ principal: user, scope: 'chat:qq-group-1125016053' });
  equal('导入记录落在正确 Scope', importedList.memories.length, 4);
  check('导入记录来源标记为 qq-adapter', importedList.memories.every((m) => m.source === 'qq-adapter'));
  check('导入记录保留可追溯 ref', importedList.memories.every((m) => m.origin && m.origin.ref));

  const agentImport = capture(() => adapter.importInto({
    runtime: qqRuntime, principal: { kind: 'agent', id: 'x', grants: { scopes: ['chat:qq-group-1125016053'] } }
  }));
  check('Agent 不能执行导入（长期写入）', agentImport.threw === true, String(agentImport.code));

  // ── 9. Service 层（memory.* 方法白名单） ────────────────────────────────
  const svcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-memory-svc-'));
  const service = createMemoryService({ stateDir: svcDir, now });

  const created = await service.execute({ method: 'memory.create', params: {
    type: 'workspace', scope: 'workspace:w1', content: 'Workspace 是安全边界', tags: ['原则']
  } });
  check('service memory.create 可用', Boolean(created.id));

  const pinResult = await service.execute({ method: 'memory.pin', params: { id: created.id, expectedRev: created.rev } });
  equal('service memory.pin 生效', pinResult.pinned, true);
  equal('pin 递增 rev', pinResult.rev, 2);

  const svcList = await service.execute({ method: 'memory.list', params: { query: '安全边界' } });
  check('service memory.search 可用', svcList.memories.length === 1);

  const svcStats = await service.execute({ method: 'memory.stats', params: {} });
  equal('service memory.stats 统计总数', svcStats.total, 1);

  const svcProposal = await service.execute({ method: 'memory.candidates.propose', params: {
    agentId: 'chat-1', scopes: ['chat:qq-group-1125016053'], type: 'user',
    scope: 'chat:qq-group-1125016053', content: '来自模型的候选', reason: '频繁出现'
  } });
  equal('service 候选为 pending', svcProposal.candidate.status, 'pending');
  const svcConfirmed = await service.execute({ method: 'memory.candidates.confirm', params: {
    id: svcProposal.candidate.id, decision: 'accept'
  } });
  equal('service 确认后写入记忆', svcConfirmed.memory.source, 'chat-candidate');

  const svcDeleted = await service.execute({ method: 'memory.delete', params: { id: created.id, expectedRev: 2 } });
  check('service memory.delete 可用', svcDeleted.deleted === true);

  const overview = await service.execute({ method: 'memory.overview', params: { limit: 50 } });
  check('service memory.overview 一次往返返回列表', Array.isArray(overview.memories));
  check('service memory.overview 一次往返返回候选', Array.isArray(overview.candidates));
  check('memory.overview 携带授权元数据', overview.meta && Array.isArray(overview.meta.authorizedScopes));
  const overviewFiltered = await service.execute({ method: 'memory.overview', params: { query: '安全边界', limit: 50 } });
  equal('memory.overview query 过滤生效', overviewFiltered.memories.length, 0);

  const unknown = await asyncCapture(() => service.execute({ method: 'memory.nope', params: {} }));
  check('未知方法报 METHOD_NOT_FOUND', unknown.threw && unknown.code === 'METHOD_NOT_FOUND', String(unknown.code));
  // ── 10. IPC 端到端：memory.* 私有方法族可路由 ──────────────────────────
  const { PassThrough } = await import('node:stream');
  const { startIpcProtocol, IPC_PROTOCOL_VERSION } = await import('../src/control/ipc-protocol.js');
  const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cetamesh-memory-ipc-'));
  const ipcService = createMemoryService({ stateDir: ipcDir, now });
  // 与 bridge.js 的 startUiIpcServer 相同的分派形状：memory.* 走 Memory 服务。
  const ipcDispatch = ({ method, params }) => {
    if (method.startsWith('memory.')) return ipcService.execute({ method, params });
    throw new Error('unexpected method ' + method);
  };
  const ipcInput = new PassThrough({ autoDestroy: false });
  const ipcOutput = new PassThrough();
  const ipcChunks = [];
  ipcOutput.on('data', (chunk) => ipcChunks.push(Buffer.from(chunk)));
  const ipc = startIpcProtocol({ input: ipcInput, output: ipcOutput, dispatch: ipcDispatch });
  const encode = (payload) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    return frame;
  };
  const ipcRequest = (id, method, params) => ({
    version: IPC_PROTOCOL_VERSION, id, method, ...(params === undefined ? {} : { params })
  });
  ipcInput.write(encode(ipcRequest('m1', 'memory.create', { type: 'chat', scope: 'chat:c9', content: 'IPC 往返验证' })));
  ipcInput.write(encode(ipcRequest('m2', 'memory.list', { scope: 'chat:c9' })));
  ipcInput.end();
  await ipc.done;
  const frames = [];
  {
    const buffer = Buffer.concat(ipcChunks);
    let offset = 0;
    while (offset + 4 <= buffer.length) {
      const size = buffer.readUInt32LE(offset);
      frames.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + size).toString('utf8')));
      offset += 4 + size;
    }
  }
  const createdFrame = frames.find((frame) => frame.id === 'm1');
  const listFrame = frames.find((frame) => frame.id === 'm2');
  check('IPC memory.create 往返成功', Boolean(createdFrame && createdFrame.ok === true), JSON.stringify(createdFrame));
  check('IPC memory.list 往返成功', Boolean(listFrame && listFrame.ok === true), JSON.stringify(listFrame));
  equal('IPC memory.list 返回 1 条', listFrame.result.memories.length, 1);
  equal('IPC 写入内容正确', listFrame.result.memories[0].content, 'IPC 往返验证');
  fs.rmSync(ipcDir, { recursive: true, force: true });

} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed > 0) process.exit(1);
console.log('统一 Memory Runtime 验收全部通过（阶段 04）');
