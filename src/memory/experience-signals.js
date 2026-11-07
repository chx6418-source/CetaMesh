// Finite local selection only. Inputs come from the Task owner, never from model
// transcripts or a remote/background learner. No IO and no effect attribution.
import crypto from 'node:crypto';
import { explicitMemoryCandidate } from './auto-candidate.js';
import { isSafeExperienceText } from './experience.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function testReceipt(row, taskId, workspaceId, conditions) {
  if (!row || row.source !== 'core-test' || row.capability !== 'test.run' || row.status !== 'completed' || row.phase !== 'user'
    || !Number.isSafeInteger(row.exitCode) || !digest(row.resultSha256) || !row.eventId?.startsWith('core-test:')
    || !row.operationId || !row.runId || !row.provider || !row.sessionId || row.tool !== conditions?.tool
    || row.postWriteVerification?.configDigest !== conditions.configDigest || !digest(row.postWriteVerification.sourceDigest)) return null;
  return { eventId: row.eventId, taskId, workspaceId, provider: row.provider, sessionId: row.sessionId, runId: row.runId,
    operationId: row.operationId, status: row.exitCode === 0 ? 'pass' : 'fail', resultSha256: row.resultSha256, at: row.at };
}

export function detectExperienceSignals({ taskId, workspaceId, turnId, ownerTexts = [], currentRunEvidence = [], priorRunEvidence = [],
  conditions, currentVerification = null } = {}) {
  if (!taskId || !workspaceId || !turnId || !conditions || !Array.isArray(ownerTexts) || !Array.isArray(currentRunEvidence) || !Array.isArray(priorRunEvidence)) return [];
  const signal = (kind, key, content, evidence = [], ownerMessageId = null) => ({ kind,
    triggerId: hash([kind, taskId, workspaceId, key]), content, evidence, ownerMessageId });
  for (const row of ownerTexts.slice(-1)) {
    if (!row || row.truncated || !row.id || !isSafeExperienceText(row.text) || row.text.length > 500) continue;
    const text = row.text.trim();
    // Require a direct sentence, not quoted instructions or a mention of a
    // correction made by someone else. The result is an attributed statement.
    const correction = /^(?:更正|纠正|修正)(?:[:：，,\s]|一下)|^(?:不对|不是这样)[，,:：\s]|^(?:correction\b[,:\s]|actually\b[,:]\s*|please correct\b)/i.test(text);
    const remember = /^(?:请记住|记住我的|please remember\b)/i.test(text) && explicitMemoryCandidate(text);
    if (correction || remember) {
      const excerpt = text.split(/[。!！\n]/, 1)[0].slice(0, 400);
      return [signal(correction ? 'owner-correction' : 'owner-remember', row.id,
        'Owner statement / 用户陈述（条件参考，尚非机器核验事实）：' + excerpt, [], row.id)];
    }
  }
  if (!conditions.tool || !digest(conditions.configDigest) || !digest(conditions.sourceDigest)) return [];
  if ([...priorRunEvidence, ...currentRunEvidence].some(row => row?.capability === 'test.run'
    && ['unknown', 'outcome-unknown', 'cancel-unconfirmed', 'pending', 'running'].includes(row.status))) return [];
  const current = currentRunEvidence.slice(-200).map(row => testReceipt(row, taskId, workspaceId, conditions)).filter(Boolean);
  const previous = priorRunEvidence.slice(-200).map(row => testReceipt(row, taskId, workspaceId, conditions)).filter(Boolean);
  const seen = new Set(), operations = new Set();
  const all = [...previous, ...current].filter(row => {
    if (seen.has(row.eventId) || operations.has(row.operationId)) return false;
    seen.add(row.eventId); operations.add(row.operationId); return true;
  });
  const failures = all.filter(row => row.status === 'fail');
  const pass = current.findLast(row => row.status === 'pass' && currentVerification?.status === 'VERIFIED'
    && currentVerification.evidenceEventIds?.includes(row.eventId));
  if (pass) {
    const priorFailure = failures.findLast(row => row.at <= pass.at && row.operationId !== pass.operationId);
    if (priorFailure) return [signal('failure-recovery', [conditions.tool, conditions.configDigest, priorFailure.eventId],
      'Conditional project reference / 项目条件参考：同一已配置校验先失败，纠正后以新的受控操作通过；这仅记录该次机器观察，不证明建议有效、当前 Task 已完成或未来校验必然通过。', [priorFailure, pass])];
  }
  // An unrelated old pair is not a new turn signal. At least the latest
  // distinct failure must belong to this current trusted Run.
  if (failures.length >= 2 && current.at(-1)?.status === 'fail' && current.some(row => row.eventId === failures.at(-1).eventId)) {
    return [signal('repeated-failure', [conditions.tool, conditions.configDigest],
      'Conditional project reference / 项目条件参考：同一工具与配置在两个独立受控操作中失败；再次运行前应检查当前配置和原 Task 证据。这是失败观察，未推断根因或修复方案。', failures.slice(-2))];
  }
  return [];
}
