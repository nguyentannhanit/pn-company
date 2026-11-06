/**
 * P&N — Khởi tạo dữ liệu nền tảng (§3, §7).
 *
 * Toàn bộ 26 vai trò agent được tạo sẵn trong database ngay lúc khởi động, kể cả
 * những vai trò thuộc phase sau. Lý do: văn phòng 3D cần biết có những phòng ban
 * nào và ai ngồi ở đâu, và Agent Detail Panel cần hiện đủ danh sách. Vai trò
 * chưa có hiện thực thì đứng ở trạng thái `offline` chứ không biến mất.
 */

import type { Repositories } from '@pn/database';
import type { AgentRole } from '@pn/shared';
import { AGENT_PROFILES, AGENT_ROLES, MVP_AGENT_ROLES } from '@pn/shared';

/** Tạo hoặc cập nhật toàn bộ agent. Chạy lại nhiều lần vẫn an toàn. */
export async function seedAgents(repos: Repositories): Promise<{ created: number; mvp: AgentRole[] }> {
  let created = 0;
  for (const role of AGENT_ROLES) {
    const profile = AGENT_PROFILES[role];
    await repos.agents.upsert({
      role,
      displayName: profile.displayName,
      department: profile.department,
    });
    created += 1;
  }
  return { created, mvp: [...MVP_AGENT_ROLES] };
}

/**
 * §54 — nếu chưa có chính sách ngân sách toàn cục nào thì đặt một mức mặc định,
 * để hệ thống không bao giờ chạy trong tình trạng "không có trần chi tiêu".
 */
export async function seedDefaultBudget(
  repos: Repositories,
  limitUsd: number,
  warnThreshold: number,
  hardStop: boolean,
): Promise<void> {
  const existing = await repos.budgets.list();
  if (existing.some((policy) => policy.scope === 'GLOBAL' && policy.period === 'MONTH')) return;

  await repos.budgets.upsert({
    scope: 'GLOBAL',
    scopeId: null,
    limitUsd: limitUsd * 10, // trần tháng rộng hơn trần một dự án
    period: 'MONTH',
    warnThreshold,
    hardStop,
  });
}
