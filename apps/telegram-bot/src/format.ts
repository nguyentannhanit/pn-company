/**
 * P&N — Định dạng tin nhắn gửi CEO.
 *
 * §150.4: mọi phản hồi ký dưới thương hiệu P&N, đọc từ `@pn/shared`.
 * §19: không hàm nào ở đây được nhận secret; dữ liệu vào đây đã qua API và đã
 * được redact ở tầng đó.
 */

import { branding } from '@pn/shared';

/** Escape ký tự HTML vì tin nhắn gửi ở parse_mode HTML. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Biểu tượng trạng thái agent — khớp với §8.1 để CEO đọc nhanh. */
const STATE_ICON: Record<string, string> = {
  idle: '⚪',
  working: '🟢',
  reviewing: '🔵',
  meeting: '🟣',
  blocked: '🟠',
  alert: '🔴',
  completed: '✅',
  celebrate: '🎉',
  offline: '⚫',
};

const TASK_ICON: Record<string, string> = {
  BACKLOG: '📋',
  TODO: '⏳',
  IN_PROGRESS: '🟢',
  REVIEW: '🔍',
  BLOCKED: '🟠',
  DONE: '✅',
  CANCELLED: '⛔',
};

export function header(title: string): string {
  return `<b>${esc(branding.companyName)}</b> — ${esc(title)}`;
}

export function signature(): string {
  return `\n<i>${esc(branding.companyShortName)} · ${esc(branding.companyTagline)}</i>`;
}

/** Tên vai trò như trên trang Tài khoản & quyền, thay cho mã kỹ thuật. */
const ROLE_LABEL: Record<string, string> = {
  CEO: 'Chủ công ty (CEO)',
  CTO: 'Giám đốc kỹ thuật',
  PROJECT_MANAGER: 'Quản lý dự án',
  ACCOUNTANT: 'Kế toán',
  VIEWER: 'Người xem',
};

export function welcome(displayName: string, role: string): string {
  return (
    `${header('Trung tâm điều hành')}\n\n` +
    `Chào ${esc(displayName)}. Bạn đang đăng nhập với vai trò <b>${esc(ROLE_LABEL[role] ?? role)}</b>.\n\n` +
    'Gửi thẳng yêu cầu bằng tiếng Việt là tôi giao việc cho đội, ví dụ:\n' +
    '<i>"Tạo app quản lý quán cafe, có order tại bàn và báo cáo doanh thu"</i>\n\n' +
    'Hoặc dùng lệnh — gõ /help để xem danh sách.' +
    signature()
  );
}

/** Câu trả lời của trợ lý: giữ xuống dòng, escape HTML. */
export function assistantAnswer(text: string): string {
  return esc(text);
}

/** Đề nghị tạo dự án từ một câu của CEO — tạo hay không là nút bên dưới. */
export function projectProposal(name: string, goal: string, productType: string): string {
  const label: Record<string, string> = {
    WEB_APPLICATION: 'ứng dụng web',
    LANDING_PAGE: 'trang đích',
    CORPORATE_WEBSITE: 'website công ty',
    MOBILE_APPLICATION: 'ứng dụng di động',
    DESKTOP_APPLICATION: 'phần mềm máy tính (.exe)',
  };
  return (
    `🧭 Tôi hiểu đây là việc mới: <b>${esc(name)}</b> (${esc(label[productType] ?? productType)}).\n` +
    `<i>${esc(goal)}</i>\n\n` +
    'Tạo dự án và giao cho CTO phân rã chứ?'
  );
}

export function help(): string {
  return (
    `${header('Danh sách lệnh')}\n\n` +
    'Gõ câu hỏi bất kỳ về công ty là tôi trả lời bằng số liệu thật, ví dụ ' +
    '<i>"hôm nay tiêu bao nhiêu?"</i>, <i>"phòng nào đang rảnh?"</i>, <i>"có phiếu nào chờ?"</i>.\n' +
    'Mô tả một sản phẩm muốn làm thì tôi đề nghị tạo dự án, bạn bấm Tạo mới chạy.\n\n' +
    '<b>Dự án</b>\n' +
    '/newproject — tạo dự án mới\n' +
    '/projects — danh sách dự án\n' +
    '/status — tình hình chung\n' +
    '/tasks — task của dự án gần nhất\n' +
    '/bugs — lỗi đang mở\n\n' +
    '<b>Đội ngũ</b>\n' +
    '/agents — trạng thái từng agent\n\n' +
    '<b>Điều hành</b>\n' +
    '/approve — các việc đang chờ bạn duyệt\n' +
    '/reject — từ chối một yêu cầu\n' +
    '/pause — tạm dừng dự án ngay (cắt lượt đang chạy, giữ tiến độ)\n' +
    '/resume — chạy tiếp dự án đang tạm dừng\n' +
    '/huy — dừng hẳn dự án (không tự chạy nữa; làm tiếp bằng "Làm lại dự án" trên web)\n' +
    '/deploy — triển khai\n' +
    '/dashboard — mở dashboard trên điện thoại, đăng nhập sẵn\n\n' +
    '<b>Báo cáo</b>\n' +
    '/cost — chi phí AI\n' +
    '/report — báo cáo tổng hợp\n' +
    '/brief — bản tin sức khoẻ (model, đường hầm, tiền, dự án); tự gửi 8h sáng\n' +
    '/help — bảng này' +
    signature()
  );
}

