// CetaMesh Desktop Extension v1 —— 桌面扩展服务（阶段 10）。
//
// 分层：IPC(ext.*) → 本模块（方法白名单）→ Extension Runtime → 受限宿主。
// 与 memory/task 同一约定：ext.* 只经桌面 Shell 的命名管道暴露。

import { createExtensionRuntime } from './runtime.js';
import { createExtensionStore } from './store.js';
import { extensionError } from './types.js';
import { createExtensionSettingsService } from './settings.js';

export function createExtensionService({
  stateDir, fetchImpl = null, capabilityBroker = null, hostFactory,
  processHostFactory, vmHostFactory, memoryPackHostFactory, isTrustedVmExtension,
  now, monitorIntervalMs, heartbeatTimeoutMs, maxHeartbeatMisses,
  maxAutomaticRestarts, restartWindowMs, stableWindowMs
} = {}) {
  if (!stateDir || typeof stateDir !== 'string') throw new Error('createExtensionService 需要 stateDir');
  const store = createExtensionStore({ stateDir, now });
  const runtime = createExtensionRuntime({ store, fetchImpl, capabilityBroker, hostFactory,
    processHostFactory, vmHostFactory, memoryPackHostFactory, isTrustedVmExtension, now,
    monitorIntervalMs, heartbeatTimeoutMs, maxHeartbeatMisses, maxAutomaticRestarts, restartWindowMs, stableWindowMs });

  const settings = createExtensionSettingsService({ stateDir, getExtension: id => runtime.get({ id }) });

  const handlers = {
    'ext.overview': () => runtime.overview(),
    'ext.list': () => ({ extensions: runtime.list() }),
    'ext.get': (p) => runtime.get({ id: p.id }),
    'ext.review': (p) => runtime.review({ sourceDir: p.sourceDir }),
    'ext.rollback.review': (p) => runtime.reviewRollback({ id: p.id }),
    'ext.install': (p) => runtime.install({ sourceDir: p.sourceDir, approval: p.approval }),
    'ext.update': (p) => runtime.update({ sourceDir: p.sourceDir, approval: p.approval }),
    'ext.rollback': (p) => runtime.rollback({ id: p.id, approval: p.approval }),
    'ext.uninstall': (p) => runtime.uninstall({ id: p.id, keepFiles: p.keepFiles === true }),
    'ext.enable': (p) => runtime.enable({ id: p.id }),
    'ext.disable': (p) => runtime.disable({ id: p.id }),
    'ext.restart': (p) => runtime.restart({ id: p.id }),
    'ext.invoke': (p) => runtime.invoke({ id: p.id, capability: p.capability, input: p.input }),
    'ext.logs': (p) => runtime.logs({ id: p.id }),
    'ext.memory-pack.overlay': (p) => runtime.updateMemoryPackOverlay({ id: p.id, patch: p.patch }),
    'ext.settings.describe': p => settings.describe({ id: p.id }),
    'ext.settings.get': p => settings.get({ id: p.id }),
    'ext.settings.update': p => settings.update({ id: p.id, values: p.values })
  };

  return {
    stateDir,
    store,
    runtime,
    execute({ method, params } = {}) {
      const handler = handlers[method];
      if (!handler) {
        return Promise.reject(extensionError('METHOD_NOT_FOUND', '未知 Extension 方法：' + String(method)));
      }
      return Promise.resolve().then(() => handler(params || {}));
    },
    close() {
      return runtime.close();
    }
  };
}
