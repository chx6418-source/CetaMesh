import type {MicrophoneRecording} from '../capability/MicrophoneRecord';

export type VoiceDestination = 'chat' | 'memory' | 'task-note';
export type VoiceCaptureOptions = {readonly destination: VoiceDestination; readonly taskId?: string};
export type VoiceCaptureResult = {readonly destination: VoiceDestination; readonly recording: MicrophoneRecording; readonly transcript?: string};

export interface TranscriptionProvider {
  transcribe(recording: MicrophoneRecording): Promise<string>;
}