export function projectCreated(
  project: { name: string; slug: string },
  plan: string,
  taskCount: number,
  attached = 0,
): string {
  return (
    `${header('Đã nhận việc')}\n\n` +
    `📁 <b>${esc(project.name)}</b>\n` +
    (attached > 0 ? `📎 Kèm ${attached} tệp bạn đã gửi.\n` : '') +
    '\n' +
    `<b>Kế hoạch của CTO:</b>\n${esc(plan)}\n\n` +
    `Đã tạo <b>${taskCount}</b> task và đội đang bắt đầu làm.\n` +
    'Gõ /status để theo dõi.' +
    signature()
  );
}

export function projectList(projects: Array<Record<string, unknown>>): string {
  if (projects.length === 0) {
    return `${header('Dự án')}\n\nChưa có dự án nào. Gửi yêu cầu để bắt đầu.${signature()}`;
  }

  const lines = projects.slice(0, 20).map((project, index) => {
    const spent = Number(project['spentUsd'] ?? 0);
    const budget = Number(project['budgetUsd'] ?? 0);
    return (
      `${index + 1}. <b>${esc(String(project['name']))}</b>\n` +
      `   ${esc(String(project['status']))} · $${spent.toFixed(2)}/$${budget.toFixed(2)}`
    );
  });

  return `${header('Dự án')}\n\n${lines.join('\n')}${signature()}`;
}

