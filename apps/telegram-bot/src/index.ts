/**
 * P&N — Tiến trình Telegram Bot (§5, §57, §58).
 *
 * Tiến trình này cố tình rất mỏng: nó không giữ khoá chính, không chạm database,
 * không gọi model. Bot token được xin từ API qua cửa nội bộ, nên nơi duy nhất
 * giải mã được secret vẫn là tiến trình API (§19, §69).
 */

import { branding } from '@pn/shared';

import { PnApiClient } from './api.js';
import { loadPendingFiles } from './files.js';
import { handleCallback, handleMessage, loadProposals, type BotDeps } from './handler.js';
import { TelegramClient } from './telegram.js';

interface BotConfig {
  apiUrl: string;
  serviceSecret: string;
  /** Bot token đặt thẳng ở env sẽ được ưu tiên; nếu không thì xin từ API Center. */
  envBotToken: string | null;
  /** Allowlist đặt ở env, cộng thêm danh sách trong API Center. */
  envAllowedChatIds: string[];
}

function loadConfig(): BotConfig {
  const serviceSecret = process.env['PN_SERVICE_SECRET']?.trim();
  if (!serviceSecret) {
    throw new Error(
      'Thiếu PN_SERVICE_SECRET. Đây là secret dùng chung giữa API và bot; ' +
        'đặt cùng một giá trị ở cả hai tiến trình.',
    );
  }

  return {
    apiUrl: (process.env['API_PUBLIC_URL'] ?? 'http://localhost:4000').replace(/\/+$/, ''),
    serviceSecret,
    envBotToken: process.env['TELEGRAM_BOT_TOKEN']?.trim() || null,
    envAllowedChatIds: (process.env['TELEGRAM_ALLOWED_CHAT_IDS'] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const api = new PnApiClient(config.apiUrl, config.serviceSecret);

  let botToken = config.envBotToken;
  let webPublicUrl: string | null = null;
  const allowedChatIds = new Set(config.envAllowedChatIds);

  // Xin cấu hình từ API Center. Lúc mở máy, API có thể lên sau bot vài giây nên
  // thử lại trong ~1 phút rồi mới chịu thua.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const bootstrap = await api.bootstrap();
      botToken ??= bootstrap.botToken;
      webPublicUrl = bootstrap.webPublicUrl ?? null;
      for (const id of bootstrap.allowedChatIds) allowedChatIds.add(id);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 1) console.warn(`[bot] API chưa trả lời (${api.baseUrl}), chờ rồi thử lại…`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  if (lastError) {
    if (!botToken) {
      throw new Error(
        'Không lấy được cấu hình Telegram từ API và cũng không có TELEGRAM_BOT_TOKEN trong env. ' +
          `Chi tiết: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
    console.warn('[bot] không lấy được cấu hình từ API Center, dùng cấu hình env.');
  }

  const telegram = new TelegramClient(botToken!);
  const me = await telegram.getMe();

  await loadProposals();
  await loadPendingFiles();
  const deps: BotDeps = { telegram, api, allowedChatIds, onLinked: (chatId) => void setMenuFor(chatId) };

  /**
   * Nút "Mở P&N" cạnh ô nhập: lối vào cố định, không phụ thuộc link đã lưu ở máy
   * CEO. Địa chỉ đường hầm đổi khi mở lại, nên hỏi lại mỗi 2 phút và chỉ đặt lại
   * khi khác — bấm nút mà trỏ địa chỉ chết thì màn hình đứng im, không báo gì.
   */
  let menuUrl: string | null = null;
  /** Chat đã được đặt nút với `menuUrl` hiện tại — người mới nối bot cũng có nút, không chỉ người có từ lúc bật bot. */
  const menuSet = new Set<string>();
  const setMenuFor = async (chatId: string): Promise<void> => {
    if (!menuUrl || menuSet.has(chatId)) return;
    await telegram
      .setMenuButton(chatId, 'Mở P&N', menuUrl)
      .then(() => menuSet.add(chatId))
      .catch((error: unknown) => console.warn('[bot] không đặt được nút menu:', error instanceof Error ? error.message : error));
  };
  const refreshMenuButton = async (origin: string | null): Promise<void> => {
    const url = origin?.startsWith('https://') ? `${origin}/login` : null;
    if (url && url !== menuUrl) {
      menuUrl = url;
      menuSet.clear();
      console.log(`[bot] nút "Mở P&N" trỏ tới ${url}`);
    }
    for (const chatId of allowedChatIds) await setMenuFor(chatId);
  };
  await refreshMenuButton(webPublicUrl);

  // Mỗi 2 phút: địa chỉ mới cho nút menu, và allowlist mới (người vừa nối bot vào, người bị khoá ra).
  const menuTimer = setInterval(() => {
    void api
      .bootstrap()
      .then(async (fresh) => {
        const next = new Set([...config.envAllowedChatIds, ...fresh.allowedChatIds]);
        for (const id of allowedChatIds) if (!next.has(id)) allowedChatIds.delete(id);
        for (const id of next) allowedChatIds.add(id);
        await refreshMenuButton(fresh.webPublicUrl ?? null);
      })
      .catch(() => undefined);
  }, 120_000);
  menuTimer.unref();

  console.log(
    `${branding.companyName} Telegram Bot đã kết nối: @${me.username ?? me.first_name}` +
      (allowedChatIds.size > 0
        ? ` — allowlist ${allowedChatIds.size} chat`
        : ' — ⚠️ allowlist trống, mọi chat đều gọi được (chỉ nên dùng khi phát triển)'),
  );

  let offset = 0;
  let running = true;

  const stop = (signal: string): void => {
    console.log(`\n[bot] nhận ${signal}, dừng vòng lặp…`);
    running = false;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Long polling. Lỗi mạng không được làm chết tiến trình — nghỉ rồi thử lại.
  while (running) {
    try {
      const updates = await telegram.getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.message) {
          await handleMessage(deps, update.message).catch((error: unknown) => {
            console.error('[bot] lỗi xử lý tin nhắn:', error);
          });
        } else if (update.callback_query) {
          await handleCallback(deps, update.callback_query).catch((error: unknown) => {
            console.error('[bot] lỗi xử lý nút bấm:', error);
          });
        }
      }
    } catch (error) {
      console.error('[bot] lỗi long polling:', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
