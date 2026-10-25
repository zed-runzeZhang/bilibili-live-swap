import { parseRoomInput, roomIdFromUrl, type SwapRequest, type SwapResponse, type SwapStatus } from './shared';

export interface PopupTabApi {
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>>;
  sendMessage(tabId: number, request: SwapRequest): Promise<SwapResponse>;
}

const phaseLabels: Record<SwapStatus['phase'], string> = {
  disabled: '未启用',
  'waiting-player': '等待播放器',
  loading: '正在加载',
  playing: '替换中',
  recovering: '正在恢复',
  error: '需要处理'
};

const audioHints: Record<SwapStatus['bAudio'], string> = {
  playing: 'B 的声音正常播放；A 的声音已由扩展保持静音。',
  muted: 'B 当前已静音。需要声音时，请在直播页面取消静音。',
  paused: 'B 当前已暂停。请在直播页面继续播放，以恢复 B 的声音。',
  waiting: '正在等待 B 的声音。请确认直播已开始，并在页面点击播放。'
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mountPopup(root: HTMLElement, api: PopupTabApi = chrome.tabs): () => void {
  function element<T extends HTMLElement>(id: string): T {
    const node = root.querySelector<T>(`#${id}`);
    if (!node) throw new Error(`弹窗缺少元素：${id}`);
    return node;
  }

  const form = element<HTMLFormElement>('source-form');
  const source = element<HTMLInputElement>('source-room');
  const enable = element<HTMLButtonElement>('enable-button');
  const disable = element<HTMLButtonElement>('disable-button');
  const retry = element<HTMLButtonElement>('retry-button');
  const targetRoom = element('target-room');
  const phaseLabel = element('phase-label');
  const statusMessage = element('status-message');
  const audioHint = element('audio-hint');
  const feedback = element('feedback');

  let disposed = false;
  let tabId: number | null = null;
  let available = false;
  let commandPending = false;
  let lastStatus: SwapStatus | null = null;
  let inFlight: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let inputInitialized = false;

  function updateControls() {
    const blocked = !available || commandPending;
    source.disabled = blocked;
    enable.disabled = blocked;
    disable.disabled = blocked || !lastStatus?.enabled;
    retry.disabled = blocked || !lastStatus?.enabled || !lastStatus.sourceRoomId;
    enable.textContent = commandPending ? '正在处理…' : lastStatus?.enabled ? '更新画面来源' : '启用画面替换';
    form.setAttribute('aria-busy', String(commandPending));
  }

  function showFeedback(message: string) {
    feedback.textContent = message;
    feedback.hidden = !message;
  }

  function renderStatus(status: SwapStatus) {
    lastStatus = status;
    root.dataset.phase = status.phase;
    targetRoom.textContent = `B · ${status.targetRoomId}`;
    phaseLabel.textContent = phaseLabels[status.phase] ?? '状态未知';
    statusMessage.textContent = status.message;
    audioHint.textContent = !status.enabled && status.bAudio === 'playing'
      ? 'B 的声音正常播放。启用后，A 只提供画面。'
      : audioHints[status.bAudio] ?? '请在直播页面检查 B 的声音状态。';
    audioHint.dataset.state = status.bAudio;
    if (!inputInitialized) {
      if (!source.value.trim() && status.sourceRoomId) source.value = status.sourceRoomId;
      inputInitialized = true;
    }
    updateControls();
  }

  function connectionError(error: unknown) {
    available = false;
    root.dataset.phase = 'error';
    phaseLabel.textContent = '未连接';
    statusMessage.textContent = '暂时无法连接直播页面。';
    audioHint.textContent = '请刷新直播页面后重新打开此面板。';
    showFeedback(`安装或更新扩展后，已打开的直播间需要刷新页面。${errorText(error)}`);
    updateControls();
  }

  async function send(request: SwapRequest) {
    if (disposed || tabId === null) return;
    try {
      const response = await api.sendMessage(tabId, request);
      if (disposed) return;
      if (!response || typeof response !== 'object') throw new Error('直播页面没有返回有效状态。');
      if (response.ok) {
        if (!response.status) throw new Error('直播页面没有返回有效状态。');
        available = true;
        renderStatus(response.status);
      } else {
        showFeedback(response.error);
      }
    } catch (error) {
      if (!disposed) connectionError(error);
    }
  }

  function clearPoll() {
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  function schedulePoll() {
    clearPoll();
    if (disposed || !available || commandPending) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      if (disposed || commandPending || inFlight) return;
      const task = send({ type: 'bili-swap:get-status' });
      inFlight = task;
      void task.finally(() => {
        if (inFlight === task) inFlight = null;
        schedulePoll();
      });
    }, 1000);
  }

  async function command(request: SwapRequest) {
    if (disposed || !available || commandPending) return;
    commandPending = true;
    clearPoll();
    showFeedback('');
    updateControls();
    if (inFlight) await inFlight;
    if (disposed) return;
    const task = send(request);
    inFlight = task;
    await task;
    if (inFlight === task) inFlight = null;
    commandPending = false;
    if (disposed) return;
    updateControls();
    schedulePoll();
  }

  function onSubmit(event: Event) {
    event.preventDefault();
    if (!available || commandPending) return;
    try {
      const roomId = parseRoomInput(source.value);
      void command({ type: 'bili-swap:enable', source: roomId });
    } catch (error) {
      showFeedback(errorText(error));
      source.focus();
    }
  }

  const onDisable = () => { void command({ type: 'bili-swap:disable' }); };
  const onRetry = () => { void command({ type: 'bili-swap:retry' }); };

  async function connect() {
    updateControls();
    try {
      const [tab] = await api.query({ active: true, currentWindow: true });
      if (disposed) return;
      const roomId = tab?.url ? roomIdFromUrl(tab.url) : null;
      if (tab?.id === undefined || !roomId) {
        root.dataset.phase = 'disabled';
        targetRoom.textContent = '未选择直播间';
        phaseLabel.textContent = '请打开直播间';
        statusMessage.textContent = '请先打开 B 站普通直播间，再使用画面替换。';
        audioHint.textContent = '支持 https://live.bilibili.com/数字房间号。';
        return;
      }
      tabId = tab.id;
      targetRoom.textContent = `B · ${roomId}`;
      const task = send({ type: 'bili-swap:get-status' });
      inFlight = task;
      await task;
      if (inFlight === task) inFlight = null;
      schedulePoll();
    } catch (error) {
      if (!disposed) connectionError(error);
    }
  }

  form.addEventListener('submit', onSubmit);
  disable.addEventListener('click', onDisable);
  retry.addEventListener('click', onRetry);
  void connect();

  return () => {
    disposed = true;
    clearPoll();
    form.removeEventListener('submit', onSubmit);
    disable.removeEventListener('click', onDisable);
    retry.removeEventListener('click', onRetry);
  };
}

const popupRoot = typeof document !== 'undefined' ? document.querySelector<HTMLElement>('[data-popup-root]') : null;
if (popupRoot && typeof chrome !== 'undefined' && chrome.tabs) {
  const cleanup = mountPopup(popupRoot);
  window.addEventListener('pagehide', cleanup, { once: true });
}
