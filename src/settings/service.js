// CetaMesh Desktop —— 设置服务（阶段 12）。
//
// 分层：IPC(settings.*) → 本模块 → SettingsStore。
// 同时暴露页面树与字段元数据，UI 只负责渲染，不自己维护分区/默认值/锁定语义。

import { createSettingsStore } from './store.js';
import { SETTING_SECTIONS, SECTION_LABELS, describeFields, settingsError } from './schema.js';
import { ENGINEERING_PAGES, PRIMARY_PAGES, engineeringPlacement } from './pages.js';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeSkillSources } from '../context/skill-sources.js';

export function createSettingsService({ stateDir, now } = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createSettingsService 需要 stateDir');
  const store = createSettingsStore({ stateDir, now });

  function updateSettings(p) {
    if (p.section === 'extensions' && Object.hasOwn(p.values ?? {}, 'skillSources')) {
      const current = store.get().settings.extensions.skillSources;
      const supplied = normalizeSkillSources(p.values.skillSources);
      if (JSON.stringify(supplied) !== JSON.stringify(current))
        throw settingsError('SKILL_SOURCE_OWNER_COMMAND_REQUIRED', 'Use the explicit Owner Skill source registration commands');
    }
    return store.update(p.section, p.values, { merge: p.merge !== false, expectedRev: p.expectedRev });
  }
  function sourceCommand(operation, p, actor) {
    if (actor?.kind !== 'owner' || actor.id !== 'desktop')
      throw settingsError('PERMISSION_DENIED', 'Skill source registration requires authenticated Desktop Owner control');
    const current = store.get();
    if (!Number.isSafeInteger(p.expectedRev) || p.expectedRev !== current.revision)
      throw settingsError('SETTINGS_CONFLICT', 'Settings changed; refresh the reviewed Skill source configuration');
    if (typeof p.sourceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(p.sourceId))
      throw settingsError('SKILL_SOURCE_CONFIG_INVALID', 'A bounded Skill source ID is required');
    const rows = current.settings.extensions.skillSources;
    const index = rows.findIndex(row => row.sourceId.toLowerCase() === p.sourceId.toLowerCase());
    let next;
    if (operation === 'remove') {
      if (index < 0) throw settingsError('SKILL_SOURCE_NOT_FOUND', 'The registered Skill source no longer exists');
      next = rows.filter((_, i) => i !== index);
    } else {
      if (typeof p.enabled !== 'boolean') throw settingsError('SKILL_SOURCE_CONFIG_INVALID', 'Explicit reference text enablement is required');
      if (operation === 'register' && index >= 0) throw settingsError('SKILL_SOURCE_EXISTS', 'This Skill source ID is already registered');
      if (operation === 'setEnabled' && index < 0) throw settingsError('SKILL_SOURCE_NOT_FOUND', 'The registered Skill source no longer exists');
      const root = operation === 'register' ? p.root : rows[index].root;
      const [clean] = normalizeSkillSources([{ sourceId: p.sourceId, root, revision: current.revision + 1, enabled: p.enabled }]);
      if (operation === 'register' || p.enabled) {
        try {
          const actual = fs.realpathSync(clean.root), stat = fs.lstatSync(clean.root);
          const same = process.platform === 'win32' ? actual.toLowerCase() === path.resolve(clean.root).toLowerCase() : actual === path.resolve(clean.root);
          if (!same || !stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid source directory');
          clean.root = actual;
        } catch { throw settingsError('SKILL_SOURCE_DIRECTORY_INVALID', 'Choose an existing local directory with no links'); }
      }
      if (operation === 'setEnabled' && rows[index].enabled === p.enabled) return { settings: current.settings, revision: current.revision };
      next = operation === 'register' ? [...rows, clean] : rows.map((row, i) => i === index ? { ...clean, sourceId: row.sourceId } : row);
    }
    // A source generation uses the monotonically increasing Settings CAS revision,
    // so remove/re-register and disable/re-enable cannot revive old content refs.
    return store.update('extensions', { skillSources: normalizeSkillSources(next) }, { expectedRev: p.expectedRev });
  }

  const handlers = {
    'settings.get': () => store.get(),
    'settings.describe': () => ({
      sections: SETTING_SECTIONS.map((section) => ({ section, label: SECTION_LABELS[section] })),
      fields: describeFields(),
      primaryPages: [...PRIMARY_PAGES],
      engineeringPages: [...ENGINEERING_PAGES],
      engineeringPlacement: engineeringPlacement()
    }),
    'settings.update': updateSettings,
    'settings.skillSources.register': (p, actor) => sourceCommand('register', p, actor),
    'settings.skillSources.setEnabled': (p, actor) => sourceCommand('setEnabled', p, actor),
    'settings.skillSources.remove': (p, actor) => sourceCommand('remove', p, actor),
    'settings.reset': (p) => store.reset(p.section),
    'settings.resetAll': () => store.resetAll()
  };

  return {
    stateDir,
    store,
    execute({ method, params, actor } = {}) {
      const handler = handlers[method];
      if (!handler) return Promise.reject(settingsError('METHOD_NOT_FOUND', '未知 Settings 方法：' + String(method)));
      return Promise.resolve().then(() => handler(params || {}, actor));
    }
  };
}
