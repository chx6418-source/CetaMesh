import {
  errorCodes,
  isErrorWithCode,
  keepLocalCopy,
  pick,
  types,
} from '@react-native-documents/picker';
import BlobUtil from 'react-native-blob-util';
import type {ExtensionPackagePickerDriver} from './ExtensionPackagePickerProvider';
import {CetaError} from '../../shared/errors/CetaError';
import {newId} from '../../shared/utils/id';

function path(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
}

export class NativeExtensionPackagePickerDriver implements ExtensionPackagePickerDriver {
  async pick() {
    try {
      const files = await pick({mode: 'import', allowMultiSelection: false, allowVirtualFiles: false, type: [types.json]});
      const file = files[0];
      if (
        !file || file.error || file.isVirtual || !file.hasRequestedType ||
        !file.type || !Number.isFinite(file.size) || !file.size
      ) {
        throw new CetaError('unsupported', 'Choose a local JSON extension manifest');
      }
      return {uri: file.uri, name: file.name || 'extension.json', mime: file.type, size: Number(file.size)};
    } catch (error) {
      if (isErrorWithCode(error) && error.code === errorCodes.OPERATION_CANCELED) {
        throw new CetaError('cancelled', 'Extension import cancelled');
      }
      throw error instanceof CetaError
        ? error
        : new CetaError('permission_denied', 'Cannot access the selected extension manifest');
    }
  }

  async localCopy(uri: string) {
    const results = await keepLocalCopy({files: [{uri, fileName: newId('extension') + '.json'}], destination: 'cachesDirectory'});
    const result = results[0];
    if (result?.status !== 'success') {
      throw new CetaError('storage_error', 'Could not copy the extension manifest');
    }
    return result.localUri;
  }

  async stat(uri: string) {
    const result = await BlobUtil.fs.stat(path(uri));
    return Number(result.size);
  }

  read(uri: string) {
    return BlobUtil.fs.readFile(path(uri), 'utf8');
  }

  remove(uri: string) {
    return BlobUtil.fs.unlink(path(uri));
  }
}
