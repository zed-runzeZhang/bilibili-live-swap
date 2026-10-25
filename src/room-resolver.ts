import { parseRoomInput } from './shared';

export interface ResolvedRoom {
  roomId: string;
  liveStatus: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalRoomId(value: unknown): string | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

export async function resolveRoom(input: string, fetcher: typeof fetch = fetch): Promise<ResolvedRoom> {
  const sourceId = parseRoomInput(input);
  let response: Response;
  try {
    response = await fetcher(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${sourceId}`, {
      method: 'GET',
      credentials: 'omit',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const name = isRecord(error) ? error.name : undefined;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error('房间解析超时，请检查网络后重试');
    }
    throw new Error('房间解析网络请求失败，请检查网络后重试');
  }

  if (!response.ok) throw new Error(`房间解析请求失败（HTTP ${response.status}），请稍后重试`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('房间接口返回了无法识别的数据，请稍后重试');
  }
  if (!isRecord(payload) || !Number.isSafeInteger(payload.code)) {
    throw new Error('房间接口返回了无法识别的数据，请稍后重试');
  }
  if (payload.code !== 0) throw new Error(`房间解析失败（接口代码 ${payload.code}），请检查房间号后重试`);

  const data = payload.data;
  if (!isRecord(data)) throw new Error('房间接口返回了无效的房间数据');
  const roomId = canonicalRoomId(data.room_id);
  const liveStatus = data.live_status;
  if (roomId === null || typeof liveStatus !== 'number' || ![0, 1, 2].includes(liveStatus)) {
    throw new Error('房间接口返回了无效的房间数据');
  }
  if (data.is_locked || data.is_hidden) throw new Error('来源房间访问受限，暂时无法播放');

  return { roomId, liveStatus };
}
