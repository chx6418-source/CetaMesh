import {VoiceRuntime} from '../runtime/voice/VoiceRuntime';
import {CetaError} from '../shared/errors/CetaError';
import type {CapabilityRuntime} from '../runtime/capability/CapabilityRuntime';
import type {MicrophoneRecording} from '../domain/capability/MicrophoneRecord';

const recording: MicrophoneRecording = {id: 'recording-1', name: 'note.m4a', mime: 'audio/mp4', kind: 'audio', data: 'AAAA', size: 3, durationMs: 1000};

test('voice capture uses the microphone capability and provider-neutral transcription', async () => {
  const calls: unknown[] = [];
  const capability: CapabilityRuntime = {invoke: async request => {calls.push(request); return {name: request.name, output: recording};}};
  const runtime = new VoiceRuntime(capability, {transcribe: async input => `Transcript for ${input.id}`});
  await expect(runtime.capture({destination: 'memory', taskId: 'task-1'})).resolves.toMatchObject({recording, transcript: 'Transcript for recording-1'});
  expect(calls[0]).toMatchObject({name: 'microphone.record', caller: 'voice-runtime', taskId: 'task-1'});
});

test('voice cancellation is propagated and does not call transcription', async () => {
  let transcriptions = 0;
  const capability: CapabilityRuntime = {invoke: async () => {throw new CetaError('cancelled', 'Recording cancelled');}};
  const runtime = new VoiceRuntime(capability, {transcribe: async () => {transcriptions += 1; return 'never';}});
  await expect(runtime.capture({destination: 'chat'})).rejects.toMatchObject({code: 'cancelled'});
  expect(transcriptions).toBe(0);
});

test('voice transcription and artifact output are bounded', async () => {
  const capability: CapabilityRuntime = {invoke: async request => ({name: request.name, output: recording})};
  const runtime = new VoiceRuntime(capability, {transcribe: async () => 'x'.repeat(16_001)});
  await expect(runtime.capture({destination: 'task-note'})).rejects.toMatchObject({code: 'unsupported'});
});
