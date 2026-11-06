/**
 * P&N — Cho trình duyệt biết địa chỉ API hiện tại.
 *
 * App trên điện thoại hỏi đường dẫn cùng gốc này lúc mở, nên không cần bộ nhớ
 * trình duyệt hay `?api=`. Đọc thẳng `logs/tunnel.env` ở mỗi lần gọi: đường hầm
 * mở lại là địa chỉ mới có hiệu lực ngay, không phải khởi động lại web.
 */

import { readFile } from 'node:fs/promises';

export const dynamic = 'force-dynamic';

async function tunnelApiUrl(): Promise<string | null> {
  try {
    const text = await readFile('logs/tunnel.env', 'utf8');
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith('API_PUBLIC_URL='));
    return line ? line.slice('API_PUBLIC_URL='.length).trim().replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  const apiUrl = (await tunnelApiUrl()) ?? process.env['API_PUBLIC_URL'] ?? null;
  return Response.json({ apiUrl }, { headers: { 'cache-control': 'no-store' } });
}
