import { createSourceUrl, isSourceSignal, parseRoomInput, SOURCE_ORIGIN, type AudioState, type SwapStatus } from './shared';

interface PlayerLayer { root: HTMLElement; video: HTMLVideoElement; zIndex: number }
interface ControllerOptions {
  targetRoomId: string;
  resolveRoom: (source: string) => Promise<{ roomId: string; liveStatus: number }>;
}

// Only attach to known player containers. Unknown activity pages are left alone.
export function findPlayer(): PlayerLayer | null {
  for (const root of document.querySelectorAll<HTMLElement>('#live-player, .live-player-mounter')) {
    const video = [...root.children].find(el => el instanceof HTMLVideoElement) as HTMLVideoElement | undefined;
    const danmaku = [...root.children].find(el => el.matches('.web-player-danmaku'));
    if (!video || !danmaku || getComputedStyle(root).position === 'static') continue;
    const videoZ = Number.parseInt(getComputedStyle(video).zIndex, 10);
    const danmakuZ = Number.parseInt(getComputedStyle(danmaku).zIndex, 10);
    if (!Number.isFinite(videoZ) || !Number.isFinite(danmakuZ) || danmakuZ <= videoZ + 1) continue;
    return { root, video, zIndex: videoZ + 1 };
  }
  return null;
}

export class SwapController {
  private state: SwapStatus;
  private frame: HTMLIFrameElement | null = null;
  private layer: PlayerLayer | null = null;
  private observer: MutationObserver | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private token = '';
  private guarded = false;
  private hadPicture = false;
  private frameStartedAt = 0;
  private lastSignalAt = 0;
  private waitingSince = 0;
  private waitingForPlayerAt = 0;
  private rebuilds = 0;

  constructor(private options: ControllerOptions) {
    this.state = {
      enabled: false, sourceRoomId: null, targetRoomId: options.targetRoomId,
      phase: 'disabled', message: '未启用，当前显示 B 的原始画面。', bAudio: 'waiting'
    };
  }

  getStatus(): SwapStatus { return { ...this.state, bAudio: this.audioState() }; }

