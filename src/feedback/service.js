// CetaMesh Desktop —— Feedback 服务（产品化任务 D，第三 / 四 / 五 / 六节）。
//
// 产品语义（WHY）：
//   1) 提交反馈**永远先落本地 Outbox**，再尽力发一次网络。反馈服务器没上线/不可用时，
//      用户看到的是"已保存，稍后自动重试"，而不是一个红色报错 —— 软件绝不因为反馈服务器不可用而受阻；
//   2) security 类型走最小 metadata：**不自动附加**诊断日志，并给出官方安全联系入口。
//      这条规则写在服务里而不是文案里，避免 UI 或调用方"顺手"把日志挂上去；
//   3) 诊断附件默认**不附加**，必须用户显式要求；附加内容经 sanitizeDiagnostics 白名单二次过滤，
//      因此 API Key / token / 聊天内容 / Memory / 文件正文 / private key 没有进入 payload 的路径；
//   4) 自动重试没有定时器（产品里不引入常驻定时任务）：每次提交或用户点重试时，
//      顺带把到期条目冲一次，这就是"自动/用户确认重试"的落地方式。

import { createFeedbackOutbox, retryDelayMs } from './outbox.js';
import { createFeedbackTransport } from './transport.js';
import {
  FEEDBACK_LIMITS,
  FEEDBACK_TYPES,
  FEEDBACK_TYPE_LABELS,
  feedbackError,
  isSecurityType,
  newFeedbackId,
  validateSubmission
} from './types.js';
import { DIAGNOSTICS_POLICY, buildDiagnostics, minimalDiagnostics, sanitizeDiagnostics } from '../product/diagnostics.js';
import { resolveSecurityContact } from '../product/release-config.js';

export const FLUSH_MAX_PER_CALL = 3;

