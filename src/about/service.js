// CetaMesh Desktop —— About 服务（阶段 12 / 产品化任务 D）。
//
// 对外契约（UI 后续直接消费这些字段，不需要自己拼产品事实）：
//   about.info   —— 版本 / Build ID / Commit / 平台 / 架构 / 开发者 / 官网 / GitCode / GitHub /
//                   许可证 / 隐私说明 / 安全说明 / 发布清单 / 发行配置完整度 / 诊断入口
//   about.paths  —— 各事实源文件路径（排障用）
//   about.update —— 更新区块（当前版本 + 最近一次更新公告 + 下载源 + 上次检查状态），
//                   **离线可用**：只读本地公告缓存，不联网
//   about.diagnostics —— 已 redaction 的诊断附件（与反馈附件同一份实现，保证口径一致）
//
// 设计约束：About 永远不阻塞、不联网、不抛未映射错误 —— 它是"用户怀疑版本不对"时第一眼要看的地方。

import { createAboutInfo } from './build-info.js';
import { DIAGNOSTICS_POLICY } from '../product/diagnostics.js';
import { updateConfigurationIssue } from '../update/checker.js';

export function createAboutService(options = {}) {
  const notesCache = options.notesCache ?? null;
  const diagnosticsProvider = options.diagnosticsProvider ?? null;
  const about = createAboutInfo(options);

  /** 更新区块：当前版本来自 package.json，公告来自**已验签**的本地缓存。 */
  function updateSummary() {
    const info = about.info();
    const issue = options.updateConfigProvider ? updateConfigurationIssue(options.updateConfigProvider()) : null;
    if (!notesCache) {
      return {
        currentVersion: info.version,
        cacheAvailable: false,
        announcement: null,
        latest: null,
        status: issue ? 'not_configured' : 'unknown',
        checkedAt: null,
        source: null,
        sources: [],
        failureCode: issue?.code ?? null,
        failureMessage: issue?.message ?? null,
        lastError: null
      };
    }
    const cached = notesCache.read();
    const record = cached.record;
    const cachedConfigFailure = ['NO_PINNED_KEY', 'NO_MANIFEST_URL'].includes(record?.failureCode);
    const configurationRepaired = Boolean(options.updateConfigProvider && !issue && cachedConfigFailure);
    return {
      currentVersion: info.version,
      cacheAvailable: record !== null,
      announcement: record?.announcement ?? null,
      latest: record?.latest ?? null,
      status: issue ? 'not_configured' : configurationRepaired ? 'unknown'
        : cachedConfigFailure ? 'not_configured' : record?.status ?? 'unknown',
      checkedAt: record?.checkedAt ?? null,
      source: record?.source ?? null,
      // 下载源列表：UI 展示「从哪来」（GitCode 优先 / GitHub 备用），不含签名公钥。
      sources: record?.sources ?? [],
      failureCode: configurationRepaired ? null : issue?.code ?? record?.failureCode ?? null,
      failureMessage: configurationRepaired ? null : issue?.message ?? record?.failureMessage ?? null,
      lastError: cached.lastError ?? null
    };
  }

  const handlers = {
    'about.info': () => ({ about: about.info() }),
    'about.paths': () => ({ paths: about.paths }),
    'about.update': () => ({ update: updateSummary() }),
    'about.diagnostics': () => ({
      diagnostics: diagnosticsProvider ? diagnosticsProvider() : null,
      policy: DIAGNOSTICS_POLICY
    })
  };

  return {
    about,
    updateSummary,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(Object.assign(new Error('未知 About 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