export function projectStatus(detail: Record<string, unknown>): string {
  const project = detail['project'] as Record<string, unknown>;
  const counts = (detail['taskCounts'] ?? {}) as Record<string, number>;
  const cost = (detail['cost'] ?? {}) as Record<string, number>;
  const budget = detail['budget'] as Record<string, number> | null;
  const bugs = (detail['bugs'] ?? []) as Array<Record<string, unknown>>;

  const taskLine = Object.entries(counts)
    .map(([status, count]) => `${TASK_ICON[status] ?? '•'} ${status}: ${count}`)
    .join('  ');

  const openBugs = bugs.filter((bug) => bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS');

  const lines = [
    header(String(project['name'])),
    '',
    `Trạng thái: <b>${esc(String(project['status']))}</b>`,
    taskLine || 'Chưa có task nào.',
    '',
    `💰 Chi phí: $${Number(cost['costUsd'] ?? 0).toFixed(4)}` +
      (budget ? ` / $${Number(budget['limitUsd']).toFixed(2)} (${Math.round(Number(budget['ratio']) * 100)}%)` : ''),
    `🐞 Lỗi đang mở: ${openBugs.length}`,
  ];

  // §54 — cảnh báo ngân sách hiện ngay trong báo cáo, không đợi CEO tự hỏi.
  if (budget?.['exceeded']) {
    lines.push('', '⚠️ <b>Đã chạm trần ngân sách.</b> Dự án có thể đang bị tạm dừng.');
  } else if (budget?.['warned']) {
    lines.push('', '⚠️ Ngân sách đã dùng quá ngưỡng cảnh báo.');
  }

  return lines.join('\n') + signature();
}

export function agentList(agents: Array<Record<string, unknown>>): string {
  const byDepartment = new Map<string, string[]>();

  for (const agent of agents) {
    const department = String(agent['department']);
    const icon = STATE_ICON[String(agent['state'])] ?? '•';
    const line = `${icon} ${esc(String(agent['displayName']))} — ${esc(String(agent['state']))}`;
    byDepartment.set(department, [...(byDepartment.get(department) ?? []), line]);
  }

  const blocks = [...byDepartment.entries()].map(
    ([department, lines]) => `<b>${esc(department)}</b>\n${lines.join('\n')}`,
  );

  return `${header('Đội ngũ')}\n\n${blocks.join('\n\n')}${signature()}`;
}

export function taskList(tasks: Array<Record<string, unknown>>, projectName: string): string {
  if (tasks.length === 0) {
    return `${header(projectName)}\n\nChưa có task nào.${signature()}`;
  }

  const lines = tasks.slice(0, 25).map((task) => {
    const icon = TASK_ICON[String(task['status'])] ?? '•';
    const role = task['assignedRole'] ? ` · ${esc(String(task['assignedRole']))}` : '';
    return `${icon} ${esc(String(task['title']))}${role}`;
  });

  return `${header(`Công việc — ${projectName}`)}\n\n${lines.join('\n')}${signature()}`;
}

export function bugList(bugs: Array<Record<string, unknown>>): string {
  const open = bugs.filter((bug) => bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS');
  if (open.length === 0) {
    return `${header('Lỗi')}\n\n✅ Không có lỗi nào đang mở.${signature()}`;
  }

  const icon: Record<string, string> = { LOW: '🔵', MEDIUM: '🟡', HIGH: '🟠', CRITICAL: '🔴' };
  const lines = open
    .slice(0, 20)
    .map((bug) => `${icon[String(bug['severity'])] ?? '•'} ${esc(String(bug['title']))}`);

  return `${header('Lỗi đang mở')}\n\n${lines.join('\n')}${signature()}`;
}

export function costReport(summary: Record<string, unknown>): string {
  const today = summary['today'] as Record<string, number>;
  const month = summary['month'] as Record<string, number>;
  const byAgent = (summary['byAgent'] ?? []) as Array<Record<string, unknown>>;

  const top = byAgent
    .slice(0, 5)
    .map((row) => `  ${esc(String(row['label']))}: $${Number(row['costUsd']).toFixed(4)}`)
    .join('\n');

  const lines = [
    header('Chi phí AI'),
    '',
    `Hôm nay: <b>$${Number(today['costUsd']).toFixed(4)}</b> (${today['calls']} lượt gọi)`,
    `Tháng này: <b>$${Number(month['costUsd']).toFixed(4)}</b> (${month['calls']} lượt gọi)`,
  ];

  if (top) lines.push('', '<b>Theo agent</b>', top);

  // Nói rõ phần chưa tính được tiền thay vì báo một con số thiếu (§16).
  if (summary['note']) lines.push('', `ℹ️ ${esc(String(summary['note']))}`);

  return lines.join('\n') + signature();
}

/** §5.2 — thẻ phê duyệt kèm nút bấm. */
export function approvalCard(approval: Record<string, unknown>): string {
  return (
    `⚠️ <b>Cần bạn quyết định</b>\n\n` +
    `<b>${esc(String(approval['title']))}</b>\n\n` +
    `${esc(String(approval['summary']))}` +
    signature()
  );
}

export function healthReport(health: Record<string, unknown>): string {
  const checks = (health['checks'] ?? []) as Array<Record<string, unknown>>;
  const lines = checks.map(
    (check) => `${check['ok'] ? '✅' : '❌'} ${esc(String(check['label']))} — ${esc(String(check['detail']))}`,
  );

  return (
    `${header('Tình trạng hệ thống')}\n\n` +
    `Tổng thể: ${health['ready'] ? '✅ sẵn sàng' : '⚠️ còn thiếu cấu hình'}\n\n` +
    lines.join('\n') +
    signature()
  );
}

export function error(message: string): string {
  return `❌ ${esc(message)}`;
}

/** §38 — báo đã bắt đầu deploy sau khi CEO duyệt ngay trong chat. */
export function deployStarted(result: Record<string, unknown>): string {
  const deployment = (result['deployment'] ?? {}) as Record<string, unknown>;
  const env = String(deployment['environment'] ?? 'PRODUCTION').toLowerCase();
  return (
    `🚀 <b>Đã khởi tạo triển khai ${esc(env)}</b>\n` +
    `Mã: <code>${esc(String(deployment['id'] ?? '?')).slice(0, 8)}</code> · ` +
    `trạng thái ${esc(String(deployment['status'] ?? 'PENDING'))}.\n` +
    'Triển khai hỏng thì tôi sẽ báo lại đây.' +
    signature()
  );
}

/** Tin kèm nút mở dashboard: nói rõ link dùng một lần và hết hạn khi nào. */
export function dashboardLink(expiresInSeconds: number): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return (
    `${header('Mở dashboard')}\n\n` +
    `Bấm nút bên dưới là vào thẳng, không cần gõ mật khẩu. Link dùng một lần, hết hạn sau ${minutes} phút; ` +
    'muốn vào lại thì gõ /dashboard.' +
    signature()
  );
}
