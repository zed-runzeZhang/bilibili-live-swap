import { afterEach, describe, expect, it, vi } from 'vitest';
import { installSourceGuard, sourceGuardToken } from '../src/source-guard';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function install(token = 'test-token') {
  const messages = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  cleanups.push(installSourceGuard(window, token));
  return messages;
}

function videoState(video: HTMLVideoElement, state: Partial<{readyState: number; paused: boolean; videoWidth: number; currentTime: number}>) {
  for (const [key, value] of Object.entries(state)) {
    Object.defineProperty(video, key, { configurable: true, writable: true, value });
  }
}

function types(messages: ReturnType<typeof install>): unknown[] {
  return messages.mock.calls.map(([message]) => message.type);
}

describe('source frame activation', () => {
  function frame(url: string, isTop = false) {
    const self = {} as Window['self'];
    return { location: new URL(url) as unknown as Location, self, top: isTop ? self : {} as Window };
  }

  it('only selects a token-marked official embed child frame', () => {
    expect(sourceGuardToken(frame('https://www.bilibili.com/blackboard/live/live-activity-player.html?bili_swap_token=abc'))).toBe('abc');
    expect(sourceGuardToken(frame('https://www.bilibili.com/blackboard/live/live-activity-player.html?bili_swap_token=abc', true))).toBeNull();
    expect(sourceGuardToken(frame('https://www.bilibili.com/blackboard/live/live-activity-player.html'))).toBeNull();
    expect(sourceGuardToken(frame('https://www.bilibili.com/blackboard/live/live-activity-player.html?bili_swap_token='))).toBeNull();
    expect(sourceGuardToken(frame('https://evil.example/blackboard/live/live-activity-player.html?bili_swap_token=abc'))).toBeNull();
    expect(sourceGuardToken(frame('https://www.bilibili.com/video/123?bili_swap_token=abc'))).toBeNull();
  });
});

describe('source silence', () => {
  it('silences existing media and refuses later unmute or volume writes', () => {
    const video = document.createElement('video');
    const audio = document.createElement('audio');
    document.body.append(video, audio);
    install();

    for (const media of [video, audio]) {
      expect(media.muted).toBe(true);
      expect(media.defaultMuted).toBe(true);
      expect(media.volume).toBe(0);
      media.muted = false;
      media.defaultMuted = false;
      media.volume = 1;
      expect(media.muted).toBe(true);
      expect(media.defaultMuted).toBe(true);
      expect(media.volume).toBe(0);
    }
  });

  it('silences media synchronously before native play, including disconnected new media', async () => {
    const originalMuted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')!;
    const nativePlay = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      expect(this.muted).toBe(true);
      expect(this.defaultMuted).toBe(true);
      expect(this.volume).toBe(0);
      return Promise.resolve();
    });
    install();
    const video = document.createElement('video');
    originalMuted.set!.call(video, false);
    await video.play();
    expect(nativePlay).toHaveBeenCalledTimes(1);
  });

  it('repairs native volume changes and added media before reporting progress', async () => {
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')!;
    const volume = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume')!;
    install();
    const video = document.createElement('video');
    document.body.append(video);
    await Promise.resolve();
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
    muted.set!.call(video, false);
    volume.set!.call(video, 0.8);
    video.dispatchEvent(new Event('volumechange'));
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
  });

  it('restores prototype hooks and stops reports when cleaned up', () => {
    vi.useFakeTimers();
    const muted = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')!;
    const play = HTMLMediaElement.prototype.play;
    const messages = install();
    expect(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')?.set).not.toBe(muted.set);
    expect(HTMLMediaElement.prototype.play).not.toBe(play);
    const stop = cleanups.pop()!;
    stop();
    expect(Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted')).toEqual(muted);
    expect(HTMLMediaElement.prototype.play).toBe(play);
    const before = messages.mock.calls.length;
    vi.advanceTimersByTime(3000);
    expect(messages).toHaveBeenCalledTimes(before);
  });

  it('routes Web Audio output through zero gain without changing source connections', () => {
    const connections: Array<{ source: FakeNode; destination: FakeNode }> = [];
    const disconnections: FakeNode[] = [];
    class FakeNode {
      constructor(public context: { createGain(): FakeGain; destination?: FakeDestination }) {}
      connect(destination: FakeNode) {
        connections.push({ source: this, destination });
        return destination;
      }
      disconnect(destination: FakeNode) { disconnections.push(destination); }
    }
    class FakeDestination extends FakeNode {}
    class FakeGain extends FakeNode { gain = { value: 1 }; }
    vi.stubGlobal('AudioNode', FakeNode);
    vi.stubGlobal('AudioDestinationNode', FakeDestination);
    const context = { createGain: (): FakeGain => new FakeGain(context), destination: undefined as FakeDestination | undefined };
    const destination = new FakeDestination(context);
    context.destination = destination;
    const source = new FakeNode(context);
    install();

    expect(source.connect(destination)).toBe(destination);
    const gate = connections.find(edge => edge.source === source)!.destination as FakeGain;
    expect(gate).toBeInstanceOf(FakeGain);
    expect(gate.gain.value).toBe(0);
    expect(connections).toContainEqual({ source: gate, destination });
    source.disconnect(destination);
    expect(disconnections).toContain(gate);
  });
});

