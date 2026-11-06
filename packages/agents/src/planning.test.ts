/**
 * Phòng lập kế hoạch viết TÀI LIỆU đầy đủ vào docs/ của dự án: trước đó
 * nội dung nằm trong mô tả task đề xuất rồi bị vứt, dev chỉ thấy 303 ký tự.
 */

import { describe, expect, it } from 'vitest';

import type { AgentContext } from './contract.js';
import { PlanningAgent } from './roles.js';

/** Ngữ cảnh giả: workspace trong bộ nhớ, model trả về đúng câu cho sẵn. */
function fakeContext(reply: string) {
  const written = new Map<string, string>();
  const requests: string[] = [];
  const context = {
    runId: 'r1', agentId: 'a1', projectId: 'p1', taskId: 't1', project: null, task: null,
    gateway: {
      async generate(request: { messages: Array<{ content: string }> }) {
        requests.push(request.messages.map((message) => message.content).join('\n'));
        return { text: reply, provider: 'test', model: 'test', costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
      },
    },
    sandbox: {
      async readFile(path: string) {
        const content = written.get(path);
        if (content === undefined) throw new Error('không có');
        return content;
      },
      async writeFile(path: string, content: string) {
        written.set(path, content);
      },
    },
    history: [], priorWork: [], documents: [], allowedRoles: [], knowledge: [],
    signal: new AbortController().signal,
  } as unknown as AgentContext;
  return { context, written, requests };
}

describe('phòng lập kế hoạch viết tài liệu', () => {
  it('Thiết kế ghi docs/thiet-ke.md nguyên văn, tóm tắt trỏ tới file, không đề xuất task nào', async () => {
    const document = '# Thiết kế giao diện\n## Hệ thống thiết kế\n' + 'Màu nhấn #4b4fb8. '.repeat(30);
    const fake = fakeContext(JSON.stringify({ summary: 'Ba màn hình chính.', document, risks: [], needsCeoDecision: null }));

    const outcome = await new PlanningAgent('UIUX_DESIGNER').run(fake.context);

    expect(fake.written.get('docs/thiet-ke.md')).toBe(document.trim() + '\n');
    expect(outcome.summary).toContain('docs/thiet-ke.md');
    expect(outcome.producedFiles?.[0]?.path).toBe('docs/thiet-ke.md');
    expect(outcome.proposedTasks).toBeUndefined();
    // Được đưa mẫu tài liệu của phòng mình.
    expect(fake.requests[0]).toContain('Hệ thống thiết kế');
  });

  it('Phân tích viết yêu cầu có tiêu chí nghiệm thu vào docs/yeu-cau.md', async () => {
    const document = '# Yêu cầu\n## Yêu cầu chức năng\nYC-01: Cho… Khi… Thì… '.repeat(20);
    const fake = fakeContext(JSON.stringify({ summary: 'Mười yêu cầu.', document }));
    await new PlanningAgent('BUSINESS_ANALYST').run(fake.context);
    expect(fake.written.get('docs/yeu-cau.md')).toContain('YC-01');
    expect(fake.requests[0]).toContain('Cho… Khi… Thì…');
  });
});
