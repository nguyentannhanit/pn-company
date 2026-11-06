/**
 * P&N — Claude qua Claude Code CLI, đăng nhập bằng gói Claude Pro/Max.
 *
 * `claude -p` chạy trên máy CEO cho việc của CEO là cách dùng Anthropic cho phép và trừ vào hạn mức
 * gói (code.claude.com/docs/en/legal-and-compliance; support.claude.com bài "Use the Claude Agent SDK
 * with your Claude plan", cập nhật 16/06/2026). Mỗi lượt gọi: thư mục trống, tắt mọi công cụ (chỉ trả
 * lời văn bản), không lưu phiên, hướng dẫn hệ thống qua tệp (tránh trần độ dài dòng lệnh Windows),
 * lời nhắn qua stdin. Máy chạy liên tục nên dùng token dài hạn từ `claude setup-token` (truyền qua
 * CLAUDE_CODE_OAUTH_TOKEN); không có thì CLI dùng phiên đăng nhập sẵn trên máy.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import type { ModelCatalog } from '../catalog.js';
import {
  LlmError,
  type ConnectionTestResult,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ModelInfo,
  type StreamChunk,
} from '../types.js';
import { classifyCliFailure, cliEnv, cliError, Limiter, runCli, transcript, withWorkDir, writeText, type CliCommand, type CliRun } from './cli.js';

const LABEL = 'Claude (gói)';

/** Ba model qua bí danh của Claude Code: luôn trỏ bản mới nhất gói được dùng, không vỡ khi Anthropic ra bản mới. */
export const CLAUDE_CODE_MODELS: ModelInfo[] = [
  { id: 'opus', displayName: 'Claude Opus (gói)', tier: 'strong' },
  { id: 'sonnet', displayName: 'Claude Sonnet (gói)', tier: 'medium' },
  { id: 'haiku', displayName: 'Claude Haiku (gói)', tier: 'cheap' },
].map((model) => ({
  ...model,
  tier: model.tier as ModelInfo['tier'],
  provider: 'claude-code' as const,
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  // Không tính theo token: trừ vào hạn mức gói. Giá 0 để chi phí dự án không đội và model chọn được trong bảng định tuyến.
  pricing: { inputPerMTok: 0, outputPerMTok: 0 },
  pricingSource: 'seed' as const,
  pricingAsOf: '2026-09-26',
}));

/** Tìm `claude.exe`: biến PN_CLAUDE_BIN, bản cài qua npm, bản cài native; không thấy thì nhờ PATH. */
export function claudeCommand(): CliCommand {
  const fromEnv = process.env['PN_CLAUDE_BIN'];
  if (fromEnv) return { file: fromEnv, prefixArgs: [] };
  if (process.platform === 'win32') {
    const candidates = [
      path.join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      path.join(process.env['USERPROFILE'] ?? '', '.local', 'bin', 'claude.exe'),
    ];
    const found = candidates.find((file) => existsSync(file));
    return { file: found ?? 'claude.exe', prefixArgs: [] };
  }
  return { file: 'claude', prefixArgs: [] };
}

