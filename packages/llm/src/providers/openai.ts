/**
 * P&N — Adapter cho OpenAI (§45.1).
 *
 * Gọi thẳng REST endpoint Chat Completions để lớp provider gọn nhẹ và dễ thay
 * thế (§45 — provider phải plug-in được). API key do AI Gateway tiêm vào từ kho
 * secret (§19).
 */

import type { AiProviderId } from '@pn/shared';

import { tierFromName, type ModelCatalog } from '../catalog.js';
import { computeCost } from '../cost.js';
import {
  LlmError,
  httpErrorKind,
  retryAfterMs,
  throwIfAborted,
  type ConnectionTestResult,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
  type ModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '../types.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  catalog: ModelCatalog;
  probeModel?: string;
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Chỉ các dòng này là model hội thoại; phần loại trừ là embedding, giọng nói, ảnh, kiểm duyệt, mã. */
const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /embedding|tts|whisper|audio|realtime|transcribe|image|dall-e|moderation|search|instruct|codex/;

export class OpenAiProvider implements LLMProvider {
  readonly id: AiProviderId = 'openai';
  readonly displayName = 'OpenAI';

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #catalog: ModelCatalog;
  readonly #probeModel: string;
  readonly #timeoutMs: number;

  constructor(options: OpenAiProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.#catalog = options.catalog;
    this.#probeModel = options.probeModel ?? 'gpt-5-mini';
    this.#timeoutMs = options.timeoutMs ?? 600_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push(...request.messages.map((m) => ({ role: m.role, content: m.content })));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_completion_tokens: request.maxOutputTokens ?? 16_000,
    };
    if (request.temperature !== undefined) body['temperature'] = request.temperature;

    const payload = await this.#post<ChatCompletionResponse>('/chat/completions', body, request.signal);

    const usage: TokenUsage = {
      inputTokens: payload.usage?.prompt_tokens ?? 0,
      outputTokens: payload.usage?.completion_tokens ?? 0,
      cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const model = payload.model ?? request.model;

    return {
      provider: this.id,
      model,
      text: payload.choices?.[0]?.message?.content ?? '',
      usage,
      costUsd: computeCost(this.#catalog, model, usage, request.model),
      latencyMs: Date.now() - startedAt,
      stopReason: payload.choices?.[0]?.finish_reason ?? null,
      requestId: payload.id ?? null,
    };
  }

  /**
   * Streaming dùng chung một hợp đồng. Các delta SSE không mang thông tin token,
   * nên chunk `done` cuối cùng lấy số token từ payload ngay trước `[DONE]` khi
   * request có bật `stream_options`.
   */
  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    const messages: Array<{ role: string; content: string }> = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    messages.push(...request.messages.map((m) => ({ role: m.role, content: m.content })));

    const response = await this.#rawPost(
      '/chat/completions',
      {
        model: request.model,
        messages,
        max_completion_tokens: request.maxOutputTokens ?? 64_000,
        stream: true,
        stream_options: { include_usage: true },
      },
      request.signal,
    );

    if (!response.body) {
      throw new LlmError(this.id, 'network', 'OpenAI stream returned no body');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    let model = request.model;
    let stopReason: string | null = null;
    let requestId: string | null = null;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        let event: {
          id?: string;
          model?: string;
          choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          usage?: ChatCompletionResponse['usage'];
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        requestId ??= event.id ?? null;
        if (event.model) model = event.model;
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          yield { type: 'text', text: delta };
        }
        if (event.choices?.[0]?.finish_reason) stopReason = event.choices[0].finish_reason;
        if (event.usage) {
          usage = {
            inputTokens: event.usage.prompt_tokens ?? 0,
            outputTokens: event.usage.completion_tokens ?? 0,
            cachedTokens: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }
      }
    }

    yield {
      type: 'done',
      result: {
        provider: this.id,
        model,
        text,
        usage,
        costUsd: computeCost(this.#catalog, model, usage),
        latencyMs: Date.now() - startedAt,
        stopReason,
        requestId,
      },
    };
  }

  estimateCost(model: string, usage: TokenUsage): number | null {
    return computeCost(this.#catalog, model, usage);
  }

  /** OpenAI liệt kê cả embedding, TTS, ảnh…; chỉ giữ model hội thoại để định tuyến không trỏ nhầm. */
  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.#get<{ data?: Array<{ id: string }> }>('/models');
    return (payload.data ?? [])
      .filter((entry) => CHAT_MODEL.test(entry.id) && !NOT_CHAT.test(entry.id))
      .map((entry) => {
        const known = this.#catalog.get(entry.id);
        return {
          id: entry.id,
          provider: this.id,
          displayName: known?.displayName ?? entry.id,
          tier: known?.tier ?? tierFromName(entry.id),
          contextWindow: known?.contextWindow ?? 128_000,
          maxOutputTokens: known?.maxOutputTokens ?? 16_000,
          pricing: known?.pricing ?? null,
          pricingSource: known?.pricingSource ?? 'discovered',
          pricingAsOf: known?.pricingAsOf ?? null,
        };
      });
  }

  /**
   * §48 — gọi thật: hỏi danh sách model (xác thực key) rồi ping một model có
   * thật. Model suy luận tiêu token đầu ra cho phần "nghĩ", nên hạn 1 token
   * từng làm key đúng vẫn bị báo lỗi 400; hạ mức nghĩ xuống thấp nhất cho lần
   * thăm dò thay vì đoán một con số.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    let model = this.#probeModel;
    try {
      const models = await this.listModels();
      const live =
        models.find((entry) => entry.id === this.#probeModel) ??
        models.find((entry) => entry.tier === 'cheap') ??
        models[0];
      if (!live) {
        throw new LlmError(
          this.id,
          'invalid_request',
          'Key hợp lệ nhưng tài khoản không có model hội thoại nào',
        );
      }
      model = live.id;
      const body: Record<string, unknown> = {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_completion_tokens: 256,
      };
      if (/^gpt-5/.test(model)) body['reasoning_effort'] = 'minimal';
      else if (/^o\d/.test(model)) body['reasoning_effort'] = 'low';
      const payload = await this.#post<ChatCompletionResponse>('/chat/completions', body);
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: payload.model ?? model,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      const llmError = error instanceof LlmError ? error : new LlmError(this.id, 'unknown', String(error));
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        model,
        error: `${llmError.kind}: ${llmError.message}`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  /* ---------------------------------------------------------------------- */

  async #rawPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    // Lượt đã hết giờ thì không gửi: 'abort' đã phát rồi không phát lại, nghe nó ở dưới là vô ích.
    throwIfAborted(signal, this.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw await this.#httpError(response);
      return response;
    } catch (error) {
      throw this.#wrap(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async #post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#rawPost(path, body, signal);
    return (await response.json()) as T;
  }

  async #get<T>(path: string): Promise<T> {
    try {
      const response = await fetch(`${this.#baseUrl}${path}`, {
        headers: { authorization: `Bearer ${this.#apiKey}` },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (!response.ok) throw await this.#httpError(response);
      return (await response.json()) as T;
    } catch (error) {
      throw this.#wrap(error);
    }
  }

  async #httpError(response: Response): Promise<LlmError> {
    const text = await response.text().catch(() => '');
    const error = new LlmError(this.id, httpErrorKind(response.status, text), `OpenAI ${response.status}: ${text.slice(0, 500)}`, response.status);
    const wait = retryAfterMs(response.headers);
    if (wait !== undefined) error.retryAfterMs = wait;
    return error;
  }

  #wrap(error: unknown): LlmError {
    if (error instanceof LlmError) return error;
    if (error instanceof Error && error.name === 'AbortError') {
      return new LlmError(this.id, 'timeout', 'OpenAI request aborted', undefined, error);
    }
    return new LlmError(this.id, 'network', error instanceof Error ? error.message : String(error), undefined, error);
  }
}
