// CetaMesh Desktop —— 反馈类型与校验（产品化任务 D，第三 / 六节）。
//
// 五类反馈是产品契约（UI 直接渲染 label），不是自由文本：
//   bug=缺陷 / feature=功能建议 / experience=体验问题 / security=安全漏洞 / other=其它。
//
// security 特殊（第六节）：它走「最小 metadata + 官方安全入口」，**不自动附加日志**。
// 这不是提示文案，而是 service 层的硬规则（见 service.js），避免用户无意中把
// 可能包含漏洞利用细节、内网地址、凭据痕迹的诊断信息发进普通反馈通道。

export const FEEDBACK_SCHEMA_VERSION = 1;

export const FEEDBACK_TYPES = Object.freeze(['bug', 'feature', 'experience', 'security', 'other']);

export const FEEDBACK_TYPE_LABELS = Object.freeze({
  bug: '缺陷（Bug）',
  feature: '功能建议',
  experience: '体验问题',
  security: '安全漏洞',
  other: '其它'
});

export const SECURITY_FEEDBACK_TYPE = 'security';

export const FEEDBACK_LIMITS = Object.freeze({
  title: 120,
  description: 4000,
  steps: 2000,
  contact: 200
});

export function feedbackError(code, message, extra = {}) {
  return Object.assign(new Error(message), { name: 'FeedbackError', code, ...extra });
}

export function isSecurityType(type) {
  return String(type ?? '') === SECURITY_FEEDBACK_TYPE;
}

function text(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/\r\n/g, '\n').trim().slice(0, max);
}

/** 联系方式：不强制格式（可能是邮箱、群号、GitHub 账号），但拒绝控制字符。 */
function contact(value) {
  const raw = text(value, FEEDBACK_LIMITS.contact);
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * 校验并归一化一条反馈。失败抛 FeedbackError('FEEDBACK_INVALID')，带 field 便于 UI 定位。
 * 注意：安全漏洞的「不要公开提交」是 UI 必须展示的提示，但**不是**校验规则 ——
 * 用户仍然可以提交，我们只是不把日志挂上去并给出官方安全通道。
 */
export function validateSubmission(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw feedbackError('FEEDBACK_INVALID', '反馈内容必须是对象', { field: null });
  }
  const type = text(input.type, 20).toLowerCase();
  if (!FEEDBACK_TYPES.includes(type)) {
    throw feedbackError('FEEDBACK_INVALID', '未知反馈类型：' + (type || '(空)'), { field: 'type' });
  }
  const title = text(input.title, FEEDBACK_LIMITS.title);
  if (!title) throw feedbackError('FEEDBACK_INVALID', '请填写标题', { field: 'title' });
  const description = text(input.description, FEEDBACK_LIMITS.description);
  if (!description) throw feedbackError('FEEDBACK_INVALID', '请填写描述', { field: 'description' });

  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    type,
    title,
    description,
    steps: text(input.steps, FEEDBACK_LIMITS.steps),
    contact: contact(input.contact),
    // 用户意图：是否希望附加诊断信息。security 类型在 service 层会被强制忽略。
    attachDiagnostics: input.attachDiagnostics === true
  };
}

/** 稳定且可读的反馈 id：时间前缀便于人工排查，随机后缀避免同毫秒碰撞。 */
export function newFeedbackId(now = () => Date.now()) {
  const stamp = Number(now());
  const timePart = Number.isFinite(stamp) && stamp > 0 ? stamp.toString(36) : 'x';
  return 'fb-' + timePart + '-' + Math.random().toString(36).slice(2, 8);
}
