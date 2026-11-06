/**
 * Phiếu chi phí / phát hành còn treo: nhắc CEO mỗi giờ một lần, không hơn.
 */

import { describe, expect, it } from 'vitest';

import type { Approval } from '@pn/shared';

import { REMIND_EVERY_MS, dueReminders, reminderText } from './approval-reminder.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-25T08:00:00Z');

function approval(kind: Approval['kind'], createdAt = T0): Approval {
  return {
    id: `a-${kind}`,
    kind,
    status: 'PENDING',
    projectId: null,
    taskId: null,
    title: 'Cần anh quyết chi phí: thuê máy chủ',
    summary: 'Thuê máy chủ $5/tháng hay chạy trên máy nhà',
    context: {},
    requestedByAgentId: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    expiresAt: null,
    createdAt: new Date(createdAt).toISOString(),
  } as unknown as Approval;
}

describe('nhắc phiếu duyệt', () => {
  it('chưa đủ một giờ thì chưa nhắc; đủ một giờ thì nhắc; vừa nhắc thì đợi thêm một giờ', () => {
    const pending = [approval('BUDGET_INCREASE')];
    const sent = new Map<string, number>();
    expect(dueReminders(pending, sent, T0 + REMIND_EVERY_MS - 1)).toHaveLength(0);
    expect(dueReminders(pending, sent, T0 + HOUR)).toHaveLength(1);
    sent.set('a-BUDGET_INCREASE', T0 + HOUR);
    expect(dueReminders(pending, sent, T0 + HOUR + 30 * 60_000)).toHaveLength(0);
    expect(dueReminders(pending, sent, T0 + 2 * HOUR)).toHaveLength(1);
  });

  it('phiếu kiến thức không nhắc (không làm dự án đứng chờ)', () => {
    expect(dueReminders([approval('KNOWLEDGE_ITEM')], new Map(), T0 + 5 * HOUR)).toHaveLength(0);
    expect(dueReminders([approval('PRODUCTION_DEPLOY')], new Map(), T0 + 5 * HOUR)).toHaveLength(1);
  });

  it('tin nhắc nói đã chờ bao lâu và việc gì, chữ người dùng được thoát HTML', () => {
    const text = reminderText({ ...approval('BUDGET_INCREASE'), title: 'Mua <b>font</b>' } as Approval, 'App hẹn giờ', T0 + 3 * HOUR);
    expect(text).toContain('3 giờ');
    expect(text).toContain('Mua &lt;b&gt;font&lt;/b&gt;');
    expect(text).toContain('📁 App hẹn giờ');
  });
});
