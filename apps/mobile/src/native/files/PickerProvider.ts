import { launchImageLibrary } from 'react-native-image-picker';
import {
  pick,
  types,
  isErrorWithCode,
  errorCodes,
  keepLocalCopy,
} from '@react-native-documents/picker';
import BlobUtil from 'react-native-blob-util';
import type {
  AttachmentCapability,
  AttachmentProvider,
} from '../../domain/capability/Attachment';
import {
  IMAGE_LIMIT,
  TEXT_LIMIT,
  validateAttachment,
  validatePickedUri,
} from '../../domain/capability/Attachment';
import type { Attachment } from '../../domain/chat/ChatRepository';
import { CetaError } from '../../shared/errors/CetaError';
import { newId } from '../../shared/utils/id';
type Selected = { uri: string; name: string; mime: string; size: number };
type Driver = {
  select(name: AttachmentCapability): Promise<Selected>;
  stat(uri: string): Promise<number>;
  read(uri: string, encoding: 'base64' | 'utf8'): Promise<string>;
  localCopy(uri: string): Promise<string>;
  remove(uri: string): Promise<void>;
};
function path(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
}
const driver: Driver = {
  async select(name) {
    if (name === 'photos.select') {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
        includeBase64: false,
        includeExtra: false,
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.8,
      });
      if (result.didCancel) {
        throw new CetaError('cancelled', 'Image selection cancelled');
      }
      if (result.errorCode) {
        throw new CetaError(
          result.errorCode === 'permission'
            ? 'permission_denied'
            : 'provider_error',
          'Image picker unavailable',
        );
      }
      const asset = result.assets?.[0];
      if (!asset?.uri || !asset.type || !asset.fileSize) {
        throw new CetaError('unsupported', 'Image metadata unavailable');
      }
      return {
        uri: asset.uri,
        name: asset.fileName || 'image',
        mime: asset.type,
        size: asset.fileSize,
      };
    }
    try {
      const files = await pick({
        mode: 'import',
        allowMultiSelection: false,
        allowVirtualFiles: false,
        type: [types.plainText, types.csv, types.json],
      });
      const file = files[0];
      if (
        file.error ||
        file.isVirtual ||
        !file.hasRequestedType ||
        !file.type ||
        !file.size
      ) {
        throw new CetaError(
          'unsupported',
          'Choose a local plain-text document with known size',
        );
      }
      return {
        uri: file.uri,
        name: file.name || 'document.txt',
        mime: file.type,
        size: file.size,
      };
    } catch (e) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) {
        throw new CetaError('cancelled', 'File selection cancelled');
      }
      throw e instanceof CetaError
        ? e
        : new CetaError(
            'permission_denied',
            'Cannot access the selected document',
          );
    }
  },
  async stat(uri) {
    const result = await BlobUtil.fs.stat(path(uri));
    return Number(result.size);
  },
  async localCopy(uri) {
    const results = await keepLocalCopy({
      files: [{ uri, fileName: newId('picked') + '.input' }],
      destination: 'cachesDirectory',
    });
    const result = results[0];
    if (result.status !== 'success') {
      throw new CetaError('storage_error', 'Could not copy the selected file');
    }
    return result.localUri;
  },
  async remove(uri) {
    await BlobUtil.fs.unlink(path(uri));
  },
  async read(uri, encoding) {
    return BlobUtil.fs.readFile(path(uri), encoding);
  },
};
export class PickerProvider implements AttachmentProvider {
  constructor(private readonly native: Driver = driver) {}
  async pick(name: AttachmentCapability): Promise<Attachment> {
    let localUri: string | undefined;
    try {
      const selected = await this.native.select(name);
      validatePickedUri(selected.uri);
      const image = name === 'photos.select';
      const allowed = image
        ? ['image/jpeg', 'image/png', 'image/webp']
        : ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
      const limit = image ? IMAGE_LIMIT : TEXT_LIMIT;
      if (
        !allowed.includes(selected.mime) ||
        !Number.isFinite(selected.size) ||
        selected.size <= 0 ||
        selected.size > limit
      ) {
        throw new CetaError(
          'unsupported',
          'Selected file type or size is not supported',
        );
      }
      const copiedUri = await this.native.localCopy(selected.uri);
      validatePickedUri(copiedUri);
      if (!copiedUri.startsWith('file:///')) {
        throw new CetaError('storage_error', 'Picker copy is not a local file');
      }
      localUri = copiedUri;
      const size = await this.native.stat(localUri);
      if (!Number.isFinite(size) || size <= 0 || size > limit) {
        throw new CetaError('unsupported', 'Selected file exceeds size limit');
      }
      const data = await this.native.read(localUri, image ? 'base64' : 'utf8');
      return validateAttachment({
        id: newId('attachment'),
        name: selected.name,
        mime: selected.mime,
        kind: image ? 'image' : 'text',
        data,
        size,
      });
    } catch (e) {
      throw e instanceof CetaError
        ? e
        : new CetaError(
            'provider_error',
            'Could not read the selected attachment',
          );
    } finally {
      if (localUri) {
        await this.native.remove(localUri).catch(() => undefined);
      }
    }
  }
}
