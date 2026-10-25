import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRoom } from '../src/room-resolver';

function response(data: unknown, code = 0): Response {
  return new Response(JSON.stringify({ code, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function room(overrides: Record<string, unknown> = {}) {
  return { room_id: 7734200, live_status: 1, is_locked: false, is_hidden: false, ...overrides };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('resolveRoom', () => {
  it('resolves short room 6 to the canonical room id without sending credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room()));
    await expect(resolveRoom('https://live.bilibili.com/6', fetcher)).resolves.toEqual({ roomId: '7734200', liveStatus: 1 });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://api.live.bilibili.com/room/v1/Room/room_init?id=6');
    expect(options?.credentials).toBe('omit');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);
  });

  it('canonicalizes a decimal room id returned as a string', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ room_id: '0007734200' })));
    await expect(resolveRoom('6', fetcher)).resolves.toEqual({ roomId: '7734200', liveStatus: 1 });
  });

  it.each([0, 2])('returns offline status %s for the caller to explain', async liveStatus => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ live_status: liveStatus })));
    await expect(resolveRoom('6', fetcher)).resolves.toEqual({ roomId: '7734200', liveStatus });
  });

  it('rejects an invalid source before making a network request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(resolveRoom('https://live.bilibili.com.evil.com/6', fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports the API code without exposing arbitrary server messages', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 60004, message: '<script>server body</script>' })));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow('60004');
    await expect(resolveRoom('6', fetcher)).rejects.not.toThrow('script');
  });

  it.each([undefined, null, 0, -6, 1.5, Number.MAX_SAFE_INTEGER + 1, '1e6', '<html>'])('rejects invalid canonical id %s', async roomId => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ room_id: roomId })));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/数据/);
  });

  it('rejects malformed live state', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ live_status: '1' })));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/数据/);
  });

  it.each(['is_locked', 'is_hidden'])('rejects a room marked %s', async key => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ [key]: true })));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/访问受限/);
  });

  it('accepts portrait rooms because the native player handles their layout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(room({ is_portrait: true })));
    await expect(resolveRoom('6', fetcher)).resolves.toEqual({ roomId: '7734200', liveStatus: 1 });
  });

  it('reports an HTTP failure without reading its HTML body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>denied</html>', { status: 403 }));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow('HTTP 403');
  });

  it('reports invalid JSON as an invalid API response', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('<html>denied</html>'));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/数据/);
  });

  it.each(['AbortError', 'TimeoutError'])('gives a useful error for %s', async name => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('raw internal details', name));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/超时/);
  });

  it('gives a useful error for a failed connection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('raw internal details'));
    await expect(resolveRoom('6', fetcher)).rejects.toThrow(/网络/);
  });
});

describe('background room resolver', () => {
  async function listener() {
    const addListener = vi.fn();
    vi.stubGlobal('chrome', { runtime: { id: 'our-extension', onMessage: { addListener } } });
    await import('../src/background');
    return addListener.mock.calls[0][0] as (
      message: unknown,
      sender: chrome.runtime.MessageSender,
      sendResponse: (result: unknown) => void,
    ) => boolean | undefined;
  }

  const sender = { id: 'our-extension', url: 'https://live.bilibili.com/7777', frameId: 0 };

  it('responds asynchronously to a top frame from this extension on a live room', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(room())));
    const handle = await listener();
    const result = new Promise(resolve => {
      expect(handle({ type: 'bili-swap:resolve-room', source: '6' }, sender, resolve)).toBe(true);
    });
    await expect(result).resolves.toEqual({ ok: true, roomId: '7734200', liveStatus: 1 });
  });

  it.each([
    { ...sender, id: 'another-extension' },
    { ...sender, url: 'https://live.bilibili.com.evil.com/7777' },
    { ...sender, url: 'http://live.bilibili.com/7777' },
    { ...sender, url: 'chrome-extension://our-extension/popup.html' },
    { ...sender, frameId: 1 },
  ])('rejects an unauthorized sender %j before fetching', async unauthorized => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const handle = await listener();
    const sendResponse = vi.fn();
    expect(handle({ type: 'bili-swap:resolve-room', source: '6' }, unauthorized, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.stringMatching(/来源/) });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns a structured failure for invalid source data', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const handle = await listener();
    const sendResponse = vi.fn();
    expect(handle({ type: 'bili-swap:resolve-room', source: 6 }, sender, sendResponse)).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });
  });

  it('returns API failures as plain error text', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response(null, 60004)));
    const handle = await listener();
    const result = new Promise(resolve => {
      expect(handle({ type: 'bili-swap:resolve-room', source: '6' }, sender, resolve)).toBe(true);
    });
    await expect(result).resolves.toEqual({ ok: false, error: expect.stringContaining('60004') });
  });

  it('ignores unrelated extension messages', async () => {
    const handle = await listener();
    const sendResponse = vi.fn();
    expect(handle({ type: 'bili-swap:status' }, sender, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
