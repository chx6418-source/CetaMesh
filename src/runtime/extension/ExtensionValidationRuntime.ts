import type {CapabilityName, CapabilityScope, CapabilityScopeKind} from '../../domain/capability/Capability';
import {isKnownCapabilityName} from '../../domain/capability/Capability';
import type {ExtensionManifest} from '../../domain/extension/ExtensionManifest';
import {EXTENSION_TYPES} from '../../domain/extension/ExtensionManifest';
import type {ExtensionPermission} from '../../domain/extension/ExtensionPermission';
import type {WorkflowDefinition, WorkflowStep} from '../../domain/extension/Workflow';
import {CetaError} from '../../shared/errors/CetaError';
import {identifier} from '../../protocol/PairingProtocol';

const manifestKeys = new Set(['id', 'name', 'version', 'type', 'publisher', 'platforms', 'runtime', 'permissions', 'capabilities', 'networkAccess', 'inputSchema', 'outputSchema', 'minimumProtocolVersion']);
const scopeKinds: readonly CapabilityScopeKind[] = ['local', 'task', 'device', 'mesh'];

function boundedJson(value: unknown, max: number, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new CetaError('invalid_protocol', message); }
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new CetaError('invalid_protocol', message); }
  if (encoded.length > max) { throw new CetaError('invalid_protocol', message); }
  return value as Record<string, unknown>;
}

function scope(value: unknown): CapabilityScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new CetaError('permission_denied', 'Invalid extension scope'); }
  const record = value as Record<string, unknown>;
  if (!scopeKinds.includes(record.kind as CapabilityScopeKind) || record.id !== undefined && (typeof record.id !== 'string' || record.id.length > 100)) { throw new CetaError('permission_denied', 'Invalid extension scope'); }
  return {kind: record.kind as CapabilityScopeKind, ...(record.id ? {id: String(record.id)} : {})};
}

export function mapExtensionPermissions(values: readonly {readonly capability: string; readonly scope: CapabilityScope}[]): ExtensionPermission[] {
  if (!Array.isArray(values) || values.length > 32) { throw new CetaError('permission_denied', 'Extension permissions are invalid'); }
  return values.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.capability !== 'string' || !isKnownCapabilityName(value.capability)) { throw new CetaError('permission_denied', 'Extension requested an unknown capability'); }
    return {capability: value.capability as CapabilityName, scope: scope(value.scope)};
  });
}

export class ExtensionValidationRuntime {
  validateManifest(value: unknown): ExtensionManifest {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new CetaError('invalid_protocol', 'Invalid extension manifest'); }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some(key => !manifestKeys.has(key)) || typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.version !== 'string' || typeof record.publisher !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,95}$/.test(record.id) || record.name.length < 1 || record.name.length > 120 || record.version.length < 1 || record.version.length > 32 || record.publisher.length < 1 || record.publisher.length > 120 || !EXTENSION_TYPES.includes(record.type as ExtensionManifest['type']) || (record.runtime !== 'declarative' && record.runtime !== 'remote') || !Array.isArray(record.platforms) || record.platforms.length < 1 || record.platforms.some(platform => platform !== 'android' && platform !== 'ios') || !Array.isArray(record.permissions) || !Array.isArray(record.capabilities) || record.capabilities.length > 64 || record.capabilities.some(capability => !isKnownCapabilityName(String(capability))) || !Number.isInteger(record.minimumProtocolVersion) || Number(record.minimumProtocolVersion) < 1) {
      throw new CetaError('invalid_protocol', 'Invalid extension manifest');
    }
    const type = record.type as ExtensionManifest['type'];
    const runtime = record.runtime as ExtensionManifest['runtime'];
    if ((type === 'remote-plugin') !== (runtime === 'remote') || (type !== 'remote-plugin' && runtime !== 'declarative')) { throw new CetaError('unsupported', 'Extension runtime is not allowed'); }
    const network = record.networkAccess;
    if (!network || typeof network !== 'object' || !['none', 'declared', 'remote-declared'].includes((network as Record<string, unknown>).mode as string)) { throw new CetaError('invalid_protocol', 'Invalid extension network access'); }
    if (type === 'remote-plugin' && (network as Record<string, unknown>).mode !== 'remote-declared') { throw new CetaError('unsupported', 'Remote plugin network contract is invalid'); }
    const inputSchema = boundedJson(record.inputSchema, 65_536, 'Extension input schema is too large');
    const outputSchema = boundedJson(record.outputSchema, 65_536, 'Extension output schema is too large');
    const permissions = (record.permissions as unknown[]).map(permission => {
      if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
        throw new CetaError('permission_denied', 'Extension permissions are invalid');
      }
      const permissionValue = permission as Record<string, unknown>;
      if (typeof permissionValue.capability !== 'string') {
        throw new CetaError('permission_denied', 'Extension permissions are invalid');
      }
      return {capability: permissionValue.capability, scope: scope(permissionValue.scope)};
    });
    mapExtensionPermissions(permissions);
    return {id: record.id, name: record.name, version: record.version, type, publisher: record.publisher, platforms: record.platforms as ExtensionManifest['platforms'], runtime, permissions, capabilities: (record.capabilities as unknown[]).map(String), networkAccess: {mode: (network as {mode: ExtensionManifest['networkAccess']['mode']}).mode}, inputSchema, outputSchema, minimumProtocolVersion: Number(record.minimumProtocolVersion)};
  }

  validateWorkflow(value: unknown): WorkflowDefinition {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new CetaError('invalid_protocol', 'Invalid workflow'); }
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.version !== 'string' || !Array.isArray(record.steps) || record.steps.length > 50) { throw new CetaError('invalid_protocol', 'Invalid workflow'); }
    const steps: WorkflowStep[] = record.steps.map(step => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) { throw new CetaError('invalid_protocol', 'Invalid workflow step'); }
      const item = step as Record<string, unknown>;
      if (item.kind === 'tool-call' && typeof item.toolId === 'string') { return {kind: 'tool-call', toolId: item.toolId}; }
      if (item.kind === 'memory-read' && typeof item.query === 'string' && item.query.length <= 1000) { return {kind: 'memory-read', query: item.query}; }
      if (item.kind === 'task-update' && typeof item.field === 'string' && item.field.length <= 100) { return {kind: 'task-update', field: item.field}; }
      if (item.kind === 'approval' && typeof item.capability === 'string' && isKnownCapabilityName(item.capability)) { return {kind: 'approval', capability: item.capability}; }
      throw new CetaError('unsupported', 'Workflow step is not declarative');
    });
    identifier(record.id);
    return {id: record.id, version: record.version, steps};
  }
}
