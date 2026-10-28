// CetaMesh Desktop Extension v1 —— 启用 / 禁用 / 调用（阶段 10）。
//
// 启用 = 用 manifest 声明的权限构造受限宿主并挂上能力；禁用 = 丢弃宿主、清空加载状态。
// 调用只允许调用 manifest 里声明、且所需权限均已授予的能力。

import fs from 'node:fs';
import crypto from 'node:crypto';
import {requestFingerprint} from '../capability/approval.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import { createVmExtensionHost } from './host.js';
import { createProcessExtensionHost } from './process-host.js';
import { createExtensionInstaller } from './installer.js';
import { reviewSummaryLines, permissionDelta } from './review.js';
import { extensionError } from './types.js';
import { createMemoryPackHost } from './memory-pack.js';
import { manifestFingerprint } from './manifest.js';
import { createCapabilityBroker } from '../capability/broker.js';
import { createCapabilityPolicy } from '../capability/policy.js';
import { fingerprintExtensionPackage } from './package-fingerprint.js';
import {isHttpDataManifest,createHttpExtensionHost,httpRequestFor,projectHttpResult} from './http-host.js';
import {validateSchema} from '../model/input-schema.js';

export function createExtensionRuntime({
  store,
  fetchImpl = null,
  capabilityBroker = null,
  hostFactory = null,
  processHostFactory = createProcessExtensionHost,
  vmHostFactory = createVmExtensionHost,
  memoryPackHostFactory = createMemoryPackHost,
  isTrustedVmExtension = () => false,
  now = () => Date.now(),
  monitorIntervalMs = 15_000,
  heartbeatTimeoutMs = 3_000,
  maxHeartbeatMisses = 3,
  maxAutomaticRestarts = 3,
  restartWindowMs = 300_000,
  stableWindowMs = 300_000
} = {}) {
  if (!store) throw new Error('createExtensionRuntime 需要 store');
  const installer = createExtensionInstaller({ store, now });
  const hosts = new Map(); // id -> host
  const runtimeRecords = new Map();
  const pendingReviews = new Map();
  const regularHostFactory = hostFactory || processHostFactory;
  const trustedVmFactory = hostFactory || vmHostFactory;
  const broker = capabilityBroker || createCapabilityBroker({ policy: createCapabilityPolicy() });
  if (!capabilityBroker) {
    broker.register({ id: 'network', permission: 'network', risk: 'high', provider: 'extension-adapter', execute: async r => {
      if (typeof fetchImpl !== 'function') throw extensionError('PROVIDER_UNAVAILABLE', 'Network adapter unavailable');
      return fetchImpl(r.input.url, { ...(r.input.init || {}), signal: r.signal });
    }});
  }
  const actors = new Map();
  const invocationAuthority=new AsyncLocalStorage();
  function runtimeRecord(id) {
    const key = String(id);
    if (!runtimeRecords.has(key)) runtimeRecords.set(key, {
      state: 'stopped', startedAt: null, healthySince: null, heartbeatMisses: 0,
      restartTimes: [], monitorTimer: null, recovering: false, switching: false,
      suppressRecovery: false, lastError: null
    });
    return runtimeRecords.get(key);
  }

  function runtimeState(entry) {
    if (entry.status === 'disabled_due_to_crash') return 'crashed';
    if (entry.status !== 'enabled') return 'stopped';
    return runtimeRecord(entry.id).state;
  }

  function clearMonitor(id) {
    const record = runtimeRecord(id);
    if (record.monitorTimer) clearTimeout(record.monitorTimer);
    record.monitorTimer = null;
  }

  function scheduleMonitor(id) {
    if (!(monitorIntervalMs > 0) || !hosts.has(String(id))) return;
    const record = runtimeRecord(id);
    if (record.monitorTimer) clearTimeout(record.monitorTimer);
    record.monitorTimer = setTimeout(() => {
      record.monitorTimer = null;
      checkHealth({ id }).catch((error) => { record.lastError = String(error?.message ?? error); });
    }, monitorIntervalMs);
    record.monitorTimer.unref?.();
  }
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
  async function invokeOnHost(id, capability, input, { signal, authority } = {}) {
    const { host } = hostOrThrow(id);
    const record = runtimeRecord(id);
    record.state = 'running';
    try { return await invocationAuthority.run({request:authority,next:0},()=>host.invoke(capability, input, { signal })); }
    finally {
      if (hosts.get(String(id)) === host && host.available()) {
        const health = host.health?.() || {};
        record.state = health.inflight > 0 ? 'running' : 'healthy';
        record.healthySince ??= now();
      }
    }
  }
  function hideEntry(id) {
    actors.delete(String(id));
    broker.registry.replaceProviderEntries('extension:' + id, []);
  }

  function validateInstalledEntry(entry) {
    // Catalog discovery performs the same package review as installation, without
    // executing its code. Persisted metadata alone must never create authority.
    const expectedRoot = path.resolve(store.packagesDir, entry.id, entry.version);
    if (path.resolve(entry.sourceRoot) !== expectedRoot
      || fs.realpathSync(entry.sourceRoot) !== path.join(fs.realpathSync(store.packagesDir), entry.id, entry.version)) {
      throw extensionError('REVIEW_MISMATCH', 'Extension package is outside its managed version directory');
    }
    const reviewed = installer.reviewFromDirectory({ sourceDir: entry.sourceRoot });
    const grants = [...(entry.permissions || [])].sort();
    if (!reviewed.scan.ok || reviewed.review.blockers.length
      || reviewed.manifest.id !== entry.id || reviewed.manifest.version !== entry.version
      || reviewed.manifest.type !== entry.type
      || reviewed.review.fingerprint !== entry.fingerprint
      || manifestFingerprint(entry.manifest) !== reviewed.review.fingerprint
      || reviewed.packageFingerprint !== entry.packageFingerprint
      || reviewed.review.token !== entry.reviewToken
      || JSON.stringify(grants) !== JSON.stringify([...reviewed.manifest.permissions].sort())) {
      throw extensionError('REVIEW_MISMATCH', 'Installed Extension package, manifest or grants no longer match its review');
    }
    return reviewed.review.token;
  }

  function registerEntry(entry) {
    if (entry.status !== 'enabled') { hideEntry(entry.id); return; }
    const descriptorVersion = validateInstalledEntry(entry);
    const catalogOwner = 'extension:' + entry.id;
    const definitions = (entry.manifest.capabilities || []).map(cap => {
      const id = 'extension.' + entry.id + '.' + cap.id;
      return { id, catalogOwner, descriptorVersion, permission: 'extension.invoke', provider: 'extension', risk: isHttpDataManifest(entry.manifest)?'high':'low', effect: 'unknown',delegatesOperation:isHttpDataManifest(entry.manifest),
        description: typeof cap.description === 'string' && cap.description.trim() ? cap.description : 'Invoke the declared Extension capability ' + cap.id + '.',
        inputSchema: cap.inputSchema && typeof cap.inputSchema === 'object' ? cap.inputSchema : null,
        modelCallable: Boolean(cap.inputSchema && typeof cap.inputSchema === 'object'),
        ...(isHttpDataManifest(entry.manifest)?{
          validateChildRequest(parent,child){const current=entryOrThrow(entry.id);if(current.status!=='enabled'||validateInstalledEntry(current)!==descriptorVersion)throw extensionError('STALE_EXTENSION_HOST','HTTP package identity changed');
            return child.capability==='network'&&child.constrainedActor?.id===entry.id&&child.scope?.descriptorVersion===descriptorVersion
              &&requestFingerprint({input:child.input})===requestFingerprint({input:httpRequestFor(current.manifest,fs.readFileSync(path.join(current.sourceRoot,current.manifest.entry),'utf8'),cap.id,parent.input)});},
          projectChildResult(parent,result){const current=entryOrThrow(entry.id);return projectHttpResult(current.manifest,fs.readFileSync(path.join(current.sourceRoot,current.manifest.entry),'utf8'),cap.id,result);}
        }:{}),
        validate: r=>{if(cap.inputSchema)validateSchema(cap.inputSchema,r.input);
          if(r.taskId && entry.type!=='memory-pack'&&!isHttpDataManifest(entry.manifest)&&isTrustedVmExtension(entry)!==true)
            throw extensionError('EXTENSION_CONTEXT_UNSUPPORTED','This process adapter does not yet bind reverse calls to a Task invocation; use a context-aware adapter');},
        execute: async r => {
        const current = entryOrThrow(entry.id);
        if (current.status !== 'enabled') throw extensionError('EXTENSION_DISABLED', current.id);
        if (runtimeRecord(current.id).switching || validateInstalledEntry(current) !== descriptorVersion) {
          throw extensionError('STALE_EXTENSION_HOST', 'Capability descriptor no longer matches the active Extension version');
        }
        const result=await invokeOnHost(entry.id, cap.id, r.input, { signal:r.signal,authority:r });
        if(isHttpDataManifest(entry.manifest))return result?.status==='pending'?result:{requestId:r.requestId,status:'completed',capability:id,result};
        return result;
      }};
    });
    broker.registry.replaceProviderEntries(catalogOwner, definitions);
    actors.set(entry.id, actorFor(entry));
  }

  function entryOrThrow(id) {
    const entry = store.get(id);
    if (!entry) throw extensionError('NOT_INSTALLED', '扩展未安装：' + String(id));
    return entry;
  }

  function capabilityExecutorFor(bound) {
    return async (capability, input, { signal } = {}) => {
      const current = entryOrThrow(bound.id);
      const currentManifestFingerprint = manifestFingerprint(current.manifest);
      const currentFingerprint = current.fingerprint || currentManifestFingerprint;
      const currentPackageFingerprint = bound.packageFingerprint
        ? current.packageFingerprint || fingerprintExtensionPackage(current.sourceRoot)
        : null;
      const currentGrants = [...(current.permissions || [])].sort();
      if (current.status !== 'enabled') throw extensionError('EXTENSION_DISABLED', current.id);
      if (current.version !== bound.version || currentFingerprint !== bound.fingerprint
        || currentManifestFingerprint !== bound.manifestFingerprint
        || (bound.packageFingerprint && currentPackageFingerprint !== bound.packageFingerprint)) {
        throw extensionError('STALE_EXTENSION_HOST', 'Worker identity no longer matches the active Extension version');
      }
      if (!(current.manifest.permissions || []).includes(capability)) {
        throw extensionError('CAPABILITY_NOT_DECLARED', 'Extension manifest does not declare ' + capability);
      }
      if (!(current.permissions || []).includes(capability)) {
        throw extensionError('PERMISSION_DENIED', 'Extension grant is not approved: ' + capability);
      }
      if (JSON.stringify(currentGrants) !== JSON.stringify(bound.approvedGrants)) {
        throw extensionError('STALE_EXTENSION_GRANTS', 'Approved Extension grants changed while the Worker was running');
      }
      if (!broker.registry.has(capability)) {
        throw extensionError('CAPABILITY_NOT_DECLARED', 'Capability Broker has no adapter for ' + capability);
      }
      const authority=invocationAuthority.getStore(),parent=authority?.request;
      const taskBound=parent?.taskId && ['agent','owner'].includes(parent.actor?.kind);
      const ordinal=authority?authority.next++:0;
      const operationId=taskBound?'plugin:'+crypto.createHash('sha256').update(JSON.stringify([parent.operationId??parent.requestId,current.id,ordinal,capability])).digest('hex'):undefined;
      const result = await broker.execute({ actor: taskBound?parent.actor:actorFor(current), capability,
        ...(taskBound?{taskId:parent.taskId,workspaceId:parent.workspaceId,operationId,
          constrainedActor:actorFor(current),origin:parent.origin,...(parent.approvalId?{pluginParent:{approvalId:parent.approvalId,capability:parent.capability,descriptorVersion:validateInstalledEntry(current)}}:{}),scope:{plugin:current.id,descriptorVersion:validateInstalledEntry(current),parentOperationId:parent.operationId??parent.requestId,ordinal}}:
          {workspaceId:current.manifest.scope?.workspace || undefined}),
        input:input||{},reason:'Installed Extension nested capability: '+current.id },{signal});
      if(result.status==='pending'&&isHttpDataManifest(current.manifest))return result;
      if (result.status !== 'completed') throw extensionError('APPROVAL_REQUIRED', result.approvalId);
      return result.result;
    };
  }

  function buildHost(entry) {
    if (!entry.packageFingerprint && entry.type !== 'memory-pack') {
      const reviewed = installer.reviewFromDirectory({ sourceDir: entry.sourceRoot });
      if (!reviewed.scan.ok || reviewed.review.fingerprint !== (entry.fingerprint || manifestFingerprint(entry.manifest))) {
        throw extensionError('REVIEW_REQUIRED', 'Installed Extension must be reviewed again before its package can be bound');
      }
      entry = store.put({ ...entry, packageFingerprint: reviewed.packageFingerprint, reviewToken: reviewed.review.token });
    }
    const entryPath = path.join(entry.sourceRoot, entry.manifest.entry);
    if (!fs.existsSync(entryPath)) {
      throw extensionError('ENTRY_MISSING', '受管目录中的入口文件缺失：' + entry.manifest.entry + '（请重新安装）');
    }
    const source = fs.readFileSync(entryPath, 'utf8');
    validateInstalledEntry(entry);
    const bound = {
      id: entry.id,
      version: entry.version,
      fingerprint: entry.fingerprint || manifestFingerprint(entry.manifest),
      packageFingerprint: entry.packageFingerprint,
      manifestFingerprint: manifestFingerprint(entry.manifest),
      approvedGrants: [...(entry.permissions || [])].sort()
    };
    if(isHttpDataManifest(entry.manifest))return createHttpExtensionHost({manifest:entry.manifest,source,capabilityExecutor:capabilityExecutorFor(bound)});
    const trustedVm = entry.type !== 'memory-pack' && isTrustedVmExtension(entry) === true;
    const isProcess = entry.type !== 'memory-pack' && !trustedVm;
    const factory = entry.type === 'memory-pack' ? memoryPackHostFactory : trustedVm ? trustedVmFactory : regularHostFactory;
    return factory({
      manifest: entry.manifest,
      source,
      storage: store.storage(entry.id),
      fetchImpl,
      capabilityExecutor: capabilityExecutorFor(bound),
      ...(isProcess ? {
        packageRoot: entry.sourceRoot,
        storeRoot: store.packagesDir,
        extensionId: entry.id,
        version: entry.version,
        fingerprint: bound.manifestFingerprint,
        packageFingerprint: bound.packageFingerprint,
        storageFile: (entry.manifest.permissions || []).includes('storage') ? store.storage(entry.id).file : null,
        onCrash: () => {
          if (runtimeRecord(entry.id).suppressRecovery) {
            runtimeRecord(entry.id).state = 'crashed';
            return;
          }
          recoverAfterFailure(entry.id).catch((error) => { runtimeRecord(entry.id).lastError = String(error?.message ?? error); });
        }
      } : {})
    });
  }

  async function stopHost(id) {
    const key = String(id);
    hideEntry(key);
    clearMonitor(key);
    const host = hosts.get(key);
    hosts.delete(key);
    runtimeRecord(key).state = 'stopped';
    if (typeof host?.shutdown === 'function') await host.shutdown();
  }

  function reviewResult(reviewed, sourceDir, kind = 'package') {
    const current = store.get(reviewed.manifest.id);
    const delta = current
      ? permissionDelta(current.permissions || [], reviewed.manifest.permissions || [])
      : { added: [...(reviewed.manifest.permissions || [])], removed: [] };
    const candidate = {
      id: reviewed.manifest.id,
      name: reviewed.manifest.name,
      version: reviewed.manifest.version,
      sourceDir,
      kind,
      review: reviewed.review,
      permissionDelta: delta,
      reviewedAt: now()
    };
    pendingReviews.set(candidate.id, candidate);
    return {
      review: reviewed.review,
      summary: reviewSummaryLines(reviewed.review),
      scan: reviewed.scan,
      files: reviewed.files,
      bytes: reviewed.bytes,
      permissionDelta: delta
    };
  }

  function assertOwnerReview(reviewed, current, approval) {
    const delta = permissionDelta(current.permissions || [], reviewed.manifest.permissions || []);
    const needsReview = delta.added.length > 0 || reviewed.review.requiresExplicitApproval;
    const added = delta.added.length ? ' Added permissions: ' + delta.added.join(', ') + '.' : '';
    const candidate = pendingReviews.get(current.id);
    if (candidate && candidate.version === reviewed.manifest.version
      && candidate.review.packageFingerprint !== reviewed.packageFingerprint) {
      throw extensionError('REVIEW_MISMATCH', 'Extension package changed after Owner Review; review it again');
    }
    if (!candidate || candidate.review.token !== reviewed.review.token
      || candidate.version !== reviewed.manifest.version) {
      throw extensionError(needsReview ? 'APPROVAL_REQUIRED' : 'REVIEW_REQUIRED',
        'Review this Extension version and its permissions before switching it.' + added);
    }
    if (!needsReview) return;
    if (!approval || approval.approved !== true || String(approval.token || '') !== candidate.review.token) {
      throw extensionError('APPROVAL_REQUIRED', 'Owner approval must match the reviewed Extension version and permissions.' + added);
    }
  }

  async function applyVersionChange({ id, switchVersion }) {
    const previous = entryOrThrow(id);
    const record = runtimeRecord(id);
    if (record.switching) throw extensionError('EXTENSION_UPDATE_IN_PROGRESS', 'An Extension version switch is already in progress');
    record.switching = true;
    record.suppressRecovery = true;
    let stopped = false;
    try {
      const result = await switchVersion(async () => {
        if (previous.status === 'enabled' || hosts.has(id)) {
          await stopHost(id);
          stopped = true;
        }
      });
      if (previous.status === 'enabled') {
        const host = startHost(result.entry);
        const responsive = typeof host.ping !== 'function'
          || await host.ping({ timeoutMs: heartbeatTimeoutMs });
        if (!responsive) throw extensionError('WORKER_START_FAILED', 'Updated Extension Worker did not answer its startup ping');
      }
      return result;
    } catch (error) {
      const active = store.get(id);
      if (active && active.version !== previous.version) {
        await stopHost(id);
        store.put(previous);
      }
      const currentHost = hosts.get(id);
      if (previous.status === 'enabled' && (!currentHost || !currentHost.available())) {
        if (currentHost) await stopHost(id);
        try {
          const restoredHost = startHost(previous);
          if (typeof restoredHost.ping === 'function'
            && !(await restoredHost.ping({ timeoutMs: heartbeatTimeoutMs }))) {
            await stopHost(id);
            record.lastError = 'Previous Extension Worker did not answer after rollback';
          }
        } catch (restoreError) {
          record.lastError = String(restoreError?.message ?? restoreError);
        }
      }
      throw error;
    } finally {
      record.suppressRecovery = false;
      record.switching = false;
      if (stopped && store.get(id)?.status === 'enabled' && !hosts.has(id)) {
        record.state = 'crashed';
      }
    }
  }

  function startHost(entry) {
    const host = buildHost(entry);
    if (!host.available()) {
      const failure = host.loadError?.() || { code: 'EXTENSION_LOAD_FAILED', message: 'Extension host is unavailable' };
      throw extensionError(failure.code || 'EXTENSION_LOAD_FAILED', 'Extension failed to load: ' + failure.message);
    }
    hosts.set(entry.id, host);
    registerEntry(entry);
    const record = runtimeRecord(entry.id);
    record.startedAt = now();
    record.healthySince = typeof host.ping === 'function' ? null : now();
    record.heartbeatMisses = 0;
    record.state = typeof host.ping === 'function' ? 'starting' : 'healthy';
    record.lastError = null;
    scheduleMonitor(entry.id);
    return host;
  }

  async function recoverAfterFailure(id) {
    const record = runtimeRecord(id);
    if (record.recovering) return { id, state: record.state };
    const previous = store.get(id);
    if (!previous || previous.status !== 'enabled') {
      record.state = previous?.status === 'disabled_due_to_crash' ? 'crashed' : 'stopped';
      return { id, state: record.state };
    }
    record.recovering = true;
    try {
      await stopHost(id);
      const current = entryOrThrow(id);
      const cutoff = now() - Math.max(1, restartWindowMs);
      record.restartTimes = record.restartTimes.filter((timestamp) => timestamp > cutoff);
      if (record.restartTimes.length >= Math.max(0, maxAutomaticRestarts)) {
        store.put({ ...current, status: 'disabled_due_to_crash', disabledAt: now(), updatedAt: now() });
        record.state = 'crashed';
        record.lastError = 'Automatic Worker restart limit reached';
        return { id, state: record.state };
      }
      record.restartTimes.push(now());
      try {
        startHost(current);
      } catch (error) {
        record.state = 'crashed';
        record.lastError = String(error?.message ?? error);
      }
      return { id, state: record.state };
    } finally {
      record.recovering = false;
    }
  }

  async function checkHealth({ id } = {}) {
    const entry = entryOrThrow(id);
    const record = runtimeRecord(entry.id);
    if (entry.status === 'disabled_due_to_crash') {
      record.state = 'crashed';
      return { id: entry.id, state: record.state };
    }
    if (entry.status !== 'enabled') {
      record.state = 'stopped';
      return { id: entry.id, state: record.state };
    }
    const host = hosts.get(entry.id);
    if (!host) {
      await recoverAfterFailure(entry.id);
      return { id: entry.id, state: runtimeState(store.get(entry.id)) };
    }
    const health = host.health?.() || {};
    if (!host.available() || health.crashed) {
      record.state = 'crashed';
      await recoverAfterFailure(entry.id);
      return { id: entry.id, state: runtimeState(store.get(entry.id)) };
    }
    if (typeof host.ping === 'function') {
      let responsive = false;
      try { responsive = await host.ping({ timeoutMs: heartbeatTimeoutMs }); }
      catch { responsive = false; }
      if (!responsive) {
        record.heartbeatMisses += 1;
        record.state = 'unresponsive';
        if (record.heartbeatMisses >= Math.max(1, maxHeartbeatMisses)) {
          await recoverAfterFailure(entry.id);
        }
      } else {
        record.heartbeatMisses = 0;
        record.healthySince ??= now();
        if (now() - record.healthySince >= Math.max(1, stableWindowMs)) {
          record.restartTimes = [];
          record.healthySince = now();
        }
        record.state = health.inflight > 0 ? 'running' : 'healthy';
      }
    } else {
      record.healthySince ??= now();
      if (now() - record.healthySince >= Math.max(1, stableWindowMs)) record.restartTimes = [];
      record.state = health.inflight > 0 ? 'running' : 'healthy';
    }
    scheduleMonitor(entry.id);
    return { id: entry.id, state: runtimeState(store.get(entry.id)), health: host.health?.() || null };
  }

  function hostOrThrow(id) {
    const entry = entryOrThrow(id);
    if (entry.status === 'disabled_due_to_crash') {
      throw extensionError('EXTENSION_CRASH_LOOP_DISABLED', 'Extension was disabled after repeated Worker crashes');
    }
    if (entry.status !== 'enabled') {
      throw extensionError('EXTENSION_DISABLED', '扩展未启用：' + entry.id);
    }
    let host = hosts.get(entry.id);
    if (host && !host.available()) {
      runtimeRecord(entry.id).state = 'crashed';
      recoverAfterFailure(entry.id).catch((error) => { runtimeRecord(entry.id).lastError = String(error?.message ?? error); });
      throw extensionError('PROVIDER_UNAVAILABLE', 'Extension Worker is not available');
    }
    if (!host) host = startHost(entry);
    return { entry, host };
  }

  // Restore discovery synchronously at Core construction. Workers remain lazy.
  // A damaged installed package is isolated from the rest of the catalog.
  for (const entry of store.list()) {
    try { registerEntry(entry); }
    catch (error) {
      hideEntry(entry.id);
      runtimeRecord(entry.id).lastError = String(error?.message ?? error);
    }
  }

  return {
    installer,

    list() {
      return store.list();
    },

    get({ id } = {}) {
      const entry = entryOrThrow(id);
      const host = hosts.get(entry.id);
      const health = host?.health?.() || null;
      return { extension: entry, loaded: Boolean(host), runtimeState: runtimeState(entry), health, provider: health?.provider || null };
    },

    /** UI 用聚合：已安装列表 + 各自权限摘要 + 运行状态。 */
    overview() {
      const entries = store.list();
      return {
        extensions: entries.map((entry) => {
          const host = hosts.get(entry.id);
          const health = host?.health?.() || null;
          const pendingReview = pendingReviews.get(entry.id) || null;
          return ({
          id: entry.id,
          name: entry.name,
          version: entry.version,
          type: entry.type,
          status: entry.status,
          riskLevel: entry.riskLevel,
          permissions: entry.permissions,
          capabilities: (entry.manifest.capabilities || []).map((c) => c.id),
          loaded: Boolean(host),
          runtimeState: runtimeState(entry),
          health,
          provider: health?.provider || null,
          pendingReview,
          updatedAt: entry.updatedAt
          });
        }),
        reviews: [...pendingReviews.values()],
        needsReview: pendingReviews.size,
        total: entries.length,
        enabled: entries.filter((e) => e.status === 'enabled').length
      };
    },

    review({ sourceDir } = {}) {
      const reviewed = installer.reviewFromDirectory({ sourceDir });
      return reviewResult(reviewed, sourceDir);
    },

    reviewRollback({ id } = {}) {
      const current = entryOrThrow(id);
      if (!current.previousVersion) throw extensionError('ROLLBACK_UNAVAILABLE', 'No previous Extension version is retained');
      const sourceDir = path.join(store.packagesDir, current.id, current.previousVersion);
      const reviewed = installer.reviewFromDirectory({ sourceDir });
      return reviewResult(reviewed, sourceDir, 'rollback');
    },

    install({ sourceDir, approval } = {}) {
      const result = installer.install({ sourceDir, approval });
      pendingReviews.delete(result.entry.id);
      return result;
    },

    async update({ sourceDir, approval } = {}) {
      const reviewed = installer.reviewFromDirectory({ sourceDir });
      const current = entryOrThrow(reviewed.manifest.id);
      assertOwnerReview(reviewed, current, approval);
      const result = await applyVersionChange({
        id: current.id,
        switchVersion: beforeSwitch => installer.update({ sourceDir, approval,
          expectedReviewToken: reviewed.review.token, beforeSwitch })
      });
      pendingReviews.delete(result.entry.id);
      return result;
    },

    async rollback({ id, approval } = {}) {
      const current = entryOrThrow(id);
      if (!current.previousVersion) throw extensionError('ROLLBACK_UNAVAILABLE', 'No previous Extension version is retained');
      const previousRoot = path.join(store.packagesDir, current.id, current.previousVersion);
      const reviewed = installer.reviewFromDirectory({ sourceDir: previousRoot });
      assertOwnerReview(reviewed, current, approval);
      const result = await applyVersionChange({
        id: current.id,
        switchVersion: beforeSwitch => installer.rollback({ id: current.id, approval,
          expectedReviewToken: reviewed.review.token, beforeSwitch })
      });
      pendingReviews.delete(result.entry.id);
      return result;
    },

    async uninstall({ id, keepFiles } = {}) {
      const entry = entryOrThrow(id);
      await stopHost(entry.id);
      const result = installer.uninstall({ id: entry.id, keepFiles });
      pendingReviews.delete(entry.id);
      return result;
    },

    enable({ id } = {}) {
      const entry = entryOrThrow(id);
      if (entry.status === 'disabled_due_to_crash') {
        throw extensionError('EXTENSION_CRASH_LOOP_DISABLED', 'Use explicit Restart to start this Extension again');
      }
      const existing = hosts.get(entry.id);
      if (entry.status === 'enabled' && existing?.available()) {
        return { extension: entry, changed: false };
      }
      if (existing) stopHost(entry.id).catch((error) => { runtimeRecord(entry.id).lastError = String(error?.message ?? error); });
      const host = startHost(entry);
      if (!host.available()) {
        hosts.delete(entry.id);
        const failure = host.loadError();
        throw extensionError(failure.code, '扩展加载失败：' + failure.message);
      }
      hosts.set(entry.id, host);
      try {
        const updated = store.put({ ...entry, status: 'enabled', enabledAt: now(), updatedAt: now() });
        registerEntry(updated);
        return { extension: updated, changed: true };
      } catch (error) {
        void stopHost(entry.id).catch((cleanupError) => {
          runtimeRecord(entry.id).lastError = 'Worker cleanup after enable failure: ' + String(cleanupError?.message ?? cleanupError);
        });
        throw error;
      }
    },

    async disable({ id } = {}) {
      const entry = entryOrThrow(id);
      await stopHost(entry.id);
      if (entry.status === 'disabled') return { extension: entry, changed: false };
      const updated = store.put({ ...entry, status: 'disabled', disabledAt: now(), updatedAt: now() });
      return { extension: updated, changed: true };
    },

    async restart({ id } = {}) {
      let entry = entryOrThrow(id);
      if (entry.status === 'disabled_due_to_crash') {
        entry = store.put({ ...entry, status: 'enabled', updatedAt: now() });
      } else if (entry.status !== 'enabled') {
        throw extensionError('EXTENSION_DISABLED', 'Only an enabled or crash-disabled Extension can be restarted');
      }
      await stopHost(entry.id);
      const host = startHost(entry);
      return { extension: store.get(entry.id), runtimeState: runtimeState(store.get(entry.id)), health: host.health?.() || null };
    },

    checkHealth,

    async invoke({ id, capability, input } = {}) {
      const { entry } = hostOrThrow(id);
      if (!entry.manifest.capabilities.some(c => c.id === capability)) throw extensionError('CAPABILITY_NOT_DECLARED', String(capability));
      const result = await broker.execute({ actor: actorFor(entry), capability: 'extension.' + entry.id + '.' + capability,
        input: input === undefined ? null : input, reason: 'Extension invocation' });
      return result.status==='completed'?result.result:result;
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
      for (const entry of store.list()) hideEntry(entry.id);
      return Promise.all([...hosts.keys()].map((id) => stopHost(id))).then(() => undefined);
    }
  };
}
