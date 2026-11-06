/**
 * P&N — Đẩy thông báo chủ động qua Telegram (§5.2, §29, §55).
 *
 * Từ Phase 1 hệ thống đã phát event `BUDGET_WARNING` và `APPROVAL_REQUIRED`,
 * nhưng không có ai nghe: cảnh báo ngân sách chỉ nằm trong log, còn phiếu duyệt
 * chỉ hiện trên dashboard. Người dùng không ngồi trước dashboard cả ngày, nên
 * "đã cảnh báo" mà không ai đọc thì bằng không cảnh báo.
 *
 * Bộ này đứng ở phía API chứ không ở tiến trình bot vì API mới là nơi biết
 * event xảy ra; bot chỉ xử lý tin nhắn đi vào.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { EventBus, PnEvent } from '@pn/events';
import { secretRef } from '@pn/secrets';
import { branding, type Environment } from '@pn/shared';

import type { AppContext } from '../context.js';

/** Loại event đủ quan trọng để làm phiền người dùng ngoài dashboard. */
const PUSHED_EVENTS = new Set<PnEvent['type']>([
  'BUDGET_WARNING',
  'APPROVAL_REQUIRED',
  'DEPLOY_FAILED',
  'DEPLOY_SUCCESS',
  'PROJECT_MILESTONE',
  'TASK_FAILED',
  'PROVIDER_ALERT',
  'PROJECT_DELIVERED',
]);

export interface TelegramTarget {
  botToken: string;
  chatIds: string[];
}

/**
 * Đọc cấu hình Telegram đang lưu. Trả `null` khi chưa cấu hình — im lặng là
 * đúng ở đây, vì chưa nối Telegram không phải là lỗi.
 */
export async function telegramTarget(
  context: AppContext,
  env: Environment,
): Promise<TelegramTarget | null> {
  const integration = await context.repos.integrations.find('TELEGRAM', env);
  if (!integration || !integration.isEnabled) return null;

  const botToken = await context.secrets
    .reveal(secretRef.integration('TELEGRAM', 'botToken', env))
    .catch(() => null);
  if (!botToken) return null;

  const settings = integration.settings as { allowedChatIds?: string[] };
  const chatIds = settings.allowedChatIds ?? [];
  return chatIds.length > 0 ? { botToken, chatIds } : null;
}

/**
 * Gửi một tin tới mọi chat trong allowlist. Trả về số chat gửi được.
 *
 * Lỗi gửi không được ném ra ngoài: bộ này chạy trong handler của event bus, và
 * một cảnh báo ngân sách không gửi được thì cũng không được phép làm hỏng cái
 * request đã sinh ra nó.
 */
