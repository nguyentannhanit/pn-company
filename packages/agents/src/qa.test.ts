/**
 * §3.9, §144 — QA nghiệm thu bản dựng thật: có script build thì phải dựng
 * được, và giao diện dựng ra được đưa cho QA đối chiếu với thiết kế.
 */

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentContext } from './contract.js';
import { QaAgent } from './roles.js';

function fakeContext(
  files: Record<string, string>,
  exitCodes: Record<string, number>,
  reply: Record<string, unknown>,
  priorWork: AgentContext['priorWork'] = [],
) {
  const execs: string[] = [];
  const requests: string[] = [];
  const sandbox = {
    async listFiles() {
      return Object.keys(files);
    },
    async readFile(path: string) {
      if (!(path in files)) throw new Error('không có');
      return files[path]!;
    },
    async writeFile() {},
    async exec(command: string, args: string[] = []) {
      const line = [command, ...args].join(' ');
      execs.push(line);
      const key = Object.keys(exitCodes).find((prefix) => line.startsWith(prefix));
      const exitCode = key ? exitCodes[key]! : 0;
      return { command: line, exitCode, stdout: exitCode ? 'not ok' : 'ok', stderr: '', timedOut: false, durationMs: 1 };
    },
  };
  const gateway = {
    async generate(request: { messages: Array<{ content: string }> }) {
      requests.push(request.messages.map((message) => message.content).join('\n'));
      return { text: JSON.stringify(reply), provider: 't', model: 't', costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } };
    },
  };
  const context = {
    runId: 'r', agentId: 'a', projectId: 'p', taskId: 't', project: null, task: null,
    gateway, sandbox, history: [], priorWork, allowedRoles: [], knowledge: [],
    signal: new AbortController().signal,
  } as unknown as AgentContext;
  return { context, execs, requests };
}

const pkg = JSON.stringify({ scripts: { test: 'node --test', build: 'vite build' } });

describe('QaAgent nghiệm thu bản dựng', () => {
  it('có script build thì dựng, và đưa trang + CSS + thiết kế cho model đối chiếu', async () => {
    const fake = fakeContext(
      { 'package.json': pkg, 'index.html': '<h1 class="calc">Máy tính</h1>', 'src/styles.css': '.calc{color:blue}' },
      {},
      { passed: true, summary: 'ổn', bugs: [] },
      [{ role: 'UIUX_DESIGNER', title: 'Thiết kế', summary: 'Màu xanh, phím tròn' }],
    );
    const outcome = await new QaAgent().run(fake.context);

    expect(fake.execs).toEqual(['npm install --no-audit --no-fund --dangerously-allow-all-scripts', 'npm test --silent', 'npm run build --silent']);
    expect(fake.requests[0]).toContain('KẾT QUẢ DỰNG');
    expect(fake.requests[0]).toContain('GIAO DIỆN ĐÃ DỰNG');
    expect(fake.requests[0]).toContain('.calc{color:blue}');
    expect(fake.requests[0]).toContain('Màu xanh, phím tròn');
    expect(outcome.summary).toContain('Đạt');
  });

  it('dựng lỗi thì không đạt dù model nói đạt, và có bug nói rõ', async () => {
    const fake = fakeContext(
      { 'package.json': pkg, 'index.html': '<p>x</p>' },
      { 'npm run build': 1 },
      { passed: true, summary: 'trông ổn', bugs: [] },
    );
    const outcome = await new QaAgent().run(fake.context);
    expect(outcome.summary).toContain('Không đạt');
    expect(outcome.reportedBugs?.map((bug) => bug.title)).toContain('Bản dựng (npm run build) lỗi');
  });

  it('chạy thử thật có lỗi thì không đạt dù test xanh và model nói đạt; bằng chứng chạy thử đưa cho model', async () => {
    const fake = fakeContext(
      { 'package.json': pkg, 'index.html': '<p>x</p>' },
      {},
      { passed: true, summary: 'trông ổn', bugs: [] },
    );
    (fake.context.sandbox as { workspace?: string }).workspace = 'D:/ws/ghi-chu';
    const seen: string[] = [];
    const agent = new QaAgent({
      probe: async (workspace, shotDir) => {
        seen.push(workspace, shotDir);
        return {
          kind: 'web',
          ok: false,
          pages: [{ url: 'http://127.0.0.1:1/', title: 'Ghi chú', interactive: 4, textLength: 20, clicked: ['Cộng'], problems: ['Lỗi JavaScript: ReferenceError: tinh is not defined'] }],
          screenshots: [],
          detail: 'Trang 1: … LỖI: ReferenceError: tinh is not defined',
        };
      },
    });
    const outcome = await agent.run(fake.context);

    expect(seen).toEqual(['D:/ws/ghi-chu', path.join('D:/ws', '_anh-san-pham', 'ghi-chu')]);
    expect(fake.requests[0]).toContain('CHẠY THỬ SẢN PHẨM THẬT (trình duyệt): CÓ LỖI');
    expect(fake.requests[0]).toContain('tinh is not defined');
    expect(outcome.summary).toContain('Không đạt');
    expect(outcome.reportedBugs?.map((bug) => bug.title)).toContain('Trang web có lỗi khi chạy thử trong trình duyệt');
  });

  it('máy không có trình duyệt (bỏ qua chạy thử) thì vẫn đạt theo test và dựng', async () => {
    const fake = fakeContext({ 'package.json': pkg, 'index.html': '<p>x</p>' }, {}, { passed: true, summary: 'ổn', bugs: [] });
    (fake.context.sandbox as { workspace?: string }).workspace = 'D:/ws/ghi-chu';
    const agent = new QaAgent({ probe: async () => ({ kind: 'web', ok: true, skipped: true, pages: [], screenshots: [], detail: 'Bỏ qua' }) });
    const outcome = await agent.run(fake.context);
    expect(fake.requests[0]).toContain('BỎ QUA');
    expect(outcome.summary).toContain('Đạt');
  });

  it('không có script build thì không dựng, vẫn nghiệm thu như cũ', async () => {
    const fake = fakeContext(
      { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'index.html': '<p>x</p>' },
      {},
      { passed: true, summary: 'ok', bugs: [] },
    );
    const outcome = await new QaAgent().run(fake.context);
    expect(fake.execs).toEqual(['npm install --no-audit --no-fund --dangerously-allow-all-scripts', 'npm test --silent']);
    expect(outcome.summary).toContain('Đạt');
  });
});
