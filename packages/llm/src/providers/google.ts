/**
 * P&N — Adapter cho Google Gemini (§45.1).
 *
 * Gọi REST API Generative Language. Key do AI Gateway tiêm vào từ kho secret
 * (§19); ở đây không bao giờ đọc từ biến môi trường.
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

export interface GoogleProviderOptions {
  apiKey: string;
  baseUrl?: string | null;
  catalog: ModelCatalog;
  probeModel?: string;
  timeoutMs?: number;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
}

/** Gemini nhận system prompt ở một field riêng, không phải một lượt hội thoại. */
function toGoogleBody(request: GenerateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    contents: request.messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    generationConfig: {
      maxOutputTokens: request.maxOutputTokens ?? 16_000,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    },
  };
  if (request.system) {
    body['systemInstruction'] = { parts: [{ text: request.system }] };
  }
  return body;
}

export class GoogleProvider implements LLMProvider {
  readonly id: AiProviderId = 'google';
  readonly displayName = 'Google Gemini';

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #catalog: ModelCatalog;
  readonly #probeModel: string;
  readonly #timeoutMs: number;

  constructor(options: GoogleProviderOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/+$/,
      '',
    );
    this.#catalog = options.catalog;
    // `gemini-2.5-flash` đã bị Google gỡ (404 "no longer available to new users")
    // nên nút Kiểm tra ở Cài đặt luôn báo đỏ dù khoá vẫn tốt. Dùng bí danh
    // "-latest" để không phải sửa mỗi lần Google ra bản mới.
    this.#probeModel = options.probeModel ?? 'gemini-flash-latest';
    this.#timeoutMs = options.timeoutMs ?? 600_000;
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const startedAt = Date.now();
    const payload = await this.#post<GenerateContentResponse>(
      `/models/${encodeURIComponent(request.model)}:generateContent`,
      toGoogleBody(request),
      request.signal,
    );

    const usage: TokenUsage = {
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      cachedTokens: payload.usageMetadata?.cachedContentTokenCount ?? 0,
    };
    const model = payload.modelVersion ?? request.model;
    const text = (payload.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');

    return {
      provider: this.id,
      model,
      text,
      usage,
      costUsd: computeCost(this.#catalog, model, usage),
      latencyMs: Date.now() - startedAt,
      stopReason: payload.candidates?.[0]?.finishReason ?? null,
      requestId: payload.responseId ?? null,
    };
  }

  async *stream(request: GenerateRequest): AsyncIterable<StreamChunk> {
    const startedAt = Date.now();
    const response = await this.#rawPost(
      `/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
      toGoogleBody(request),
      request.signal,
    );

    if (!response.body) {
      throw new LlmError(this.id, 'network', 'Gemini stream returned no body');
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

        let event: GenerateContentResponse;
        try {
          event = JSON.parse(trimmed.slice(5).trim());
        } catch {
          continue;
        }

        requestId ??= event.responseId ?? null;
        if (event.modelVersion) model = event.modelVersion;
        const delta = (event.candidates?.[0]?.content?.parts ?? [])
          .map((part) => part.text ?? '')
          .join('');
        if (delta) {
          text += delta;
          yield { type: 'text', text: delta };
        }
        if (event.candidates?.[0]?.finishReason) stopReason = event.candidates[0].finishReason;
        if (event.usageMetadata) {
          usage = {
            inputTokens: event.usageMetadata.promptTokenCount ?? 0,
            outputTokens: event.usageMetadata.candidatesTokenCount ?? 0,
            cachedTokens: event.usageMetadata.cachedContentTokenCount ?? 0,
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

  /** Danh sách Google gồm cả model embedding, ảnh…; chỉ giữ model sinh nội dung để định tuyến không trỏ nhầm. */
  async listModels(): Promise<ModelInfo[]> {
    const payload = await this.#get<{
      models?: Array<{
        name: string;
        displayName?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    }>('/models');

    return (payload.models ?? [])
      .filter((entry) => entry.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((entry) => {
        const id = entry.name.replace(/^models\//, '');
        const known = this.#catalog.get(id);
        return {
          id,
          provider: this.id,
          displayName: entry.displayName ?? id,
          tier: known?.tier ?? tierFromName(id),
          contextWindow: entry.inputTokenLimit ?? known?.contextWindow ?? 1_000_000,
          maxOutputTokens: entry.outputTokenLimit ?? known?.maxOutputTokens ?? 8_192,
          pricing: known?.pricing ?? null,
          pricingSource: known?.pricingSource ?? 'discovered',
          pricingAsOf: known?.pricingAsOf ?? null,
        };
      });
  }

  /**
   * §48 — gọi thật bằng đúng key đã cấu hình: hỏi danh sách model trước (vừa
   * xác thực key, vừa biết model nào còn sống), rồi ping một model có thật.
   * Không ghi cứng tên model vì Google ngừng cấp tên cũ mà không báo — lần đó
   * key đúng vẫn bị báo lỗi 404 và người dùng tưởng key hỏng.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const startedAt = Date.now();
    let model = this.#probeModel;
    try {
      const models = await this.listModels();
      const live =
        models.find((entry) => entry.id === this.#probeModel) ??
        models.find((entry) => entry.id.includes('flash')) ??
        models[0];
      if (!live) {
        throw new LlmError(
          this.id,
          'invalid_request',
          'Key hợp lệ nhưng tài khoản không có model nào hỗ trợ generateContent',
        );
      }
      model = live.id;
      const payload = await this.#post<GenerateContentResponse>(
        `/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
          generationConfig: { maxOutputTokens: 16 },
        },
      );
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        model: payload.modelVersion ?? model,
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
          // Đưa key vào header giúp key không nằm trong URL, nên không lọt vào log (§81).
          'x-goog-api-key': this.#apiKey,
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
        headers: { 'x-goog-api-key': this.#apiKey },
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
    let kind = httpErrorKind(response.status, text);
    // Gemini báo "exceeded your current quota" cho cả hạn mức theo phút lẫn theo ngày. Chỉ hạn mức ngày
    // (hoặc hết tiền gói trả phí) mới đáng né lâu; theo phút thì đợi vài chục giây là gọi lại được.
    if (kind === 'quota' && !/PerDay|per day|per_day/i.test(text)) kind = 'rate_limit';
    const error = new LlmError(this.id, kind, `Gemini ${response.status}: ${text.slice(0, 500)}`, response.status);
    const wait = retryAfterMs(response.headers) ?? geminiRetryDelayMs(text);
    if (wait !== undefined) error.retryAfterMs = wait;
    return error;
  }

  #wrap(error: unknown): LlmError {
    if (error instanceof LlmError) return error;
    if (error instanceof Error && error.name === 'AbortError') {
      return new LlmError(this.id, 'timeout', 'Gemini request aborted', undefined, error);
    }
    return new LlmError(this.id, 'network', error instanceof Error ? error.message : String(error), undefined, error);
  }
}

/** Gemini ghi thời gian chờ trong thân lỗi (`"retryDelay": "33s"` hoặc "Please retry in 33.2s") thay vì header. */
export function geminiRetryDelayMs(body: string): number | undefined {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"|retry in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  const seconds = Number(match?.[1] ?? match?.[2]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}
