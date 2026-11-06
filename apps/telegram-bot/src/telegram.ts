/**
 * P&N — Client Bot API của Telegram.
 *
 * Gọi REST trực tiếp: bề mặt cần dùng chỉ vài endpoint, và giữ nguyên như vậy
 * thì không phải chạy theo phiên bản của một thư viện bọc.
 */

const API_ROOT = 'https://api.telegram.org';

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly description: string,
  ) {
    super(`Telegram ${method}: ${description}`);
    this.name = 'TelegramError';
  }
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  document?: TelegramDocument;
  photo?: Array<{ file_id: string; file_size?: number; width: number; height: number }>;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

/** Nút bấm inline — dùng cho luồng duyệt/từ chối (§5.2). */
export interface InlineButton {
  text: string;
  callback_data?: string;
  /** Nút mở link thay vì gửi callback. */
  url?: string;
}

export class TelegramClient {
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(token: string, timeoutMs = 40_000) {
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  /** Xác nhận token còn sống và bot tên gì (§48). */
  async getMe(): Promise<TelegramUser> {
    return this.#call<TelegramUser>('getMe');
  }

  /**
   * Long polling. Chọn long polling thay vì webhook vì webhook cần một URL công
   * khai — điều không có khi chạy cục bộ. Interface giữ nguyên nếu sau này đổi.
   */
  async getUpdates(offset: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    return this.#call<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async sendMessage(
    chatId: number | string,
    text: string,
    options: { buttons?: InlineButton[][]; replyTo?: number } = {},
  ): Promise<TelegramMessage> {
    return this.#call<TelegramMessage>('sendMessage', {
      chat_id: chatId,
      text: truncate(text),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(options.replyTo ? { reply_to_message_id: options.replyTo } : {}),
      ...(options.buttons ? { reply_markup: { inline_keyboard: options.buttons } } : {}),
    });
  }

  /** Sửa nội dung tin nhắn cũ — dùng để thay bàn phím sau khi CEO đã bấm. */
  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
  ): Promise<void> {
    await this.#call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: truncate(text),
      parse_mode: 'HTML',
    }).catch(() => undefined);
  }

  /** Bắt buộc gọi sau mỗi lần bấm nút, nếu không Telegram sẽ quay vòng mãi. */
  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    await this.#call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }).catch(
      () => undefined,
    );
  }

  /** Lấy đường dẫn tải file đính kèm (§5.3). */
  /**
   * Nút menu cạnh ô nhập của bot: mở dashboard ngay trong Telegram và tự đăng
   * nhập. Địa chỉ đường hầm đổi thì gọi lại hàm này là nút trỏ đúng chỗ mới.
   */
  async setMenuButton(chatId: string, text: string, url: string): Promise<void> {
    await this.#call('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text, web_app: { url } },
    });
  }

  async getFileUrl(fileId: string): Promise<string> {
    const file = await this.#call<{ file_path: string }>('getFile', { file_id: fileId });
    return `${API_ROOT}/file/bot${this.#token}/${file.file_path}`;
  }

  async #call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API_ROOT}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });

    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) {
      throw new TelegramError(method, payload.description ?? `HTTP ${response.status}`);
    }
    return payload.result as T;
  }
}

/** Telegram giới hạn 4096 ký tự mỗi tin nhắn. */
function truncate(text: string, max = 4000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(đã rút gọn)`;
}