  async enable(source: string): Promise<SwapStatus> {
    const input = parseRoomInput(source);
    this.stopActivity();
    const epoch = ++this.epoch;
    this.state = { ...this.state, enabled: true, sourceRoomId: input, phase: 'loading', message: '正在解析 A 直播间…' };
    this.rebuilds = 0;
    try {
      const resolved = await this.options.resolveRoom(input);
      if (epoch !== this.epoch) return this.getStatus();
      if (resolved.liveStatus !== 1) throw new Error('A 直播间尚未开播或正在轮播，请选择正在直播的房间。');
      this.state.sourceRoomId = parseRoomInput(resolved.roomId);
      this.waitingForPlayerAt = Date.now();
      window.addEventListener('message', this.onSourceMessage);
      this.observer = new MutationObserver(() => {
        // Danmaku changes continually; do no DOM scan while the existing player is intact.
        if (this.layer?.video.isConnected && this.frame?.isConnected && this.frame.parentElement === this.layer.root) return;
        this.scheduleAttach();
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
      this.heartbeat = setInterval(() => this.tick(), 1000);
      this.attach();
    } catch (error) {
      if (epoch === this.epoch) this.fail(error instanceof Error ? error.message : '解析 A 直播间失败，请重试。');
    }
    return this.getStatus();
  }

  disable(message = '已关闭，恢复 B 的原始画面。'): SwapStatus {
    ++this.epoch;
    this.stopActivity();
    this.state = { ...this.state, enabled: false, phase: 'disabled', message };
    return this.getStatus();
  }

  retry(): Promise<SwapStatus> {
    if (!this.state.sourceRoomId) throw new Error('请先输入 A 直播间。');
    return this.enable(this.state.sourceRoomId);
  }

  private audioState(): AudioState {
    const video = this.layer?.video.isConnected ? this.layer.video : findPlayer()?.video;
    if (!video || video.readyState < 2) return 'waiting';
    if (video.paused) return 'paused';
    return video.muted || video.volume === 0 ? 'muted' : 'playing';
  }

  private scheduleAttach() {
    if (this.attachTimer || this.state.phase === 'error') return;
    this.attachTimer = setTimeout(() => { this.attachTimer = null; this.attach(); }, 250);
  }

  private attach() {
    if (!this.state.enabled || this.state.phase === 'error') return;
    const layer = findPlayer();
    if (!layer) {
      if (this.layer) this.waitingForPlayerAt = Date.now();
      this.frame?.remove();
      this.frame = null;
      this.layer = null;
      this.state.phase = 'waiting-player';
      this.state.message = '等待 B 播放器。请先播放 B；活动页或未知播放器结构暂不支持。';
      return;
    }
    if (this.frame?.isConnected && this.frame.parentElement === layer.root) {
      this.layer = layer;
      this.frame.style.zIndex = String(layer.zIndex);
      return;
    }
    if (++this.rebuilds > 4) {
      this.fail('B 播放器多次重建，已恢复原始画面。请稳定播放后重试。');
      return;
    }
    this.frame?.remove();
    this.layer = layer;
    this.token = crypto.randomUUID();
    this.guarded = false;
    this.hadPicture = false;
    this.frameStartedAt = this.lastSignalAt = this.waitingSince = Date.now();
    const frame = document.createElement('iframe');
    frame.dataset.biliSwap = 'source';
    frame.title = `A 直播间 ${this.state.sourceRoomId} 的静音画面`;
    frame.tabIndex = -1;
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('allow', "autoplay 'none'; encrypted-media");
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    Object.assign(frame.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0',
      display: 'block', background: '#000', pointerEvents: 'none', opacity: '0', zIndex: String(layer.zIndex)
    });
    frame.src = createSourceUrl(this.state.sourceRoomId!, this.token);
    this.frame = frame;
    layer.root.appendChild(frame);
    this.waitingForPlayerAt = 0;
    this.state.phase = 'loading';
    this.state.message = '正在加载 A 的静音画面，期间继续显示 B。';
  }

  private onSourceMessage = (event: MessageEvent) => {
    if (!this.frame || event.origin !== SOURCE_ORIGIN || event.source !== this.frame.contentWindow
      || !isSourceSignal(event.data) || event.data.token !== this.token) return;
    this.lastSignalAt = Date.now();
    const signal = event.data;
    if (signal.type === 'ready') { this.guarded = true; return; }
    if (!this.guarded) return;
    if (signal.type === 'playing') {
      this.frame.style.opacity = '1';
      this.hadPicture = true;
      this.waitingSince = 0;
      this.state.phase = 'playing';
      this.state.message = `正在显示 A（${this.state.sourceRoomId}）的画面，声音与弹幕来自 B。`;
    } else if (signal.type === 'waiting') {
      this.frame.style.opacity = '0';
      if (!this.waitingSince) this.waitingSince = Date.now();
      this.state.phase = this.hadPicture ? 'recovering' : 'loading';
      this.state.message = 'A 正在缓冲或重连，暂时显示 B；可使用“重试 A”。';
    } else {
      this.fail(signal.message?.slice(0, 200) || 'A 播放失败，已恢复 B 画面。请确认 A 正在直播后重试。');
    }
  };

  private tick() {
    if (this.layer && (!this.layer.video.isConnected || !this.frame?.isConnected)) this.scheduleAttach();
    if (!this.frame) {
      if (Date.now() - this.waitingForPlayerAt > 30_000) this.fail('未找到受支持的 B 播放器。请进入普通直播间并播放后重试；赛事活动页暂不支持。');
      return;
    }
    if (!this.guarded && Date.now() - this.frameStartedAt > 10_000) {
      this.fail('A 静音约束未就绪，已停止加载。请检查扩展站点权限并刷新 B 页面。');
    } else if (Date.now() - this.lastSignalAt > 10_000) {
      this.fail('与 A 播放器失去连接，已恢复 B 画面。请重试。');
    } else if (this.waitingSince && Date.now() - this.waitingSince > 30_000) {
      this.fail('A 长时间没有可播放的画面，已恢复 B。可能未开播、网络异常或受到登录/地区限制，请重试。');
    }
  }

  private fail(message: string) {
    this.stopActivity();
    this.state.phase = 'error';
    this.state.message = message;
  }

  private stopActivity() {
    this.observer?.disconnect(); this.observer = null;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.attachTimer) clearTimeout(this.attachTimer);
    this.heartbeat = this.attachTimer = null;
    window.removeEventListener('message', this.onSourceMessage);
    this.frame?.remove();
    this.frame = null;
    this.layer = null;
    this.guarded = false;
  }
}
