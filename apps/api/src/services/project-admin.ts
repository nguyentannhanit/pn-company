/**
 * P&N — Thư mục làm việc của dự án khi làm lại hoặc xoá.
 *
 * Làm lại từ bước Lập trình trở về trước thì mã cũ bị CẤT (không xoá) sang
 * `_luu/`, để các phòng dựng lại sạch theo tài liệu mới mà vẫn lấy lại được khi
 * cần. Xoá dự án thì xoá hẳn thư mục, ảnh sản phẩm và cả các bản đã cất.
 */

import { cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

/** Đường dẫn workspace của một dự án dưới thư mục gốc sandbox. */
export function workspaceOf(root: string, slug: string): string {
  return path.resolve(root, slug);
}

/**
 * Cất workspace sang `_luu/<slug>-<thời điểm>`, tạo workspace rỗng, chép lại các
 * tài liệu cần giữ. Trả về chỗ đã cất, hoặc `null` nếu dự án chưa có workspace.
 */
export async function archiveWorkspace(root: string, slug: string, keep: string[], now = new Date()): Promise<string | null> {
  const workspace = workspaceOf(root, slug);
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const archive = path.resolve(root, '_luu', `${slug}-${stamp}`);
  await mkdir(path.dirname(archive), { recursive: true });
  try {
    await rename(workspace, archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `Không cất được mã cũ (${(error as Error).message}). Có thể app của dự án đang mở — tắt app rồi bấm lại.`,
    );
  }
  await mkdir(workspace, { recursive: true });
  for (const file of keep) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    // Tài liệu chưa từng được viết thì không có gì để chép lại.
    await cp(path.join(archive, file), path.join(workspace, file)).catch(() => undefined);
  }
  return archive;
}

/** Xoá hẳn workspace, ảnh sản phẩm và mọi bản cất `_luu/<slug>-<thời điểm>` của dự án. */
export async function removeWorkspace(root: string, slug: string): Promise<void> {
  await rm(workspaceOf(root, slug), { recursive: true, force: true });
  await rm(path.resolve(root, '_anh-san-pham', `${slug}.png`), { force: true });
  // Tên bản cất là <slug>-<YYYY-MM-DD-HH-mm>; so cả dấu thời gian để không xoá nhầm dự án có tiền tố giống.
  const isArchive = new RegExp(`^${slug}-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}$`);
  const archives = await readdir(path.resolve(root, '_luu')).catch(() => [] as string[]);
  for (const name of archives) {
    if (isArchive.test(name)) await rm(path.resolve(root, '_luu', name), { recursive: true, force: true });
  }
}
