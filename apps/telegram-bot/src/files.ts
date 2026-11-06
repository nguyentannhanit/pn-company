/**
 * P&N — Kho tệp CEO gửi qua Telegram (§65 phần local).
 *
 * Bot tải tệp về đĩa máy chủ (mặc định storage/attachments/) và nhớ theo từng
 * chat; dự án tạo ngay sau đó nhận đường dẫn tệp trong phần mô tả để CTO và
 * đội đọc được. Không đưa tệp qua API vì bot và API chạy cùng một máy.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { TelegramClient, TelegramMessage } from './telegram.js';

export interface SavedFile {
  name: string;
  path: string;
  size: number;
  at: number;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const pendingByChat = new Map<string, SavedFile[]>();

/** Đọc mỗi lần gọi để test trỏ được sang thư mục tạm. */
const root = (): string => resolve(process.env['PN_ATTACHMENT_DIR'] ?? 'storage/attachments');
const indexFile = (): string => join(root(), 'pending.json');
const fresh = (file: SavedFile): boolean => Date.now() - file.at < TTL_MS;

/** Đọc lại danh sách chờ lúc khởi động; file hỏng thì coi như trống. */
export async function loadPendingFiles(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(indexFile(), 'utf8')) as Record<string, SavedFile[]>;
    for (const [chatId, files] of Object.entries(saved)) {
      const alive = files.filter(fresh);
      if (alive.length > 0) pendingByChat.set(chatId, alive);
    }
  } catch {
    /* chưa có file hoặc file hỏng */
  }
}

async function savePendingFiles(): Promise<void> {
  try {
    await mkdir(root(), { recursive: true });
    await writeFile(indexFile(), JSON.stringify(Object.fromEntries(pendingByChat)));
  } catch {
    /* không ghi được thì vẫn chạy, chỉ mất khi khởi động lại */
  }
}

/** Chọn tệp trong tin nhắn; ảnh Telegram gửi nhiều cỡ, lấy cỡ lớn nhất (cuối mảng). */
export function pickFile(message: TelegramMessage): { fileId: string; name: string } | null {
  if (message.document) {
    return { fileId: message.document.file_id, name: message.document.file_name ?? `tai-lieu-${message.message_id}` };
  }
  const photo = message.photo?.at(-1);
  if (photo) return { fileId: photo.file_id, name: `anh-${message.message_id}.jpg` };
  if (message.voice) return { fileId: message.voice.file_id, name: `ghi-am-${message.message_id}.ogg` };
  if (message.audio) {
    return { fileId: message.audio.file_id, name: message.audio.file_name ?? `am-thanh-${message.message_id}.mp3` };
  }
  return null;
}

/** Tải tệp về đĩa rồi xếp vào danh sách chờ của chat. */
export async function storeAttachment(
  telegram: TelegramClient,
  chatId: string,
  message: TelegramMessage,
): Promise<SavedFile> {
  const picked = pickFile(message);
  if (!picked) throw new Error('Tin nhắn không có tệp');

  const response = await fetch(await telegram.getFileUrl(picked.fileId), { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Telegram không cho tải tệp (HTTP ${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());

  const dir = join(root(), new Date().toISOString().slice(0, 10));
  await mkdir(dir, { recursive: true });
  // Giữ chữ, số, dấu chấm; còn lại thành gạch để tên không phá đường dẫn.
  const safeName = picked.name.replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80);
  const path = join(dir, `${message.message_id}-${safeName}`);
  await writeFile(path, bytes);

  const saved: SavedFile = { name: picked.name, path, size: bytes.length, at: Date.now() };
  pendingByChat.set(chatId, [...(pendingByChat.get(chatId) ?? []).filter(fresh), saved]);
  await savePendingFiles();
  return saved;
}

/** Lấy và xoá tệp đang chờ của chat — gọi đúng lúc tạo dự án. */
export function takePendingFiles(chatId: string): SavedFile[] {
  const files = (pendingByChat.get(chatId) ?? []).filter(fresh);
  pendingByChat.delete(chatId);
  void savePendingFiles();
  return files;
}

/** Đoạn nối vào mục tiêu dự án để CTO biết tệp nằm đâu. */
export function describeFiles(files: SavedFile[]): string {
  if (files.length === 0) return '';
  return (
    '\n\nTệp CEO đính kèm (đã lưu trên máy chủ, đọc bằng đường dẫn):\n' +
    files.map((file) => `- ${file.name} — ${file.path}`).join('\n')
  );
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
