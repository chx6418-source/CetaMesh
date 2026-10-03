import type {CapabilityRuntime} from '../capability/CapabilityRuntime';
import type {MicrophoneRecording} from '../../domain/capability/MicrophoneRecord';
import type {TranscriptionProvider, VoiceCaptureOptions, VoiceCaptureResult} from '../../domain/voice';
import {CetaError} from '../../shared/errors/CetaError';

function recording(value: unknown): MicrophoneRecording {
  if (!value || typeof value !== 'object') { throw new CetaError('invalid_protocol', 'Invalid voice capability result'); }
  const item = value as Partial<MicrophoneRecording>;
  if (item.kind !== 'audio' || item.mime !== 'audio/mp4' || typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.data !== 'string' || typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size <= 0 || item.size > 8 * 1024 * 1024 || typeof item.durationMs !== 'number' || !Number.isInteger(item.durationMs) || item.durationMs <= 0 || item.durationMs > 60_000 || item.data.length > 12 * 1024 * 1024) { throw new CetaError('invalid_protocol', 'Invalid voice capability result'); }
  return item as MicrophoneRecording;
}

export class VoiceRuntime {
  constructor(private readonly capability: CapabilityRuntime, private readonly transcriber: TranscriptionProvider) {}

  async capture(options: VoiceCaptureOptions): Promise<VoiceCaptureResult> {
    const result = await this.capability.invoke({name: 'microphone.record', caller: 'voice-runtime', taskId: options.taskId, scope: options.taskId ? {kind: 'task', id: options.taskId} : {kind: 'local'}});
    if (!result || typeof result !== 'object' || !('output' in result)) { throw new CetaError('invalid_protocol', 'Invalid voice capability result'); }
    const value = recording((result as {output: unknown}).output);
    const transcript = await this.transcriber.transcribe(value);
    if (typeof transcript !== 'string' || transcript.length > 16_000) { throw new CetaError('unsupported', 'Transcript is too large'); }
    return {destination: options.destination, recording: value, ...(transcript ? {transcript} : {})};
  }
}
