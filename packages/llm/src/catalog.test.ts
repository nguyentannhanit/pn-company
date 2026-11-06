/** Đoán hạng model theo tên chỉ cần đúng cho các dòng phổ biến; sai thì CEO sửa trong API Center. */
import { describe, expect, it } from 'vitest';

import { tierFromName } from './catalog.js';

describe('tierFromName', () => {
  it('pro/opus là mạnh, mini/lite/haiku là rẻ, còn lại là trung', () => {
    expect(tierFromName('gemini-3.6-pro')).toBe('strong');
    expect(tierFromName('claude-opus-5')).toBe('strong');
    expect(tierFromName('gpt-5')).toBe('strong');
    expect(tierFromName('gpt-5-mini')).toBe('cheap');
    expect(tierFromName('gemini-3.6-flash-lite')).toBe('cheap');
    expect(tierFromName('claude-haiku-4-5')).toBe('cheap');
    expect(tierFromName('gemini-3.6-flash')).toBe('medium');
    expect(tierFromName('gpt-4o')).toBe('medium');
  });
});
