/**
 * Số liệu quan sát: việc kẹt phải kèm lý do tiếng người, và lỗi thô không được
 * lọt khoá API ra ngoài (lỗi nhà cung cấp từng làm lộ key — §89).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { containsSecret } from '@pn/shared';

import { seedAgents } from './services/seed.js';
import { createTestApp, type TestHarness } from './test/fixtures.js';

let harness: TestHarness;
let token: string;
const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const GEMINI_429 =
  'Gemini 429: { "error": { "code": 429, "message": "Quota exceeded for metric: generate_content_free_tier_requests, limit: 5, ' +
  'model: gemini-3.8-flash\\nPlease retry in 25.1s. key=AIzaSyA1234567890abcdefghijklmnopqrstuv" } }';

beforeAll(async () => {
  harness = await createTestApp();
  token = await harness.loginAsCeo();
  const { repos } = harness.context;
  await seedAgents(repos);
  const project = await repos.projects.create({ name: 'Website bán hoa', slug: 'ban-hoa', goal: 'x', productType: 'WEBSITE', budgetUsd: 20 } as never);
  const task = await repos.tasks.create({ projectId: project.id, title: 'Dựng giao diện', description: '', assignedRole: 'FRONTEND_DEVELOPER' } as never);
  await repos.tasks.setStatus(task.id, 'BLOCKED');
  const agent = await repos.agents.findByRole('FRONTEND_DEVELOPER');
  const run = await repos.runs.create({ agentId: agent!.id, taskId: task.id, projectId: project.id });
  await repos.runs.finish(run.id, { status: 'FAILED', errorMessage: GEMINI_429 } as never);
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
});

describe('số liệu quan sát', () => {
  it('việc kẹt kèm lý do đã dịch, không lộ khoá', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/insights/blocked', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(containsSecret(response.body)).toBe(false);
    const [item] = response.json().items;
    expect(item).toMatchObject({
      title: 'Dựng giao diện',
      projectName: 'Website bán hoa',
      role: 'FRONTEND_DEVELOPER',
      failedRuns: 1,
      explained: { kind: 'quota', model: 'gemini-3.8-flash', title: 'Hết lượt gọi model trong phút này' },
    });
  });

  it('số lần bị từ chối đếm theo model', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/insights/refusals?days=7', headers: auth() });
    expect(response.json()).toMatchObject({ total: 1, byModel: [{ model: 'gemini-3.8-flash', kind: 'quota', count: 1 }] });
  });

  it('thành tích nhân viên: một lần lỗi, lỗi gần nhất nói bằng tiếng người', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/insights/agents', headers: auth() });
    const frontend = response.json().agents.find((row: { role: string }) => row.role === 'FRONTEND_DEVELOPER');
    expect(frontend).toMatchObject({ failed: 1, open: 1, done: 0, lastError: 'Hết lượt gọi model trong phút này' });
  });

  it('không có phiên đăng nhập thì từ chối', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/insights/blocked' });
    expect(response.statusCode).toBe(401);
  });
});