export async function sendTelegram(
  target: TelegramTarget,
  text: string,
  onError?: (message: string) => void,
  buttons?: Array<Array<{ text: string; callback_data: string }>>,
): Promise<number> {
  let delivered = 0;

  for (const chatId of target.chatIds) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${target.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          // HTML có escape thay vì Markdown: tiêu đề phiếu chứa `_` hay `*` là
          // Telegram trả 400 và tin đẩy biến mất không dấu vết.
          parse_mode: 'HTML',
          ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) delivered += 1;
      else {
        const body = (await response.json().catch(() => ({}))) as { description?: string };
        onError?.(`chat ${chatId}: ${body.description ?? `HTTP ${response.status}`}`);
      }
    } catch (error) {
      onError?.(`chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return delivered;
}

/**
 * Gửi một ảnh kèm chú thích (HTML) tới mọi chat — dùng cho ảnh cửa sổ sản phẩm thật.
 * Không đọc được file ảnh thì gửi chữ như thường, đừng để mất tin.
 */
export async function sendTelegramPhoto(
  target: TelegramTarget,
  file: string,
  caption: string,
  onError?: (message: string) => void,
): Promise<number> {
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return sendTelegram(target, caption, onError);
  let delivered = 0;
  for (const chatId of target.chatIds) {
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      // Chú thích ảnh Telegram tối đa 1024 ký tự.
      form.set('caption', caption.slice(0, 1_000));
      form.set('parse_mode', 'HTML');
      form.set('photo', new Blob([bytes], { type: 'image/png' }), 'san-pham.png');
      const response = await fetch(`https://api.telegram.org/bot${target.botToken}/sendPhoto`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) delivered += 1;
      else {
        const body = (await response.json().catch(() => ({}))) as { description?: string };
        onError?.(`chat ${chatId}: ${body.description ?? `HTTP ${response.status}`}`);
      }
    } catch (error) {
      onError?.(`chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return delivered;
}

/** Gửi một yêu cầu multipart tới Bot API cho mọi chat; trả số chat gửi được. Lỗi chỉ ghi log, không ném. */
async function postForm(
  target: TelegramTarget,
  method: string,
  fill: (form: FormData, chatId: string) => void,
  onError?: (message: string) => void,
  timeoutMs = 60_000,
): Promise<number> {
  let delivered = 0;
  for (const chatId of target.chatIds) {
    try {
      const form = new FormData();
      form.set('chat_id', chatId);
      fill(form, chatId);
      const response = await fetch(`https://api.telegram.org/bot${target.botToken}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) delivered += 1;
      else {
        const body = (await response.json().catch(() => ({}))) as { description?: string };
        onError?.(`chat ${chatId}: ${body.description ?? `HTTP ${response.status}`}`);
      }
    } catch (error) {
      onError?.(`chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return delivered;
}

/**
 * Gửi tới 4 ảnh thành một cụm (album), chú thích nằm ở ảnh đầu. Đọc được ít hơn 1 ảnh
 * thì gửi chữ như thường. Dùng cho bàn giao sản phẩm: CEO nhìn thấy sản phẩm ngay trong chat.
 */
export async function sendTelegramMediaGroup(
  target: TelegramTarget,
  files: string[],
  caption: string,
  onError?: (message: string) => void,
): Promise<number> {
  const photos: Array<{ name: string; bytes: Buffer }> = [];
  for (const file of files.slice(0, 4)) {
    const bytes = await readFile(file).catch(() => null);
    if (bytes) photos.push({ name: `anh-${photos.length + 1}.png`, bytes });
  }
  if (photos.length === 0) return sendTelegram(target, caption, onError);
  if (photos.length === 1) return sendTelegramPhoto(target, files[0]!, caption, onError);
  return postForm(target, 'sendMediaGroup', (form) => {
    form.set(
      'media',
      JSON.stringify(
        photos.map((photo, index) => ({
          type: 'photo',
          media: `attach://${photo.name}`,
          ...(index === 0 ? { caption: caption.slice(0, 1_000), parse_mode: 'HTML' } : {}),
        })),
      ),
    );
    for (const photo of photos) form.set(photo.name, new Blob([photo.bytes], { type: 'image/png' }), photo.name);
  }, onError);
}

/** Telegram nhận tệp tới 50 MB qua Bot API. */
export const TELEGRAM_DOCUMENT_MAX_BYTES = 50 * 1_048_576;

/** Gửi một tệp (ví dụ .exe) kèm chú thích. Tệp quá cỡ hoặc không đọc được thì báo bằng chữ, không im. */
export async function sendTelegramDocument(
  target: TelegramTarget,
  file: string,
  caption: string,
  onError?: (message: string) => void,
): Promise<number> {
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) return sendTelegram(target, `${caption}\n(không đọc được tệp ${esc(path.basename(file))})`, onError);
  if (bytes.length > TELEGRAM_DOCUMENT_MAX_BYTES) {
    return sendTelegram(
      target,
      `${caption}\nTệp ${esc(path.basename(file))} nặng ${(bytes.length / 1_048_576).toFixed(0)} MB, quá 50 MB Telegram cho phép — tải qua link ở trên.`,
      onError,
    );
  }
  return postForm(target, 'sendDocument', (form) => {
    form.set('caption', caption.slice(0, 1_000));
    form.set('parse_mode', 'HTML');
    form.set('document', new Blob([bytes], { type: 'application/octet-stream' }), path.basename(file));
  }, onError, 120_000);
}

/** Ảnh chụp sản phẩm: ảnh khởi động thử của staging rồi tới ảnh QA đi thử (tối đa 4, thứ tự tên). */
export async function productScreenshots(sandboxRoot: string, slug: string): Promise<string[]> {
  const dir = path.join(sandboxRoot, '_anh-san-pham');
  const shots: string[] = [];
  const staging = path.join(dir, `${slug}.png`);
  if (await stat(staging).then(() => true, () => false)) shots.push(staging);
  const qa = await readdir(path.join(dir, slug)).catch(() => [] as string[]);
  for (const name of qa.filter((item) => item.endsWith('.png')).sort()) shots.push(path.join(dir, slug, name));
  return shots.slice(0, 4);
}

/** Escape cho parse_mode HTML của Telegram. */
const esc = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Câu chữ cho từng loại event. Ngắn — đây là tin đẩy, không phải báo cáo. */
export interface EventExtra {
  taskTitle?: string | null;
  /** Phiếu duyệt: tóm tắt + dự án + chi phí để CEO quyết ngay trên điện thoại. */
  approval?: { summary: string; projectName: string | null; spentUsd: number | null } | null;
}

