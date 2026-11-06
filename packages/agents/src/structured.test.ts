/**
 * P&N — generateStructured: lượt sửa định dạng phải đi sang model khác, và câu hỏi lệch dạng vẫn đọc được
 * (Quản lý sản phẩm lỗi 4/22 lượt vì Gemini trả options là object, recommended là chữ).
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { AgentGatewayClient, AgentGenerateRequest, AgentGenerateResult } from './gateway-client.js';
import { questionsField } from './questions.js';
import { extractJson, generateStructured } from './structured.js';

function reply(text: string, provider: string, model: string): AgentGenerateResult {
  return { text, provider, model, costUsd: 0.001, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
}

const base: AgentGenerateRequest = { agentRole: 'PRODUCT_MANAGER', system: 's', messages: [{ role: 'user', content: 'x' }] };

describe('generateStructured — lượt sửa né model vừa trả sai', () => {
  it('lần hai báo gateway né đúng model đã trả JSON hỏng ở lần một', async () => {
    const seen: Array<AgentGenerateRequest['avoidModels']> = [];
    const gateway: AgentGatewayClient = {
      async generate(request) {
        seen.push(request.avoidModels);
        return seen.length === 1
          ? reply('không phải JSON', 'google', 'gemini-3.8-flash')
          : reply('{"ok": true}', 'anthropic', 'claude-sonnet-5');
      },
    };
    const result = await generateStructured(gateway, base, z.object({ ok: z.boolean() }), '{ "ok": true }');
    expect(result.repairs).toBe(1);
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual([{ provider: 'google', model: 'gemini-3.8-flash' }]);
  });
});

describe('questionsField — đọc rộng dạng model hay trả lệch', () => {
  it('nhận options là object, khoá "text", recommended là chữ cái', () => {
    const parsed = questionsField.parse([
      {
        text: 'Ứng dụng cần chạy nền khi máy ngủ không?',
        options: [
          { label: 'Có', description: 'Cần quyền quản trị' },
          { label: 'Không' },
        ],
        recommended: 'B',
      },
    ]);
    expect(parsed[0]?.question).toContain('chạy nền');
    expect(parsed[0]?.options).toEqual(['Có — Cần quyền quản trị', 'Không']);
    expect(parsed[0]?.recommended).toBe(1);
  });

  it('recommended là chuỗi số hoặc trùng chữ phương án; số vượt quá thì về 0', () => {
    const make = (recommended: unknown) =>
      questionsField.parse([{ question: 'Chọn kiểu nào đây?', options: ['một', 'hai'], recommended }])[0]?.recommended;
    expect(make('1')).toBe(1);
    expect(make('hai')).toBe(1);
    expect(make(7)).toBe(0);
  });

  it('câu hỏi quên kèm phương án thì điền sẵn hai phương án, không vứt cả lượt', () => {
    const parsed = questionsField.parse([
      { question: 'Màn hình kết quả có cần nút chia sẻ không?' },
      { question: 'Có cần âm thanh không?', options: ['có'], costImpact: false },
      { question: 'Mua gói giọng đọc trả phí không?', costImpact: true },
    ]);
    expect(parsed[0]?.options).toHaveLength(2);
    expect(parsed[1]?.options[0]).toBe('có');
    expect(parsed[1]?.options).toHaveLength(2);
    // Câu hỏi chi phí: phương án đầu là cách tốn tiền, sau là cách không tốn (CEO duyệt = phương án đầu).
    expect(parsed[2]?.options[1]).toContain('không tốn');
  });

  it('dạng chuẩn vẫn qua nguyên vẹn', () => {
    const parsed = questionsField.parse([{ question: 'Có cần đăng nhập không?', why: 'đổi giao diện', options: ['có', 'không'], recommended: 0, costImpact: true }]);
    expect(parsed[0]).toMatchObject({ options: ['có', 'không'], recommended: 0, costImpact: true });
  });
});

describe('extractJson — tài liệu dài bên trong JSON', () => {
  it('không bị cắt bởi ``` nằm trong chuỗi tài liệu', () => {
    const inner = JSON.stringify({ summary: 'ok', document: '# SRS\n\n```ts\nconst a = 1;\n```\n\nHết', questions: [] });
    const doc = 'Tài liệu đây:\n```json\n' + inner + '\n```\n';
    const json = extractJson(doc);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!)).toMatchObject({ summary: 'ok', questions: [] });
  });

  it('bỏ qua ngoặc lạc trong lời dẫn và lấy khối parse được', () => {
    expect(extractJson('Lưu ý {quan trọng}: đây là kết quả {"a":1} xong.')).toBe('{"a":1}');
  });

  it('câu trả lời bị cắt cụt thì trả null', () => {
    expect(extractJson('```json\n{"summary":"x","document":"# SRS rất dài')).toBeNull();
  });
});
