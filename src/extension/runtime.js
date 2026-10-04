// CetaMesh Desktop Extension v1 —— 启用 / 禁用 / 调用（阶段 10）。
//
// 启用 = 用 manifest 声明的权限构造受限宿主并挂上能力；禁用 = 丢弃宿主、清空加载状态。
// 调用只允许调用 manifest 里声明、且所需权限均已授予的能力。

import fs from 'node:fs';
import path from 'node:path';
import { createExtensionHost } from './host.js';
import { createExtensionInstaller } from './installer.js';
import { reviewSummaryLines } from './review.js';
import { extensionError } from './types.js';

export function createExtensionRuntime({ store, fetchImpl = null, now = () => Date.now() } = {}) {
  if (!store) throw new Error('createExtensionRuntime 需要 store');
  const installer = createExtensionInstaller({ store, now });
  const hosts = new Map(); // id -> host

  function entryOrThrow(id) {
    const entry = store.get(id);
    if (!entry) throw extensionError('NOT_INSTALLED', '扩展未安装：' + String(id));
    return entry;
  }

  function buildHost(entry) {
    const entryPath = path.join(entry.sourceRoot, entry.manifest.entry);
    if (!fs.existsSync(entryPath)) {
      throw extensionError('ENTRY_MISSING', '受管目录中的入口文件缺失：' + entry.manifest.entry + '（请重新安装）');
    }
    const source = fs.readFileSync(entryPath, 'utf8');
    return createExtensionHost({
      manifest: entry.manifest,
      source,
      storage: store.storage(entry.id),
      fetchImpl
    });
  }

  function hostOrThrow(id) {
    const entry = entryOrThrow(id);
    if (entry.status !== 'enabled') {
      throw extensionError('EXTENSION_DISABLED', '扩展未启用：' + entry.id);
    }
    let host = hosts.get(entry.id);
    if (!host) {
      // 重启后注册表里仍是 enabled，但宿主不在内存里：这里惰性重建，
      // 让"启用"这个状态跨重启真正生效，而不是要求用户再点一次。
      host = buildHost(entry);
      if (!host.available()) {
        const failure = host.loadError();
        throw extensionError(failure.code, '扩展加载失败：' + failure.message);
      }
      hosts.set(entry.id, host);
    }
    return { entry, host };
  }

  return {
    installer,

    list() {
      return store.list();
    },

    get({ id } = {}) {
      const entry = entryOrThrow(id);
      return { extension: entry, loaded: hosts.has(entry.id) };
    },

    /** UI 用聚合：已安装列表 + 各自权限摘要 + 运行状态。 */
    overview() {
      const entries = store.list();
      return {
        extensions: entries.map((entry) => ({
          id: entry.id,
          name: entry.name,
          version: entry.version,
          type: entry.type,
          status: entry.status,
          riskLevel: entry.riskLevel,
          permissions: entry.permissions,
          capabilities: (entry.manifest.capabilities || []).map((c) => c.id),
          loaded: hosts.has(entry.id),
          updatedAt: entry.updatedAt
        })),
        total: entries.length,
        enabled: entries.filter((e) => e.status === 'enabled').length
      };
    },

    review({ sourceDir } = {}) {
      const reviewed = installer.reviewFromDirectory({ sourceDir });
      return {
        review: reviewed.review,
        summary: reviewSummaryLines(reviewed.review),
        scan: reviewed.scan,
        files: reviewed.files,
        bytes: reviewed.bytes
      };
    },

    install({ sourceDir, approval } = {}) {
      const result = installer.install({ sourceDir, approval });
      hosts.delete(result.entry.id);
      return result;
    },

    update({ sourceDir, approval } = {}) {
      const result = installer.update({ sourceDir, approval });
      hosts.delete(result.entry.id); // 旧宿主作废，需重新启用
      return result;
    },

    uninstall({ id, keepFiles } = {}) {
      const entry = entryOrThrow(id);
      hosts.delete(entry.id);
      return installer.uninstall({ id: entry.id, keepFiles });
    },

    enable({ id } = {}) {
      const entry = entryOrThrow(id);
      if (entry.status === 'enabled' && hosts.has(entry.id)) {
        return { extension: entry, changed: false };
      }
      const host = buildHost(entry);
      if (!host.available()) {
        hosts.delete(entry.id);
        const failure = host.loadError();
        throw extensionError(failure.code, '扩展加载失败：' + failure.message);
      }
      hosts.set(entry.id, host);
      const updated = store.put({ ...entry, status: 'enabled', enabledAt: now(), updatedAt: now() });
      return { extension: updated, changed: true };
    },

    disable({ id } = {}) {
      const entry = entryOrThrow(id);
      hosts.delete(entry.id);
      if (entry.status === 'disabled') return { extension: entry, changed: false };
      const updated = store.put({ ...entry, status: 'disabled', disabledAt: now(), updatedAt: now() });
      return { extension: updated, changed: true };
    },

    async invoke({ id, capability, input } = {}) {
      const { host } = hostOrThrow(id);
      return host.invoke(capability, input === undefined ? null : input);
    },

    logs({ id } = {}) {
      entryOrThrow(id);
      const host = hosts.get(String(id));
      return { logs: host ? host.logs : [], loaded: Boolean(host) };
    },

    close() {
      hosts.clear();
    }
  };
}
