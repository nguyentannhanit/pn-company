/**
 * P&N — Báo cáo cho CEO (§29).
 *
 * Đúng chín mục §29 liệt kê, không thêm không bớt: tiến độ, task xong, task bị
 * chặn, bug, bảo mật, triển khai, chi phí, rủi ro, việc cần làm tiếp.
 *
 * Tách khỏi route vì §29 nói báo cáo "có thể gửi Telegram": cùng một dữ liệu
 * phải ra được hai nơi. Nếu để trong route thì bản gửi Telegram sẽ là một bản
 * dựng lại bằng tay và hai bản sẽ lệch nhau ngay lần sửa đầu tiên.
 */

import type { Repositories } from '@pn/database';
import type { Uuid } from '@pn/shared';

export interface ProjectLine {
  id: Uuid;
  name: string;
  status: string;
  done: number;
  total: number;
  blocked: number;
  openBugs: number;
  spentUsd: number;
  budgetUsd: number;
}

export interface CeoReport {
  generatedAt: string;
  /** §29 Project Progress */
  projects: ProjectLine[];
  /** §29 Tasks Completed / Tasks Blocked, cộng dồn toàn công ty */
  tasks: { done: number; blocked: number; inProgress: number; total: number };
  /** §29 Bugs */
  bugs: { open: number; critical: number };
  /** §29 Security — phát hiện do Security và Red Team báo lên */
  security: { open: number; note: string };
  /** §29 Deploy */
  deployments: Array<{ id: Uuid; environment: string; status: string; createdAt: string }>;
  /** §29 Costs */
  costs: { todayUsd: number; monthUsd: number; unpricedCalls: number };
  /** §29 Risks — thứ đang thật sự chặn công ty lại */
  risks: string[];
  /** §29 Next Actions — việc chỉ CEO làm được */
  nextActions: string[];
}

/** Bug do hai vai trò rà soát báo lên được tính là phát hiện bảo mật (§3.10, §3.11). */
const SECURITY_REPORTERS = new Set(['SECURITY', 'RED_TEAM']);

