import type {ExtensionManifest} from '../../domain/extension/ExtensionManifest';
import {ExtensionValidationRuntime, mapExtensionPermissions} from './ExtensionValidationRuntime';
import type {ExtensionPermission} from '../../domain/extension/ExtensionPermission';
import type {ExtensionRepository, InstalledExtension} from '../../domain/extension/ExtensionRepository';
import {
  EXTENSION_SIGNATURE_STATES,
  type ExtensionSignatureState,
  type ExtensionSource,
  type SecurityReport,
} from '../../domain/extension/SecurityReport';
import {CetaError} from '../../shared/errors/CetaError';

const CURRENT_PROTOCOL_VERSION = 1;
const MAX_PACKAGE_BYTES = 1_048_576;
const UNSAFE_KEYS = new Set(['script', 'code', 'executable', 'nativemodule', 'native_module', 'wasm', 'command', 'shell']);
const HIGH_RISK_CAPABILITIES = new Set([
  'camera.capture',
  'camera.scanDocument',
  'camera.scanQr',
  'microphone.record',
  'location.current',
  'nfc.read',
  'nfc.write',
  'bluetooth.scan',
  'bluetooth.connect',
]);

export type ExtensionPublisherMetadata = {
  readonly publisher?: string;
  readonly signatureState?: ExtensionSignatureState;
};

export type ExtensionPermissionReview = {
  readonly addedPermissions: readonly ExtensionPermission[];
  readonly requiresConfirmation: boolean;
};

export type ExtensionInstallInput = {
  readonly manifest: unknown;
  readonly source: ExtensionSource;
  readonly packageData?: unknown;
  readonly publisherMetadata?: ExtensionPublisherMetadata;
  readonly dataScope?: readonly string[];
  readonly permissionReview?: ExtensionPermissionReview;
};

function extensionId(value: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{1,95}$/.test(value)) {
    throw new CetaError('invalid_protocol', 'Invalid extension identifier');
  }
  return value;
}

function source(value: ExtensionSource): ExtensionSource {
  if (value !== 'base' && value !== 'user-overlay' && value !== 'import') {
    throw new CetaError('invalid_protocol', 'Invalid extension source');
  }
  return value;
}

function encoded(value: unknown, max: number, message: string): string {
  let result: string | undefined;
  try {
    result = JSON.stringify(value);
  } catch {
    throw new CetaError('unsupported', message);
  }
  if (!result || result.length > max) {
    throw new CetaError('unsupported', message);
  }
  return result;
}

function inspectPayload(value: unknown, seen = new WeakSet<object>(), depth = 0): void {
  if (depth > 32) {
    throw new CetaError('unsupported', 'Extension payload is too deeply nested');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new CetaError('unsupported', 'Extension payload cannot contain executable values');
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  if (seen.has(value)) {
    throw new CetaError('unsupported', 'Extension payload contains a cycle');
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => inspectPayload(item, seen, depth + 1));
  } else {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
      if (UNSAFE_KEYS.has(key.toLowerCase())) {
        throw new CetaError('unsupported', 'Executable extension payloads are not supported');
      }
      inspectPayload(item, seen, depth + 1);
    });
  }
  seen.delete(value);
}

export function validateExtensionPackageData(value: unknown): void {
  inspectPayload(value);
  encoded(value, MAX_PACKAGE_BYTES, 'Extension package is too large or invalid');
}

/* eslint-disable no-bitwise */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
        index += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 0x3f), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

function hash(value: string): string {
  const bytes = utf8Bytes(value);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length + 8) % 64 !== 0) {
    bytes.push(0);
  }
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(Math.floor(bitLength / 2 ** shift) % 256);
  }
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15];
      const previousTwo = words[index - 2];
      const small0 = ((previous >>> 7) | (previous << 25)) ^ ((previous >>> 18) | (previous << 14)) ^ (previous >>> 3);
      const small1 = ((previousTwo >>> 17) | (previousTwo << 15)) ^ ((previousTwo >>> 19) | (previousTwo << 13)) ^ (previousTwo >>> 10);
      words[index] = (words[index - 16] + small0 + words[index - 7] + small1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const big1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const big0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(item => item.toString(16).padStart(8, '0')).join('');
}
/* eslint-enable no-bitwise */

