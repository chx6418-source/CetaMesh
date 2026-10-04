// CetaMesh Desktop —— Update 服务（阶段 12）。
//
// 配置（清单地址 / 固定公钥 / 通道 / 允许主机）来自产品设置，因此 UI 改设置即可生效。
// 构造时不发起网络请求；只有显式调用 update.check 才会联网。

import { createUpdateChecker } from './checker.js';

export function createUpdateService({ currentVersion, settingsStore = null, fetchImpl = null } = {}) {
  const checker = createUpdateChecker({ currentVersion, fetchImpl });

  function effectiveConfig() {
    if (!settingsStore) return { channel: 'stable', manifestUrl: '', pinnedPublicKey: '', allowedHosts: [] };
    const { settings } = settingsStore.get();
    return {
      channel: settings.updates.channel,
      manifestUrl: settings.updates.manifestUrl,
      pinnedPublicKey: settings.updates.pinnedPublicKey,
      allowedHosts: String(settings.security.allowedUpdateHosts || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    };
  }

  const handlers = {
    'update.capabilities': () => checker.capabilities(),
    'update.config': () => ({ config: { ...effectiveConfig(), pinnedPublicKey: effectiveConfig().pinnedPublicKey ? '[configured]' : '' } }),
    'update.check': (p) => {
      const config = effectiveConfig();
      return checker.check({
        manifestUrl: p.manifestUrl === undefined ? config.manifestUrl : p.manifestUrl,
        pinnedPublicKey: p.pinnedPublicKey === undefined ? config.pinnedPublicKey : p.pinnedPublicKey,
        channel: p.channel === undefined ? config.channel : p.channel,
        allowedHosts: config.allowedHosts
      });
    }
  };

  return {
    checker,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(Object.assign(new Error('未知 Update 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
