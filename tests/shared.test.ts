import { describe, expect, it } from 'vitest';
import { parseRoomInput, roomIdFromUrl, createSourceUrl, isSourceSignal } from '../src/shared';

describe('room input', () => {
  it.each(['6', ' 7777 ', 'https://live.bilibili.com/545068?from=search#anchor'])('accepts %s', input => {
    expect(parseRoomInput(input)).toMatch(/^[1-9]\d*$/);
  });
  it.each(['0', '-1', '1.2', 'https://live.bilibili.com.evil.com/6', 'http://live.bilibili.com/6', 'https://user@live.bilibili.com/6', 'https://live.bilibili.com/6/extra', 'javascript:alert(1)', '1e6'])('rejects %s', input => {
    expect(() => parseRoomInput(input)).toThrow();
  });
  it('rejects activities and non-room pages as B', () => {
    expect(roomIdFromUrl('https://live.bilibili.com/blackboard/foo')).toBeNull();
  });
  it('creates only the official HTTPS embed with muted params and token', () => {
    const url = new URL(createSourceUrl('6', 'token-123'));
    expect(url.origin).toBe('https://www.bilibili.com');
    expect(url.searchParams.get('cid')).toBe('6');
    expect(url.searchParams.get('mute')).toBe('1');
    expect(url.searchParams.get('bili_swap_token')).toBe('token-123');
  });
});

it('rejects malformed source telemetry', () => {
  expect(isSourceSignal(null)).toBe(false);
  expect(isSourceSignal({channel:'bili-live-swap', token:'x', type:'playing'})).toBe(true);
  expect(isSourceSignal({channel:'bili-live-swap', token:'x', type:'eval'})).toBe(false);
});
