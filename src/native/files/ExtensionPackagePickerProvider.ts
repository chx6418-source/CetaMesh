import type {ExtensionPackageDocument, ExtensionPackagePicker} from '../../domain/extension/ExtensionPackagePicker';
import {EXTENSION_PACKAGE_MAX_BYTES} from '../../domain/extension/ExtensionPackagePicker';
import {validatePickedUri} from '../../domain/capability/Attachment';
import {CetaError} from '../../shared/errors/CetaError';

export type SelectedExtensionDocument = {uri: string; name: string; mime: string; size: number};

export interface ExtensionPackagePickerDriver {
  pick(): Promise<SelectedExtensionDocument>;
  localCopy(uri: string): Promise<string>;
  stat(uri: string): Promise<number>;
  read(uri: string): Promise<string>;
  remove(uri: string): Promise<void>;
}

function safeName(value: string): string {
  const name = Array.from(value).map(character =>
    character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character,
  ).join('');
  return name.slice(0, 120) || 'extension.json';
}

export class ExtensionPackagePickerProvider implements ExtensionPackagePicker {
  constructor(private readonly driver: ExtensionPackagePickerDriver) {}

  async pick(): Promise<ExtensionPackageDocument> {
    let copiedUri: string | undefined;
    try {
      const selected = await this.driver.pick();
      validatePickedUri(selected.uri);
      if (
        !['application/json', 'text/json'].includes(selected.mime) ||
        !Number.isFinite(selected.size) || selected.size <= 0 || selected.size > EXTENSION_PACKAGE_MAX_BYTES
      ) {
        throw new CetaError('unsupported', 'Choose a JSON extension manifest up to 1 MiB');
      }
      copiedUri = await this.driver.localCopy(selected.uri);
      validatePickedUri(copiedUri);
      if (!copiedUri.startsWith('file:///')) {
        throw new CetaError('storage_error', 'Extension manifest copy is not a local file');
      }
      const actualSize = await this.driver.stat(copiedUri);
      if (!Number.isFinite(actualSize) || actualSize <= 0 || actualSize > EXTENSION_PACKAGE_MAX_BYTES) {
        throw new CetaError('unsupported', 'Extension manifest exceeds the 1 MiB limit');
      }
      const text = await this.driver.read(copiedUri);
      if (!text || text.length > EXTENSION_PACKAGE_MAX_BYTES || text.includes('\0')) {
        throw new CetaError('unsupported', 'Extension manifest is empty or invalid');
      }
      return {name: safeName(selected.name), text};
    } catch (error) {
      throw error instanceof CetaError
        ? error
        : new CetaError('provider_error', 'Could not read the selected extension manifest');
    } finally {
      if (copiedUri) {
        await this.driver.remove(copiedUri).catch(() => undefined);
      }
    }
  }
}
