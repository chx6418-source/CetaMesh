import type {AppRoute} from '../app';
import type {BootstrapBoundary} from '../app/bootstrap';
import type {AppServices} from '../app/providers';
import type {ApprovalsFeatureBoundary} from '../features/approvals';
import type {FeatureContext} from '../features/FeatureContext';
import type {ChatFeatureBoundary} from '../features/chat';
import type {DevicesFeatureBoundary} from '../features/devices';
import type {DiscoverFeatureBoundary} from '../features/discover';
import type {HomeFeatureBoundary} from '../features/home';
import type {MemoryFeatureBoundary} from '../features/memory';
import type {ProfileFeatureBoundary} from '../features/profile';
import type {TasksFeatureBoundary} from '../features/tasks';
import type {CapabilityBoundary} from '../domain/capability';
import type {DeviceBoundary} from '../domain/device';
import type {IdentityBoundary} from '../domain/identity';
import type {MemoryBoundary} from '../domain/memory';
import type {ModelBoundary} from '../domain/model';
import type {TaskBoundary} from '../domain/task';
import type {EntityId} from '../domain';
import type {DataBoundary} from '../data';
import type {CacheBoundary} from '../data/cache';
import type {DatabaseBoundary} from '../data/database';
import type {MigrationBoundary} from '../data/migrations';
import type {RepositoryBoundary} from '../data/repositories';
import type {CapabilityRuntime} from '../runtime/capability/CapabilityRuntime';
import type {ChatRuntimePort} from '../runtime/chat';
import type {EventRuntimePort} from '../runtime/event';
import type {IdentityRuntimePort} from '../runtime/identity';
import type {MemoryRuntimePort} from '../runtime/memory';
import type {SessionRuntimePort} from '../runtime/session';
import type {SyncRuntimePort} from '../runtime/sync';
import type {TaskRuntimePort} from '../runtime/task';
import type {RuntimeLayer} from '../runtime';
import type {BluetoothProviderBoundary} from '../native/bluetooth';
import type {CameraProviderBoundary} from '../native/camera';
import type {LocationProviderBoundary} from '../native/location';
import type {MicrophoneProviderBoundary} from '../native/microphone';
import type {NfcProviderBoundary} from '../native/nfc';
import type {SecureStorageProviderBoundary} from '../native/secure-storage';
import type {ShareProviderBoundary} from '../native/share';
import type {NativeCapabilityProvider} from '../native';
import type {DesktopProviderPort} from '../providers/desktop';
import type {ModelProviderPort} from '../providers/model';
import type {NetworkProviderPort} from '../providers/network';
import type {PushProviderPort} from '../providers/push';
import type {ProviderReference} from '../providers';
import type {ProtocolEnvelope} from '../protocol/ProtocolEnvelope';
import type {SecretReference} from '../security';
import type {CorrelationContext} from '../shared';
import type {ErrorBoundary} from '../shared/errors';
import type {HookBoundary} from '../shared/hooks';
import type {UiBoundary} from '../shared/ui';
import type {UtilityBoundary} from '../shared/utils';

type ArchitectureBoundaryTypes = {
  appRoute: AppRoute;
  bootstrap: BootstrapBoundary;
  appServices: AppServices;
  featureContext: FeatureContext;
  approvals: ApprovalsFeatureBoundary;
  chat: ChatFeatureBoundary;
  devices: DevicesFeatureBoundary;
  discover: DiscoverFeatureBoundary;
  home: HomeFeatureBoundary;
  memory: MemoryFeatureBoundary;
  profile: ProfileFeatureBoundary;
  tasks: TasksFeatureBoundary;
  capability: CapabilityBoundary;
  device: DeviceBoundary;
  identity: IdentityBoundary;
  memoryDomain: MemoryBoundary;
  model: ModelBoundary;
  task: TaskBoundary;
  entityId: EntityId;
  data: DataBoundary;
  cache: CacheBoundary;
  database: DatabaseBoundary;
  migration: MigrationBoundary;
  repository: RepositoryBoundary;
  capabilityRuntime: CapabilityRuntime;
  chatRuntime: ChatRuntimePort;
  eventRuntime: EventRuntimePort;
  identityRuntime: IdentityRuntimePort;
  memoryRuntime: MemoryRuntimePort;
  sessionRuntime: SessionRuntimePort;
  syncRuntime: SyncRuntimePort;
  taskRuntime: TaskRuntimePort;
  runtimeLayer: RuntimeLayer;
  bluetooth: BluetoothProviderBoundary;
  camera: CameraProviderBoundary;
  location: LocationProviderBoundary;
  microphone: MicrophoneProviderBoundary;
  nfc: NfcProviderBoundary;
  secureStorage: SecureStorageProviderBoundary;
  share: ShareProviderBoundary;
  native: NativeCapabilityProvider;
  desktopProvider: DesktopProviderPort;
  modelProvider: ModelProviderPort;
  networkProvider: NetworkProviderPort;
  pushProvider: PushProviderPort;
  provider: ProviderReference;
  protocol: ProtocolEnvelope;
  secret: SecretReference;
  correlation: CorrelationContext;
  error: ErrorBoundary;
  hook: HookBoundary;
  ui: UiBoundary;
  utility: UtilityBoundary;
};

const architectureBoundaryNames: Array<keyof ArchitectureBoundaryTypes> = [
  'appRoute',
  'bootstrap',
  'appServices',
  'featureContext',
  'approvals',
  'chat',
  'devices',
  'discover',
  'home',
  'memory',
  'profile',
  'tasks',
  'capability',
  'device',
  'identity',
  'memoryDomain',
  'model',
  'task',
  'entityId',
  'data',
  'cache',
  'database',
  'migration',
  'repository',
  'capabilityRuntime',
  'chatRuntime',
  'eventRuntime',
  'identityRuntime',
  'memoryRuntime',
  'sessionRuntime',
  'syncRuntime',
  'taskRuntime',
  'runtimeLayer',
  'bluetooth',
  'camera',
  'location',
  'microphone',
  'nfc',
  'secureStorage',
  'share',
  'native',
  'desktopProvider',
  'modelProvider',
  'networkProvider',
  'pushProvider',
  'provider',
  'protocol',
  'secret',
  'correlation',
  'error',
  'hook',
  'ui',
  'utility',
];

test('compiles every M0 architecture boundary', () => {
  expect(architectureBoundaryNames).toHaveLength(53);
});

test('features depend on runtime interfaces, never concrete native providers', () => {
  const runtime: CapabilityRuntime = {
    invoke: async () => undefined,
  };
  const featureContext: FeatureContext = {capabilityRuntime: runtime};

  expect(featureContext.capabilityRuntime).toBe(runtime);
});

test('native providers expose the capability provider contract', async () => {
  const native: NativeCapabilityProvider = {
    listCapabilities: () => [],
    invoke: async request => ({name: request.name, output: null}),
  };

  expect(await native.invoke({name: 'camera.capture'})).toEqual({
    name: 'camera.capture',
    output: null,
  });
});

test('protocol envelope stays independent from React Native UI', () => {
  const protocolEnvelope: ProtocolEnvelope = {
    protocol: 'cetamesh',
    version: 1,
    id: 'test-envelope',
    type: 'test',
    timestamp: new Date(0).toISOString(),
    payload: null,
  };

  expect(protocolEnvelope.protocol).toBe('cetamesh');
  expect(protocolEnvelope.version).toBe(1);
});