export function createFeedbackService({
  stateDir,
  releaseConfig = null,
  outbox = null,
  transport = null,
  diagnosticsProvider = null,
  aboutInfo = null,
  fetchImpl = null,
  now = () => Date.now(),
  log = () => {}
} = {}) {
  if (!outbox && (!stateDir || typeof stateDir !== 'string')) {
    throw new Error('createFeedbackService 需要 stateDir 或 outbox');
  }
  const queue = outbox || createFeedbackOutbox({
    stateDir,
    maxEntries: releaseConfig?.feedback?.outboxMaxEntries
  });
  const channel = transport || createFeedbackTransport({
    endpoint: releaseConfig?.feedback?.endpoint ?? null,
    fetchImpl,
    timeoutMs: releaseConfig?.feedback?.requestTimeoutMs
  });

  function resolveAbout() {
    return typeof aboutInfo === 'function' ? aboutInfo() : (aboutInfo ?? null);
  }

  function buildFullDiagnostics() {
    if (typeof diagnosticsProvider === 'function') return diagnosticsProvider();
    return buildDiagnostics({ aboutInfo: resolveAbout(), now });
  }

  function securityChannel() {
    const contact = resolveSecurityContact(releaseConfig);
    return {
      contactUrl: contact.url,
      contactSource: contact.source,
      notice: '安全漏洞请不要公开提交：请通过官方安全通道报告，并避免在公开渠道披露利用细节。'
    };
  }

  /**
   * 决定这次提交带什么诊断：security → 最小 metadata；其它类型 → 仅在用户勾选时带全量。
   * 返回 { kind, payload }。
   */
  function resolveDiagnostics({ type, attachDiagnostics }) {
    if (isSecurityType(type)) {
      return { kind: 'minimal', payload: minimalDiagnostics({ aboutInfo: resolveAbout(), now }) };
    }
    if (attachDiagnostics === true) {
      return { kind: 'full', payload: sanitizeDiagnostics(buildFullDiagnostics()) };
    }
    return { kind: 'none', payload: null };
  }

  async function attempt(entry) {
    const result = await channel.send(entry);
    const attempts = (Number.isFinite(entry.attempts) ? entry.attempts : 0) + 1;
    const at = new Date(now()).toISOString();
    if (result.ok) {
      return {
        entry: queue.patch(entry.id, { status: 'sent', attempts, lastAttemptAt: at, sentAt: at, nextAttemptAt: null, lastErrorCode: null }),
        result
      };
    }
    const retryable = result.retryable === true;
    if (result.deferred === true) {
      // 官方地址尚未配置（网站未上线）：保持待发、不消耗重试次数、不排退避时间。
      return {
        entry: queue.patch(entry.id, {
          status: 'queued',
          attempts: Number.isFinite(entry.attempts) ? entry.attempts : 0,
          lastAttemptAt: at,
          nextAttemptAt: null,
          lastErrorCode: result.code ?? null
        }),
        result
      };
    }
    return {
      entry: queue.patch(entry.id, {
        status: retryable ? 'queued' : 'failed',
        attempts,
        lastAttemptAt: at,
        nextAttemptAt: retryable ? new Date(now() + retryDelayMs(attempts)).toISOString() : null,
        lastErrorCode: result.code ?? 'UNKNOWN'
      }),
      result
    };
  }

  /** 把到期条目冲一次（尽力而为，绝不影响调用方）。 */
  async function flushDue(max = FLUSH_MAX_PER_CALL) {
    const results = [];
    for (const entry of queue.due(now()).slice(0, Math.max(1, max))) {
      try {
        results.push(await attempt(entry));
      } catch (error) {
        // 单条发送失败不能拖垮其它条目：记录后继续。
        log('Feedback 重试失败（' + entry.id + '）：' + String(error?.message ?? error));
      }
    }
    return results;
  }

  async function submit(input = {}) {
    const normalized = validateSubmission(input);
    const diagnostics = resolveDiagnostics({ type: normalized.type, attachDiagnostics: normalized.attachDiagnostics });
    const about = resolveAbout();
    const id = newFeedbackId(now);
    const createdAt = new Date(now()).toISOString();

    // 先把历史到期条目冲一次（"自动重试"），**再**入队当前这条：
    // 顺序很关键 —— 先入队会把刚写的内容也算进"到期"，导致同一条被尝试两次、退避时间翻倍。
    const flushed = await flushDue();
    queue.enqueue({
      schemaVersion: 1,
      id,
      type: normalized.type,
      title: normalized.title,
      description: normalized.description,
      steps: normalized.steps,
      contact: normalized.contact,
      attachDiagnostics: normalized.attachDiagnostics,
      diagnosticsKind: diagnostics.kind,
      diagnostics: diagnostics.payload,
      product: { name: about?.product ?? 'CetaMesh', version: about?.version ?? null },
      platform: { os: about?.runtime?.platform ?? process.platform, arch: about?.runtime?.arch ?? process.arch },
      createdAt
    });

    const stored = queue.get(id);
    const sent = await attempt(stored);

    return {
      id,
      type: normalized.type,
      status: sent.entry.status,
      sent: sent.result.ok === true,
      queued: sent.entry.status === 'queued',
      offline: sent.result.ok !== true,
      attempts: sent.entry.attempts,
      nextAttemptAt: sent.entry.nextAttemptAt ?? null,
      errorCode: sent.result.ok ? null : (sent.result.code ?? null),
      diagnostics: { attached: diagnostics.payload !== null, kind: diagnostics.kind },
      security: isSecurityType(normalized.type) ? securityChannel() : null,
      flushedEarlier: flushed.length,
      message: sent.result.ok
        ? '反馈已发送，感谢你的反馈。'
        : '反馈已保存在本地，' + (sent.result.message ?? '稍后会自动重试发送。'),
      outbox: queue.stats()
    };
  }

  async function retry({ id } = {}) {
    if (id) {
      const entry = queue.get(id);
      if (!entry) throw feedbackError('FEEDBACK_NOT_FOUND', '未找到该反馈：' + String(id));
      if (entry.status === 'sent') return { results: [{ id: entry.id, status: 'sent', alreadySent: true }], outbox: queue.stats() };
      const outcome = await attempt(entry);
      return {
        results: [{ id: entry.id, status: outcome.entry.status, sent: outcome.result.ok, code: outcome.result.code ?? null, message: outcome.result.message }],
        outbox: queue.stats()
      };
    }
    const outcomes = await flushDue(5);
    return {
      results: outcomes.map((outcome) => ({
        id: outcome.entry.id,
        status: outcome.entry.status,
        sent: outcome.result.ok,
        code: outcome.result.code ?? null,
        message: outcome.result.message
      })),
      outbox: queue.stats()
    };
  }

  function config() {
    let host = null;
    try {
      host = channel.endpoint ? new URL(channel.endpoint).hostname : null;
    } catch {
      host = null; // endpoint 已经过 https 校验；这里只是展示用，取不到就不显示。
    }
    return {
      types: FEEDBACK_TYPES.map((type) => ({ id: type, label: FEEDBACK_TYPE_LABELS[type] })),
      limits: { ...FEEDBACK_LIMITS },
      endpoint: { configured: channel.configured === true, host },
      security: securityChannel(),
      diagnosticsPolicy: DIAGNOSTICS_POLICY,
      outbox: queue.stats(),
      lastError: queue.lastError()
    };
  }

  function previewDiagnostics({ type, attachDiagnostics } = {}) {
    const resolved = resolveDiagnostics({ type: type ?? 'bug', attachDiagnostics: attachDiagnostics === true });
    return { kind: resolved.kind, payload: resolved.payload };
  }

  const handlers = {
    'feedback.config': () => config(),
    'feedback.submit': (p) => submit(p),
    'feedback.retry': (p) => retry(p),
    'feedback.list': (p) => {
      const status = p?.status ? String(p.status) : null;
      const entries = queue.list().filter((entry) => !status || entry.status === status);
      return { entries, outbox: queue.stats(), lastError: queue.lastError() };
    },
    'feedback.remove': (p) => ({ ...queue.remove(p?.id), outbox: queue.stats() }),
    'feedback.clear': (p) => ({ ...queue.clear({ scope: p?.scope === 'all' ? 'all' : 'sent' }), outbox: queue.stats() }),
    'feedback.previewDiagnostics': (p) => previewDiagnostics(p ?? {}),
    'feedback.diagnosticsPolicy': () => ({ policy: DIAGNOSTICS_POLICY })
  };

  return {
    outbox: queue,
    transport: channel,
    config,
    submit,
    retry,
    flushDue,
    previewDiagnostics,
    securityChannel,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(feedbackError('METHOD_NOT_FOUND', '未知 Feedback 方法：' + String(method ?? '')));
      }
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
