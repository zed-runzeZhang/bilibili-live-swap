import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPopup, type PopupTabApi } from '../src/popup';
import type { SwapResponse, SwapStatus } from '../src/shared';

const initialStatus: SwapStatus = {
  enabled: false,
  sourceRoomId: null,
  targetRoomId: '7777',
  phase: 'disabled',
  message: '显示当前直播间的原画面。',
  bAudio: 'playing'
};

function fixture() {
  document.body.innerHTML = `
    <main data-popup-root>
      <span id="target-room"></span><span id="phase-label"></span>
      <p id="status-message"></p><p id="audio-hint"></p>
      <p id="feedback" hidden></p>
      <form id="source-form">
        <input id="source-room" /><button id="enable-button">启用替换</button>
      </form>
      <button id="disable-button">关闭替换</button>
      <button id="retry-button">重新连接</button>
    </main>`;
  return document.querySelector<HTMLElement>('[data-popup-root]')!;
}

function setup(status: SwapStatus = initialStatus, url = 'https://live.bilibili.com/7777') {
  const api: PopupTabApi = {
    query: vi.fn().mockResolvedValue([{ id: 42, url }]),
    sendMessage: vi.fn().mockResolvedValue({ ok: true, status })
  };
  const root = fixture();
  const stop = mountPopup(root, api);
  return { api, root, stop };
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function submit(input: string) {
  (document.querySelector('#source-room') as HTMLInputElement).value = input;
  document.querySelector('#source-form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('popup controls', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('only connects to a supported current room and shows its B audio state', async () => {
    const { api, stop } = setup({ ...initialStatus, enabled: true, sourceRoomId: '1234', phase: 'playing', bAudio: 'muted', message: '正在播放 A 的画面。' });
    cleanups.push(stop);
    await settle();

    expect(api.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(api.sendMessage).toHaveBeenCalledWith(42, { type: 'bili-swap:get-status' });
    expect(document.querySelector('#target-room')!.textContent).toContain('7777');
    expect(document.querySelector('#phase-label')!.textContent).toContain('替换中');
    expect(document.querySelector('#audio-hint')!.textContent).toContain('静音');
    expect((document.querySelector('#source-room') as HTMLInputElement).value).toBe('1234');
    expect((document.querySelector('#disable-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('validates the source locally and sends a normalized room ID', async () => {
    const { api, stop } = setup();
    cleanups.push(stop);
    await settle();
    submit('https://example.com/1234');
    await settle();

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#feedback')!.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#feedback')!.textContent).not.toBe('');

    submit('https://live.bilibili.com/1234?from=search');
    await settle();
    expect(api.sendMessage).toHaveBeenLastCalledWith(42, { type: 'bili-swap:enable', source: '1234' });
  });

  it('does not send messages to unrelated pages', async () => {
    const { api, stop } = setup(initialStatus, 'https://www.bilibili.com/video/1234');
    cleanups.push(stop);
    await settle();

    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(document.querySelector('#status-message')!.textContent).toContain('普通直播间');
    expect((document.querySelector('#enable-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains how to connect tabs that existed before installation', async () => {
    const { api, stop } = setup();
    vi.mocked(api.sendMessage).mockRejectedValue(new Error('Could not establish connection. Receiving end does not exist.'));
    cleanups.push(stop);
    await settle();

    expect(document.querySelector('#feedback')!.textContent).toContain('刷新');
    expect(document.querySelector('#feedback')!.textContent).toContain('安装');
    expect((document.querySelector('#enable-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('renders returned errors as text and allows the next command', async () => {
    const { api, stop } = setup();
    cleanups.push(stop);
    await settle();
    vi.mocked(api.sendMessage).mockResolvedValueOnce({ ok: false, error: '<img src=x onerror=alert(1)> 房间不可用' });
    submit('1234');
    await settle();

    expect(document.querySelector('#feedback')!.textContent).toContain('<img');
    expect(document.querySelector('#feedback img')).toBeNull();
    expect((document.querySelector('#enable-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends disable and retry actions for an enabled source', async () => {
    const { api, stop } = setup({ ...initialStatus, enabled: true, sourceRoomId: '1234', phase: 'error' });
    cleanups.push(stop);
    await settle();
    (document.querySelector('#retry-button') as HTMLButtonElement).click();
    await settle();
    expect(api.sendMessage).toHaveBeenLastCalledWith(42, { type: 'bili-swap:retry' });
    (document.querySelector('#disable-button') as HTMLButtonElement).click();
    await settle();
    expect(api.sendMessage).toHaveBeenLastCalledWith(42, { type: 'bili-swap:disable' });
  });

  it('does not overlap status polls and stops polling after cleanup', async () => {
    const { api, stop } = setup();
    cleanups.push(stop);
    await settle();
    let finishPoll!: (response: SwapResponse) => void;
    vi.mocked(api.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    stop();
    finishPoll({ ok: true, status: initialStatus });
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('serializes an action behind an in-flight poll and keeps edited input', async () => {
    const { api, stop } = setup({ ...initialStatus, enabled: true, sourceRoomId: '1234', phase: 'playing' });
    cleanups.push(stop);
    await settle();
    let finishPoll!: (response: SwapResponse) => void;
    vi.mocked(api.sendMessage).mockImplementationOnce(() => new Promise((resolve) => { finishPoll = resolve; }));
    await vi.advanceTimersByTimeAsync(1000);
    submit('5678');
    await settle();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    finishPoll({ ok: true, status: { ...initialStatus, enabled: true, sourceRoomId: '1234', phase: 'playing' } });
    await settle();
    expect(api.sendMessage).toHaveBeenLastCalledWith(42, { type: 'bili-swap:enable', source: '5678' });
    expect((document.querySelector('#source-room') as HTMLInputElement).value).toBe('5678');
  });
});