export async function buildCeoReport(repos: Repositories): Promise<CeoReport> {
  const [allProjects, deployments, today, month, pendingApprovals, agents] = await Promise.all([
    repos.projects.list({}),
    repos.deployments.listRecent(10),
    repos.costs.today(),
    repos.costs.thisMonth(),
    repos.approvals.listPending(),
    repos.agents.list(),
  ]);

  // Dự án đã lưu trữ không còn là việc của hôm nay; đếm cả nó thì báo cáo nói
  // "254 task, 31 xong" trong khi công ty chỉ đang làm một dự án 17 task.
  const projects = allProjects.filter((project) => project.status !== 'ARCHIVED');
  const agentRoleById = new Map(agents.map((agent) => [agent.id, agent.role]));

  const lines: ProjectLine[] = [];
  const totals = { done: 0, blocked: 0, inProgress: 0, total: 0 };
  let openBugs = 0;
  let criticalBugs = 0;
  let securityFindings = 0;

  for (const project of projects) {
    const [counts, bugs] = await Promise.all([
      repos.tasks.countByStatus(project.id),
      repos.bugs.listByProject(project.id),
    ]);

    const done = counts['DONE'] ?? 0;
    const blocked = counts['BLOCKED'] ?? 0;
    const inProgress = counts['IN_PROGRESS'] ?? 0;
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

    const open = bugs.filter((bug) => bug.status === 'OPEN' || bug.status === 'IN_PROGRESS');
    openBugs += open.length;
    criticalBugs += open.filter((bug) => bug.severity === 'CRITICAL').length;
    securityFindings += open.filter((bug) => {
      const role = bug.reportedByAgentId ? agentRoleById.get(bug.reportedByAgentId) : null;
      return role !== null && role !== undefined && SECURITY_REPORTERS.has(role);
    }).length;

    totals.done += done;
    totals.blocked += blocked;
    totals.inProgress += inProgress;
    totals.total += total;

    lines.push({
      id: project.id,
      name: project.name,
      status: project.status,
      done,
      total,
      blocked,
      openBugs: open.length,
      spentUsd: project.spentUsd,
      budgetUsd: project.budgetUsd,
    });
  }

  /* Rủi ro: chỉ nêu thứ đang thật sự chặn, kèm con số. Danh sách rủi ro chung
     chung thì đọc xong không ai làm gì khác đi. */
  const risks: string[] = [];
  if (totals.blocked > 0) risks.push(`${totals.blocked} task đang bị chặn, không tự chạy tiếp được.`);
  if (criticalBugs > 0) risks.push(`${criticalBugs} lỗi mức CRITICAL còn mở.`);
  if (securityFindings > 0) risks.push(`${securityFindings} phát hiện bảo mật chưa xử lý.`);
  for (const project of lines) {
    if (project.budgetUsd > 0 && project.spentUsd / project.budgetUsd >= 0.8) {
      risks.push(
        `Dự án "${project.name}" đã tiêu ${Math.round((project.spentUsd / project.budgetUsd) * 100)}% ngân sách.`,
      );
    }
  }

  const nextActions: string[] = [];
  if (pendingApprovals.length > 0) {
    nextActions.push(
      `Duyệt ${pendingApprovals.length} phiếu đang chờ: ${pendingApprovals
        .slice(0, 3)
        .map((approval) => approval.title)
        .join('; ')}${pendingApprovals.length > 3 ? '…' : ''}`,
    );
  }
  if (totals.blocked > 0) nextActions.push('Xem lý do các task bị chặn trong Bảng công việc.');
  if (today.unpricedCalls > 0) {
    nextActions.push(
      `${today.unpricedCalls} lượt gọi chưa có giá model — vào Cài đặt để điền giá, nếu không chi phí hôm nay bị thiếu.`,
    );
  }
  if (nextActions.length === 0) nextActions.push('Không có việc nào cần CEO quyết ngay.');

  return {
    generatedAt: new Date().toISOString(),
    projects: lines,
    tasks: totals,
    bugs: { open: openBugs, critical: criticalBugs },
    security: {
      open: securityFindings,
      note:
        securityFindings > 0
          ? 'Do Security và Red Team báo lên, đang chờ sửa.'
          : 'Chưa có phát hiện bảo mật nào đang mở.',
    },
    deployments: deployments.map((deployment) => ({
      id: deployment.id,
      environment: deployment.environment,
      status: deployment.status,
      createdAt: deployment.createdAt,
    })),
    costs: {
      todayUsd: today.costUsd,
      monthUsd: month.costUsd,
      unpricedCalls: today.unpricedCalls,
    },
    risks,
    nextActions,
  };
}

/** Bản văn bản thuần để gửi Telegram (§29). Giữ ngắn — Telegram cắt tin dài. */
export function formatReportForTelegram(report: CeoReport): string {
  const lines: string[] = ['*P&N — Báo cáo*', ''];

  if (report.projects.length === 0) {
    lines.push('Chưa có dự án nào.');
  } else {
    lines.push('*Tiến độ dự án*');
    for (const project of report.projects.slice(0, 8)) {
      lines.push(
        `• ${project.name}: ${project.done}/${project.total} task` +
          (project.blocked > 0 ? `, ${project.blocked} bị chặn` : '') +
          (project.openBugs > 0 ? `, ${project.openBugs} lỗi` : ''),
      );
    }
  }

  lines.push(
    '',
    `*Công việc*: ${report.tasks.done} xong · ${report.tasks.inProgress} đang làm · ${report.tasks.blocked} bị chặn`,
    `*Lỗi*: ${report.bugs.open} đang mở (${report.bugs.critical} nghiêm trọng)`,
    `*Bảo mật*: ${report.security.open} phát hiện đang mở`,
    `*Chi phí*: hôm nay $${report.costs.todayUsd.toFixed(2)} · tháng $${report.costs.monthUsd.toFixed(2)}`,
  );

  if (report.risks.length > 0) {
    lines.push('', '*Rủi ro*');
    for (const risk of report.risks) lines.push(`• ${risk}`);
  }

  lines.push('', '*Việc cần làm*');
  for (const action of report.nextActions) lines.push(`• ${action}`);

  return lines.join('\n');
}
