/**
 * P&N — Nhắc CEO phiếu duyệt còn treo, mỗi giờ một lần.
 *
 * CEO chỉ còn bị hỏi hai loại việc: chi phí phát sinh và phát hành chính thức.
 * Phiếu loại đó treo là dự án đứng chờ, nên tin nhắn đầu bị trôi thì phải nhắc
 * lại — kèm nút Duyệt/Từ chối như tin đầu, bấm được ngay.
 */

import type { Approval } from '@pn/shared';

import type { AppContext } from '../context.js';
import { sendTelegram, telegramTarget } from './notifier.js';

/** Phiếu kéo theo dự án đứng chờ CEO. Phiếu kiến thức/nâng cấp phòng ban không gấp nên không nhắc. */
const REMINDED_KINDS = new Set<Approval['kind']>(['BUDGET_INCREASE', 'PRODUCTION_DEPLOY', 'PROJECT_PLAN', 'ARCHITECTURE']);
export const REMIND_EVERY_MS = 60 * 60_000;

/** Phiếu nào tới giờ nhắc; `lastSent` giữ lần gửi gần nhất của từng phiếu (lần đầu = lúc tạo phiếu). */
export function dueReminders(pending: Approval[], lastSent: Map<string, number>, now: number): Approval[] {
  return pending.filter((approval) => {
    if (!REMINDED_KINDS.has(approval.kind)) return false;
    const last = lastSent.get(approval.id) ?? Date.parse(approval.createdAt);
    return now - last >= REMIND_EVERY_MS;
  });
}

/** Nội dung tin nhắc: đã chờ bao lâu, việc gì, dự án nào. */
export function reminderText(approval: Approval, projectName: string | null, now: number): string {
  const hours = Math.max(1, Math.round((now - Date.parse(approval.createdAt)) / 3_600_000));
  const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return (
    `⏰ <b>Nhắc lại — vẫn chờ anh quyết (${hours} giờ)</b>\n<b>${esc(approval.title)}</b>` +
    (projectName ? `\n📁 ${esc(projectName)}` : '') +
    (approval.summary ? `\n\n${esc(approval.summary.slice(0, 1_200))}` : '')
  );
}

/** Kiểm tra 5 phút một lần; trả về hàm dừng. */
export function startApprovalReminders(context: AppContext, log: (message: string) => void): () => void {
  const lastSent = new Map<string, number>();
  const tick = async (): Promise<void> => {
    const now = Date.now();
    const due = dueReminders(await context.repos.approvals.listPending(), lastSent, now);
    if (due.length === 0) return;
    const target = await telegramTarget(context, context.config.environment);
    if (!target) return;
    for (const approval of due) {
      lastSent.set(approval.id, now);
      const project = approval.projectId ? await context.repos.projects.findById(approval.projectId) : null;
      const delivered = await sendTelegram(target, reminderText(approval, project?.name ?? null, now), (error) => log(`không gửi được tin nhắc: ${error}`), [
        [
          { text: '✅ Duyệt', callback_data: `approve:${approval.id}` },
          { text: '❌ Từ chối', callback_data: `reject:${approval.id}` },
        ],
      ]);
      if (delivered > 0) log(`đã nhắc CEO phiếu "${approval.title}"`);
    }
  };
  const timer = setInterval(() => void tick().catch((error: unknown) => log(`nhắc phiếu duyệt lỗi: ${String(error)}`)), 5 * 60_000);
  return () => clearInterval(timer);
}
