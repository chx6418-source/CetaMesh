import type {DeviceCrypto} from '../../domain/identity/DeviceIdentity';
import type {PairingTransport} from '../../domain/device/DeviceTrust';
import {IdentityRuntime} from '../../runtime/identity/IdentityRuntime';
import {PairingRuntime} from '../../runtime/identity/PairingRuntime';
import {SqliteTrustRepository} from '../../data/repositories/SqliteTrustRepository';
import type { SqliteConnection } from '../../data/database/SqliteConnection';
import { serializeConnection } from '../../data/database/serializeConnection';
import { migrateDatabase } from '../../data/database/MigrationEngine';
import { appMigrations } from '../../data/migrations/AppMigrations';
import { SqliteChatRepository } from '../../data/repositories/SqliteChatRepository';
import { SqliteProviderRepository } from '../../data/repositories/SqliteProviderRepository';
import { SqliteMemoryRepository } from '../../data/repositories/SqliteMemoryRepository';
import { MemoryRuntime } from '../../runtime/memory/MemoryRuntime';
import { ChatMemoryExtraction } from '../../runtime/memory/ChatMemoryExtraction';
import type { SecureStorage } from '../../security/SecureStorage';
import type { HttpTransport } from '../../providers/network/HttpTransport';
import { CompatibleProvider } from '../../providers/model/CompatibleProvider';
import { ProviderRegistry } from '../../runtime/chat/ProviderRegistry';
import { ChatRuntime } from '../../runtime/chat/ChatRuntime';
import { ProviderSettings } from '../../runtime/session/ProviderSettings';
import { SessionRuntime } from '../../runtime/session/SessionRuntime';
import type { MobileServices } from '../../runtime/session/MobileServices';
import type {CapabilityRuntime} from '../../runtime/capability/CapabilityRuntime';
import {CapabilityRouterRuntime} from '../../runtime/capability/CapabilityRouterRuntime';
import {InMemoryCapabilityPolicy} from '../../security/CapabilityPolicy';
import {InMemoryCapabilityAuditLog} from '../../domain/capability/CapabilityAudit';
import type {CapabilityAuditSink} from '../../domain/capability/CapabilityAudit';
import {SqliteTaskRepository} from '../../data/repositories/SqliteTaskRepository';
import {SqliteApprovalRepository} from '../../data/repositories/SqliteApprovalRepository';
import {EventLogRuntime} from '../../runtime/event/EventLogRuntime';
import {TaskRuntime} from '../../runtime/task/TaskRuntime';
import {ApprovalRuntime} from '../../runtime/task/ApprovalRuntime';
import {PushAttentionRuntime} from '../../runtime/task/PushAttentionRuntime';
import {SqliteSyncQueueRepository} from '../../data/repositories/SqliteSyncQueueRepository';
import {SyncQueueRuntime} from '../../runtime/sync/SyncQueueRuntime';
import {SqliteOfflineInboxRepository} from '../../data/repositories/SqliteOfflineInboxRepository';
import {OfflineInboxRuntime} from '../../runtime/inbox/OfflineInboxRuntime';
import {ShareIngressRuntime} from '../../runtime/inbox/ShareIngressRuntime';
import {VoiceRuntime} from '../../runtime/voice/VoiceRuntime';
import {ActionCenterRuntime} from '../../runtime/event/ActionCenterRuntime';
import {BackgroundCatchupRuntime} from '../../runtime/sync/BackgroundCatchupRuntime';
import {SqliteExtensionRepository} from '../../data/repositories/SqliteExtensionRepository';
import {ExtensionInstallRuntime} from '../../runtime/extension/ExtensionInstallRuntime';
import {ExtensionLifecycleRuntime} from '../../runtime/extension/ExtensionLifecycleRuntime';
import {ExtensionImportRuntime} from '../../runtime/extension/ExtensionImportRuntime';
import type {ExtensionPackagePicker} from '../../domain/extension/ExtensionPackagePicker';
import {SqliteMobilePreferencesRepository} from '../../data/repositories/SqliteMobilePreferencesRepository';
import {PreferencesRuntime} from '../../runtime/session/PreferencesRuntime';
export async function assembleServices(
  connection: SqliteConnection,
  secure: SecureStorage,
  http: HttpTransport,
  mesh?: {crypto: DeviceCrypto;transport: PairingTransport},
  capabilityRuntime?: CapabilityRuntime,
  capabilityAudit?: CapabilityAuditSink,
  extensionPackagePicker?: ExtensionPackagePicker,
): Promise<MobileServices> {
  const db = serializeConnection(connection);
  try {
    await db.executeAsync('PRAGMA foreign_keys = ON');
    await migrateDatabase(db, appMigrations);
    const repo = new SqliteChatRepository(db);
    await repo.recoverInterrupted();
    const providers = new SqliteProviderRepository(db);
    const registry = new ProviderRegistry();
    const reloadProviders = async () => {
      for (const config of await providers.list()) {
        registry.replace(new CompatibleProvider(config, secure, http));
      }
    };
    await reloadProviders();
    const chat = new ChatRuntime(repo, registry);
    const memory = new MemoryRuntime(new SqliteMemoryRepository(db));
    const memoryExtraction = new ChatMemoryExtraction(repo, memory);
    const taskRepository = new SqliteTaskRepository(db);
    const eventLog = new EventLogRuntime(taskRepository);
    const tasks = new TaskRuntime(taskRepository, eventLog);
    const approvals = new ApprovalRuntime(new SqliteApprovalRepository(db));
    const pushAttention = new PushAttentionRuntime(tasks, approvals);
    const syncQueue = new SyncQueueRuntime(new SqliteSyncQueueRepository(db));
    const inbox = new OfflineInboxRuntime(new SqliteOfflineInboxRepository(db));
    const shareIngress = new ShareIngressRuntime(inbox);
    const identity=mesh?new IdentityRuntime(mesh.crypto):undefined;
    const pairing=mesh&&identity?new PairingRuntime(identity,mesh.crypto,new SqliteTrustRepository(db),mesh.transport):undefined;
    const audit = capabilityAudit ?? new InMemoryCapabilityAuditLog();
    const closedCapabilityRuntime = new CapabilityRouterRuntime(
      [],
      new InMemoryCapabilityPolicy(async () => 'deny'),
      'android',
      audit,
    );
    const voice = new VoiceRuntime(capabilityRuntime ?? closedCapabilityRuntime, {transcribe: async () => ''});
    const actionCenter = new ActionCenterRuntime(tasks, approvals, audit);
    const backgroundCatchup = new BackgroundCatchupRuntime(syncQueue, inbox);
    const extensionRepository = new SqliteExtensionRepository(db);
    const extensionInstall = new ExtensionInstallRuntime(extensionRepository);
    const extensionLifecycle = new ExtensionLifecycleRuntime(extensionRepository, extensionInstall);
    const extensionImport = extensionPackagePicker
      ? new ExtensionImportRuntime(extensionLifecycle, extensionPackagePicker)
      : undefined;
    const preferences = new PreferencesRuntime(new SqliteMobilePreferencesRepository(db));
    return {
      capabilityRuntime: capabilityRuntime ?? closedCapabilityRuntime,
      capabilityAudit: audit,
      tasks,
      approvals,
      pushAttention,
      syncQueue,
      inbox,
      shareIngress,
      voice,
      actionCenter,
      backgroundCatchup,
      extensionInstall,
      extensionLifecycle,
      extensionImport,
      identity,
      pairing,
      memory,
      memoryExtraction,
      settings: new ProviderSettings(secure, providers),
      preferences,
      sessions: new SessionRuntime(repo),
      chat,
      reloadProviders,
      listModels: id => registry.get(id).listModels(),
      close: async () => {
        await pairing?.close();
        await chat.close();
        memoryExtraction.clear();
        memory.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
