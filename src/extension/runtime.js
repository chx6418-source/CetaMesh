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
import { createMemoryPackHost } from './memory-pack.js';
import { createCapabilityBroker } from '../capability/broker.js';
import { createCapabilityPolicy } from '../capability/policy.js';

export function createExtensionRuntime({ store, fetchImpl = null, capabilityBroker = null, hostFactory = createExtensionHost, now = () => Date.now() } = {}) {
  if (!store) throw new Error('createExtensionRuntime 需要 store');
  const installer = createExtensionInstaller({ store, now });
  const hosts = new Map(); // id -> host
  const broker = capabilityBroker || createCapabilityBroker({ policy: createCapabilityPolicy() });
  if (!capabilityBroker) {
    broker.register({ id: 'network', permission: 'network', risk: 'high', provider: 'extension-adapter', execute: async r => {
      if (typeof fetchImpl !== 'function') throw extensionError('PROVIDER_UNAVAILABLE', 'Network adapter unavailable');
      return fetchImpl(r.input.url, r.input.init);
    }});
  }
  const actors = new Map();
  function actorFor(entry) {
    // Only installed manifest/review metadata creates grants, never handler input.
    const scope = entry.manifest.scope?.workspace;
    return { kind: 'extension', id: entry.id, grants: {
      capabilities: [...entry.permissions, ...(entry.manifest.capabilities || []).map(c => 'extension.' + entry.id + '.' + c.id)],
      approvedCapabilities: entry.permissions.filter(p => ['network', 'filesystem.read', 'filesystem.write', 'memory.write'].includes(p)),
      workspaceIds: scope ? [scope] : [], paths: entry.manifest.scope?.paths || [], hosts: entry.manifest.network?.hosts || [],
      scopes: scope ? ['workspace:' + scope] : [], types: ['working', 'workspace', 'knowledge', 'skill']
    }};
  }
  function registerEntry(entry) {
    actors.set(entry.id, actorFor(entry));
    for (const cap of entry.manifest.capabilities || []) {
      const id = 'extension.' + entry.id + '.' + cap.id;
      if (broker.registry.has(id)) continue;
      broker.register({ id, permission: 'extension.invoke', provider: 'extension', risk: 'low', execute: async r => {
        const { entry: current, host } = hostOrThrow(entry.id);
        if (!current.manifest.capabilities.some(c => c.id === cap.id)) throw extensionError('CAPABILITY_NOT_DECLARED', cap.id);
        return host.invoke(cap.id, r.input);
      }});
    }
  }

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
    registerEntry(entry);
    const factory = entry.type === 'memory-pack' ? createMemoryPackHost : hostFactory;
    return factory({
      manifest: entry.manifest,
      source,
      storage: store.storage(entry.id),
      fetchImpl,
      capabilityExecutor: async (capability, input) => {
        const current = entryOrThrow(entry.id);
        if (current.status !== 'enabled') throw extensionError('EXTENSION_DISABLED', entry.id);
        const result = await broker.execute({ actor: actorFor(current), capability,
          workspaceId: current.manifest.scope?.workspace || undefined, input: input || {}, reason: 'Installed Extension capability' });
        if (result.status !== 'completed') throw extensionError('APPROVAL_REQUIRED', result.approvalId);
        return result.result;
      }
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
      const { entry } = hostOrThrow(id);
      if (!entry.manifest.capabilities.some(c => c.id === capability)) throw extensionError('CAPABILITY_NOT_DECLARED', String(capability));
      const result = await broker.execute({ actor: actorFor(entry), capability: 'extension.' + entry.id + '.' + capability,
        input: input === undefined ? null : input, reason: 'Extension invocation' });
      return result.result;
    },

    updateMemoryPackOverlay({ id, patch } = {}) {
      const { entry, host } = hostOrThrow(id);
      if (entry.type !== 'memory-pack') throw extensionError('MEMORY_PACK_INVALID', 'Not a Memory Pack');
      return host.updateOverlay({ principal: { kind: 'user', id: 'desktop' }, patch });
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