interface ClaudeJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude (gói thuê bao)';
  readonly #command: CliCommand;
  readonly #oauthToken: string | null;
  readonly #catalog: ModelCatalog;
  readonly #limiter: Limiter;
  readonly #timeoutMs: number;

  constructor(options: { catalog: ModelCatalog; oauthToken?: string | null; command?: CliCommand; maxConcurrent?: number; timeoutMs?: number }) {
    this.#catalog = options.catalog;
    this.#oauthToken = options.oauthToken ?? null;
    this.#command = options.command ?? claudeCommand();
    this.#limiter = new Limiter(options.maxConcurrent ?? 2);
    this.#timeoutMs = options.timeoutMs ?? 20 * 60_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    try {
      return await this.#limiter.run(() =>
        withWorkDir(async (dir) => {
          const args = ['-p', '--output-format', 'json', '--model', request.model, '--tools', '', '--no-session-persistence'];
          // Không đặt thì CLI lấy mức suy nghĩ trong cài đặt Claude Code cá nhân của máy — mỗi lượt
          // nghĩ rất lâu và ăn hạn mức gói. Router đặt mức theo vai trò.
          if (request.effort) args.push('--effort', request.effort);
          if (request.system) {
            const file = path.join(dir, 'he-thong.txt');
            await writeText(file, request.system);
            args.push('--system-prompt-file', file);
          }
          const extra: Record<string, string> = { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
          if (this.#oauthToken) extra['CLAUDE_CODE_OAUTH_TOKEN'] = this.#oauthToken;
          if (request.maxOutputTokens) extra['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = String(request.maxOutputTokens);
          const run = await runCli({
            command: this.#command,
            args,
            input: transcript(request.messages),
            cwd: dir,
            env: cliEnv(extra),
            timeoutMs: this.#timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          });
          if (request.signal?.aborted) throw new LlmError(this.id, 'aborted', `${LABEL}: dừng vì lượt chạy đã hết giờ`);
          return this.#parse(run, request.model, started);
        }),
      );
    } catch (error) {
      throw cliError(this.id, LABEL, error);
    }
  }

  #parse(run: CliRun, model: string, started: number): GenerateResult {
    if (run.timedOut) throw new LlmError(this.id, 'timeout', `${LABEL}: quá thời gian chờ`);
    const json = lastJson(run.stdout);
    if (!json) {
      const output = (run.stderr || run.stdout).trim();
      throw new LlmError(this.id, classifyCliFailure(output), `${LABEL} thoát mã ${run.code}: ${output.slice(0, 600)}`);
    }
    if (json.is_error || (json.subtype && json.subtype !== 'success')) {
      const message = String(json.result ?? json.subtype ?? 'lỗi không rõ');
      throw new LlmError(this.id, classifyCliFailure(message), `${LABEL}: ${message.slice(0, 600)}`);
    }
    const usage = json.usage ?? {};
    return {
      provider: this.id,
      model,
      text: String(json.result ?? ''),
      usage: {
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.cache_read_input_tokens ?? 0,
      },
      costUsd: 0,
      latencyMs: Date.now() - started,
      stopReason: json.stop_reason ?? null,
      requestId: json.session_id ?? null,
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const result = await this.generate(request);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }

  estimateCost(): number {
    return 0;
  }

  async listModels(): Promise<ModelInfo[]> {
    return CLAUDE_CODE_MODELS.map((model) => this.#catalog.get(model.id) ?? model);
  }

  /** Hỏi một câu thật bằng model rẻ nhất — chứng minh CLI có, đăng nhập còn hạn và gói còn lượt. */
  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      await this.generate({ model: 'haiku', messages: [{ role: 'user', content: 'Trả lời đúng một từ: OK' }], maxOutputTokens: 200 });
      return { ok: true, latencyMs: Date.now() - started, model: 'haiku', error: null, checkedAt: new Date().toISOString() };
    } catch (error) {
      const llmError = error instanceof LlmError ? error : null;
      return {
        ok: false,
        latencyMs: Date.now() - started,
        model: null,
        error: `${llmError?.kind ?? 'unknown'}: ${error instanceof Error ? error.message : String(error)}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}

/** Kết quả JSON của `claude -p`: cả stdout là một khối; phòng khi có dòng cảnh báo phía trước thì lấy dòng JSON cuối. */
function lastJson(stdout: string): ClaudeJson | null {
  const text = stdout.trim();
  try {
    return JSON.parse(text) as ClaudeJson;
  } catch {
    for (const line of text.split(/\r?\n/).reverse()) {
      if (!line.trim().startsWith('{')) continue;
      try {
        return JSON.parse(line) as ClaudeJson;
      } catch {
        /* dòng khác */
      }
    }
    return null;
  }
}