export function permissionRisk(permissions: readonly ExtensionPermission[], network: ExtensionManifest['networkAccess']['mode']): SecurityReport['risk'] {
  if (permissions.some(permission => HIGH_RISK_CAPABILITIES.has(permission.capability))) {
    return 'high';
  }
  if (network === 'remote-declared') {
    return 'high';
  }
  if (network === 'declared' || permissions.length > 0) {
    return 'medium';
  }
  return 'low';
}

function signatureState(value: ExtensionPublisherMetadata | undefined): ExtensionSignatureState {
  const state = value?.signatureState ?? 'unsigned';
  if (!EXTENSION_SIGNATURE_STATES.includes(state)) {
    throw new CetaError('invalid_protocol', 'Invalid extension signature state');
  }
  return state;
}

function report(
  manifest: ExtensionManifest,
  extensionSource: ExtensionSource,
  contentHash: string,
  publisherMetadata: ExtensionPublisherMetadata | undefined,
  dataScope: readonly string[],
  permissionReview: ExtensionPermissionReview | undefined,
): SecurityReport {
  const permissions = mapExtensionPermissions(manifest.permissions);
  const publisher = publisherMetadata?.publisher ?? manifest.publisher;
  if (publisher !== manifest.publisher) {
    throw new CetaError('unauthorized', 'Extension publisher metadata does not match the manifest');
  }
  if (publisher.length < 1 || publisher.length > 120) {
    throw new CetaError('invalid_protocol', 'Invalid extension publisher metadata');
  }
  return {
    source: extensionSource,
    publisher,
    signatureState: signatureState(publisherMetadata),
    permissions,
    addedPermissions: permissionReview?.addedPermissions ?? [],
    capabilities: [...manifest.capabilities],
    dataScope: [...dataScope],
    networkAccess: manifest.networkAccess.mode,
    platforms: [...manifest.platforms],
    risk: permissionRisk(permissions, manifest.networkAccess.mode),
    contentHash,
    requiresPermissionConfirmation: permissionReview?.requiresConfirmation ?? false,
  };
}

export class ExtensionInstallRuntime {
  constructor(
    private readonly repository: ExtensionRepository,
    private readonly validation = new ExtensionValidationRuntime(),
    private readonly clock: () => number = Date.now,
    private readonly protocolVersion = CURRENT_PROTOCOL_VERSION,
  ) {}

  async install(input: ExtensionInstallInput): Promise<InstalledExtension> {
    const validated = this.validation.validateManifest(input.manifest);
    const id = extensionId(validated.id);
    const extensionSource = source(input.source);
    if (validated.minimumProtocolVersion > this.protocolVersion) {
      throw new CetaError('unsupported', 'Extension requires a newer protocol version');
    }
    const dataScope = input.dataScope ?? ['local-only'];
    if (!Array.isArray(dataScope) || dataScope.length > 8 || dataScope.some(scope => typeof scope !== 'string' || scope.length < 1 || scope.length > 64)) {
      throw new CetaError('permission_denied', 'Invalid extension data scope');
    }
    const packageData = input.packageData === undefined ? validated : input.packageData;
    inspectPayload(packageData);
    const packageJson = encoded(packageData, MAX_PACKAGE_BYTES, 'Extension package is too large or invalid');
    const manifestJson = encoded(validated, MAX_PACKAGE_BYTES, 'Extension manifest is too large or invalid');
    const contentHash = hash(JSON.stringify({manifest: manifestJson, package: packageJson}));
    const securityReport = report(validated, extensionSource, contentHash, input.publisherMetadata, dataScope, input.permissionReview);
    const existing = await this.repository.get(id, extensionSource);
    const now = new Date(this.clock()).toISOString();
    const next: InstalledExtension = {
      id,
      manifest: validated,
      contentHash,
      source: extensionSource,
      status: existing?.status ?? 'disabled',
      securityReport,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      revision: (existing?.revision ?? 0) + 1,
      ...(existing ? {previousManifest: existing.manifest, previousContentHash: existing.contentHash} : {}),
    };
    try {
      return await this.repository.save(next);
    } catch (error) {
      try {
        if (existing) {
          await this.repository.save(existing);
        } else {
          await this.repository.remove(id, extensionSource);
        }
      } catch {
        // The original storage error remains the actionable failure. No payload is executed.
      }
      if (error instanceof CetaError) {
        throw error;
      }
      throw new CetaError('storage_error', 'Extension install could not be persisted', {cause: error});
    }
  }
}
