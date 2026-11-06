import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyInitData } from './services/telegram-webapp.js';

const TOKEN = '123456:test-bot-token';

/** Dựng chuỗi initData có chữ ký thật, giống Telegram gửi cho Mini App. */
function signed(fields: Record<string, string>): string {
  const checkString = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(checkString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const now = 1_700_000_000_000;
const fresh = {
  auth_date: String(Math.floor(now / 1000) - 5),
  query_id: 'AAH',
  user: JSON.stringify({ id: 5550001234, first_name: 'An', last_name: 'CEO' }),
};

describe('chữ ký Mini App Telegram', () => {
  it('nhận cả hai cách ghép chuỗi kiểm của Telegram (có và không kèm signature)', () => {
    // Bản mô tả nói bỏ `signature`; một số phiên bản khách lại ký kèm. Cả hai đều
    // phải khớp HMAC bằng bot token nên chấp nhận cách nào cũng an toàn như nhau.
    const kem = verifyInitData(signed({ ...fresh, signature: 'Zm9vYmFy' }), TOKEN, now);
    expect(kem).toMatchObject({ ok: true, variant: 'có signature, dấu cộng = dấu cách' });

    const bo = new URLSearchParams(signed(fresh));
    bo.set('signature', 'Zm9vYmFy');
    expect(verifyInitData(bo.toString(), TOKEN, now)).toMatchObject({ ok: true, variant: 'bỏ signature, dấu cộng = dấu cách' });
  });

  it('nhận chuỗi có chữ ký đúng', () => {
    const check = verifyInitData(signed(fresh), TOKEN, now);
    expect(check).toMatchObject({ ok: true, identity: { telegramUserId: '5550001234', displayName: 'An CEO' } });
  });

  it('từ chối khi sửa nội dung mà giữ chữ ký cũ', () => {
    const tampered = signed(fresh).replace('5550001234', '9999999999');
    expect(verifyInitData(tampered, TOKEN, now)).toMatchObject({ ok: false, reason: 'chữ ký không khớp' });
  });

  it('từ chối chữ ký của bot token khác', () => {
    expect(verifyInitData(signed(fresh), '999:bot-khac', now)).toMatchObject({ ok: false, reason: 'chữ ký không khớp' });
  });

  it('từ chối chuỗi quá cũ', () => {
    const old = signed({ ...fresh, auth_date: String(Math.floor(now / 1000) - 3600) });
    expect(verifyInitData(old, TOKEN, now)).toMatchObject({ ok: false, reason: 'chuỗi quá cũ' });
  });

  it('từ chối chuỗi không có hash', () => {
    expect(verifyInitData('user=%7B%22id%22%3A1%7D&auth_date=1', TOKEN, now)).toMatchObject({ ok: false, reason: 'thiếu hash' });
  });
});
