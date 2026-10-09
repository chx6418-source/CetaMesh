// CetaMesh Desktop —— 产品文案与配置体验服务（产品化任务 D，第八 / 九节）。
//
// 为什么把它做成服务而不是散在 UI 里：同一句"先添加一个模型"要在聊天页、设置页、
// Agent 页、错误提示里保持一致；技术错误码到用户语言的映射也必须**只有一份**。
// UI 只负责渲染返回的 title/message/action，不自己拼文案、也不自己判断技术码。
//
// 本服务不持有任何状态、不联网、不读写文件：纯函数 + 设置元数据。

import { describeFields } from '../settings/schema.js';
import { describeProviderTestFailure, buildProviderView, providerFieldGuidance } from './provider-view.js';
import { emptyStateFor, emptyStateForError, EMPTY_STATES, TECHNICAL_CODE_TO_STATE } from './empty-states.js';

export function createProductService() {
  const handlers = {
    /** 空状态文案（第九节）：key 来自 EMPTY_STATES。 */
    'product.emptyState': (p) => ({ state: emptyStateFor(p?.key, p?.context ?? {}) }),
    /** 技术错误 → 用户语言：永远返回友好文案，技术细节放在 detail 里另附。 */
    'product.emptyStateForError': (p) => ({ state: emptyStateForError({ code: p?.code, message: p?.message }) }),
    /** Provider 配置视图（第八节）：普通用户只看 基础字段，工程字段收进 advanced。 */
    'product.providerView': () => {
      const view = buildProviderView({ fields: describeFields() });
      return { view, guidance: providerFieldGuidance(view) };
    },
    /** 连接测试失败的友好文案：UI 把 providerSecrets.test 的结果直接丢进来即可。 */
    'product.providerTestFailure': (p) => ({ failure: describeProviderTestFailure(p ?? {}) }),
    /** 文案表本身（UI 可离线渲染，测试可断言覆盖率）。 */
    'product.copy': () => ({ emptyStates: Object.values(EMPTY_STATES), technicalCodeMap: { ...TECHNICAL_CODE_TO_STATE } })
  };

  return {
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(Object.assign(new Error('未知 Product 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      }
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
