/**
 * P&N — Giao việc phải báo đúng thứ còn thiếu (§3.1, §50).
 *
 * Người dùng báo "giao việc mà chẳng thấy gì xảy ra": hệ thống vẫn tạo dự án,
 * agent chạy rồi chết vì chưa có bảng định tuyến, và lý do nằm khuất trong
 * luồng tin nhắn của task. Bộ test này giữ cho lỗi đó luôn hiện ra ngay lúc
 * bấm nút.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, workingProvider, type TestHarness } from './test/fixtures.js';

const API_KEY = 'sk-ant-api03-KHOAGIALAPdungdethuabcdefghijklmn0123456789';

let harness: TestHarness;
let token: string;

beforeAll(async () => {
  harness = await createTestApp();
  token = await harness.loginAsCeo();
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const intake = async (): Promise<ReturnType<TestHarness['app']['inject']>> =>
  harness.app.inject({
    method: 'POST',
    url: '/orchestrator/intake',
    headers: auth(),
    payload: { goal: 'Làm một trang giới thiệu công ty', productType: 'WEB_APPLICATION' },
  });

describe('Chặn giao việc khi chưa đủ điều kiện', () => {
  it('chưa có provider nào thì từ chối kèm chỉ dẫn, không tạo dự án chết', async () => {
    const response = await intake();
    expect(response.statusCode).toBe(409);

    const body = response.json() as { error: string; fix: string; fixPath: string };
    expect(body.error).toContain('nhà cung cấp AI');
    expect(body.fix).toContain('Test Connection');
    expect(body.fixPath).toBe('/settings');

    // Điều quan trọng nhất: không có dự án nào được tạo ra rồi bỏ đó.
    const projects = await harness.app.inject({ method: 'GET', url: '/projects', headers: auth() });
    expect((projects.json() as { projects: unknown[] }).projects).toHaveLength(0);
  });

  it('có provider nhưng chưa có định tuyến thì chỉ đúng vào bước còn thiếu', async () => {
    harness.context.registry.register('anthropic', () => workingProvider());
    harness.context.registry.configure('anthropic', { apiKey: API_KEY });

    const response = await intake();
    expect(response.statusCode).toBe(409);

    const body = response.json() as { error: string; fix: string };
    expect(body.error).toContain('định tuyến');
    expect(body.fix).toContain('Tạo bảng định tuyến mặc định');
  });
});

describe('Test Connection tự tạo bảng định tuyến (§50)', () => {
  it('kết nối thành công lần đầu thì sinh luôn định tuyến cho mọi vai trò', async () => {
    const before = await harness.context.repos.routes.list(harness.context.config.environment);
    expect(before).toHaveLength(0);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-center/providers/anthropic/test',
      headers: auth(),
    });

    const body = response.json() as { ok: boolean; routingSeeded: number | null };
    expect(body.ok).toBe(true);
    expect(body.routingSeeded).toBeGreaterThan(0);

    const after = await harness.context.repos.routes.list(harness.context.config.environment);
    expect(after.some((route) => route.agentRole === 'CTO_ORCHESTRATOR')).toBe(true);
  });

  it('không ghi đè bảng định tuyến người dùng đã sửa', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-center/providers/anthropic/test',
      headers: auth(),
    });
    expect((response.json() as { routingSeeded: number | null }).routingSeeded).toBeNull();
  });
});

describe('Đủ điều kiện thì việc chạy thật', () => {
  it('giao việc tạo được dự án và task, không còn 409', async () => {
    const response = await intake();
    expect(response.statusCode).toBe(201);

    const body = response.json() as { project: { id: string }; tasks: unknown[] };
    expect(body.project.id).toBeTruthy();
    expect(body.tasks.length).toBeGreaterThan(0);
  });
});

describe('Giao việc chạy nền (CTO qua gói Claude mất vài phút, đường hầm cắt sau 100 giây)', () => {
  it('trả lời ngay 202 kèm dự án; hỏi lại /plan tới khi có kế hoạch; autoStart=false thì đứng ở PLANNING', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/orchestrator/intake',
      headers: auth(),
      payload: { goal: 'Làm trò chơi đố vui cho học sinh', productType: 'WEB_APPLICATION', autoStart: false, background: true },
    });
    expect(response.statusCode).toBe(202);
    const opened = response.json() as { project: { id: string; status: string }; planning: boolean };
    expect(opened.planning).toBe(true);
    expect(opened.project.status).toBe('PLANNING');

    let plan: { planning: boolean; plan: string | null; failed: string | null; tasks: Array<{ assignedRole: string | null; status: string }>; project: { status: string } } | null = null;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const polled = await harness.app.inject({ method: 'GET', url: `/projects/${opened.project.id}/plan`, headers: auth() });
      expect(polled.statusCode).toBe(200);
      plan = polled.json() as typeof plan;
      if (!plan!.planning) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(plan!.planning).toBe(false);
    expect(plan!.project.status).toBe('PLANNING');
    // Provider giả trong bộ test không trả kế hoạch hợp lệ nên CTO dừng ở BLOCKED: trang phải nhận được lý do
    // (`failed`) thay vì chờ mãi. Với kế hoạch thật thì `plan` có nội dung và `failed` là null.
    const cto = plan!.tasks.find((task) => task.assignedRole === 'CTO_ORCHESTRATOR');
    expect(cto).toBeTruthy();
    if (cto!.status === 'BLOCKED') expect(plan!.failed).toBeTruthy();
    else expect(plan!.plan).toBeTruthy();
    expect(Boolean(plan!.plan) !== Boolean(plan!.failed)).toBe(true);
  });
});
