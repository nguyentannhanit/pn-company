/**
 * P&N — Adapter cho Anthropic (§45.1).
 *
 * Dùng SDK chính hãng `@anthropic-ai/sdk`. API key do AI Gateway tiêm vào từ kho
 * secret mã hoá — class này không bao giờ tự đọc biến môi trường hay chạm vào
 * database (§19, §89).
 */

import Anthropic from '@anthropic-ai/sdk';
import type { AiProviderId } from '@pn/shared';

import type { ModelCatalog } from '../catalog.js';
import { computeCost } from '../cost.js';
import {
  LlmError,
  isQuotaMessage,
  type ConnectionTestResult,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  catalog: ModelCatalog;
  /** Model mà `testConnection()` dùng khi chưa cấu hình model nào. */
  probeModel?: string;
  timeoutMs?: number;
}

/** Các model mà `thinking: {type:'adaptive'}` là cách bật suy luận đúng. */
const ADAPTIVE_THINKING_PREFIXES = ['claude-opus-5', 'claude-opus-4-', 'claude-sonnet-5', 'claude-fable-5'];

function supportsAdaptiveThinking(model: string): boolean {
  return ADAPTIVE_THINKING_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export class AnthropicProvider implements LLMProvider {
  readonly id: AiProviderId = 'anthropic';
  readonly displayName = 'Anthropic';

  readonly #client: Anthropic;
  readonly #catalog: ModelCatalog;
  readonly #probeModel: string;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      timeout: options.timeoutMs ?? 600_000,
      maxRetries: 0, // chính sách retry/fallback nằm ở router (§53, §79)
    });
    this.#catalog = options.catalog;
    this.#probeModel = options.probeModel ?? 'claude-haiku-4-5';
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = Date.now();
    try {
      const response = await this.#client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens ?? 16_000,
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(supportsAdaptiveThinking(request.model)
            ? { thinking: { type: 'adaptive' as const } }
            : {}),
          ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        },
        request.signal ? { signal: request.signal } : {},
      );

      const usage = this.#readUsage(response.usage);
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        provider: this.id,
        model: response.model,
        text,
        usage,
        costUsd: computeCost(this.#catalog, response.model, usage),
        latencyMs: Date.now() - startedAt,
        stopReason: response.stop_reason ?? null,
        requestId: response.id ?? null,
      };
    } catch (error) {
      throw toLlmError(error);
    }
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    try {
      const stream = this.#client.messages.stream(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens ?? 64_000,
          ...(request.system ? { system: request.system } : {}),
          messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
          ...(supportsAdaptiveThinking(request.model)
            ? { thinking: { type: 'adaptive' as const } }
            : {}),
          ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        },
        request.signal ? { signal: request.signal } : {},
      );

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          'delta' in event &&
          event.delta.type === 'text_delta'
        ) {
          yield { type: 'text', text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      const usage = this.#readUsage(final.usage);
      const text = final.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      yield {
        type: 'done',
        result: {
          provider: this.id,
          model: final.model,
          text,
          usage,
          costUsd: computeCost(this.#catalog, final.model, usage),
          latencyMs: Date.now() - startedAt,
          stopReason: final.stop_reason ?? null,
          requestId: final.id ?? null,
        },
      };
    } catch (error) {
      throw toLlmError(error);
    }
  }

  estimateCost(model: string, usage: TokenUsage): number | null {
    return computeCost(this.#catalog, model, usage);
  }

  /** §49 — lấy danh sách model trực tiếp. API không trả giá nên giữ nguyên giá khởi tạo. */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const models: ModelInfo[] = [];
      for await (const model of this.#client.models.list()) {
        const known = this.#catalog.get(model.id);
        models.push({
          id: model.id,
          provider: this.id,
          displayName: model.display_name ?? model.id,
          tier: known?.tier ?? 'medium',
          contextWindow: known?.contextWindow ?? 200_000,
          maxOutputTokens: known?.maxOutputTokens ?? 16_000,
          pricing: known?.pricing ?? null,
          pricingSource: known?.pricingSource ?? 'discovered',
          pricingAsOf: known?.pricingAsOf ?? null,
        });
      }
      return models;
    } catch (error) {
      throw toLlmError(error);
    }
  }

  /**
   * §48, §89 — gọi thật. Một lần gọi rẻ với 1 token đủ chứng minh key, đường
   * mạng và quyền dùng model đều hoạt động; không có gì ở đây là giả lập.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    try {
      const response = await this.#client.messages.create({
        model: this.#probeModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: response.model,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const llmError = toLlmError(error);
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        model: this.#probeModel,
        error: `${llmError.kind}: ${llmError.message}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  #readUsage(usage: Anthropic.Usage): TokenUsage {
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedTokens: usage.cache_read_input_tokens ?? 0,
    };
  }
}

/**
 * Đọc header `retry-after`. Giá trị là số giây theo RFC 9110; dạng ngày tuyệt
 * đối hiếm gặp ở API AI nên bỏ qua và để backoff mặc định lo.
 */
function readRetryAfterMs(headers: unknown): number | null {
  if (!headers || typeof headers !== 'object') return null;
  const raw =
    headers instanceof Headers
      ? headers.get('retry-after')
      : (headers as Record<string, string | undefined>)['retry-after'];

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

export function toLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError('anthropic', 'auth', error.message, error.status, error);
  }
  if (error instanceof Anthropic.RateLimitError) {
    // Cùng mã 429 nhưng "hết credit" thì đợi cũng vô ích — phải chuyển hãng và báo CEO.
    const rateLimited = new LlmError('anthropic', isQuotaMessage(error.message) ? 'quota' : 'rate_limit', error.message, error.status, error);
    // §78 — provider biết hạn mức của chính nó; tôn trọng `retry-after` của nó
    // thay vì tự đoán khoảng chờ.
    const retryAfter = readRetryAfterMs(error.headers);
    if (retryAfter !== null) rateLimited.retryAfterMs = retryAfter;
    return rateLimited;
  }
  if (error instanceof Anthropic.BadRequestError) {
    // Anthropic báo hết credit bằng 400 invalid_request_error (từng có dự án đứng 11 giờ vì bị coi là "yêu cầu sai").
    return new LlmError('anthropic', isQuotaMessage(error.message) ? 'quota' : 'invalid_request', error.message, error.status, error);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('anthropic', 'timeout', error.message, undefined, error);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('anthropic', 'network', error.message, undefined, error);
  }
  if (error instanceof Anthropic.APIError) {
    const kind =
      error.status === 529 || error.status === 503 ? 'overloaded' : error.status && error.status >= 500 ? 'server' : 'unknown';
    return new LlmError('anthropic', kind, error.message, error.status, error);
  }
  return new LlmError('anthropic', 'unknown', error instanceof Error ? error.message : String(error), undefined, error);
}
