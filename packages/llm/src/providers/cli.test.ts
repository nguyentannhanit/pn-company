/**
 * CLI gói thuê bao: chạy Claude Code / Codex bằng chương trình giả in đúng dạng JSON của bản
 * thật — kiểm đối số, lời nhắn qua stdin, phân loại lỗi, và bí mật của nền tảng không lọt sang CLI.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ModelCatalog } from '../catalog.js';
import { LlmError } from '../types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { Limiter, classifyCliFailure, transcript } from './cli.js';
import { CodexProvider, codexModels, parseCodexModel } from './codex.js';

/** Chương trình giả: đọc stdin + đối số + tệp hướng dẫn (nếu có), trả lời theo `body`. */
async function fakeCli(body: string): Promise<{ file: string; prefixArgs: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pn-fake-cli-'));
  const script = path.join(dir, 'cli.mjs');
  await writeFile(
    script,
    `import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const sysAt = args.indexOf('--system-prompt-file');
const system = sysAt >= 0 ? readFileSync(args[sysAt + 1], 'utf8') : null;
const seen = { args, input, system, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, leaked: process.env.DATABASE_URL ?? null };
${body}
`,
  );
  return { file: process.execPath, prefixArgs: [script] };
}

const catalog = new ModelCatalog();

beforeEach(() => {
  process.env['DATABASE_URL'] = 'postgres://bi-mat';
});
afterEach(() => {
  delete process.env['DATABASE_URL'];
});