const PROVIDER_NAME: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  'claude-code': 'Claude (gói thuê bao)',
  codex: 'ChatGPT (gói thuê bao)',
};
const providerName = (id: string): string => PROVIDER_NAME[id] ?? id;

export function describeEvent(event: PnEvent, extra: EventExtra = {}): string | null {
  const brand = esc(branding.companyShortName);
  switch (event.type) {
    case 'TASK_FAILED':
      // Việc bị chặn là lúc CEO phải ra tay; kèm tên việc và lý do để quyết
      // ngay trên điện thoại thay vì phải mở dashboard tìm.
      return (
        `🟠 <b>${brand} — việc bị chặn</b>
` +
        (extra.taskTitle ? `<b>${esc(extra.taskTitle)}</b>
` : '') +
        esc(event.payload.reason).slice(0, 600)
      );
    case 'BUDGET_WARNING': {
      const payload = event.payload;
      return (
        `⚠️ <b>${brand} — ngân sách</b>\n` +
        `Phạm vi ${esc(payload.scope)} đã dùng ${Math.round(payload.ratio * 100)}% ` +
        `($${payload.spentUsd.toFixed(2)} / $${payload.limitUsd.toFixed(2)}).`
      );
    }
    case 'APPROVAL_REQUIRED': {
      // Chỉ tiêu đề thì CEO không biết vì sao phải quyết; kèm tóm tắt của agent
      // (lý do, lỗi còn lại, hai nút nghĩa là gì) và dự án + chi phí.
      const approval = extra.approval;
      const where = approval?.projectName
        ? `\n📁 ${esc(approval.projectName)}${approval.spentUsd !== null ? ` · đã tiêu $${approval.spentUsd.toFixed(2)}` : ''}`
        : '';
      const summary = approval?.summary ? `\n\n${esc(approval.summary.slice(0, 1_500))}` : '';
      return `🔔 <b>${brand} — cần bạn duyệt</b>\n<b>${esc(event.payload.title)}</b>${where}${summary}`;
    }
    case 'DEPLOY_FAILED':
      return `❌ <b>${brand} — triển khai thất bại</b>\n${esc(event.payload.reason)}`;
    case 'DEPLOY_SUCCESS':
      // Link mang vé xem 12 giờ; CEO mở thẳng từ điện thoại, không cần dashboard.
      return event.payload.url
        ? `🚀 <b>${brand} — sản phẩm mở được rồi</b>\n${esc(event.payload.url)}`
        : null;
    case 'PROVIDER_ALERT': {
      // Hết tiền / hết hạn mức gói / đăng nhập hết hạn: nói rõ hãng nào, né bao lâu, CEO cần làm gì.
      const { provider, kind, model, detail, cooldownMs } = event.payload;
      const name = esc(providerName(provider));
      const wait = cooldownMs >= 3_600_000 ? `${Math.round(cooldownMs / 3_600_000)} giờ` : `${Math.round(cooldownMs / 60_000)} phút`;
      const cli = provider === 'claude-code' || provider === 'codex';
      const title = kind === 'auth' ? `${name} không đăng nhập được` : cli ? `${name} hết lượt dùng của gói` : `${name} hết credit`;
      const what =
        kind === 'auth'
          ? cli
            ? `Phiên đăng nhập CLI hết hạn hoặc chưa đăng nhập. Anh mở terminal chạy <code>${provider === 'codex' ? 'codex login' : 'claude setup-token'}</code> rồi bấm Kiểm tra ở Cài đặt.`
            : 'API key bị từ chối. Anh kiểm tra lại key ở Cài đặt.'
          : cli
            ? 'Gói thuê bao đã chạm hạn mức (theo khung giờ hoặc theo tuần); hạn mức tự hồi, không cần làm gì.'
            : 'Anh nạp tiền rồi vào Cài đặt → Kiểm tra kết nối để dùng lại sớm hơn.';
      return (
        `💳 <b>${brand} — ${title}</b>\n` +
        `Lỗi khi gọi ${esc(model)}. Em tạm bỏ qua hãng này ${wait}, việc chạy bằng hãng dự phòng.\n${what}\n` +
        `<i>${esc(detail.slice(0, 200))}</i>`
      );
    }
    case 'PROJECT_DELIVERED': {
      // Bàn giao: tên, link dùng thử (vé 12 giờ), chi phí. Ảnh và tệp đi kèm do registerNotifier gửi.
      const payload = event.payload;
      return (
        `🎁 <b>${brand} — sản phẩm hoàn thành</b>\n<b>${esc(payload.name)}</b>\n` +
        `${payload.taskCount} việc xong · chi phí $${payload.spentUsd.toFixed(2)}\n` +
        (payload.url ? `Dùng thử (link sống 12 giờ): ${esc(payload.url)}\n` : '') +
        (payload.file ? `Tệp chạy: ${esc(path.basename(payload.file))} gửi kèm bên dưới.\n` : '') +
        'Cần sửa gì, anh nhắn thẳng cho Khang trong chat này.'
      );
    }
    case 'PROJECT_MILESTONE':
      // Mốc "hoàn thành" đã có tin bàn giao đầy đủ hơn (PROJECT_DELIVERED) — không gửi hai tin.
      if (event.payload.title.startsWith('Dự án hoàn thành')) return null;
      return (
        `🏁 <b>${brand} — ${esc(event.payload.title)}</b>\n` +
        (event.payload.detail ? `${esc(event.payload.detail)}\n` : '') +
        `Chi phí dự án tới giờ: $${event.payload.spentUsd.toFixed(2)}`
      );
    default:
      return null;
  }
}

