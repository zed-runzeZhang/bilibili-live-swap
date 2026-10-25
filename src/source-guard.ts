import { SIGNAL_CHANNEL, SOURCE_ORIGIN, type SourceSignal } from './shared';

const PATH_ATTRIBUTE = 'data-bili-live-swap-path';
const ROOT_ATTRIBUTE = 'data-bili-live-swap-media-root';
const installed = new WeakMap<Window, () => void>();

/** Top-level embeds and unmarked native players must retain their normal behavior. */
export function sourceGuardToken(win: Pick<Window, 'location' | 'self' | 'top'>): string | null {
  if (win.self === win.top) return null;
  const url = new URL(win.location.href);
  if (url.origin !== SOURCE_ORIGIN || url.pathname !== '/blackboard/live/live-activity-player.html') return null;
  const token = url.searchParams.get('bili_swap_token');
  return token?.trim() ? token : null;
}

/** Called at document_start in MAIN world, before the official player can start audio. */
export function installSourceGuard(win: Window & typeof globalThis, token: string): () => void {
  if (!token.trim()) return () => {};
  installed.get(win)?.();
  const doc = win.document;
  const prototype = win.HTMLMediaElement.prototype;
  const restorers: Array<() => void> = [];
  const mediaProperties = ['muted', 'defaultMuted', 'volume'] as const;
  const nativeProperties = new Map(mediaProperties.map(key => [key, Object.getOwnPropertyDescriptor(prototype, key)!]));
  let active = true;

  // Captured native setters avoid invoking the wrappers recursively. Checking the
  // native getters also avoids an endless stream of volumechange events.
  function silence(media: HTMLMediaElement) {
    for (const key of mediaProperties) {
      const descriptor = nativeProperties.get(key);
      const value = key === 'volume' ? 0 : true;
      if (descriptor?.set && descriptor.get?.call(media) !== value) descriptor.set.call(media, value);
    }
  }

  for (const key of mediaProperties) {
    const original = nativeProperties.get(key);
    if (!original?.set) continue;
    const setter = function (this: HTMLMediaElement, _value: unknown) {
      original.set!.call(this, key === 'volume' ? 0 : true);
    };
    Object.defineProperty(prototype, key, { ...original, set: setter });
    restorers.push(() => {
      if (Object.getOwnPropertyDescriptor(prototype, key)?.set === setter) Object.defineProperty(prototype, key, original);
    });
  }

  const originalPlay = Object.getOwnPropertyDescriptor(prototype, 'play')!;
  const guardedPlay = function (this: HTMLMediaElement, ...args: unknown[]) {
    silence(this);
    return Reflect.apply(originalPlay.value, this, args) as Promise<void>;
  };
  Object.defineProperty(prototype, 'play', { ...originalPlay, value: guardedPlay });
  restorers.push(() => {
    if (prototype.play === guardedPlay) Object.defineProperty(prototype, 'play', originalPlay);
  });

  // A media element can be routed into Web Audio. Silence the destination graph
  // as well, without suspending its clock or interrupting video decoding.
  if (win.AudioNode && win.AudioDestinationNode) {
    const audioPrototype = win.AudioNode.prototype;
    const connect = audioPrototype.connect;
    const disconnect = audioPrototype.disconnect;
    const gates = new WeakMap<BaseAudioContext, GainNode>();
    const guardedConnect = function (this: AudioNode, destination: AudioNode | AudioParam, ...args: number[]) {
      if (!(destination instanceof win.AudioDestinationNode)) return Reflect.apply(connect, this, [destination, ...args]);
      let gate = gates.get(this.context);
      if (!gate) {
        gate = this.context.createGain();
        gate.gain.value = 0;
        Reflect.apply(connect, gate, [destination]);
        gates.set(this.context, gate);
      }
      Reflect.apply(connect, this, [gate, ...args]);
      return destination;
    };
    const guardedDisconnect = function (this: AudioNode, ...args: unknown[]) {
      if (args[0] instanceof win.AudioDestinationNode) args[0] = gates.get(this.context) ?? args[0];
      return Reflect.apply(disconnect, this, args);
    };
    audioPrototype.connect = guardedConnect as typeof connect;
    audioPrototype.disconnect = guardedDisconnect as typeof disconnect;
    restorers.push(() => {
      if (audioPrototype.connect === guardedConnect) audioPrototype.connect = connect;
      if (audioPrototype.disconnect === guardedDisconnect) audioPrototype.disconnect = disconnect;
    });
  }

  const style = doc.createElement('style');
  style.setAttribute('data-bili-live-swap-style', '');
  style.textContent = `
    html, body { width:100%!important; height:100%!important; margin:0!important; padding:0!important; overflow:hidden!important; background:#000!important; }
    #player_container, .player-left-container { width:100%!important; height:100%!important; max-width:none!important; min-height:0!important; flex:1!important; position:relative!important; }
    [${PATH_ATTRIBUTE}] { display:block!important; visibility:visible!important; opacity:1!important; width:100%!important; height:100%!important; min-width:0!important; min-height:0!important; }
    [${PATH_ATTRIBUTE}] > :not([${PATH_ATTRIBUTE}]):not(video):not(style) { display:none!important; }
    [${ROOT_ATTRIBUTE}] { position:relative!important; flex:1!important; overflow:hidden!important; }
    video { display:block!important; visibility:visible!important; opacity:1!important; position:absolute!important; inset:0!important; width:100%!important; height:100%!important; object-fit:contain!important; z-index:1!important; }
  `;
  const originalPaths = new Map<HTMLElement, string | null>();
  const originalRoots = new Map<HTMLElement, { attribute: string | null; style: string | null }>();
  let paths = new Set<HTMLElement>();
  let roots = new Set<HTMLElement>();
  const samples = new WeakMap<HTMLVideoElement, { time: number; progressedAt?: number }>();
  const stalled = new WeakSet<HTMLVideoElement>();
  const failed = new WeakSet<HTMLVideoElement>();

  function refreshMedia() {
    if (!style.isConnected && doc.documentElement) (doc.head ?? doc.documentElement).append(style);
    doc.querySelectorAll<HTMLMediaElement>('video, audio').forEach(silence);
    const nextPaths = new Set<HTMLElement>();
    const nextRoots = new Set<HTMLElement>();
    for (const video of doc.querySelectorAll('video')) {
      if (!samples.has(video)) samples.set(video, { time: video.currentTime });
      for (let node: HTMLElement | null = video; node; node = node.parentElement) nextPaths.add(node);
      if (video.parentElement) nextRoots.add(video.parentElement);
    }
    for (const node of paths) {
      if (!nextPaths.has(node)) restoreAttribute(node, PATH_ATTRIBUTE, originalPaths.get(node) ?? null);
    }
    for (const node of nextPaths) {
      if (!originalPaths.has(node)) originalPaths.set(node, node.getAttribute(PATH_ATTRIBUTE));
      node.setAttribute(PATH_ATTRIBUTE, '');
    }
    for (const node of roots) {
      if (!nextRoots.has(node)) restoreRoot(node);
    }
    for (const node of nextRoots) {
      if (!originalRoots.has(node)) originalRoots.set(node, { attribute: node.getAttribute(ROOT_ATTRIBUTE), style: node.getAttribute('style') });
      node.setAttribute(ROOT_ATTRIBUTE, '');
      node.style.setProperty('position', 'relative', 'important');
      node.style.setProperty('flex', '1', 'important');
    }
    paths = nextPaths;
    roots = nextRoots;
  }

  function restoreRoot(node: HTMLElement) {
    const original = originalRoots.get(node)!;
    restoreAttribute(node, ROOT_ATTRIBUTE, original.attribute);
    restoreAttribute(node, 'style', original.style);
  }

  function send(type: SourceSignal['type'], message?: string) {
    if (!active) return;
    const signal: SourceSignal = { channel: SIGNAL_CHANNEL, token, type };
    if (message) signal.message = message;
    win.parent.postMessage(signal, 'https://live.bilibili.com');
  }

  function report() {
    const now = win.Date.now();
    let playing = false;
    let error: string | undefined;
    for (const video of doc.querySelectorAll('video')) {
      silence(video);
      const previous = samples.get(video);
      const advanced = previous !== undefined && video.currentTime > previous.time;
      const progressedAt = advanced ? now : previous?.progressedAt;
      samples.set(video, { time: video.currentTime, progressedAt });
      if (advanced) {
        stalled.delete(video);
        failed.delete(video);
      }
      if (video.error || failed.has(video)) error = video.error?.message || '来源播放器发生错误，请重试或检查直播是否可播放。';
      if (video.readyState >= 2 && !video.paused && !video.ended && video.videoWidth > 0 && !stalled.has(video)
        && !video.error && !failed.has(video) && progressedAt !== undefined && now - progressedAt < 2000) playing = true;
    }
    if (playing) send('playing');
    else if (error) send('error', error);
    else send('waiting');
  }

  const onMediaEvent = (event: Event) => {
    if (!(event.target instanceof win.HTMLMediaElement)) return;
    silence(event.target);
    if (event.target instanceof win.HTMLVideoElement) {
      if (event.type === 'waiting' || event.type === 'stalled' || event.type === 'emptied') stalled.add(event.target);
      if (event.type === 'error') failed.add(event.target);
      report();
    }
  };
  const events = ['volumechange', 'loadstart', 'loadeddata', 'play', 'playing', 'pause', 'timeupdate', 'waiting', 'stalled', 'emptied', 'ended', 'error'];
  events.forEach(event => doc.addEventListener(event, onMediaEvent, true));
  const observer = new win.MutationObserver(() => { if (active) refreshMedia(); });
  observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['muted'] });
  refreshMedia();
  send('ready');
  report();
  const interval = win.setInterval(() => {
    refreshMedia();
    send('ready');
    report();
  }, 1000);

  const cleanup = () => {
    if (!active) return;
    active = false;
    win.clearInterval(interval);
    observer.disconnect();
    events.forEach(event => doc.removeEventListener(event, onMediaEvent, true));
    restorers.reverse().forEach(restore => restore());
    style.remove();
    for (const node of paths) restoreAttribute(node, PATH_ATTRIBUTE, originalPaths.get(node) ?? null);
    roots.forEach(restoreRoot);
    installed.delete(win);
  };
  installed.set(win, cleanup);
  return cleanup;
}

function restoreAttribute(node: HTMLElement, name: string, value: string | null) {
  if (value === null) node.removeAttribute(name);
  else node.setAttribute(name, value);
}

if (typeof window !== 'undefined') {
  const token = sourceGuardToken(window);
  if (token) installSourceGuard(window, token);
}
