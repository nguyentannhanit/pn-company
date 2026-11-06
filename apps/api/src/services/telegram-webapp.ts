/**
 * P&N — Kiểm tra chữ ký của "Mini App" Telegram.
 *
 * Khi CEO bấm nút "Mở P&N" trong bot, Telegram mở dashboard kèm một chuỗi
 * `initData` có chữ ký bằng chính bot token. Kiểm đúng chữ ký nghĩa là người mở
 * đúng là chủ tài khoản Telegram đó — đủ để cấp phiên mà không cần gõ mật khẩu
 * trên điện thoại. Chuỗi cũ (quá 10 phút) bị từ chối để link chụp lại không dùng được.
 *
 * Hàm trả về lý do từ chối chứ không chỉ null: từng có lúc nút mở được nhưng bị từ
 * chối, không có lý do thì chỉ còn cách đoán.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_AGE_SECONDS = 600;

export interface WebAppIdentity {
  /** Chat riêng với bot có id trùng id người dùng, nên đây cũng là chat id. */
  telegramUserId: string;
  displayName: string;
}

export type WebAppCheck =
  | { ok: true; identity: WebAppIdentity; variant: string }
  | { ok: false; reason: string; detail: Record<string, unknown> };

/**
 * Các cách Telegram có thể gói chuỗi kiểm: bản mô tả nói bỏ `hash` và `signature`,
 * nhưng một số phiên bản khách gói khác (giữ `signature`, hoặc dùng dấu `+` cho
 * dấu cách). Thử từng cách; cách nào cũng phải khớp HMAC bằng bot token nên
 * không có cách nào dễ giả hơn cách nào.
 */
function checkStrings(initData: string): Array<{ variant: string; value: string }> {
  const pairs = initData
    .split('&')
    .map((part) => {
      const at = part.indexOf('=');
      return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)];
    })
    .filter(([key]) => key !== 'hash') as Array<[string, string]>;

  const decode = (value: string, plusIsSpace: boolean): string => {
    try {
      return decodeURIComponent(plusIsSpace ? value.replace(/\+/g, '%20') : value);
    } catch {
      return value;
    }
  };

  const variants: Array<{ variant: string; value: string }> = [];
  for (const keepSignature of [false, true]) {
    for (const plusIsSpace of [true, false]) {
      const value = pairs
        .filter(([key]) => keepSignature || key !== 'signature')
        .map(([key, raw]) => [key, decode(raw, plusIsSpace)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, raw]) => `${key}=${raw}`)
        .join(String.fromCharCode(10));
      variants.push({ variant: `${keepSignature ? 'có' : 'bỏ'} signature, dấu cộng = ${plusIsSpace ? 'dấu cách' : 'dấu cộng'}`, value });
    }
  }
  return variants;
}

export function verifyInitData(initData: string, botToken: string, now: number = Date.now()): WebAppCheck {
  const params = new URLSearchParams(initData);
  const keys = [...params.keys()].sort();
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'thiếu hash', detail: { keys } };

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const given = Buffer.from(hash, 'hex');
  let matched: string | null = null;
  let firstExpected = '';
  for (const { variant, value } of checkStrings(initData)) {
    const expected = createHmac('sha256', secret).update(value).digest('hex');
    if (!firstExpected) firstExpected = expected;
    const mine = Buffer.from(expected, 'hex');
    if (given.length === mine.length && timingSafeEqual(given, mine)) {
      matched = variant;
      break;
    }
  }
  if (!matched) {
    // Chỉ ghi 8 ký tự đầu để so bằng mắt; không đủ để dựng lại chữ ký.
    return { ok: false, reason: 'chữ ký không khớp', detail: { keys, given: hash.slice(0, 8), expected: firstExpected.slice(0, 8) } };
  }

  const authDate = Number(params.get('auth_date'));
  const ageSeconds = Math.floor(now / 1000) - authDate;
  if (!Number.isFinite(authDate) || ageSeconds > MAX_AGE_SECONDS) {
    return { ok: false, reason: 'chuỗi quá cũ', detail: { keys, ageSeconds } };
  }

  try {
    const user = JSON.parse(params.get('user') ?? '') as { id?: number; first_name?: string; last_name?: string };
    if (!user.id) return { ok: false, reason: 'không có người dùng', detail: { keys } };
    return {
      ok: true,
      variant: matched,
      identity: {
        telegramUserId: String(user.id),
        displayName: [user.first_name, user.last_name].filter(Boolean).join(' ') || String(user.id),
      },
    };
  } catch {
    return { ok: false, reason: 'trường user không đọc được', detail: { keys } };
  }
}
