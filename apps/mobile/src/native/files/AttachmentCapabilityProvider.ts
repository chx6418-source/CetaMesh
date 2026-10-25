import type {
  CapabilityDescriptor,
  CapabilityProvider,
  CapabilityRequest,
  CapabilityResult,
} from '../../domain/capability/Capability';
import type {
  AttachmentCapability,
  AttachmentProvider,
} from '../../domain/capability/Attachment';
import {validateAttachment} from '../../domain/capability/Attachment';
import {CetaError} from '../../shared/errors/CetaError';
import {PickerProvider} from './PickerProvider';

const descriptors: readonly CapabilityDescriptor[] = [
  {
    name: 'file.pick',
    version: 1,
    platforms: ['android', 'ios'],
    requiresPermission: true,
  },
  {
    name: 'photos.select',
    version: 1,
    platforms: ['android', 'ios'],
    requiresPermission: true,
  },
];

function isAttachmentCapability(name: string): name is AttachmentCapability {
  return name === 'file.pick' || name === 'photos.select';
}

export class AttachmentCapabilityProvider implements CapabilityProvider {
  constructor(
    private readonly picker: AttachmentProvider = new PickerProvider(),
  ) {}

  listCapabilities(): readonly CapabilityDescriptor[] {
    return descriptors;
  }

  async invoke(request: CapabilityRequest): Promise<CapabilityResult> {
    if (!isAttachmentCapability(request.name)) {
      throw new CetaError(
        'unsupported',
        'File and photo selection is unavailable',
      );
    }
    if (request.input !== undefined && request.input !== null) {
      throw new CetaError(
        'invalid_protocol',
        'File and photo selection does not accept external input',
      );
    }
    const attachment = validateAttachment(await this.picker.pick(request.name));
    return {name: request.name, output: attachment};
  }
}
