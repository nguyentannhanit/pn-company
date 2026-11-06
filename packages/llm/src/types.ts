/**
 * P&N — Lớp trừu tượng nhà cung cấp LLM (§15, §45).
 *
 * §15 bắt buộc có interface này và cấm hard-code vendor tại nơi gọi. Mọi thứ
 * bên trên lớp này (agent, orchestrator, AI Gateway) chỉ nói chuyện qua
 * `LLMProvider` cộng với một model id đã được route.
 */

import type { AiProviderId, ModelTier } from '@pn/shared';

/* -------------------------------------------------------------------------- */
/* Tin nhắn                                                                    */
/* -------------------------------------------------------------------------- */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  model: string;
  system?: string;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Độ sâu suy luận. Mỗi provider ánh xạ một kiểu — với Anthropic nó thành
   * `output_config.effort`; provider không có khái niệm tương đương thì bỏ qua.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tín hiệu huỷ để timeout của sandbox/worker cắt được lời gọi đang chạy (§18). */
  signal?: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Token lấy từ cache phía provider — theo dõi riêng theo §16. */
  cachedTokens: number;
}

export interface GenerateResult {
  provider: AiProviderId;
  model: string;
  text: string;
  usage: TokenUsage;
  /** `null` khi model không có trong bảng giá (§49). */
  costUsd: number | null;
  latencyMs: number;
  stopReason: string | null;
  /** Id do provider trả về, giữ lại để đối chiếu khi hỗ trợ và ghi log (§81). */
  requestId: string | null;
}

export interface StreamChunk {
  type: 'text' | 'done';
  text?: string;
  result?: GenerateResult;
}

/* -------------------------------------------------------------------------- */
/* Danh mục model                                                              */
/* -------------------------------------------------------------------------- */

export interface ModelPricing {
  /** USD cho mỗi 1 triệu token đầu vào. */
  inputPerMTok: number;
  /** USD cho mỗi 1 triệu token đầu ra. */
  outputPerMTok: number;
  /** USD cho mỗi 1 triệu token đọc từ cache, nếu provider tính giá riêng. */
  cachedInputPerMTok?: number;
}

export interface ModelInfo {
  id: string;
  provider: AiProviderId;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * `null` nghĩa là "chưa biết giá" — khi đó chi phí được ghi `null` chứ không
   * đoán bừa. §89 cấm làm giả; một con số chi phí sai còn tệ hơn là không có.
   */
  pricing: ModelPricing | null;
  /** Giá lấy từ đâu, để API Center hiển thị được nguồn gốc. */
  pricingSource: 'seed' | 'operator' | 'discovered';
  /** Ngày (ISO) lần cuối đối chiếu lại giá gốc. */
  pricingAsOf: string | null;
}

/* -------------------------------------------------------------------------- */
/* Kiểm tra kết nối — §48 (phải gọi thật, không được giả lập)                  */
/* -------------------------------------------------------------------------- */

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  /** Model thực sự chạm tới được trong lần thử. */
  model: string | null;
  /** Thông báo lỗi của provider đã redact, khi `ok === false`. */
  error: string | null;
  checkedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Hợp đồng provider — §15                                                     */
/* -------------------------------------------------------------------------- */

export interface LLMProvider {
  readonly id: AiProviderId;
  readonly displayName: string;

  generate(request: GenerateRequest): Promise<GenerateResult>;

  stream(request: GenerateRequest): AsyncIterable<StreamChunk>;

  /** Hàm thuần trên danh mục model — không gọi mạng. */
  estimateCost(model: string, usage: TokenUsage): number | null;

  /** §49 — lấy danh sách model trực tiếp từ provider. */
  listModels(): Promise<ModelInfo[]>;

  /** §48 — gửi một request thật, nhỏ nhất có thể, tới provider. */
  testConnection(): Promise<ConnectionTestResult>;
}

/* -------------------------------------------------------------------------- */
/* Lỗi                                                                         */
/* -------------------------------------------------------------------------- */

export type LlmErrorKind =
  | 'auth'
  | 'rate_limit'
  /** Hết tiền / hết hạn mức tài khoản — thử lại vô ích, phải chuyển hãng và báo CEO nạp tiền. */
  | 'quota'
  | 'overloaded'
  | 'invalid_request'
  | 'timeout'
  | 'network'
  | 'server'
  /**
   * Lượt chạy của agent đã hết giờ (signal abort): dừng hẳn — không thử lại, không chuyển hãng. Từng có một lượt
   * 30 phút kéo thành 62 phút vì lần bị huỷ được coi là "quá giờ, thử lại" và mở thêm 5 tiến trình CLI.
   */
  | 'aborted'
  | 'unknown';

/** Thân lỗi 429 nói "hết tiền" chứ không phải "gọi quá nhanh" (OpenAI, Anthropic, Gemini). */
const QUOTA_PATTERN = /insufficient_quota|credit[_ ]balance|no credits|billing hard limit|exceeded your current quota|quota exceeded|purchase credits/i;

/**
 * Phân loại lỗi HTTP chung cho các provider gọi bằng fetch. 429 tách hai loại:
 * hết tiền (`quota`) và gọi quá nhanh (`rate_limit`); 503/529 là quá tải, không phải máy chủ hỏng.
 */
export function httpErrorKind(status: number, body: string): LlmErrorKind {
  if (status === 401 || status === 403) return 'auth';
  // Hết tiền có hãng trả 400 chứ không phải 429 (Anthropic: "credit balance is too low").
  if (status === 400 && QUOTA_PATTERN.test(body)) return 'quota';
  if (status === 429) return QUOTA_PATTERN.test(body) ? 'quota' : 'rate_limit';
  if (status === 503 || status === 529) return 'overloaded';
  if (status >= 500) return 'server';
  return 'invalid_request';
}

/** Lượt đã hết giờ thì ném lỗi `aborted` ngay, trước khi mở lời gọi mới. */
export function throwIfAborted(signal: AbortSignal | undefined, provider: AiProviderId): void {
  if (signal?.aborted) throw new LlmError(provider, 'aborted', 'Dừng vì lượt chạy đã hết giờ');
}

export function isQuotaMessage(message: string): boolean {
  return QUOTA_PATTERN.test(message);
}

/** Header `retry-after` (giây theo RFC 9110) → mili giây; không có hoặc không phải số thì `undefined`. */
export function retryAfterMs(headers: Headers | null | undefined): number | undefined {
  const seconds = Number(headers?.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

export class LlmError extends Error {
  /**
   * §78 — provider bảo đợi bao lâu rồi hãy gọi lại (header `retry-after`).
   * Có giá trị thì phải tôn trọng nó thay vì tự tính backoff: gọi lại sớm hơn
   * chỉ làm hạn mức bị siết chặt thêm.
   */
  retryAfterMs?: number;

  constructor(
    readonly provider: AiProviderId,
    readonly kind: LlmErrorKind,
    message: string,
    readonly status?: number,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  /** §53, §79 — chỉ những lỗi này mới đáng retry hoặc chuyển provider. */
  get retryable(): boolean {
    return (
      this.kind === 'rate_limit' ||
      this.kind === 'overloaded' ||
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      this.kind === 'server'
    );
  }
}
