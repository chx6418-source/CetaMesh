import BlobUtil from 'react-native-blob-util';
import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
} from '../../domain/capability/Capability';
import {
  parseMicrophoneRecordNativeResult,
} from '../../domain/capability/MicrophoneRecord';
import type {MicrophoneRecording} from '../../domain/capability/MicrophoneRecord';
import {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';
import Native from './NativeCetaMicrophoneRecord';

type MicrophoneNativeModule = {
  record(): Promise<string>;
  cancel(): void;
};

type AudioFileDriver = {
  stat(uri: string): Promise<number | string>;
  read(uri: string, encoding: 'base64'): Promise<string>;
  remove(uri: string): Promise<void>;
};

const descriptor: CapabilityDescriptor = {
  name: 'microphone.record',
  version: 1,
  platforms: ['android', 'ios'],
  requiresPermission: true,
  providerId: 'native.microphone',
};

const MAX_BYTES = 8 * 1024 * 1024;

const driver: AudioFileDriver = {
  async stat(uri) {
    const result = await BlobUtil.fs.stat(uri);
    return Number(result.size);
  },
  async read(uri, encoding) {
    return BlobUtil.fs.readFile(uri, encoding);
  },
  async remove(uri) {
    await BlobUtil.fs.unlink(uri);
  },
};

function normalizeNativeError(error: unknown): CetaError {
  if (error instanceof CetaError) {
    return error;
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (
      code === 'cancelled' ||
      code === 'invalid_protocol' ||
      code === 'permission_denied' ||
      code === 'storage_error' ||
      code === 'unsupported' ||
      code === 'timeout'
    ) {
      return new CetaError(
        code,
        code === 'permission_denied'
          ? 'Microphone permission was denied'
          : 'Microphone recording is unavailable',
      );
    }
  }
  return new CetaError('provider_error', 'Microphone recording is unavailable');
}

function filePath(uri: string): string {
  try {
    const path = decodeURIComponent(uri.slice('file://'.length));
    if (
      path.split('/').includes('..') ||
      Array.from(path).some(character => character.charCodeAt(0) < 32 || character === '\\')
    ) {
      throw new CetaError('permission_denied', 'Unsafe microphone file URI');
    }
    return path;
  } catch {
    throw new CetaError('permission_denied', 'Invalid microphone file URI');
  }
}

export class MicrophoneRecordProvider implements CapabilityProvider {
  constructor(
    private readonly native: MicrophoneNativeModule | null = Native ?? null,
    private readonly files: AudioFileDriver = driver,
  ) {}

  listCapabilities(): readonly CapabilityDescriptor[] {
    return [descriptor];
  }

  async invoke(request: CapabilityRequest): Promise<CapabilityResult> {
    if (request.name !== descriptor.name) {
      throw new CetaError('unsupported', 'Microphone recording is unavailable');
    }
    if (request.input !== undefined && request.input !== null) {
      throw new CetaError(
        'invalid_protocol',
        'Microphone recording does not accept external file input',
      );
    }
    if (!this.native) {
      throw new CetaError('unsupported', 'Microphone recording is unavailable');
    }

    let path: string | undefined;
    try {
      const nativeResult = parseMicrophoneRecordNativeResult(
        await this.native.record(),
      );
      path = filePath(nativeResult.uri);
      const size = Number(await this.files.stat(path));
      if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
        throw new CetaError(
          'unsupported',
          'Microphone recording exceeds the supported size limit',
        );
      }
      const data = await this.files.read(path, 'base64');
      if (
        !data ||
        data.length > Math.ceil((MAX_BYTES / 3) * 4) ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
      ) {
        throw new CetaError('invalid_protocol', 'Invalid microphone recording');
      }
      const recording: MicrophoneRecording = {
        id: newId('recording'),
        name: nativeResult.name,
        mime: nativeResult.mime,
        kind: 'audio',
        data,
        size,
        durationMs: nativeResult.durationMs,
      };
      return {name: request.name, output: recording};
    } catch (error) {
      throw normalizeNativeError(error);
    } finally {
      if (path) {
        await this.files.remove(path).catch(() => undefined);
      }
    }
  }

  cancel(): void {
    this.native?.cancel();
  }
}
