/**
 * P&N — Mã đăng nhập một lần cho link "Mở dashboard" gửi qua Telegram.
 *
 * Trên điện thoại gõ mật khẩu là bước hay bị bỏ cuộc; bot đã xác thực CEO qua
 * allowlist chat rồi, nên API phát một mã ngắn hạn: sống 2 phút, dùng một lần,
 * đổi được thành phiên đăng nhập đúng tài khoản đó. Giữ trong bộ nhớ tiến
 * trình API là đủ — mã chết theo tiến trình, không cần bảng.
 */

import { randomBytes } from 'node:crypto';

const TTL_MS = 2 * 60_000;

const codes = new Map<string, { userId: string; expiresAt: number }>();

export function createLoginCode(userId: string, now = Date.now()): { code: string; expiresInSeconds: number } {
  for (const [code, entry] of codes) if (entry.expiresAt <= now) codes.delete(code);
  const code = randomBytes(24).toString('base64url');
  codes.set(code, { userId, expiresAt: now + TTL_MS });
  return { code, expiresInSeconds: TTL_MS / 1000 };
}

/** Trả về userId nếu mã còn hạn; dù hợp lệ hay không, mã bị xoá sau lần hỏi đầu. */
export function consumeLoginCode(code: string, now = Date.now()): string | null {
  const entry = codes.get(code);
  codes.delete(code);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.userId;
}
