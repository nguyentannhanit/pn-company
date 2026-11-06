/**
 * §5.1, §57 — trợ lý điều hành: hỏi thì trả lời từ số liệu thật, yêu cầu làm
 * sản phẩm thì đề nghị tạo dự án chứ không tự tạo.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LLMProvider } from '@pn/llm';

import { parseAssistantReply } from './routes/assistant.js';
import { seedRouting } from './routes/api-center.js';
import { createTestApp, type TestHarness } from './test/fixtures.js';

let harness: TestHarness;
let token: string;
let lastPrompt = '';
let nextReply = '{"intent":"answer","text":"Hôm nay $2.24, tháng này $3.80."}';

function scriptedProvider(): LLMProvider {
  return {
    id: 'anthropic',
    displayName: 'giả lập',
    async generate(request: { messages: Array<{ content: string }> }) {
      lastPrompt = request.messages.map((message) => message.content).join('\n');
      return { text: nextReply, model: 'claude-sonnet-5', provider: 'anthropic', usage: { inputTokens: 5, outputTokens: 5 }, finishReason: 'stop' };
    },
    async *stream() {},
    estimateCost: () => 0,
    async listModels() {
      return [{ id: 'claude-sonnet-5', displayName: 'Sonnet 5' }];
    },
    async testConnection() {
      return { ok: true, latencyMs: 1, model: 'claude-sonnet-5', error: null, checkedAt: new Date().toISOString() };
    },
  } as unknown as LLMProvider;
}

beforeAll(async () => {
  harness = await createTestApp();
  token = await harness.loginAsCeo();
  harness.context.registry.register('anthropic', () => scriptedProvider());
  harness.context.registry.configure('anthropic', { apiKey: 'sk-ant-test' });
  await seedRouting(harness.context, 'anthropic');
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
});

describe('parseAssistantReply', () => {
  it('JSON trả lời → answer; JSON dự án → project với loại hợp lệ; chữ thường → answer nguyên văn', () => {
    expect(parseAssistantReply('{"intent":"answer","text":"Rảnh 11/13 phòng."}')).toEqual({ intent: 'answer', text: 'Rảnh 11/13 phòng.' });
    expect(parseAssistantReply('Đây là JSON: {"intent":"project","name":"Đặt lịch","goal":"Web đặt lịch cắt tóc","productType":"WEB_APPLICATION"}')).toEqual({
      intent: 'project', name: 'Đặt lịch', goal: 'Web đặt lịch cắt tóc', productType: 'WEB_APPLICATION',
    });
    expect(parseAssistantReply('{"intent":"project","goal":"App exe","productType":"LINH_TINH"}').intent === 'project' &&
      (parseAssistantReply('{"intent":"project","goal":"App exe","productType":"LINH_TINH"}') as { productType: string }).productType).toBe('WEB_APPLICATION');
    expect(parseAssistantReply('Hôm nay tiêu $2.')).toEqual({ intent: 'answer', text: 'Hôm nay tiêu $2.' });
  });
});

describe('POST /assistant/ask', () => {
  it('đưa snapshot công ty cho model và trả câu trả lời', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/assistant/ask',
      headers: { authorization: `Bearer ${token}` },
      payload: { question: 'Hôm nay tiêu bao nhiêu?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ intent: 'answer', text: 'Hôm nay $2.24, tháng này $3.80.' });
    expect(lastPrompt).toContain('SNAPSHOT');
    expect(lastPrompt).toContain('chiPhi');
    expect(lastPrompt).toContain('Hôm nay tiêu bao nhiêu?');
  });

  it('yêu cầu làm sản phẩm thì trả về đề nghị tạo dự án, không tự tạo', async () => {
    nextReply = '{"intent":"project","name":"Đặt lịch cắt tóc","goal":"Web đặt lịch cắt tóc có chọn giờ","productType":"WEB_APPLICATION"}';
    const response = await harness.app.inject({
      method: 'POST',
      url: '/assistant/ask',
      headers: { authorization: `Bearer ${token}` },
      payload: { question: 'Làm web đặt lịch cắt tóc có chọn giờ' },
    });
    expect(response.json()).toMatchObject({ intent: 'project', productType: 'WEB_APPLICATION' });
    const projects = await harness.app.inject({ method: 'GET', url: '/projects', headers: { authorization: `Bearer ${token}` } });
    expect((projects.json() as { projects: unknown[] }).projects).toHaveLength(0);
  });

  it('chưa đăng nhập thì 401', async () => {
    const response = await harness.app.inject({ method: 'POST', url: '/assistant/ask', payload: { question: 'x' } });
    expect(response.statusCode).toBe(401);
  });
});
