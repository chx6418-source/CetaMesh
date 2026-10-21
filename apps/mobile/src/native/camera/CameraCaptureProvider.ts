import BlobUtil from 'react-native-blob-util';
import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
} from '../../domain/capability/Capability';
import {
  parseCameraCaptureNativeResult,
} from '../../domain/capability/CameraCapture';
import {validateAttachment, validatePickedUri} from '../../domain/capability/Attachment';
import type {Attachment} from '../../domain/chat/ChatRepository';
import {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';
import Native from './NativeCetaCameraCapture';

type CameraNativeModule = {
  capture(): Promise<string>;
  cancel(): void;
};

type CameraFileDriver = {
  stat(uri: string): Promise<number | string>;
  read(uri: string, encoding: 'base64'): Promise<string>;
  remove(uri: string): Promise<void>;
};

const descriptor: CapabilityDescriptor = {
  name: 'camera.capture',
  version: 1,
  platforms: ['android', 'ios'],
  requiresPermission: true,
};

const driver: CameraFileDriver = {
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
      code === 'unsupported'
    ) {
      return new CetaError(
        code,
        code === 'permission_denied'
          ? 'Camera permission was denied'
          : 'Camera capture is unavailable',
      );
    }
  }
  return new CetaError('provider_error', 'Camera capture is unavailable');
}

function filePath(uri: string): string {
  try {
    return decodeURIComponent(uri.slice('file://'.length));
  } catch {
    throw new CetaError('permission_denied', 'Invalid camera file URI');
  }
}

export class CameraCaptureProvider implements CapabilityProvider {
  constructor(
    private readonly native: CameraNativeModule | null = Native ?? null,
    private readonly files: CameraFileDriver = driver,
  ) {}

  listCapabilities(): readonly CapabilityDescriptor[] {
    return [descriptor];
  }

  async invoke(request: CapabilityRequest): Promise<CapabilityResult> {
    if (request.name !== descriptor.name) {
      throw new CetaError('unsupported', 'Camera capture is unavailable');
    }
    if (request.input !== undefined && request.input !== null) {
      throw new CetaError(
        'invalid_protocol',
        'Camera capture does not accept external file input',
      );
    }
    if (!this.native) {
      throw new CetaError('unsupported', 'Camera capture is unavailable');
    }

    let uri: string | undefined;
    try {
      const nativeResult = parseCameraCaptureNativeResult(
        await this.native.capture(),
      );
      uri = nativeResult.uri;
      validatePickedUri(uri);
      const path = filePath(uri);
      const size = Number(await this.files.stat(path));
      if (!Number.isFinite(size) || size <= 0 || size > 4 * 1024 * 1024) {
        throw new CetaError(
          'unsupported',
          'Captured image exceeds the supported size limit',
        );
      }
      const data = await this.files.read(path, 'base64');
      const attachment: Attachment = validateAttachment({
        id: newId('camera'),
        name: nativeResult.name,
        mime: nativeResult.mime,
        kind: 'image',
        data,
        size,
      });
      return {name: request.name, output: attachment};
    } catch (error) {
      throw normalizeNativeError(error);
    } finally {
      if (uri) {
        await this.files.remove(filePath(uri)).catch(() => undefined);
      }
    }
  }

  cancel(): void {
    this.native?.cancel();
  }
}
