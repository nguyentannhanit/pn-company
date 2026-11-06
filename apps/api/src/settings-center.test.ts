/**
 * P&N — Kiểm các route của Cài đặt bản 4: thứ tự hãng + phân bổ model phải ghi đúng vào bảng định tuyến
 * thật (không chỉ lưu cho đẹp), nhật ký lọc được dòng bot lặp, và các số tổng trả đúng dạng.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, workingProvider, type TestHarness } from './test/fixtures.js';

let harness: TestHarness;
let token: string;

beforeAll(async () => {
  harness = await createTestApp();
  token = await harness.loginAsCeo();
  // Hai hãng dùng được để thấy rõ thứ tự chính / dự phòng.
  for (const id of ['anthropic', 'google'] as const) {
    harness.context.registry.register(id, () => workingProvider());
    harness.context.registry.configure(id, { apiKey: `sk-test-${id}-khong-phai-key-that-0123456789` });
  }
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });
const route = async (role: string): Promise<Record<string, unknown> | null> =>
  (await harness.context.repos.routes.find(role as never, harness.context.config.environment)) as Record<string, unknown> | null;

describe('Thứ tự hãng và phân bổ model', () => {
  it('trả trạng thái đủ cho trang: thứ tự 5 hãng, kế hoạch 26 vai trò, hãng dùng được', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api-center/allocation', headers: auth() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { order: string[]; mode: string; combo: string; plans: Record<string, unknown>; usable: string[]; providers: unknown[] };
    expect(body.order).toHaveLength(5);
    expect(body.mode).toBe('auto');
    expect(body.combo).toBe('balanced');
    expect(Object.keys(body.plans)).toHaveLength(26);
    expect(body.usable.sort()).toEqual(['anthropic', 'google']);
    expect(body.providers).toHaveLength(5);
  });

  it('đổi thứ tự thì hãng đứng trước thành hãng chính, hãng sau thành dự phòng', async () => {
    let response = await harness.app.inject({ method: 'PUT', url: '/api-center/allocation', headers: auth(), payload: { order: ['google', 'anthropic'] } });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { written: number }).written).toBe(26);
    let cto = await route('CTO_ORCHESTRATOR');
    expect(cto?.['provider']).toBe('google');
    expect((cto?.['fallbacks'] as Array<{ provider: string }>)[0]?.provider).toBe('anthropic');

    response = await harness.app.inject({ method: 'PUT', url: '/api-center/allocation', headers: auth(), payload: { order: ['anthropic', 'google'] } });
    cto = await route('CTO_ORCHESTRATOR');
    expect(cto?.['provider']).toBe('anthropic');
    expect((response.json() as { order: string[] }).order.slice(0, 2)).toEqual(['anthropic', 'google']);
  });

  it('combo Tốc độ ghi bậc thấp hơn một nấc; Chất lượng đặt router sang quality', async () => {
    await harness.app.inject({ method: 'PUT', url: '/api-center/allocation', headers: auth(), payload: { combo: 'speed' } });
    expect((await route('CTO_ORCHESTRATOR'))?.['tier']).toBe('medium');
    expect((await route('GITHUB_SCOUT'))?.['tier']).toBe('cheap');
    expect(await harness.context.repos.settings.get('routing.mode')).toBe('balanced');

    await harness.app.inject({ method: 'PUT', url: '/api-center/allocation', headers: auth(), payload: { combo: 'quality' } });
    expect((await route('GITHUB_SCOUT'))?.['tier']).toBe('strong');
    expect(await harness.context.repos.settings.get('routing.mode')).toBe('quality');
  });

  it('thủ công: vai trò chọn tay dùng đúng hãng đã chọn, vai trò khác theo thứ tự chung', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/allocation',
      headers: auth(),
      payload: { combo: 'balanced', mode: 'manual', overrides: { QA: { provider: 'google', tier: 'strong' } } },
    });
    expect(response.statusCode).toBe(200);
    expect((await route('QA'))?.['provider']).toBe('google');
    expect((await route('QA'))?.['tier']).toBe('strong');
    expect((await route('PRODUCT_MANAGER'))?.['provider']).toBe('anthropic');
  });

  it('từ chối hãng hoặc combo không có thật', async () => {
    const bad = await harness.app.inject({ method: 'PUT', url: '/api-center/allocation', headers: auth(), payload: { combo: 'sieu-re' } });
    expect(bad.statusCode).toBe(400);
  });

  it('Phân tích lại ghi lại bảng và lưu thời điểm + lý do', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/api-center/allocation/analyze', headers: auth() });
    const body = response.json() as { written: number; analyzedAt: string | null; trigger: string | null };
    expect(body.written).toBe(26);
    expect(body.analyzedAt).not.toBeNull();
    expect(body.trigger).toBe('CEO bấm Phân tích lại');
  });
});

describe('Nhật ký và số tổng', () => {
  it('lọc bỏ dòng bot lấy cấu hình khi trang yêu cầu', async () => {
    await harness.context.repos.audit.record({ actor: 'system', action: 'TELEGRAM_BOOTSTRAP', targetType: 'telegram' });
    const all = (await harness.app.inject({ method: 'GET', url: '/audit?limit=500', headers: auth() })).json() as { entries: Array<{ action: string }> };
    const clean = (await harness.app.inject({ method: 'GET', url: '/audit?limit=500&excludeNoise=true', headers: auth() })).json() as { entries: Array<{ action: string }> };
    expect(all.entries.some((entry) => entry.action === 'TELEGRAM_BOOTSTRAP')).toBe(true);
    expect(clean.entries.some((entry) => entry.action === 'TELEGRAM_BOOTSTRAP')).toBe(false);

    const stats = (await harness.app.inject({ method: 'GET', url: '/audit/stats', headers: auth() })).json() as { total: number; noise: number };
    expect(stats.noise).toBeGreaterThanOrEqual(1);
    expect(stats.total).toBeGreaterThan(stats.noise);
  });

  it('trang Ngân sách và thanh thẻ nhận đủ dạng dữ liệu', async () => {
    const budget = await harness.app.inject({ method: 'GET', url: '/api-center/budget-overview', headers: auth() });
    expect(budget.statusCode).toBe(200);
    expect(Object.keys(budget.json() as object)).toEqual(expect.arrayContaining(['month', 'globalMonth', 'policies', 'projects', 'countFrom']));

    const summary = (await harness.app.inject({ method: 'GET', url: '/api-center/settings-summary', headers: auth() })).json() as {
      ai: { usable: number; total: number };
      integrations: { total: number };
    };
    expect(summary.ai).toEqual({ usable: 2, total: 5 });
    // 10 loại ngoài Nguồn AI.
    expect(summary.integrations.total).toBe(10);
  });
});
