/**
 * P&N — Kinh nghiệm và cấp độ phòng ban (§111, §112, §113).
 *
 * §112 mở đầu bằng "XP không được random" và kết bằng "Không cho knowledge
 * nhiều nhưng chất lượng thấp làm level tăng giả". Hai câu đó chi phối cả file:
 *
 *   - mỗi lần cộng XP phải kèm **bằng chứng** là một sự kiện đã xảy ra thật;
 *   - kiến thức được duyệt cho XP thấp hơn nhiều so với kết quả đo được, vì
 *     duyệt một tài liệu dễ hơn nhiều so với việc làm giảm số lỗi thật.
 */

import type { Department } from '@pn/shared';

/** Nguồn XP hợp lệ. Không có mục nào cộng XP theo thời gian trôi qua. */
export type XpReason =
  | 'knowledge_approved'
  | 'knowledge_adopted'
  | 'task_completed'
  | 'qa_passed_first_try'
  | 'bug_fixed'
  | 'deploy_succeeded'
  | 'performance_improved';

/**
 * Bảng điểm. Chênh lệch giữa `knowledge_approved` (5) và `performance_improved`
 * (40) chính là chỗ §112 chặn việc nạp thật nhiều tài liệu để lên cấp.
 */
export const XP_TABLE: Record<XpReason, number> = {
  knowledge_approved: 5,
  knowledge_adopted: 15,
  task_completed: 10,
  qa_passed_first_try: 20,
  bug_fixed: 12,
  deploy_succeeded: 25,
  performance_improved: 40,
};

export interface XpGrant {
  department: Department;
  amount: number;
  reason: XpReason;
  /** Câu mô tả sự kiện đã xảy ra, để người đọc kiểm lại được (§112). */
  evidence: string;
  projectId?: string | null;
  taskId?: string | null;
  itemId?: string | null;
}

export class MissingEvidenceError extends Error {
  constructor(reason: XpReason) {
    super(`XP vì "${reason}" phải kèm bằng chứng cụ thể (spec §112)`);
    this.name = 'MissingEvidenceError';
  }
}

/**
 * Dựng một lần cộng XP. Ném lỗi khi không có bằng chứng — cố tình ném thay vì
 * lặng lẽ bỏ qua, vì XP không bằng chứng là XP bịa, và nó làm hỏng đúng thứ
 * §112 muốn bảo vệ.
 */
export function grantXp(
  department: Department,
  reason: XpReason,
  evidence: string,
  context: { projectId?: string | null; taskId?: string | null; itemId?: string | null } = {},
): XpGrant {
  if (evidence.trim().length < 10) throw new MissingEvidenceError(reason);

  return {
    department,
    amount: XP_TABLE[reason],
    reason,
    evidence: evidence.trim(),
    projectId: context.projectId ?? null,
    taskId: context.taskId ?? null,
    itemId: context.itemId ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Cấp độ — §111                                                               */
/* -------------------------------------------------------------------------- */

/**
 * XP cần để đạt từng cấp, cộng dồn. Khoảng cách giãn dần: cấp đầu dễ để phòng
 * ban mới thấy tiến bộ, cấp sau khó để cấp cao thật sự có nghĩa.
 */
export const LEVEL_THRESHOLDS = [0, 100, 300, 700, 1500, 3000, 6000, 12_000, 24_000, 50_000];

export const MAX_LEVEL = LEVEL_THRESHOLDS.length;

export function levelForXp(totalXp: number): number {
  let level = 1;
  for (let index = 1; index < LEVEL_THRESHOLDS.length; index += 1) {
    if (totalXp >= LEVEL_THRESHOLDS[index]!) level = index + 1;
  }
  return level;
}

export interface LevelProgress {
  level: number;
  totalXp: number;
  /** XP còn thiếu để lên cấp; `null` khi đã ở cấp cao nhất. */
  xpToNext: number | null;
  /** Tỷ lệ hoàn thành cấp hiện tại, 0..1. */
  ratio: number;
}

export function levelProgress(totalXp: number): LevelProgress {
  const level = levelForXp(totalXp);
  const floor = LEVEL_THRESHOLDS[level - 1] ?? 0;
  const ceiling = LEVEL_THRESHOLDS[level] ?? null;

  if (ceiling === null) return { level, totalXp, xpToNext: null, ratio: 1 };

  return {
    level,
    totalXp,
    xpToNext: ceiling - totalXp,
    ratio: (totalXp - floor) / (ceiling - floor),
  };
}
