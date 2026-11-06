/**
 * Nút "Dừng dự án": trước đây CEO phải tắt CLI/API bằng tay. Dừng thì không việc nào được xếp nữa,
 * mọi ngả chạy tiếp đều bị từ chối, Tiếp tục thì chạy lại.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from './test/fixtures.js';

let h: TestHarness;
let token: string;

beforeAll(async () => {
  h = await createTestApp();
  token = await h.loginAsCeo();
});
afterAll(async () => {
  await h.app.close();
  await h.context.shutdown();
});

const call = (method: 'POST' | 'PATCH', url: string, payload: unknown = {}) =>
  h.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload });

async function project(status = 'IN_PROGRESS'): Promise<string> {
  const created = await h.context.repos.projects.create({
    name: 'Thử dừng', slug: `thu-dung-${Math.random().toString(36).slice(2, 8)}`, description: 'x',
    productType: 'WEB_APPLICATION', ownerId: null, repoFullName: null, budgetUsd: 20,
  } as never);
  await h.context.repos.projects.updateStatus(created.id, status as never);
  return created.id;
}

describe('dừng / tiếp tục dự án', () => {
  it('dừng: ghi Đã dừng, phát sự kiện, rồi chạy tiếp và chạy lại việc đều bị từ chối', async () => {
    const id = await project();
    const task = await h.context.repos.tasks.create({ projectId: id, title: 'Viết API', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' } as never);

    expect((await call('POST', `/projects/${id}/stop`)).statusCode).toBe(200);
    expect((await h.context.repos.projects.findById(id))?.status).toBe('PAUSED');

    const advance = await call('POST', `/projects/${id}/advance`);
    expect(advance.statusCode).toBe(409);
    expect(advance.json()).toMatchObject({ error: expect.stringContaining('Tiếp tục') });
    expect((await call('POST', `/tasks/${task.id}/run`)).statusCode).toBe(409);
  });

  it('tiếp tục: về đang làm; dự án không dừng thì báo rõ', async () => {
    const id = await project();
    await call('POST', `/projects/${id}/stop`);
    expect((await call('POST', `/projects/${id}/resume`)).statusCode).toBe(200);
    expect((await h.context.repos.projects.findById(id))?.status).toBe('IN_PROGRESS');
    expect((await call('POST', `/projects/${id}/resume`)).statusCode).toBe(409);
  });

  it('dự án đã xong thì không có gì để dừng', async () => {
    const id = await project('COMPLETED');
    expect((await call('POST', `/projects/${id}/stop`)).statusCode).toBe(409);
  });

  it('đổi trạng thái sang PAUSED bằng PATCH cũng đi qua bộ điều phối (không chỉ đổi nhãn)', async () => {
    const id = await project();
    const task = await h.context.repos.tasks.create({ projectId: id, title: 'Chờ lượt', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' } as never);
    await h.context.repos.tasks.setStatus(task.id, 'IN_PROGRESS');
    await call('PATCH', `/projects/${id}/status`, { status: 'PAUSED' });
    expect((await h.context.repos.tasks.findById(task.id))?.status).toBe('TODO');
  });
});