/**
 * Nối event bus với Telegram. Trả về hàm huỷ đăng ký để đóng ứng dụng cho sạch.
 *
 * Chống lặp: cùng một cảnh báo ngân sách có thể phát nhiều lần trong một phút
 * khi nhiều agent chạy song song. Gửi cả chục tin giống nhau là cách nhanh nhất
 * để người dùng tắt thông báo, nên mỗi nội dung chỉ gửi lại sau `#COOLDOWN_MS`.
 */
export function registerNotifier(
  events: EventBus,
  context: AppContext,
  log: (message: string) => void,
): () => void {
  const COOLDOWN_MS = 5 * 60_000;
  const lastSent = new Map<string, number>();

  return events.subscribe((event) => {
    if (!PUSHED_EVENTS.has(event.type)) return;

    void (async () => {
      const task =
        event.type === 'TASK_FAILED' ? await context.repos.tasks.findById(event.payload.taskId) : null;
      let approval: EventExtra['approval'] = null;
      if (event.type === 'APPROVAL_REQUIRED') {
        const row = await context.repos.approvals.findById(event.payload.approvalId);
        const project = row?.projectId ? await context.repos.projects.findById(row.projectId) : null;
        if (row) approval = { summary: row.summary, projectName: project?.name ?? null, spentUsd: project?.spentUsd ?? null };
      }
      const text = describeEvent(event, { taskTitle: task?.title ?? null, approval });
      if (text === null) return;

      // Một dự án có thể chặn cả loạt việc trong một giây (thiếu route model…);
      // mỗi dự án chỉ báo một việc chặn mỗi phút, tin khác dedup theo nội dung.
      const key = event.type === 'TASK_FAILED' ? `TASK_FAILED:${event.projectId}` : text;
      const cooldown = event.type === 'TASK_FAILED' ? 60_000 : COOLDOWN_MS;
      const now = Date.now();
      const previous = lastSent.get(key);
      if (previous !== undefined && now - previous < cooldown) return;
      lastSent.set(key, now);

      // Nút bấm ngay trong chat; tiến trình bot nhận callback `approve:<id>`,
      // `reject:<id>` (y như thẻ của lệnh /approve) và `retry:<taskId>`.
      const buttons =
        event.type === 'APPROVAL_REQUIRED'
          ? [
              [
                { text: '✅ Duyệt', callback_data: `approve:${event.payload.approvalId}` },
                { text: '❌ Từ chối', callback_data: `reject:${event.payload.approvalId}` },
              ],
            ]
          : event.type === 'TASK_FAILED'
            ? [[{ text: '🔁 Chạy lại', callback_data: `retry:${event.payload.taskId}` }]]
            : undefined;

      const target = await telegramTarget(context, context.config.environment);
      if (!target) return;
      const onError = (error: string): void => log(`không gửi được thông báo Telegram: ${error}`);
      let delivered: number;
      if (event.type === 'PROJECT_DELIVERED') {
        // Bàn giao: album ảnh sản phẩm (chú thích là tin chính) rồi tệp .exe nếu có.
        const shots = await productScreenshots(context.config.sandboxRoot, event.payload.slug);
        delivered = await sendTelegramMediaGroup(target, shots, text, onError);
        if (event.payload.file) await sendTelegramDocument(target, event.payload.file, `📦 ${esc(event.payload.name)} — bản chạy thử (portable)`, onError);
      } else {
        // Bản desktop có ảnh cửa sổ thật lúc khởi động thử: gửi ảnh, link nằm trong chú thích.
        const screenshot = event.type === 'DEPLOY_SUCCESS' ? event.payload.screenshot : null;
        delivered = screenshot
          ? await sendTelegramPhoto(target, screenshot, text, onError)
          : await sendTelegram(target, text, onError, buttons);
      }
      if (delivered > 0) log(`đã đẩy ${event.type} tới ${delivered} chat Telegram`);
    })();
  });
}
