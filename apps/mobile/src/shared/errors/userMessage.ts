import type {CetaErrorCode} from './CetaErrorCode';

const messages: Partial<Record<CetaErrorCode, string>> = {
  provider_error: '模型服务返回异常',
  timeout: '模型响应超时',
  network_unavailable: '网络连接中断',
  unsupported: '回答内容超过限制',
  invalid_protocol: '响应格式异常',
  unauthorized: '模型服务认证失败',
  cancelled: '回答已停止',
};

export function userErrorMessage(code: CetaErrorCode): string {
  return messages[code] ?? '操作失败，请重试';
}
