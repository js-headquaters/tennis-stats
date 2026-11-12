export interface RecordedAudio { blob: Blob; mimeType: string }
export interface AudioRecorder { start(): Promise<void>; stop(): Promise<RecordedAudio>; cancel(): Promise<void> }

interface RecorderLike {
  state: RecordingState;
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}
interface RecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): RecorderLike;
  isTypeSupported?: (type: string) => boolean;
}
export interface AudioRecorderDependencies {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  MediaRecorder?: RecorderConstructor;
}
export type AudioRecorderErrorCode = 'unsupported' | 'permission' | 'start' | 'failed' | 'cancelled' | 'empty' | 'state';
export class AudioRecorderError extends Error {
  constructor(public readonly code: AudioRecorderErrorCode, message: string) { super(message); this.name = 'AudioRecorderError'; }
}
const error = (code: AudioRecorderErrorCode, message: string) => new AudioRecorderError(code, message);
const formats = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];

export function createAudioRecorder(deps: AudioRecorderDependencies = {
  mediaDevices: globalThis.navigator?.mediaDevices,
  MediaRecorder: globalThis.MediaRecorder as unknown as RecorderConstructor,
}): AudioRecorder {
  let state: 'idle' | 'starting' | 'recording' | 'stopping' | 'done' | 'failed' | 'cancelled' = 'idle';
  let recorder: RecorderLike | undefined;
  let stream: MediaStream | undefined;
  const chunks: Blob[] = [];
  let failure: AudioRecorderError | undefined;
  let result: RecordedAudio | undefined;
  let stopping: Promise<RecordedAudio> | undefined;
  let rejectStop: ((reason: AudioRecorderError) => void) | undefined;
  let resolveStop: ((result: RecordedAudio) => void) | undefined;
  const cleanup = () => { stream?.getTracks().forEach(track => track.stop()); stream = undefined; };
  const fail = (reason: AudioRecorderError) => {
    if (state === 'failed' || state === 'cancelled' || state === 'done') return;
    state = 'failed'; failure = reason; cleanup(); rejectStop?.(reason); rejectStop = undefined;
  };
  return {
    async start() {
      if (state !== 'idle') throw error('state', 'Recording already started');
      const Constructor = deps.MediaRecorder;
      if (!deps.mediaDevices?.getUserMedia || !Constructor) throw error('unsupported', 'Audio recording is unsupported');
      state = 'starting';
      let mimeType: string | undefined;
      try { mimeType = formats.find(type => Constructor.isTypeSupported?.(type)); }
      catch { fail(error('unsupported', 'Audio recording format is unsupported')); throw failure; }
      try { stream = await deps.mediaDevices.getUserMedia({ audio: true }); }
      catch {
        if ((state as string) === 'cancelled') throw error('cancelled', 'Recording cancelled');
        fail(error('permission', 'Microphone permission denied or unavailable')); throw failure;
      }
      if ((state as string) === 'cancelled') { cleanup(); throw error('cancelled', 'Recording cancelled'); }
      try {
        recorder = mimeType ? new Constructor(stream, { mimeType }) : new Constructor(stream);
        recorder.ondataavailable = event => { if (event.data.size && (state === 'recording' || state === 'stopping')) chunks.push(event.data); };
        recorder.onerror = () => fail(error('failed', 'Audio recording failed'));
        recorder.onstop = () => {
          if (state !== 'stopping') { if (state === 'recording') fail(error('failed', 'Audio recording failed')); return; }
          cleanup();
          const type = recorder?.mimeType || chunks.find(chunk => chunk.type)?.type || '';
          const blob = new Blob(chunks, { type });
          if (!blob.size) { fail(error('empty', 'Recording is empty')); return; }
          state = 'done'; result = { blob, mimeType: blob.type }; resolveStop?.(result); rejectStop = undefined;
        };
        recorder.start();
        if ((state as string) === 'failed') throw failure;
        state = 'recording';
      } catch {
        if ((state as string) !== 'failed') fail(error(mimeType ? 'start' : 'unsupported', mimeType ? 'Audio recording could not start' : 'Audio recording format is unsupported'));
        throw failure;
      }
    },
    async stop() {
      if (result) return result;
      if (stopping) return stopping;
      if (failure) throw failure;
      if (state !== 'recording' || !recorder) throw error('state', 'No active recording');
      state = 'stopping';
      stopping = new Promise<RecordedAudio>((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
      try { recorder.stop(); } catch { fail(error('failed', 'Audio recording failed')); }
      return stopping;
    },
    async cancel() {
      if (state === 'done' || state === 'cancelled' || state === 'failed') return;
      state = 'cancelled';
      rejectStop?.(error('cancelled', 'Recording cancelled')); rejectStop = undefined;
      if (recorder && recorder.state !== 'inactive') { try { recorder.stop(); } catch { /* Tracks still need cleanup. */ } }
      cleanup();
    },
  };
}
