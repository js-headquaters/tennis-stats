import { describe, expect, it, vi } from 'vitest';
import { createAudioRecorder } from './mediaRecorder';

function fixture(supported = ['audio/mp4', 'audio/webm']) {
  const stopTrack = vi.fn();
  const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  class Recorder {
    static isTypeSupported(type: string) { return supported.includes(type); }
    state: RecordingState = 'inactive';
    mimeType: string;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(_stream: MediaStream, options?: MediaRecorderOptions) { this.mimeType = options?.mimeType ?? ''; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['sound']) } as BlobEvent); this.onstop?.(); }
  }
  const recorder = createAudioRecorder({ mediaDevices: { getUserMedia }, MediaRecorder: Recorder });
  return { recorder, getUserMedia, stopTrack };
}

describe('audio recorder', () => {
  it('prefers supported mp4 over webm and cleans up tracks', async () => {
    const { recorder, stopTrack } = fixture();
    await recorder.start();
    const audio = await recorder.stop();
    expect(audio.mimeType).toBe('audio/mp4');
    expect(await audio.blob.text()).toBe('sound');
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(await recorder.stop()).toBe(audio);
  });
  it('falls back only to a supported format', async () => {
    const { recorder } = fixture(['audio/webm']);
    await recorder.start();
    expect((await recorder.stop()).mimeType).toBe('audio/webm');
  });
  it('rejects stop before start and safely repeats cancellation', async () => {
    const { recorder, stopTrack } = fixture();
    await expect(recorder.stop()).rejects.toThrow();
    await recorder.start();
    await recorder.cancel();
    await recorder.cancel();
    expect(stopTrack).toHaveBeenCalledOnce();
    await expect(recorder.stop()).rejects.toThrow();
  });
  it('does not expose permission errors', async () => {
    const { recorder, getUserMedia } = fixture();
    getUserMedia.mockRejectedValue(new Error('secret'));
    await expect(recorder.start()).rejects.toThrow(/permission/i);
  });
});

describe('recorder edge cases', () => {
  function setup(supported: string[] = ['audio/mp4']) {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    let instance: Fake;
    class Fake {
      static isTypeSupported(type: string) { return supported.includes(type); }
      state: RecordingState = 'inactive';
      mimeType: string;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_stream: MediaStream, options?: MediaRecorderOptions) { instance = Object.assign(this, {}); this.mimeType = options?.mimeType ?? 'audio/default'; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
      data(text: string, type = '') { this.ondataavailable?.({ data: new Blob([text], { type }) } as BlobEvent); }
      finish() { this.onstop?.(); }
      fail() { this.onerror?.(); }
    }
    return { recorder: createAudioRecorder({ mediaDevices: { getUserMedia }, MediaRecorder: Fake }), track, getUserMedia, instance: () => instance };
  }

  it('prefers the explicit AAC codec over plain mp4', async () => {
    const f = setup(['audio/mp4', 'audio/mp4;codecs=mp4a.40.2']);
    await f.recorder.start();
    expect(f.instance().mimeType).toBe('audio/mp4;codecs=mp4a.40.2');
    await f.recorder.cancel();
  });
  it('uses the default constructor when no explicit format is supported', async () => {
    const f = setup([]);
    await f.recorder.start();
    const pending = f.recorder.stop();
    f.instance().data('sound'); f.instance().finish();
    expect((await pending).mimeType).toBe('audio/default');
  });
  it('rejects a pending stop immediately on asynchronous error', async () => {
    const f = setup(); await f.recorder.start();
    const pending = f.recorder.stop(); f.instance().fail();
    await expect(pending).rejects.toThrow(/failed/i);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it('rejects a pending stop on cancel even if stop event never arrives', async () => {
    const f = setup(); await f.recorder.start();
    const pending = f.recorder.stop();
    await f.recorder.cancel();
    await expect(pending).rejects.toThrow(/cancel/i);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it('rejects stop after an error before stop was requested', async () => {
    const f = setup(); await f.recorder.start(); f.instance().fail();
    await expect(f.recorder.stop()).rejects.toThrow(/failed/i);
  });
  it('rejects empty recordings', async () => {
    const f = setup(); await f.recorder.start();
    const pending = f.recorder.stop(); f.instance().finish();
    await expect(pending).rejects.toThrow(/empty/i);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it('cleans up a stream arriving after cancellation', async () => {
    const f = setup();
    let resolve!: (stream: MediaStream) => void;
    f.getUserMedia.mockReturnValue(new Promise<MediaStream>(r => { resolve = r; }));
    const start = f.recorder.start(); await f.recorder.cancel();
    resolve({ getTracks: () => [f.track] } as unknown as MediaStream);
    await expect(start).rejects.toThrow(/cancel/i);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
  it('rejects missing APIs safely', async () => {
    await expect(createAudioRecorder({}).start()).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('rejects double start without requesting another stream', async () => {
    const f = setup(); await f.recorder.start();
    await expect(f.recorder.start()).rejects.toMatchObject({ code: 'state' });
    expect(f.getUserMedia).toHaveBeenCalledOnce(); await f.recorder.cancel();
  });
  it('retains chunk MIME when the recorder reports none', async () => {
    const f = setup(); await f.recorder.start(); f.instance().mimeType = '';
    const pending = f.recorder.stop(); f.instance().data('sound', 'audio/aac'); f.instance().finish();
    expect((await pending).mimeType).toBe('audio/aac');
  });
  it('rejects construction failure without exposing its message and cleans tracks', async () => {
    const track = { stop: vi.fn() };
    class Broken { static isTypeSupported() { return false; } constructor() { throw new Error('secret'); } }
    const recorder = createAudioRecorder({ mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [track] }) }, MediaRecorder: Broken as never });
    await expect(recorder.start()).rejects.toMatchObject({ code: 'unsupported', message: expect.not.stringContaining('secret') });
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('cleans tracks when start throws', async () => {
    const f = setup();
    // A synchronous failure after construction is modeled by a subclass below.
    class Broken {
      static isTypeSupported() { return true; }
      state: RecordingState = 'inactive'; mimeType = 'audio/mp4'; ondataavailable = null; onstop = null; onerror = null;
      start() { throw new Error('secret'); } stop() {}
    }
    const recorder = createAudioRecorder({ mediaDevices: { getUserMedia: f.getUserMedia }, MediaRecorder: Broken });
    await expect(recorder.start()).rejects.toMatchObject({ code: 'start', message: expect.not.stringContaining('secret') });
    expect(f.track.stop).toHaveBeenCalledOnce();
  });
});
