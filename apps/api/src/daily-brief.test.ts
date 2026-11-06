import { describe, expect, it } from 'vitest';

import { formatBrief, localClock, type BriefInput } from './services/daily-brief.js';

const report: BriefInput['report'] = {
  generatedAt: '2026-09-20T01:00:00.000Z',
  projects: [
    { id: 'p1', name: 'Website bán hoa', status: 'IN_PROGRESS', done: 3, total: 9, blocked: 1, openBugs: 0, spentUsd: 1.2, budgetUsd: 20 },
    { id: 'p2', name: 'Ứng dụng ghi chú', status: 'ARCHIVED', done: 9, total: 9, blocked: 0, openBugs: 0, spentUsd: 1, budgetUsd: 10 },
  ],
  tasks: { done: 12, blocked: 1, inProgress: 2, total: 18 },
  bugs: { open: 2, critical: 1 },
  security: { open: 0, note: '' },
  deployments: [],
  costs: { todayUsd: 0.4, monthUsd: 15.2, unpricedCalls: 3 },
  risks: ['Một việc bị chặn quá 24 giờ'],
  nextActions: ['Duyệt kiến trúc dự án bán hoa'],
};

describe('bản tin sáng', () => {
  it('nói rõ model hỏng và bao nhiêu tuyến bị ảnh hưởng', () => {
    const text = formatBrief({
      day: '2026-09-20',
      providers: [{ provider: 'openai', routes: 26, ok: false, error: 'OpenAI 429: no credits remaining' }],
      publicApi: { url: 'https://a.trycloudflare.com', ok: true },
      publicWeb: { url: 'https://w.trycloudflare.com', ok: true },
      report,
    });
    expect(text).toContain('<b>openai hỏng</b>');
    expect(text).toContain('26 tuyến');
    expect(text).toContain('no credits');
    expect(text).toContain('Từ ngoài: vào được');
  });

  it('khi ổn thì gọn: model ổn, đường hầm ổn, chỉ dự án đang chạy', () => {
    const text = formatBrief({
      day: '2026-09-20',
      providers: [{ provider: 'google', routes: 26, ok: true, error: null }],
      publicApi: { url: 'https://a.trycloudflare.com', ok: false },
      publicWeb: { url: 'https://w.trycloudflare.com', ok: true },
      report,
    });
    expect(text).toContain('Model: ổn (google 26 tuyến)');
    expect(text).toContain('Từ ngoài: <b>hỏng</b> (API chết, web ok)');
    expect(text).toContain('Website bán hoa — 3/9 việc, <b>1 bị chặn</b>');
    expect(text).not.toContain('Ứng dụng ghi chú');
    expect(text).toContain('3 lượt chưa tính giá');
    expect(text).toContain('Duyệt kiến trúc');
  });

  it('đọc giờ theo múi giờ CEO, không theo máy chủ', () => {
    // 01:30 UTC = 08:30 ở Việt Nam, vẫn là cùng ngày 20/09.
    expect(localClock(new Date('2026-09-20T01:30:00Z'), 'Asia/Ho_Chi_Minh')).toEqual({ day: '2026-09-20', hour: 8 });
    // 18:00 UTC ngày 19 = 01:00 ngày 20 ở Việt Nam.
    expect(localClock(new Date('2026-09-19T18:00:00Z'), 'Asia/Ho_Chi_Minh')).toEqual({ day: '2026-09-20', hour: 1 });
  });
});
