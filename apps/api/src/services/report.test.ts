/**
 * §29 — báo cáo CEO phải nói đúng thứ đang chặn công ty, và phải im lặng khi
 * không có gì chặn. Một danh sách rủi ro luôn có sáu dòng thì đọc xong không ai
 * làm gì khác đi.
 */

import { describe, expect, it } from 'vitest';

import type { Repositories } from '@pn/database';

import { buildCeoReport, formatReportForTelegram } from './report.js';

interface Fixture {
  taskCounts?: Record<string, number>;
  bugs?: Array<{ status: string; severity: string; reportedByAgentId: string | null }>;
  spentUsd?: number;
  budgetUsd?: number;
  pendingApprovals?: Array<{ title: string }>;
  unpricedCalls?: number;
}

/** Repo giả tối thiểu: chỉ những hàm mà `buildCeoReport` thật sự gọi. */
function fakeRepos(fixture: Fixture = {}): Repositories {
  return {
    projects: {
      async list() {
        return [
          {
            id: 'p1',
            name: 'Dự án thử',
            status: 'IN_PROGRESS',
            spentUsd: fixture.spentUsd ?? 0,
            budgetUsd: fixture.budgetUsd ?? 100,
          },
        ];
      },
    },
    tasks: {
      async countByStatus() {
        return fixture.taskCounts ?? {};
      },
    },
    bugs: {
      async listByProject() {
        return fixture.bugs ?? [];
      },
    },
    deployments: {
      async listRecent() {
        return [];
      },
    },
    costs: {
      async today() {
        return { costUsd: 1.5, calls: 10, unpricedCalls: fixture.unpricedCalls ?? 0 };
      },
      async thisMonth() {
        return { costUsd: 12, calls: 100, unpricedCalls: 0 };
      },
    },
    approvals: {
      async listPending() {
        return fixture.pendingApprovals ?? [];
      },
    },
    agents: {
      async list() {
        return [
          { id: 'a-sec', role: 'SECURITY' },
          { id: 'a-dev', role: 'BACKEND_DEVELOPER' },
        ];
      },
    },
  } as unknown as Repositories;
}

describe('báo cáo CEO (§29)', () => {
  it('cộng dồn task theo trạng thái của mọi dự án', async () => {
    const report = await buildCeoReport(
      fakeRepos({ taskCounts: { DONE: 4, BLOCKED: 2, IN_PROGRESS: 1 } }),
    );

    expect(report.tasks).toEqual({ done: 4, blocked: 2, inProgress: 1, total: 7 });
    expect(report.projects[0]!.done).toBe(4);
  });

  it('không nêu rủi ro nào khi không có gì đang chặn', async () => {
    const report = await buildCeoReport(fakeRepos({ taskCounts: { DONE: 3 } }));

    expect(report.risks).toEqual([]);
    expect(report.nextActions).toEqual(['Không có việc nào cần CEO quyết ngay.']);
  });

  it('nêu task bị chặn, lỗi nghiêm trọng và ngân sách sắp cạn thành rủi ro', async () => {
    const report = await buildCeoReport(
      fakeRepos({
        taskCounts: { BLOCKED: 3 },
        bugs: [{ status: 'OPEN', severity: 'CRITICAL', reportedByAgentId: 'a-dev' }],
        spentUsd: 85,
        budgetUsd: 100,
      }),
    );

    expect(report.risks).toHaveLength(3);
    expect(report.risks.join(' ')).toContain('3 task đang bị chặn');
    expect(report.risks.join(' ')).toContain('1 lỗi mức CRITICAL');
    expect(report.risks.join(' ')).toContain('85% ngân sách');
  });

  it('chỉ tính là phát hiện bảo mật khi người báo là Security hoặc Red Team (§3.10, §3.11)', async () => {
    const report = await buildCeoReport(
      fakeRepos({
        bugs: [
          { status: 'OPEN', severity: 'HIGH', reportedByAgentId: 'a-sec' },
          { status: 'OPEN', severity: 'HIGH', reportedByAgentId: 'a-dev' },
        ],
      }),
    );

    expect(report.bugs.open).toBe(2);
    expect(report.security.open).toBe(1);
  });

  it('không tính lỗi đã đóng vào số đang mở', async () => {
    const report = await buildCeoReport(
      fakeRepos({ bugs: [{ status: 'RESOLVED', severity: 'CRITICAL', reportedByAgentId: 'a-dev' }] }),
    );

    expect(report.bugs.open).toBe(0);
    expect(report.risks).toEqual([]);
  });

  it('nhắc CEO duyệt phiếu đang chờ và điền giá model còn thiếu', async () => {
    const report = await buildCeoReport(
      fakeRepos({ pendingApprovals: [{ title: 'Duyệt kiến trúc' }], unpricedCalls: 5 }),
    );

    expect(report.nextActions[0]).toContain('Duyệt kiến trúc');
    expect(report.nextActions.join(' ')).toContain('5 lượt gọi chưa có giá model');
  });

  it('bản gửi Telegram chứa đủ các mục §29', async () => {
    const text = formatReportForTelegram(
      await buildCeoReport(fakeRepos({ taskCounts: { DONE: 1, BLOCKED: 1 } })),
    );

    for (const heading of ['Tiến độ dự án', 'Công việc', 'Lỗi', 'Bảo mật', 'Chi phí', 'Việc cần làm']) {
      expect(text).toContain(heading);
    }
  });
});
