export const SOURCE_ORIGIN = 'https://www.bilibili.com';
export const SIGNAL_CHANNEL = 'bili-live-swap';
export const SOURCE_PATH = '/blackboard/live/live-activity-player.html';

export type SwapPhase = 'disabled' | 'waiting-player' | 'loading' | 'playing' | 'recovering' | 'error';
export type AudioState = 'playing' | 'muted' | 'paused' | 'waiting';
export interface SwapStatus {
  enabled: boolean;
  sourceRoomId: string | null;
  targetRoomId: string;
  phase: SwapPhase;
  message: string;
  bAudio: AudioState;
}
export type SwapRequest =
  | { type: 'bili-swap:get-status' }
  | { type: 'bili-swap:enable'; source: string }
  | { type: 'bili-swap:disable' }
  | { type: 'bili-swap:retry' };
export type SwapResponse = { ok: true; status: SwapStatus } | { ok: false; error: string };
export type SourceSignal = {
  channel: typeof SIGNAL_CHANNEL;
  token: string;
  type: 'ready' | 'playing' | 'waiting' | 'error';
  message?: string;
};

const ID_PATTERN = /^[1-9]\d{0,14}$/;
export function roomIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://live.bilibili.com' || url.username || url.password) return null;
    const match = /^\/([1-9]\d{0,14})\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export function parseRoomInput(input: string): string {
  const value = input.trim();
  if (ID_PATTERN.test(value)) return value;
  const id = roomIdFromUrl(value);
  if (id) return id;
  throw new Error('请输入有效的房间号或 https://live.bilibili.com/房间号');
}

export function createSourceUrl(roomId: string, token: string): string {
  if (!ID_PATTERN.test(roomId)) throw new Error('无效的来源房间号');
  const url = new URL(SOURCE_PATH, SOURCE_ORIGIN);
  const params: Record<string, string> = {
    cid: roomId, mute: '1', danmaku: '0', sendpanel: '0', send: '0',
    entrance: '0', recommend: '0', quality: '0', enableCtrlUI: '0', enableAutoPlayTips: '0',
    bili_swap_token: token
  };
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

export function isSourceSignal(data: unknown): data is SourceSignal {
  if (!data || typeof data !== 'object') return false;
  const signal = data as Partial<SourceSignal>;
  return signal.channel === SIGNAL_CHANNEL && typeof signal.token === 'string'
    && ['ready', 'playing', 'waiting', 'error'].includes(signal.type ?? '')
    && (signal.message === undefined || typeof signal.message === 'string');
}
