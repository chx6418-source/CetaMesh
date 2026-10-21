// CetaMesh Desktop —— 最近错误码（有界内存环，产品化任务 D）。
//
// 诊断附件要能回答「最近一次错误码是什么」。做法上刻意**只存错误码，不存错误消息**：
// 错误消息里经常夹带 prompt / 路径 / 凭据片段，一旦进了诊断附件就等于把用户数据带出发动机。
// 码是枚举量（MODEL_PROVIDER_KEY_MISSING、TOOL_DENIED ...），天然可安全外发。
//
// 只保存在内存里（进程重启即清空）：诊断的意义是「这次运行出了什么错」，
// 落盘一份跨会话的错误历史既不必要，也会扩大可被读取的敏感面。

export const ERROR_REGISTRY_LIMIT = 20;

function clean(value, max) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function createErrorRegistry({ limit = ERROR_REGISTRY_LIMIT, now = () => Date.now() } = {}) {
  const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : ERROR_REGISTRY_LIMIT;
  const entries = [];

  /** 记录一个错误码（不含消息、不含堆栈）。空码直接忽略，避免污染诊断。 */
  function record(code, { source = null } = {}) {
    const normalized = clean(code, 64);
    if (!normalized) return null;
    const entry = {
      code: normalized,
      source: clean(source, 48),
      at: new Date(now()).toISOString()
    };
    entries.push(entry);
    if (entries.length > safeLimit) entries.splice(0, entries.length - safeLimit);
    return entry;
  }

  /** 从任意 error 对象上取码；没有 code 时用 fallback（默认不记录）。 */
  function recordError(error, { source = null, fallback = null } = {}) {
    const code = clean(error?.code, 64) || clean(fallback, 64);
    return code ? record(code, { source }) : null;
  }

  return {
    record,
    recordError,
    last: () => (entries.length ? { ...entries[entries.length - 1] } : null),
    list: () => entries.map((entry) => ({ ...entry })),
    clear: () => {
      const count = entries.length;
      entries.length = 0;
      return count;
    },
    size: () => entries.length
  };
}