describe('source signals', () => {
  it('acknowledges installed hooks and repeats the token-bound handshake every second', () => {
    vi.useFakeTimers();
    const messages = install('secret-frame-token');
    expect(messages).toHaveBeenCalledWith({ channel: 'bili-live-swap', token: 'secret-frame-token', type: 'ready' }, 'https://live.bilibili.com');
    const count = types(messages).filter(type => type === 'ready').length;
    vi.advanceTimersByTime(1000);
    expect(types(messages).filter(type => type === 'ready')).toHaveLength(count + 1);
    for (const [message, origin] of messages.mock.calls) {
      expect(message.token).toBe('secret-frame-token');
      expect(origin).toBe('https://live.bilibili.com');
    }
  });

  it('reports playing only after a decodable visible video actually advances', () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    videoState(video, { readyState: 2, paused: false, videoWidth: 1920, currentTime: 0 });
    document.body.append(video);
    const messages = install();
    expect(types(messages)).not.toContain('playing');
    vi.advanceTimersByTime(1000);
    expect(types(messages)).not.toContain('playing');
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(types(messages).at(-1)).toBe('playing');
    videoState(video, { paused: true });
    video.dispatchEvent(new Event('pause'));
    expect(types(messages).at(-1)).toBe('waiting');
  });

  it('falls back to waiting on stalls and errors on native playback failures', () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    videoState(video, { readyState: 4, paused: false, videoWidth: 1920, currentTime: 0 });
    document.body.append(video);
    const messages = install();
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(types(messages).at(-1)).toBe('playing');
    video.dispatchEvent(new Event('waiting'));
    expect(types(messages).at(-1)).toBe('waiting');
    video.dispatchEvent(new Event('error'));
    expect(types(messages).at(-1)).toBe('error');
  });

  it('never reveals ended video even when its final frame still reports enough data', () => {
    const video = document.createElement('video');
    videoState(video, { readyState: 4, paused: false, videoWidth: 1920, currentTime: 0 });
    document.body.append(video);
    const messages = install();
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(types(messages).at(-1)).toBe('playing');
    Object.defineProperty(video, 'ended', { configurable: true, value: true });
    video.dispatchEvent(new Event('ended'));
    expect(types(messages).at(-1)).toBe('waiting');
  });
});

describe('source presentation', () => {
  it('keeps the video and all ancestors visible while hiding sibling overlays', async () => {
    const container = document.createElement('div');
    container.id = 'player_container';
    container.innerHTML = '<div class="player-left-container"><div class="native-stage"><video></video><div class="native-overlay">Click to unmute</div></div><div class="native-danmaku">A danmaku</div></div><div class="native-sidebar">native chrome</div>';
    document.body.append(container);
    install();
    const video = container.querySelector('video')!;
    for (let node: HTMLElement | null = video; node; node = node.parentElement) {
      expect(getComputedStyle(node).display).not.toBe('none');
      expect(getComputedStyle(node).visibility).not.toBe('hidden');
    }
    for (const overlay of container.querySelectorAll<HTMLElement>('.native-overlay, .native-danmaku, .native-sidebar')) {
      expect(getComputedStyle(overlay).display).toBe('none');
    }
    expect(video.parentElement!.style.position).toBe('relative');
    expect(video.parentElement!.style.flex).toBe('1 1 0%');

    const overlay = document.createElement('div');
    overlay.textContent = 'late unmute';
    video.parentElement!.append(overlay);
    await Promise.resolve();
    expect(getComputedStyle(overlay).display).toBe('none');
  });

  it('finds a replacement video after the native player rebuilds', async () => {
    install();
    const replacement = document.createElement('video');
    const stage = document.createElement('div');
    stage.append(replacement);
    document.body.replaceChildren(stage);
    await Promise.resolve();
    expect(replacement.muted).toBe(true);
    expect(replacement.defaultMuted).toBe(true);
    expect(stage.style.position).toBe('relative');
    expect(getComputedStyle(replacement).display).not.toBe('none');
  });
});
