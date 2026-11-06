import { describe, expect, it } from 'vitest';

import { consumeLoginCode, createLoginCode } from './services/login-codes.js';

describe('mã đăng nhập một lần', () => {
  it('đổi được đúng một lần trong hạn', () => {
    const { code, expiresInSeconds } = createLoginCode('user-1', 1_000);
    expect(expiresInSeconds).toBe(120);
    expect(consumeLoginCode(code, 2_000)).toBe('user-1');
    expect(consumeLoginCode(code, 2_000)).toBeNull();
  });

  it('hết hạn sau 2 phút', () => {
    const { code } = createLoginCode('user-2', 1_000);
    expect(consumeLoginCode(code, 1_000 + 121_000)).toBeNull();
  });

  it('mã lạ không đổi được', () => {
    expect(consumeLoginCode('khong-ton-tai')).toBeNull();
  });
});
