// CetaMesh Desktop —— About 服务（阶段 12）。

import { createAboutInfo } from './build-info.js';

export function createAboutService(options = {}) {
  const about = createAboutInfo(options);
  const handlers = {
    'about.info': () => ({ about: about.info() }),
    'about.paths': () => ({ paths: about.paths })
  };
  return {
    about,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(Object.assign(new Error('未知 About 方法：' + String(method)), { code: 'METHOD_NOT_FOUND' }));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
