/**
 * Phòng rà soát (Bảo mật…) phải đọc được mã thật. Từng có dự án mà danh sách file xếp ABC, gặp
 * package-lock.json 160 KB là vượt trần và dừng đọc — Bảo mật chỉ thấy ghi chú tiến độ, sáu lượt liền báo
 * "thiếu src/main.ts, package.json" trong khi file có thật.
 */

import { describe, expect, it } from 'vitest';

import type { AgentContext } from './contract.js';
import { ReviewAgent } from './roles.js';

function fakeContext(files: Record<string, string>) {
  const requests: string[] = [];
  const sandbox = {
    async listFiles() {
      return Object.keys(files).sort();
    },
    async readFile(path: string) {
      if (!(path in files)) throw new Error('không có');
      return files[path]!;
    },
  };
  const gateway = {
    async generate(request: { messages: Array<{ content: string }> }) {
      requests.push(request.messages.map((message) => message.content).join('\n'));
      const reply = { passed: true, summary: 'ổn', bugs: [] };
      return { text: JSON.stringify(reply), provider: 't', model: 't', costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    },
  };
  const context = {
    runId: 'r', agentId: 'a', projectId: 'p', taskId: 't', project: null, task: null,
    gateway, sandbox, history: [], priorWork: [], allowedRoles: [], knowledge: [],
    signal: new AbortController().signal,
  } as unknown as AgentContext;
  return { context, requests };
}

describe('ReviewAgent đọc mã nguồn', () => {
  it('file khoá phụ thuộc khổng lồ không chặn việc đọc src/, package.json, index.html', async () => {
    const fake = fakeContext({
      '.pn/tien-do/abc.json': '{"conLai":["src/main.ts"]}',
      'package-lock.json': 'x'.repeat(160_000),
      'package.json': '{"name":"hoccuuchuong"}',
      'src/main.ts': 'new BrowserWindow({ webPreferences: { contextIsolation: true } })',
      'src/preload.ts': 'contextBridge.exposeInMainWorld("gameApi", {})',
      'src/renderer/index.html': '<meta http-equiv="Content-Security-Policy">',
    });
    await new ReviewAgent('SECURITY').run(fake.context);

    const prompt = fake.requests[0]!;
    expect(prompt).toContain('--- package.json ---');
    expect(prompt).toContain('contextIsolation: true');
    expect(prompt).toContain('exposeInMainWorld');
    expect(prompt).toContain('Content-Security-Policy');
    expect(prompt).not.toContain('x'.repeat(1000));
    expect(prompt).not.toContain('conLai');
  });

  it('hết chỗ thì cắt bớt và liệt kê tên file còn lại, không dừng đọc giữa chừng', async () => {
    const files: Record<string, string> = { 'package.json': '{}' };
    for (let index = 0; index < 30; index += 1) files[`src/ui/screen-${index}.ts`] = `// màn ${index}\n${'y'.repeat(9_000)}`;
    files['src/zz-preload.ts'] = 'contextBridge.exposeInMainWorld("api", {})';
    const fake = fakeContext(files);
    await new ReviewAgent('SECURITY').run(fake.context);

    const prompt = fake.requests[0]!;
    // Preload là ranh giới bảo mật — được đọc trước dù tên xếp cuối.
    expect(prompt).toContain('exposeInMainWorld');
    // File không vừa chỗ vẫn được nêu tên để model không kết luận là "thiếu".
    expect(prompt).toContain('src/ui/screen-29.ts');
    expect(prompt.length).toBeLessThan(200_000);
  });
});
