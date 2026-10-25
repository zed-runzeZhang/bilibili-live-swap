import { SwapController } from './player-host';
import { roomIdFromUrl, type SwapResponse } from './shared';

const roomId = roomIdFromUrl(location.href);
if (window === window.top && roomId) {
  const controller = new SwapController({
    targetRoomId: roomId,
    resolveRoom: async source => {
      const result = await chrome.runtime.sendMessage({ type: 'bili-swap:resolve-room', source });
      if (!result?.ok) throw new Error(result?.error || '无法解析房间，请重新加载扩展并刷新页面。');
      return { roomId: result.roomId, liveStatus: result.liveStatus };
    }
  });
  chrome.runtime.onMessage.addListener((request: unknown, sender, sendResponse: (response: SwapResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !request || typeof request !== 'object') return;
    const message = request as { type?: string; source?: unknown };
    if (!message.type?.startsWith('bili-swap:') || message.type === 'bili-swap:resolve-room') return;
    void (async () => {
      try {
        if (roomIdFromUrl(location.href) !== roomId) {
          controller.disable();
          throw new Error('房间地址已改变，请刷新页面后启用。');
        }
        switch (message.type) {
          case 'bili-swap:get-status': return sendResponse({ ok: true, status: controller.getStatus() });
          case 'bili-swap:disable': return sendResponse({ ok: true, status: controller.disable() });
          case 'bili-swap:retry': return sendResponse({ ok: true, status: await controller.retry() });
          case 'bili-swap:enable':
            if (typeof message.source !== 'string') throw new Error('无效的来源房间号');
            return sendResponse({ ok: true, status: await controller.enable(message.source) });
          default: throw new Error('未知操作');
        }
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' });
      }
    })();
    return true;
  });
  window.addEventListener('pagehide', () => controller.disable());
}
