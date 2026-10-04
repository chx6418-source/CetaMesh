// CetaMesh Desktop —— 设置服务（阶段 12）。
//
// 分层：IPC(settings.*) → 本模块 → SettingsStore。
// 同时暴露页面树与字段元数据，UI 只负责渲染，不自己维护分区/默认值/锁定语义。

import { createSettingsStore } from './store.js';
import { SETTING_SECTIONS, SECTION_LABELS, describeFields, settingsError } from './schema.js';
import { ENGINEERING_PAGES, PRIMARY_PAGES, engineeringPlacement } from './pages.js';

export function createSettingsService({ stateDir, now } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createSettingsService 需要 stateDir');
  const store = createSettingsStore({ stateDir, now });

  const handlers = {
    'settings.get': () => store.get(),
    'settings.describe': () => ({
      sections: SETTING_SECTIONS.map((section) => ({ section, label: SECTION_LABELS[section] })),
      fields: describeFields(),
      primaryPages: [...PRIMARY_PAGES],
      engineeringPages: [...ENGINEERING_PAGES],
      engineeringPlacement: engineeringPlacement()
    }),
    'settings.update': (p) => store.update(p.section, p.values, { merge: p.merge !== false, expectedRev: p.expectedRev }),
    'settings.reset': (p) => store.reset(p.section),
    'settings.resetAll': () => store.resetAll()
  };

  return {
    stateDir,
    store,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(settingsError('METHOD_NOT_FOUND', '未知 Settings 方法：' + String(method)));
      return Promise.resolve().then(() => handler(params || {}));
    }
  };
}
