/**
 * P&N — Danh tính Telegram dùng chung cho cửa nội bộ và đường đăng nhập Mini App.
 *
 * Một chỗ duy nhất biết: lấy bot token ở đâu, chat nào được phép, và chat gắn với
 * tài khoản nào — để cửa `/internal/*` và `/auth/telegram-webapp` không lệch luật.
 */

import { createHash, randomBytes } from 'node:crypto';

import { secretRef } from '@pn/secrets';

import type { AppContext } from '../context.js';

/** Cấu hình Telegram lưu ở phần không nhạy cảm của bảng integrations. */
export interface TelegramSettings {
  allowedChatIds?: string[];
  botUsername?: string | null;
}

/** Bot token thật; chỉ tiến trình API giải mã được (§19, §69). */
export async function telegramBotToken(context: AppContext): Promise<string | null> {
  const env = context.config.environment;
  const integration = await context.repos.integrations.find('TELEGRAM', env);
  if (!integration || !integration.isEnabled) return null;
  return context.secrets.reveal(secretRef.integration('TELEGRAM', 'botToken', env)).catch(() => null);
}

/**
 * Danh sách chat được phép điều khiển công ty (§58): danh sách CEO nhập tay ở Tích hợp → Telegram, cộng chat của
 * mọi người đang dùng đã tự nối bot qua link mời. Người bị khoá rơi khỏi danh sách ngay.
 */
export async function telegramAllowedChatIds(context: AppContext): Promise<string[]> {
  const integration = await context.repos.integrations.find('TELEGRAM', context.config.environment);
  if (!integration?.isEnabled) return [];
  const listed = ((integration.settings ?? {}) as TelegramSettings).allowedChatIds ?? [];
  const linked = (await context.repos.users.list())
    .filter((user) => user.isActive && user.telegramChatId)
    .map((user) => user.telegramChatId!);
  return [...new Set([...listed, ...linked])];
}

/* -------------------------------------------------------------------------- */
/* Nối bot cho từng người (người được mời cũng dùng Telegram)        */
/* -------------------------------------------------------------------------- */

/** Link nối sống 30 phút: đủ để mở Telegram bấm Start, không đủ lâu để trôi nổi trong nhóm chat. */
const LINK_TTL_MS = 30 * 60_000;
/** Mã → người. Chỉ giữ bản băm; mất khi API khởi động lại thì tạo link mới, không cần bảng riêng. */
const linkCodes = new Map<string, { userId: string; expiresAt: number }>();
const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');

/** Tạo mã nối bot cho một người; mã cũ chưa dùng của người đó bị thay. */
export function createTelegramLinkCode(userId: string, now = Date.now()): { code: string; expiresInSeconds: number } {
  for (const [key, entry] of linkCodes) if (entry.expiresAt <= now || entry.userId === userId) linkCodes.delete(key);
  // 18 byte → 24 ký tự base64url: vừa giới hạn 64 ký tự của tham số start, chỉ gồm chữ số, chữ, - và _.
  const code = randomBytes(18).toString('base64url');
  linkCodes.set(hashCode(code), { userId, expiresAt: now + LINK_TTL_MS });
  return { code, expiresInSeconds: LINK_TTL_MS / 1000 };
}

/** Dùng một lần: đúng hay sai mã đều bị xoá sau lần hỏi đầu. */
export function consumeTelegramLinkCode(code: string, now = Date.now()): string | null {
  const key = hashCode(code);
  const entry = linkCodes.get(key);
  linkCodes.delete(key);
  if (!entry || entry.expiresAt <= now) return null;
  return entry.userId;
}

let cachedUsername: { token: string; username: string } | null = null;

/** Tên bot (@...) để dựng link t.me; hỏi Telegram một lần rồi nhớ, đổi token thì hỏi lại. */
export async function telegramBotUsername(context: AppContext): Promise<string | null> {
  const token = await telegramBotToken(context);
  if (!token) return null;
  if (cachedUsername?.token === token) return cachedUsername.username;
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const body = (await response?.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
  const username = body?.ok ? body.result?.username : undefined;
  if (!username) return null;
  cachedUsername = { token, username };
  return username;
}

/** Link mở bot kèm mã nối; null khi chưa cấu hình bot. */
export async function telegramLinkUrl(context: AppContext, userId: string): Promise<{ url: string; expiresInSeconds: number } | null> {
  const username = await telegramBotUsername(context);
  if (!username) return null;
  const { code, expiresInSeconds } = createTelegramLinkCode(userId);
  return { url: `https://t.me/${username}?start=link_${code}`, expiresInSeconds };
}

/**
 * Chat nằm trong allowlist mà chưa gắn với ai thì gắn vào tài khoản CEO duy nhất.
 * CEO đã tự tay cho chat này vào danh sách ở API Center; bắt họ tìm thêm một
 * chỗ "gắn tài khoản" nữa là bước không ai đoán ra — lần bấm Duyệt đầu tiên
 * trên Telegram đã chết ở đây với lời nhắn "không xử lý được".
 */
export async function linkAllowlistedChat(
  context: AppContext,
  chatId: string,
): Promise<Awaited<ReturnType<AppContext['repos']['users']['findByTelegramChatId']>>> {
  const env = context.config.environment;
  const integration = await context.repos.integrations.find('TELEGRAM', env);
  const allowed = ((integration?.settings ?? {}) as TelegramSettings).allowedChatIds ?? [];
  if (!integration?.isEnabled || !allowed.includes(chatId)) return null;

  const ceos = (await context.repos.users.list()).filter((user) => user.role === 'CEO' && user.isActive);
  if (ceos.length !== 1) return null;

  const linked = await context.repos.users.linkTelegramChat(ceos[0]!.id, chatId);
  await context.repos.audit.record({
    actor: `telegram:${chatId}`,
    action: 'TELEGRAM_LINKED',
    targetType: 'users',
    targetId: linked.id,
    environment: env,
  });
  return linked;
}
