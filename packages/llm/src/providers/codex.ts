/**
 * P&N — ChatGPT qua Codex CLI, đăng nhập bằng gói ChatGPT.
 *
 * `codex exec` chạy không cần người bấm, trừ vào hạn mức gói ChatGPT. Tài khoản ChatGPT chỉ được
 * dùng model mặc định của Codex (đã thử: gpt-6-astra chạy, gpt-6-sol/gpt-6-luna bị từ chối), nên
 * ba hạng mạnh/trung/rẻ là ba MỨC SUY NGHĨ của cùng model: `<model>@high|medium|low`.
 * Codex là một agent có công cụ: chạy trong thư mục trống, sandbox chỉ đọc, dặn không chạy lệnh —
 * nó chỉ cần trả lời văn bản. Kết quả đọc từ dòng sự kiện JSON (`--json`).
 */

import { existsSync, readFileSync } from 'node:fs';
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
import { classifyCliFailure, cliEnv, cliError, Limiter, runCli, transcript, withWorkDir, type CliCommand, type CliRun } from './cli.js';

const LABEL = 'ChatGPT (gói)';
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Tìm Codex: biến PN_CODEX_BIN, bản cài qua npm (chạy bằng node); không thấy thì nhờ PATH. */
export function codexCommand(): CliCommand {
  const fromEnv = process.env['PN_CODEX_BIN'];
  if (fromEnv) return fromEnv.endsWith('.js') ? { file: process.execPath, prefixArgs: [fromEnv] } : { file: fromEnv, prefixArgs: [] };
  if (process.platform === 'win32') {
    const script = path.join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return { file: process.execPath, prefixArgs: [script] };
    return { file: 'codex.exe', prefixArgs: [] };
  }
  return { file: 'codex', prefixArgs: [] };
}

/** Model mặc định trong `~/.codex/config.toml` (dòng `model = "..."`); không có thì để Codex tự chọn. */
export function codexDefaultModel(): string {
  const home = process.env['CODEX_HOME'] ?? path.join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.codex');
  try {
    const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(readFileSync(path.join(home, 'config.toml'), 'utf8'));
    return match?.[1] ?? 'default';
  } catch {
    return 'default';
  }
}

/** Ba hạng = ba mức suy nghĩ của model mặc định. */
export function codexModels(name = codexDefaultModel()): ModelInfo[] {
  const label = name === 'default' ? 'Codex' : name;
  return (
    [
      ['high', 'strong', 'nghĩ kỹ'],
      ['medium', 'medium', 'vừa'],
      ['low', 'cheap', 'nhanh'],
    ] as const
  ).map(([effort, tier, note]) => ({
    id: `${name}@${effort}`,
    provider: 'codex' as const,
    displayName: `${label} — ${note} (gói)`,
    tier,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 },
    pricingSource: 'discovered' as const,
    pricingAsOf: '2026-09-26',
  }));
}

/** `gpt-6-astra@high` → tên model và mức suy nghĩ; mức lạ thì bỏ qua để Codex dùng mặc định. */
export function parseCodexModel(model: string): { name: string; effort: string | null } {
  const [name = 'default', effort = null] = model.split('@');
  return { name, effort: effort && (EFFORTS as readonly string[]).includes(effort) ? effort : null };
}

interface CodexEvent {
  type?: string;
  message?: string;
  item?: { type?: string; text?: string };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

export class CodexProvider implements LLMProvider {
  readonly id = 'codex' as const;
  readonly displayName = 'ChatGPT (gói thuê bao)';
  readonly #command: CliCommand;
  readonly #catalog: ModelCatalog;
  readonly #limiter: Limiter;
  readonly #timeoutMs: number;

  constructor(options: { catalog: ModelCatalog; command?: CliCommand; maxConcurrent?: number; timeoutMs?: number }) {
    this.#catalog = options.catalog;
    this.#command = options.command ?? codexCommand();
    this.#limiter = new Limiter(options.maxConcurrent ?? 2);
    this.#timeoutMs = options.timeoutMs ?? 20 * 60_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    const { name, effort } = parseCodexModel(request.model);
    try {
      return await this.#limiter.run(() =>
        withWorkDir(async (dir) => {
          const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-C', dir];
          if (name !== 'default') args.push('-m', name);
          if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
          // Codex không có cờ hướng dẫn hệ thống: đặt lên đầu lời nhắn, và dặn chỉ trả lời văn bản.
          const input =
            (request.system ? `<huong_dan_he_thong>\n${request.system}\n</huong_dan_he_thong>\n\n` : '') +
            'Chỉ trả lời bằng văn bản đúng yêu cầu bên dưới. Không chạy lệnh, không đọc hay sửa tệp nào.\n\n' +
            transcript(request.messages);
          const run = await runCli({
            command: this.#command,
            args,
            input,
            cwd: dir,
            env: cliEnv(),
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
    let text: string | null = null;
    let failure: string | null = null;
    let usage: CodexEvent['usage'] = {};
    for (const line of run.stdout.split(/\r?\n/)) {
      if (!line.trim().startsWith('{')) continue;
      let event: CodexEvent;
      try {
        event = JSON.parse(line) as CodexEvent;
      } catch {
        continue;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
      else if (event.type === 'turn.completed' && event.usage) usage = event.usage;
      else if (event.type === 'turn.failed') failure = innerMessage(event.error?.message ?? 'lượt chạy thất bại');
      else if (event.type === 'error' && !failure) failure = innerMessage(event.message ?? 'lỗi');
    }
    if (failure) throw new LlmError(this.id, classifyCliFailure(failure), `${LABEL}: ${failure.slice(0, 600)}`);
    if (text === null) {
      const output = (run.stderr || run.stdout).trim();
      throw new LlmError(this.id, classifyCliFailure(output), `${LABEL} thoát mã ${run.code} mà không có câu trả lời: ${output.slice(-600)}`);
    }
    return {
      provider: this.id,
      model,
      text,
      usage: {
        inputTokens: (usage?.input_tokens ?? 0) - (usage?.cached_input_tokens ?? 0),
        outputTokens: usage?.output_tokens ?? 0,
        cachedTokens: usage?.cached_input_tokens ?? 0,
      },
      costUsd: 0,
      latencyMs: Date.now() - started,
      stopReason: 'end_turn',
      requestId: null,
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
    return codexModels().map((model) => this.#catalog.get(model.id) ?? model);
  }

  /** Hỏi một câu thật bằng mức suy nghĩ thấp nhất — chứng minh CLI có, đã đăng nhập ChatGPT và gói còn lượt. */
  async testConnection(): Promise<ConnectionTestResult> {
    const started = Date.now();
    const model = `${codexDefaultModel()}@low`;
    try {
      await this.generate({ model, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] });
      return { ok: true, latencyMs: Date.now() - started, model, error: null, checkedAt: new Date().toISOString() };
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

/** Codex gói lỗi của hãng thành chuỗi JSON bên trong `message`; lấy câu thật để phân loại và hiện cho người đọc. */
function innerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? raw;
  } catch {
    return raw;
  }
}
