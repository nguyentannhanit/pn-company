/**
 * P&N — Định tuyến model, fallback và smart routing (§15, §50–§53).
 *
 * §15: không dùng model mạnh nhất cho mọi việc, và không hard-code vendor.
 * Routing ánh xạ một *vai trò agent* (kèm tín hiệu về loại task nếu có) sang một
 * cặp provider+model cụ thể thông qua bảng cấu hình được.
 *
 * §53: fallback chỉ kích hoạt khi provider sập / dính rate limit / lỗi tạm thời,
 * không bao giờ âm thầm, và không tự hạ hạng năng lực nếu chính sách không cho.
 */

import type { AgentRole, AiProviderId, ModelTier, RoutingMode } from '@pn/shared';

import type { ModelCatalog } from './catalog.js';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js';
import { ProviderNotConfiguredError } from './registry.js';
import {
  LlmError,
  throwIfAborted,
  type GenerateRequest,
  type GenerateResult,
  type LLMProvider,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Hạng model mặc định theo vai trò — §15                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ví dụ trong §15: CTO / Architect / Security dùng hạng strong; PM, BA và QA
 * dùng hạng medium; việc cơ học dùng hạng cheap. Mọi dòng đều sửa được từ API
 * Center (§50) — đây chỉ là giá trị khởi tạo.
 */
export const DEFAULT_ROLE_TIERS: Record<AgentRole, ModelTier> = {
  CTO_ORCHESTRATOR: 'strong',
  SOLUTION_ARCHITECT: 'strong',
  SECURITY: 'strong',
  RED_TEAM: 'strong',
  BACKEND_DEVELOPER: 'strong',
  FRONTEND_DEVELOPER: 'strong',
  MOBILE_DEVELOPER: 'strong',

  PRODUCT_MANAGER: 'medium',
  BUSINESS_ANALYST: 'medium',
  QA: 'medium',
  UIUX_DESIGNER: 'medium',
  DEVOPS: 'medium',
  WEB_PRODUCT_LEAD: 'medium',
  SEO: 'medium',
  WEB_PERFORMANCE: 'medium',
  ACCESSIBILITY: 'medium',
  KNOWLEDGE_DIRECTOR: 'medium',
  RESEARCH: 'medium',
  KNOWLEDGE_SECURITY_REVIEW: 'strong',
  SANDBOX_EVALUATION: 'medium',
  DEPARTMENT_TRAINER: 'medium',
  KNOWLEDGE_AUDITOR: 'medium',

  GITHUB_SCOUT: 'cheap',
  TECHNOLOGY_RADAR: 'cheap',
  SKILL_SCOUT: 'cheap',
  KNOWLEDGE_CURATOR: 'cheap',
};

/**
 * Mức suy nghĩ khi gọi Claude qua gói (CLI). CTO phân rã và Kiến trúc cần nghĩ kỹ; các phòng khác "medium" đủ
 * tốt mà nhanh hơn nhiều. Trước đây không đặt nên CLI lấy xhigh từ cài đặt cá nhân của máy đang chạy.
 */
export function cliEffortFor(role: AgentRole): 'high' | 'medium' {
  return role === 'CTO_ORCHESTRATOR' || role === 'SOLUTION_ARCHITECT' ? 'high' : 'medium';
}

/** §52 — các dạng task mà router tự nhận ra mà không cần cấu hình riêng. */
export type TaskKind =
  | 'classification'
  | 'summarization'
  | 'formatting'
  | 'code'
  | 'architecture_review'
  | 'debugging'
  | 'general';

const TASK_TIER_FLOOR: Record<TaskKind, ModelTier | null> = {
  classification: 'cheap',
  summarization: 'cheap',
  formatting: 'cheap',
  code: 'strong',
  architecture_review: 'strong',
  debugging: 'strong',
  general: null,
};

/* -------------------------------------------------------------------------- */
/* Bảng định tuyến                                                             */
/* -------------------------------------------------------------------------- */

export interface RouteTarget {
  provider: AiProviderId;
  model: string;
}

export interface RouteConfig extends RouteTarget {
  agentRole: AgentRole;
  tier: ModelTier;
  /** §53 — chuỗi fallback theo thứ tự. Rỗng nghĩa là vai trò này không fallback. */
  fallbacks: RouteTarget[];
  maxOutputTokens?: number | null;
}

export interface RouterOptions {
  catalog: ModelCatalog;
  /** Đổi id provider thành client sẵn sàng; chưa cấu hình thì ném lỗi (§47). */
  getProvider: (provider: AiProviderId) => LLMProvider;
  routes: RouteConfig[];
  mode?: RoutingMode;
  /** §52 — công tắc "Smart Model Routing". */
  smartRouting?: boolean;
  breaker?: CircuitBreaker;
  /** §53 — mọi lần fallback đều phải ghi log, không được im lặng. */
  onFallback?: (event: FallbackEvent) => void;
  /** §54 — ngân sách còn lại tính bằng USD; `null` là không giới hạn. */
  budgetRemainingUsd?: () => number | null;
  /** §78, §79 — chính sách thử lại trên cùng một model trước khi đổi provider. */
  retry?: Partial<RetryPolicy>;
  /** Cho test thay hàm chờ; mặc định là `setTimeout` thật. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * §79 — thử lại có giới hạn. Không có nó thì một lần 429 thoáng qua giết luôn
 * task, vì hệ thống chỉ có một provider là chuyện bình thường và chuỗi fallback
 * lúc đó rỗng.
 *
 * Backoff tăng gấp đôi mỗi lần, có trần: §78 cấm retry storm, và mười tiến
 * trình cùng thử lại đúng một nhịp thì chính chúng tạo ra lần 429 tiếp theo.
 */
export interface RetryPolicy {
  /** Số lần thử LẠI trên cùng một model, chưa tính lần đầu. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
};

/**
 * Khoảng chờ trước lần thử thứ `attempt` (đếm từ 0).
 *
 * `retryAfterMs` do provider trả về luôn thắng: nó biết hạn mức của chính nó,
 * còn ta chỉ đang đoán. Vẫn kẹp theo trần để một header sai không treo task
 * hàng giờ.
 */
export function retryDelayMs(policy: RetryPolicy, attempt: number, retryAfterMs?: number): number {
  const backoff = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs);
  if (retryAfterMs === undefined) return backoff;
  return Math.min(Math.max(retryAfterMs, backoff), policy.maxDelayMs);
}

/** Lỗi cho thấy model đang bận chứ không hỏng: quá tải, hết lượt theo phút, máy chủ hãng lỗi. */
const BUSY_KINDS = new Set(['rate_limit', 'overloaded', 'server']);

/** Né model đang bận trong 1 phút — hạn mức theo phút của gói miễn phí Gemini hồi lại sau chừng đó. */
export const BUSY_COOLDOWN_MS = 60_000;

/** Hết tiền thì né cả hãng 6 giờ: tiền không tự về, và trong lúc đó mọi lượt đi thẳng sang hãng dự phòng. */
export const QUOTA_COOLDOWN_MS = 6 * 60 * 60_000;

/**
 * Key sai / đăng nhập CLI hết hạn: né 30 phút rồi thử lại (CEO có thể đã đăng nhập lại). Trước đây lỗi này
 * không chuyển hãng — một key hỏng ở hãng chính là cả dự án kẹt dù hãng dự phòng vẫn chạy.
 */
export const AUTH_COOLDOWN_MS = 30 * 60_000;

export interface FallbackEvent {
  agentRole: AgentRole;
  from: RouteTarget;
  to: RouteTarget;
  reason: string;
  /** Chưa biết ảnh hưởng chi phí cho tới khi gọi xong; gateway sẽ ghi lại. */
  attempt: number;
}

/**
 * Một lần gọi hỏng trong chuỗi thử lại / chuyển hãng. Gateway ghi mỗi lần thành một dòng nhật ký riêng —
 * trước đây cả chuỗi chỉ để lại một dòng, 5 lần gọi thừa sau khi hết giờ không hiện ra ở đâu.
 */
export interface AttemptFailure {
  target: RouteTarget;
  error: unknown;
  latencyMs: number;
  /** Lần thử thứ mấy trên chính model này (0 = lần đầu). */
  retry: number;
}

export interface RouteDecision extends RouteTarget {
  tier: ModelTier;
  reason: string;
}

export interface RouteSignals {
  taskKind?: TaskKind;
  /** Kích thước ước lượng của prompt, để tránh route vào model có context quá nhỏ. */
  estimatedInputTokens?: number;
}

export class NoRouteError extends Error {
  constructor(role: AgentRole) {
    super(`No model route configured for agent role ${role} (spec §50)`);
    this.name = 'NoRouteError';
  }
}

/* -------------------------------------------------------------------------- */
/* Bộ định tuyến                                                               */
/* -------------------------------------------------------------------------- */

export class ModelRouter {
  readonly #catalog: ModelCatalog;
  readonly #getProvider: RouterOptions['getProvider'];
  readonly #routes = new Map<AgentRole, RouteConfig>();
  readonly #breaker: CircuitBreaker;
  readonly #onFallback: (event: FallbackEvent) => void;
  readonly #budgetRemainingUsd: () => number | null;
  readonly #retry: RetryPolicy;
  readonly #sleep: (ms: number) => Promise<void>;
  #mode: RoutingMode;
  #smartRouting: boolean;

  constructor(options: RouterOptions) {
    this.#catalog = options.catalog;
    this.#getProvider = options.getProvider;
    this.#breaker = options.breaker ?? new CircuitBreaker();
    this.#onFallback = options.onFallback ?? (() => {});
    this.#budgetRemainingUsd = options.budgetRemainingUsd ?? (() => null);
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.#sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#mode = options.mode ?? 'balanced';
    this.#smartRouting = options.smartRouting ?? true;
    for (const route of options.routes) this.#routes.set(route.agentRole, route);
  }

  setMode(mode: RoutingMode): void {
    this.#mode = mode;
  }

  setSmartRouting(enabled: boolean): void {
    this.#smartRouting = enabled;
  }

  setRoute(route: RouteConfig): void {
    this.#routes.set(route.agentRole, route);
  }

  getRoute(role: AgentRole): RouteConfig | undefined {
    return this.#routes.get(role);
  }

  /**
   * Chọn đích chính cho một vai trò.
   *
   * Chế độ `custom` (§51) luôn tôn trọng đúng route đã cấu hình — CEO đã chọn có
   * chủ đích. Các chế độ khác được phép đổi hạng model trong cùng provider, và
   * smart routing (§52) có thể hạ hạng cho việc cơ học hoặc khi ngân sách còn ít.
   */
  resolve(role: AgentRole, signals: RouteSignals = {}): RouteDecision {
    const route = this.#routes.get(role);
    if (!route) throw new NoRouteError(role);

    if (this.#mode === 'custom') {
      return { provider: route.provider, model: route.model, tier: route.tier, reason: 'custom route' };
    }

    let tier = route.tier;
    let reason = `role default (${route.tier})`;

    if (this.#mode === 'quality' && tier !== 'strong') {
      tier = 'strong';
      reason = 'quality mode';
    } else if (this.#mode === 'economy' && tier === 'strong') {
      tier = 'medium';
      reason = 'economy mode';
    }

    if (this.#smartRouting) {
      const floor = TASK_TIER_FLOOR[signals.taskKind ?? 'general'];
      if (floor && rank(floor) < rank(tier) && this.#mode !== 'quality') {
        tier = floor;
        reason = `smart routing: ${signals.taskKind} task`;
      } else if (floor && rank(floor) > rank(tier)) {
        tier = floor;
        reason = `smart routing: ${signals.taskKind} needs ${floor}`;
      }

      const remaining = this.#budgetRemainingUsd();
      if (remaining !== null && remaining < 1 && tier === 'strong') {
        tier = 'medium';
        reason = 'smart routing: budget nearly exhausted';
      }
    }

    if (tier === route.tier) {
      return { provider: route.provider, model: route.model, tier, reason };
    }

    const candidate = this.#catalog
      .list(route.provider)
      .find((model) => model.tier === tier && fitsContext(model.contextWindow, signals));

    if (!candidate) {
      return { provider: route.provider, model: route.model, tier: route.tier, reason: `${reason} (no ${tier} model for ${route.provider}, kept default)` };
    }
    return { provider: route.provider, model: candidate.id, tier, reason };
  }

  /**
   * Chạy sinh nội dung theo route đã chọn, áp dụng chuỗi fallback ở §53.
   * Fallback chỉ chạy với lỗi đáng retry; lỗi xác thực hay request sai định dạng
   * được báo ra ngay thay vì đốt thêm provider kế tiếp.
   *
   * `avoid` là các model đã thử và trả lời hỏng ở lượt gọi TRƯỚC (gọi lần hai của
   * cùng một request, ví dụ vòng sửa JSON ở `generateStructured`) — trường hợp này
   * provider trả 200 OK nên không phải lỗi retryable, cầu dao không thấy để tự
   * chuyển; phải nói thẳng cho router biết để nó bỏ qua, không hỏi lại đúng model
   * vừa sai. Loại hết mà không còn ai thì thà thử lại model đã loại còn hơn báo
   * "hết route" khi rõ ràng route vẫn tồn tại.
   *
   * Lượt chạy hết giờ (`request.signal` đã huỷ) thì dừng ngay, không thử lại hay chuyển hãng nữa.
   * `onAttemptFailed` nhận từng lần gọi hỏng để ghi nhật ký riêng từng lần.
   */
  async generate(
    role: AgentRole,
    request: Omit<GenerateRequest, 'model'>,
    signals: RouteSignals = {},
    avoid: readonly RouteTarget[] = [],
    onAttemptFailed?: (failure: AttemptFailure) => void,
  ): Promise<GenerateResult> {
    const route = this.#routes.get(role);
    if (!route) throw new NoRouteError(role);

    const primary = this.resolve(role, signals);
    const fullChain: RouteTarget[] = [primary, ...route.fallbacks];
    const avoidKeys = new Set(avoid.map((t) => `${t.provider}:${t.model}`));
    const filtered = fullChain.filter((t) => !avoidKeys.has(`${t.provider}:${t.model}`));
    const chain = filtered.length > 0 ? filtered : fullChain;

    let lastError: unknown;
    for (let attempt = 0; attempt < chain.length; attempt += 1) {
      const target = chain[attempt]!;
      const key = `${target.provider}:${target.model}`;

      try {
        // §79 — thử lại trên chính model này trước đã. Đổi provider ngay khi
        // gặp 429 là bỏ phí một model đang hoạt động bình thường, chỉ là bận.
        const result = await this.#generateWithRetry(key, target, route, request, onAttemptFailed);
        return result;
      } catch (error) {
        lastError = error;
        if (error instanceof LlmError && error.kind === 'aborted') throw error;
        // Hết tiền không đáng thử lại trên cùng model, nhưng rất đáng chuyển hãng. Hãng đã bị xoá key
        // (hoặc tắt) mà vẫn nằm trong chuỗi thì đi thẳng sang người kế tiếp.
        const retryable =
          error instanceof CircuitOpenError ||
          error instanceof ProviderNotConfiguredError ||
          (error instanceof LlmError && (error.retryable || error.kind === 'quota' || error.kind === 'auth'));

        const next = chain[attempt + 1];
        if (!retryable || !next) break;

        this.#onFallback({
          agentRole: role,
          from: target,
          to: next,
          reason:
            error instanceof CircuitOpenError
              ? 'circuit open'
              : error instanceof ProviderNotConfiguredError
                ? 'not configured'
                : `${(error as LlmError).kind}: ${(error as LlmError).message}`,
          attempt: attempt + 1,
        });
      }
    }

    throw lastError;
  }

  /**
   * §78, §79 — gọi một model, thử lại có giới hạn khi lỗi là loại đáng thử lại.
   *
   * Circuit breaker chỉ ghi nhận thất bại ở lần cuối cùng: đếm mỗi lần thử lại
   * là một thất bại riêng thì một lần 429 kéo dài đủ để mở mạch, và model đó bị
   * loại khỏi vòng dù nó chưa hỏng.
   */
  async #generateWithRetry(
    key: string,
    target: RouteTarget,
    route: RouteConfig,
    request: Omit<GenerateRequest, 'model'>,
    onAttemptFailed?: (failure: AttemptFailure) => void,
  ): Promise<GenerateResult> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.#retry.maxRetries; attempt += 1) {
      // Hết giờ trong lúc chờ backoff hoặc giữa hai hãng: không mở lời gọi mới.
      throwIfAborted(request.signal, target.provider);
      const startedAt = Date.now();
      try {
        this.#breaker.assertClosed(key);
        const provider = this.#getProvider(target.provider);
        const result = await provider.generate({
          ...request,
          model: target.model,
          ...(route.maxOutputTokens && !request.maxOutputTokens
            ? { maxOutputTokens: route.maxOutputTokens }
            : {}),
          ...(target.provider === 'claude-code' && !request.effort ? { effort: cliEffortFor(route.agentRole) } : {}),
        });
        this.#breaker.recordSuccess(key);
        return result;
      } catch (error) {
        lastError = error;

        // Mạch đang mở thì thử lại vô nghĩa — nó sẽ mở nguyên khoảng nghỉ. Hãng chưa có key cũng vậy,
        // và không tính là model hỏng.
        if (error instanceof CircuitOpenError || error instanceof ProviderNotConfiguredError) throw error;

        // Lượt hết giờ giữa chừng: provider có thể báo "timeout" vì tiến trình bị giết — đó không phải lỗi của
        // hãng (không tính vào cầu dao) và càng không được thử lại.
        if (request.signal?.aborted) {
          const aborted =
            error instanceof LlmError && error.kind === 'aborted'
              ? error
              : new LlmError(target.provider, 'aborted', 'Dừng vì lượt chạy đã hết giờ', undefined, error);
          onAttemptFailed?.({ target, error: aborted, latencyMs: Date.now() - startedAt, retry: attempt });
          throw aborted;
        }
        onAttemptFailed?.({ target, error, latencyMs: Date.now() - startedAt, retry: attempt });

        // Hết tiền: không thử lại (mỗi lần thử là một lượt gọi bị từ chối), né hãng lâu.
        if (error instanceof LlmError && error.kind === 'quota') {
          this.#breaker.trip(key, QUOTA_COOLDOWN_MS);
          throw error;
        }
        if (error instanceof LlmError && error.kind === 'auth') {
          this.#breaker.trip(key, AUTH_COOLDOWN_MS);
          throw error;
        }

        const retryable = error instanceof LlmError && error.retryable;
        if (!retryable || attempt === this.#retry.maxRetries) {
          // Thử hết lượt mà model vẫn báo bận/quá tải: cả công ty tạm né nó, người
          // sau đi thẳng sang dự phòng. Trước đây phải 5 lần thất bại mới ngắt, nên
          // lúc Gemini nghẽn mỗi nhân viên đều tự thử lại rồi cùng báo kẹt.
          if (error instanceof LlmError && BUSY_KINDS.has(error.kind)) {
            this.#breaker.trip(key, Math.max(BUSY_COOLDOWN_MS, error.retryAfterMs ?? 0));
          } else {
            this.#breaker.recordFailure(key);
          }
          throw error;
        }

        await this.#sleep(
          retryDelayMs(this.#retry, attempt, (error as LlmError).retryAfterMs),
        );
      }
    }

    throw lastError;
  }
}

function rank(tier: ModelTier): number {
  return tier === 'cheap' ? 0 : tier === 'medium' ? 1 : 2;
}

function fitsContext(contextWindow: number, signals: RouteSignals): boolean {
  const needed = signals.estimatedInputTokens;
  return needed === undefined || contextWindow >= needed * 1.2;
}
