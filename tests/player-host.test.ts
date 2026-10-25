import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwapController } from '../src/player-host';
import { SIGNAL_CHANNEL, SOURCE_ORIGIN } from '../src/shared';

function fixture() {
  document.body.innerHTML = '<div id="live-player" style="position:relative"><video style="position:absolute;z-index:1"></video><div class="web-player-danmaku" style="position:relative;z-index:10">B弹幕</div><button style="position:relative;z-index:20">B控件</button></div><input id="chat">';
  const video = document.querySelector('video')!;
  Object.defineProperties(video, { paused: {value:false}, readyState:{value:4} });
  video.volume = .6;
  return video;
}

describe('replacement lifecycle', () => {
  let host: SwapController;
  beforeEach(() => {
    vi.useFakeTimers();
    fixture();
    host = new SwapController({resolveRoom:async () => ({roomId:'7734200',liveStatus:1}), targetRoomId: '7777'});
  });
  afterEach(() => { host.disable(); vi.useRealTimers(); document.body.innerHTML=''; });

  function signal(type: 'ready' | 'playing' | 'waiting' | 'error', overrides: Record<string, unknown> = {}) {
    const frame = document.querySelector('iframe')!;
    const token = new URL(frame.src).searchParams.get('bili_swap_token');
    window.dispatchEvent(new MessageEvent('message', {
      origin:SOURCE_ORIGIN, source:frame.contentWindow,
      data:{channel:SIGNAL_CHANNEL,token,type}, ...overrides
    }));
  }

  it('keeps B media untouched and layers A below B danmaku', async () => {
    const video=document.querySelector('video')!;
    const original = video.outerHTML;
    await host.enable('6');
    const frame = document.querySelector('iframe')!;
    expect(document.querySelector('video')).toBe(video);
    expect(video.outerHTML).toBe(original);
    expect(video.volume).toBe(.6);
    expect(video.muted).toBe(false);
    expect(video.paused).toBe(false);
    expect(frame.style.zIndex).toBe('2');
    expect(frame.style.pointerEvents).toBe('none');
    expect(new URL(frame.src).searchParams.get('cid')).toBe('7734200');
    expect(frame.style.opacity).toBe('0');
    signal('ready'); signal('playing');
    expect(frame.style.opacity).toBe('1');
    expect(host.getStatus().phase).toBe('playing');
    expect(document.querySelector('.web-player-danmaku')!.textContent).toBe('B弹幕');
  });

  it('requires guard acknowledgement and rejects spoofed messages', async () => {
    await host.enable('6');
    signal('playing');
    expect(host.getStatus().phase).toBe('loading');
    signal('ready', {origin:'https://example.com'});
    signal('playing');
    expect(host.getStatus().phase).toBe('loading');
    signal('ready'); signal('playing'); signal('ready');
    expect(host.getStatus().phase).toBe('playing');
  });

  it('restores B on buffering and destroys A on disable', async () => {
    await host.enable('6'); signal('ready'); signal('playing'); signal('waiting');
    expect(document.querySelector('iframe')!.style.opacity).toBe('0');
    expect(host.getStatus().phase).toBe('recovering');
    host.disable();
    expect(document.querySelector('iframe')).toBeNull();
    expect(host.getStatus().enabled).toBe(false);
    expect(document.querySelector('video')!.volume).toBe(.6);
    expect(document.querySelector('#chat')).not.toBeNull();
  });

  it('ignores a resolver completion after disable', async () => {
    let resolve!: (value:{roomId:string;liveStatus:number})=>void;
    host = new SwapController({targetRoomId:'7777',resolveRoom:()=>new Promise(r=>{resolve=r;})});
    const pending=host.enable('6');
    host.disable(); resolve({roomId:'7734200',liveStatus:1}); await pending;
    expect(document.querySelector('iframe')).toBeNull();
    expect(host.getStatus().phase).toBe('disabled');
  });

  it('fails safely if the source never acknowledges the mute guard', async () => {
    await host.enable('6');
    await vi.advanceTimersByTimeAsync(11_000);
    expect(host.getStatus().phase).toBe('error');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('reattaches after B rebuilds its player without changing B audio', async () => {
    await host.enable('6'); signal('ready'); signal('playing');
    const newVideo=fixture();
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.querySelector('iframe')).not.toBeNull();
    expect(newVideo.volume).toBe(.6);
    expect(newVideo.paused).toBe(false);
  });

  it('rejects offline sources before creating an iframe', async () => {
    host=new SwapController({targetRoomId:'7777',resolveRoom:async()=>({roomId:'7734200',liveStatus:0})});
    await host.enable('6');
    expect(host.getStatus().phase).toBe('error');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('allows a fresh recovery window when B rebuilds after a long watch', async () => {
    await host.enable('6'); signal('ready'); signal('playing');
    vi.setSystemTime(Date.now()+60_000);
    signal('ready'); signal('playing');
    document.querySelector('#live-player')!.remove();
    await vi.advanceTimersByTimeAsync(1500);
    expect(host.getStatus().phase).toBe('waiting-player');
    fixture();
    await vi.advanceTimersByTimeAsync(1500);
    expect(host.getStatus().phase).toBe('loading');
    expect(document.querySelector('iframe')).not.toBeNull();
  });
});
