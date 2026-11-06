/**
 * P&N — Địa chỉ đường hầm đọc ngay lúc chạy.
 *
 * Đường hầm Cloudflare miễn phí đổi địa chỉ mỗi lần mở lại, và Cloudflare có thể
 * xoá nó bất cứ lúc nào (link chết khi đang dùng). Nếu API chỉ đọc
 * biến môi trường lúc khởi động thì mỗi lần đổi phải khởi động lại cả API và bot.
 * Ở đây đọc thẳng `logs/tunnel.env` và nhớ 5 giây, nên mở lại đường hầm là xong.
 */

import { readFileSync } from 'node:fs';

const FILE = 'logs/tunnel.env';
const TTL_MS = 5_000;

let cache: { at: number; values: Record<string, string> } = { at: 0, values: {} };

function read(now = Date.now()): Record<string, string> {
  if (cache.at > 0 && now - cache.at < TTL_MS) return cache.values;
  let values: Record<string, string> = {};
  try {
    values = Object.fromEntries(
      readFileSync(FILE, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        }),
    );
  } catch {
    /* Chưa mở đường hầm thì dùng địa chỉ trong .env. */
  }
  cache = { at: now, values };
  return values;
}

const clean = (value: string | undefined): string | null => (value ? value.replace(/\/+$/, '') : null);

/** Địa chỉ API nhìn từ ngoài, hoặc null khi chưa mở đường hầm. */
export function tunnelApiUrl(): string | null {
  return clean(read()['API_PUBLIC_URL']);
}

/** Địa chỉ dashboard nhìn từ ngoài, hoặc null khi chưa mở đường hầm. */
export function tunnelWebOrigin(): string | null {
  return clean(read()['WEB_TUNNEL_ORIGIN']);
}
