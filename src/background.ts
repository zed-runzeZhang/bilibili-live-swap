import { resolveRoom } from './room-resolver';
import { roomIdFromUrl } from './shared';

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'bili-swap:resolve-room') return;

  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.url || !roomIdFromUrl(sender.url)) {
    sendResponse({ ok: false, error: '无法确认房间解析请求的来源' });
    return false;
  }
  if (!('source' in message) || typeof message.source !== 'string') {
    sendResponse({ ok: false, error: '请输入有效的来源房间号或直播间链接' });
    return false;
  }

  void resolveRoom(message.source).then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '房间解析失败，请稍后重试' }),
  );
  return true;
});