describe('ClaudeCodeProvider', () => {
  it('gọi claude -p đúng cờ, hướng dẫn qua tệp, lời nhắn qua stdin, token qua biến môi trường; không lộ bí mật nền tảng', async () => {
    const command = await fakeCli(
      `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(seen), session_id: 's1', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } }));`,
    );
    const provider = new ClaudeCodeProvider({ catalog, command, oauthToken: 'tok-dai-han' });
    const result = await provider.generate({ model: 'sonnet', system: 'Bạn là QA.', messages: [{ role: 'user', content: 'Kiểm thử đi' }], maxOutputTokens: 1000 });
    const seen = JSON.parse(result.text) as { args: string[]; input: string; system: string; token: string | null; leaked: string | null };

    expect(seen.args.slice(0, 9)).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet', '--tools', '', '--no-session-persistence', '--system-prompt-file']);
    expect(seen.system).toBe('Bạn là QA.');
    expect(seen.input).toBe('Kiểm thử đi');
    expect(seen.token).toBe('tok-dai-han');
    expect(seen.leaked).toBeNull();
    expect(result).toMatchObject({ provider: 'claude-code', model: 'sonnet', costUsd: 0, requestId: 's1', usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 3 } });
  });

  it('hết hạn mức gói → quota; phiên đăng nhập hết hạn → auth (để router lùi về API và nhắn CEO)', async () => {
    const limit = await fakeCli(`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 5pm" }));`);
    await expect(new ClaudeCodeProvider({ catalog, command: limit }).generate({ model: 'opus', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'quota', provider: 'claude-code' });

    const expired = await fakeCli(`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }));`);
    await expect(new ClaudeCodeProvider({ catalog, command: expired }).generate({ model: 'opus', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'auth' });
  });

  it('có mức suy nghĩ thì truyền --effort, không để CLI lấy mức trong cài đặt cá nhân của máy', async () => {
    const command = await fakeCli(`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(seen) }));`);
    const result = await new ClaudeCodeProvider({ catalog, command }).generate({ model: 'opus', effort: 'medium', messages: [{ role: 'user', content: 'x' }] });
    const seen = JSON.parse(result.text) as { args: string[] };
    expect(seen.args.slice(seen.args.indexOf('--effort'), seen.args.indexOf('--effort') + 2)).toEqual(['--effort', 'medium']);
  });

  it('lượt đã hết giờ thì không mở tiến trình CLI mới, báo "aborted" để router không thử lại', async () => {
    const mark = path.join(await mkdtemp(path.join(tmpdir(), 'pn-mark-')), 'da-chay');
    const command = await fakeCli(`(await import('node:fs')).writeFileSync(${JSON.stringify(mark)}, 'x'); console.log('{}');`);
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ClaudeCodeProvider({ catalog, command }).generate({ model: 'opus', messages: [{ role: 'user', content: 'x' }], signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted', provider: 'claude-code' });
    await expect(readFile(mark, 'utf8')).rejects.toThrow();
  });

  it('gói ChatGPT hết credit ("workspace is out of credits") là hết hạn mức, không phải lỗi máy chủ', () => {
    expect(classifyCliFailure('Your workspace is out of credits. Ask your workspace owner to refill in order to continue.')).toBe('quota');
  });

  it('chưa cài CLI (không tìm thấy chương trình) → auth, nói rõ lý do', async () => {
    const provider = new ClaudeCodeProvider({ catalog, command: { file: path.join(tmpdir(), 'khong-co-claude.exe'), prefixArgs: [] } });
    const error = await provider.generate({ model: 'haiku', messages: [{ role: 'user', content: 'x' }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ kind: 'auth' });
    expect(String((error as Error).message)).toContain('chưa cài');
  });

  it('danh sách model là ba bí danh opus/sonnet/haiku, giá 0 (trừ vào gói)', async () => {
    const models = await new ClaudeCodeProvider({ catalog }).listModels();
    expect(models.map((model) => [model.id, model.tier, model.pricing?.outputPerMTok])).toEqual([
      ['opus', 'strong', 0],
      ['sonnet', 'medium', 0],
      ['haiku', 'cheap', 0],
    ]);
  });
});

describe('CodexProvider', () => {
  const events = (lines: unknown[]): string => lines.map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`).join('\n');

  it('gọi codex exec --json, chọn model + mức suy nghĩ, hướng dẫn đặt đầu lời nhắn; lấy câu trả lời cuối và token', async () => {
    const command = await fakeCli(
      `process.stderr.write('log linh tinh\\n');\n` +
        events([{ type: 'thread.started' }, { type: 'item.completed', item: { type: 'agent_message', text: 'nháp' } }]) +
        `\nconsole.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(seen) } }));\n` +
        events([{ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }]),
    );
    const result = await new CodexProvider({ catalog, command }).generate({ model: 'gpt-6-astra@high', system: 'Bạn là dev.', messages: [{ role: 'user', content: 'Viết hàm cộng' }] });
    const seen = JSON.parse(result.text) as { args: string[]; input: string; leaked: string | null };

    expect(seen.args).toEqual(expect.arrayContaining(['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="high"']));
    expect(seen.input).toMatch(/^<huong_dan_he_thong>\nBạn là dev.\n<\/huong_dan_he_thong>/);
    expect(seen.input).toContain('Không chạy lệnh');
    expect(seen.input.endsWith('Viết hàm cộng')).toBe(true);
    expect(seen.leaked).toBeNull();
    expect(result).toMatchObject({ provider: 'codex', model: 'gpt-6-astra@high', costUsd: 0, usage: { inputTokens: 60, outputTokens: 7, cachedTokens: 40 } });
  });

  it('tài khoản ChatGPT không được dùng model → invalid_request; hết lượt gói → quota', async () => {
    const unsupported = await fakeCli(
      events([
        { type: 'error', message: JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } }) },
        { type: 'turn.failed', error: { message: JSON.stringify({ error: { message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } }) } },
      ]),
    );
    const error = await new CodexProvider({ catalog, command: unsupported }).generate({ model: 'gpt-6-sol@high', messages: [{ role: 'user', content: 'x' }] }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: 'invalid_request' });
    expect(String((error as Error).message)).toContain("The 'gpt-6-sol' model is not supported");

    const limit = await fakeCli(events([{ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 3 hours." } }]));
    await expect(new CodexProvider({ catalog, command: limit }).generate({ model: 'x@low', messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'quota' });
  });

  it('ba hạng là ba mức suy nghĩ của model mặc định', () => {
    expect(codexModels('gpt-6-astra').map((model) => [model.id, model.tier])).toEqual([
      ['gpt-6-astra@high', 'strong'],
      ['gpt-6-astra@medium', 'medium'],
      ['gpt-6-astra@low', 'cheap'],
    ]);
    expect(parseCodexModel('gpt-6-astra@low')).toEqual({ name: 'gpt-6-astra', effort: 'low' });
    expect(parseCodexModel('gpt-6-astra@la')).toEqual({ name: 'gpt-6-astra', effort: null });
  });
});

describe('phần chung', () => {
  it('gộp hội thoại nhiều lượt, một lượt thì gửi nguyên văn', () => {
    expect(transcript([{ role: 'user', content: 'chào' }])).toBe('chào');
    const many = transcript([
      { role: 'user', content: 'viết JSON' },
      { role: 'assistant', content: 'không phải json' },
      { role: 'user', content: 'sửa lại' },
    ]);
    expect(many).toContain('<nguoi_dung>\nviết JSON\n</nguoi_dung>');
    expect(many).toContain('<tro_ly_luot_truoc>\nkhông phải json\n</tro_ly_luot_truoc>');
    expect(many.endsWith('<nguoi_dung>\nsửa lại\n</nguoi_dung>')).toBe(true);
  });

  it('phân loại câu lỗi thường gặp', () => {
    expect(classifyCliFailure("You've hit your Opus limit")).toBe('quota');
    expect(classifyCliFailure('Please run /login')).toBe('auth');
    expect(classifyCliFailure('API Error: 529 Overloaded')).toBe('overloaded');
    expect(classifyCliFailure('429 Too Many Requests')).toBe('rate_limit');
    expect(classifyCliFailure('segfault')).toBe('server');
  });

  it('giới hạn số lượt chạy cùng lúc', async () => {
    const limiter = new Limiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
