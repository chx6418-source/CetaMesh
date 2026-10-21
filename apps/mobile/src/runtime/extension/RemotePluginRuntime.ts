import type {RemotePluginTransport} from '../../domain/extension/RemotePlugin';
import {ExtensionValidationRuntime} from './ExtensionValidationRuntime';
import {CetaError} from '../../shared/errors/CetaError';

export class RemotePluginRuntime {
  constructor(private readonly transport: RemotePluginTransport) {}

  async invoke(manifest: unknown, input: unknown): Promise<unknown> {
    const validated = new ExtensionValidationRuntime().validateManifest(manifest);
    if (validated.type !== 'remote-plugin' || validated.runtime !== 'remote') { throw new CetaError('unsupported', 'Only remote plugins use the remote contract'); }
    let encoded: string | undefined;
    try { encoded = JSON.stringify(input); } catch { throw new CetaError('invalid_protocol', 'Remote plugin input is invalid'); }
    if (!encoded) { throw new CetaError('invalid_protocol', 'Remote plugin input is invalid'); }
    if (encoded.length > 65_536) { throw new CetaError('unsupported', 'Remote plugin input is too large'); }
    const output = await this.transport.invoke({pluginId: validated.id, version: validated.version, input});
    try {
      const encodedOutput = JSON.stringify(output);
      if (!encodedOutput) { throw new CetaError('provider_error', 'Remote plugin output is invalid'); }
      if (encodedOutput.length > 65_536) { throw new CetaError('provider_error', 'Remote plugin output is too large'); }
    } catch (error) { if (error instanceof CetaError) { throw error; } throw new CetaError('provider_error', 'Remote plugin output is invalid'); }
    return output;
  }
}
