/**
 * §89 — "Phải có integration test cho secret redaction" và "Phải có test xác
 * nhận secret không xuất hiện trong API response". Đây là lớp bảo đảm ở mức
 * unit mà các integration test đó dựa lên.
 */

import { describe, expect, it } from 'vitest';

import { containsSecret, maskSecret, redactDeep, redactText, REDACTED } from './redaction.js';

const SAMPLES = {
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
  openai: 'sk-proj0123456789abcdefghijklmnopqrstuvwxyz',
  google: 'AIzaSyD-abcdefghijklmnopqrstuvwxyz0123456',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  telegram: '123456789:AAF-abcdefghijklmnopqrstuvwxyz0123456789',
  dbUrl: 'postgresql://pn_user:sup3rs3cret@db.internal:5432/pn',
};

describe('redactText', () => {
  for (const [name, value] of Object.entries(SAMPLES)) {
    it(`xoá credential ${name} khỏi văn bản tự do`, () => {
      const output = redactText(`config loaded: ${value} done`);
      expect(output).not.toContain(value);
      expect(output).toContain(REDACTED);
    });
  }

  it('không đụng vào văn bản vô hại', () => {
    const text = 'Project P&N built 12 tasks in 4 minutes.';
    expect(redactText(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('xoá trắng giá trị dưới tên field nhạy cảm, bất kể kiểu dữ liệu', () => {
    const payload = {
      provider: 'anthropic',
      apiKey: SAMPLES.anthropic,
      nested: { password: 'hunter2', authorization: 'Bearer xyz' },
      list: [{ token: 'abc123' }],
    };

    const redacted = redactDeep(payload);

    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.nested.password).toBe(REDACTED);
    expect(redacted.nested.authorization).toBe(REDACTED);
    expect(redacted.list[0]!.token).toBe(REDACTED);
    expect(redacted.provider).toBe('anthropic');
  });

  it('quét được credential nấp dưới tên field vô hại', () => {
    const redacted = redactDeep({ note: `key is ${SAMPLES.github}` });
    expect(redacted.note).not.toContain(SAMPLES.github);
  });

  it('redact cả message và stack của lỗi', () => {
    const error = new Error(`request failed with ${SAMPLES.openai}`);
    const redacted = redactDeep(error);
    expect(redacted.message).not.toContain(SAMPLES.openai);
  });

  it('không lặp vô tận với object có vòng tham chiếu', () => {
    const cyclic: Record<string, unknown> = { name: 'p&n' };
    cyclic['self'] = cyclic;
    expect(() => redactDeep(cyclic)).not.toThrow();
  });
});

describe('containsSecret', () => {
  it('phát hiện credential rò rỉ trong API response đã serialize', () => {
    expect(containsSecret({ provider: { keyPreview: SAMPLES.anthropic } })).toBe(true);
  });

  it('chấp nhận response đã mask đúng cách (§88.3)', () => {
    const response = {
      provider: 'anthropic',
      keyPreview: maskSecret(SAMPLES.anthropic),
      status: 'CONNECTED',
    };
    expect(containsSecret(response)).toBe(false);
    expect(response.keyPreview).not.toContain('api03');
  });
});

describe('maskSecret', () => {
  it('chỉ giữ lại phần đầu và phần đuôi để nhận diện', () => {
    const masked = maskSecret(SAMPLES.anthropic);
    expect(masked.startsWith('sk-ant')).toBe(true);
    expect(masked.endsWith(SAMPLES.anthropic.slice(-4))).toBe(true);
    expect(masked.length).toBeLessThan(SAMPLES.anthropic.length);
  });

  it('mask toàn bộ chuỗi ngắn thay vì để lộ gần hết', () => {
    expect(maskSecret('abcd')).toBe('••••');
  });
});
