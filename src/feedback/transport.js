// CetaMesh Desktop —— 反馈发送通道（产品化任务 D，第五节）。
//
// 职责单一：把一条已经过 redaction 的反馈 POST 到**官方发行配置**里的 endpoint。
// 这里不做任何本地状态决策（重试/丢弃由 outbox + service 决定），也**从不抛错**：
// 网络不可用是常态而非异常，反馈服务器没上线时更不该让调用方处理异常。
//
// 安全约束：
//   - endpoint 必须是 https 绝对地址；http / 非法地址一律拒绝（反馈会带诊断信息，明文传输不可接受）；
//   - 超时用 AbortController 硬约束，避免"发送中"卡住 UI；
//   - 只发送调用方传入的 payload（白名单结构由 diagnostics.sanitizeDiagnostics 保证）。

export const FEEDBACK_TRANSPORT_CODES = Object.freeze({
  ENDPOINT_NOT_CONFIGURED: 'ENDPOINT_NOT_CONFIGURED',
  INSECURE_ENDPOINT: 'INSECURE_ENDPOINT',
  NO_FETCH: 'NO_FETCH',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  HTTP_ERROR: 'HTTP_ERROR',
  REJECTED: 'REJECTED'
});

export const FEEDBACK_TIMEOUT_MS_DEFAULT = 4000;
export const FEEDBACK_MAX_BODY_BYTES = 256 * 1024;

function validEndpoint(value) {
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, reason: FEEDBACK_TRANSPORT_CODES.ENDPOINT_NOT_CONFIGURED };
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return { ok: false, reason: FEEDBACK_TRANSPORT_CODES.INSECURE_ENDPOINT };
    return { ok: true, url: url.toString() };
  } catch {
    return { ok: false, reason: FEEDBACK_TRANSPORT_CODES.ENDPOINT_NOT_CONFIGURED };
  }
}

/** 4xx（除 429）是「服务器明确拒绝」：重试没有意义，重试只会骚扰对方。 */
function retryableForStatus(status) {
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

export function createFeedbackTransport({
  endpoint = null,
  fetchImpl = null,
  timeoutMs = FEEDBACK_TIMEOUT_MS_DEFAULT,
  userAgent = 'CetaMesh-Desktop-feedback',
  now = () => Date.now()
} = {}) {
  const resolved = validEndpoint(endpoint);
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);

  function configure(nextEndpoint) {
    return validEndpoint(nextEndpoint);
  }

  /** 发送一条反馈。永远 resolve：{ok, status, code, message, retryable}。 */
  async function send(entry) {
    const check = validEndpoint(endpoint);
    if (!check.ok) {
      // deferred：这不是"发送失败"，而是"还没有可用的官方地址"（网站未上线）。
      // 调用方据此把条目留在队列里、不消耗重试次数 —— 配置就绪后自然会被冲出去。
      return {
        ok: false,
        status: 0,
        code: check.reason,
        retryable: false,
        deferred: check.reason === FEEDBACK_TRANSPORT_CODES.ENDPOINT_NOT_CONFIGURED,
        message: check.reason === FEEDBACK_TRANSPORT_CODES.INSECURE_ENDPOINT ? '反馈地址必须使用 https' : '官方反馈地址尚未配置，反馈已保存在本地队列'
      };
    }
    if (!doFetch) {
      return { ok: false, status: 0, code: FEEDBACK_TRANSPORT_CODES.NO_FETCH, retryable: false, deferred: true, message: '当前运行时不支持网络请求，反馈已保存在本地队列' };
    }

    const body = JSON.stringify(entry);
    if (Buffer.byteLength(body, 'utf8') > FEEDBACK_MAX_BODY_BYTES) {
      // 超限说明调用方拼了不该拼的东西：不静默截断（截断会丢用户正文），如实返回不可重试错误。
      return { ok: false, status: 0, code: 'BODY_TOO_LARGE', retryable: false, message: '反馈内容过大，请精简后重试' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || FEEDBACK_TIMEOUT_MS_DEFAULT));
    try {
      const response = await doFetch(check.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': userAgent },
        body,
        signal: controller.signal
      });
      const status = Number(response?.status ?? 0);
      if (response?.ok) {
        return { ok: true, status, code: null, retryable: false, message: '反馈已发送', sentAt: new Date(now()).toISOString() };
      }
      const retryable = retryableForStatus(status);
      return {
        ok: false,
        status,
        code: retryable ? FEEDBACK_TRANSPORT_CODES.HTTP_ERROR : FEEDBACK_TRANSPORT_CODES.REJECTED,
        retryable,
        message: retryable ? `反馈服务器暂时不可用（HTTP ${status}），已保留在本地队列` : `反馈被服务器拒绝（HTTP ${status}），请检查内容后重新提交`
      };
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      return {
        ok: false,
        status: 0,
        code: aborted ? FEEDBACK_TRANSPORT_CODES.TIMEOUT : FEEDBACK_TRANSPORT_CODES.NETWORK_ERROR,
        retryable: true,
        message: aborted ? '反馈发送超时，已保留在本地队列，稍后自动重试' : '网络不可用，已保留在本地队列，稍后自动重试'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    endpoint: resolved.ok ? resolved.url : null,
    configured: resolved.ok,
    configure,
    send
  };
}
