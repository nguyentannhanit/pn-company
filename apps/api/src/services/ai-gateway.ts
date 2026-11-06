/**
 * P&N — AI Gateway (§89, §90).
 *
 * §89: "Mọi AI request phải đi qua backend gateway." Đây chính là cái cổng đó.
 * Không lớp nào khác trong hệ thống được gọi thẳng provider. Mỗi lần đi qua đây
 * đều:
 *   1. kiểm tra ngân sách trước khi tiêu tiền (§54, §55);
 *   2. định tuyến theo vai trò agent, có fallback (§50–§53);
 *   3. ghi `cost_records` theo agent / project / task / model / provider (§16);
 *   4. ghi log gọi provider ở dạng metadata, không lưu prompt (§81, §82);
 *   5. phát event khi ngân sách chạm ngưỡng (§21).
 */

import type { Repositories } from '@pn/database';
import type { EventBus } from '@pn/events';
import {
  CircuitBreaker,
  ModelRouter,
  NoRouteError,
  ProviderNotConfiguredError,
  type AttemptFailure,
  type GenerateResult,
  type LlmMessage,
  type ModelCatalog,
  type ProviderRegistry,
  type RouteConfig,
  type RouteSignals,
  type RouteTarget,
  type TaskKind,
} from '@pn/llm';
import { AUTH_COOLDOWN_MS, LlmError, QUOTA_COOLDOWN_MS } from '@pn/llm';
import { isHalted } from '@pn/orchestrator';
import type { AgentRole, AiProviderId, RoutingMode, Uuid } from '@pn/shared';

import type { ApiConfig } from '../config.js';

export interface GatewayRequest {
  agentRole: AgentRole;
  messages: LlmMessage[];
  system?: string;
  projectId?: Uuid | null;
  taskId?: Uuid | null;
  runId?: Uuid | null;
  agentId?: Uuid | null;
  maxOutputTokens?: number;
  temperature?: number;
  taskKind?: TaskKind;
  /** Ghi đè model cho đúng một lần gọi — có ghi audit ở tầng route (§71). */
  overrideModel?: string;
  /** Model đã thử và trả JSON hỏng ở lượt trước — router bỏ qua khi chọn lại (§53). */
  avoidModels?: RouteTarget[];
  signal?: AbortSignal;
}

export interface GatewayResponse extends GenerateResult {
  /** Ghi lại đường đi để CEO hiểu vì sao model này được chọn (§53). */
  routing: { reason: string; fellBackTo: string | null };
}

/** §55 — chặn trước khi tiêu, kèm lý do đọc được cho người dùng. */
export class BudgetExceededError extends Error {
  constructor(
    readonly scope: string,
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(
      `Ngân sách ${scope} đã dùng $${spentUsd.toFixed(2)}/$${limitUsd.toFixed(2)}. ` +
        'Agent bị tạm dừng theo chính sách (spec §55). Tăng ngân sách hoặc tắt hard stop để tiếp tục.',
    );
    this.name = 'BudgetExceededError';
  }
}

export interface AiGatewayOptions {
  config: ApiConfig;
  repos: Repositories;
  registry: ProviderRegistry;
  catalog: ModelCatalog;
  events: EventBus;
}

export class AiGateway {
  readonly #repos: Repositories;
  readonly #registry: ProviderRegistry;
  readonly #events: EventBus;
  readonly #config: ApiConfig;
  readonly #breaker = new CircuitBreaker();
  #router: ModelRouter;
  /** Hãng đã báo hết tiền và lúc báo — mỗi hãng chỉ làm phiền CEO một lần mỗi đợt né. */
  #quotaAlerted = new Map<string, number>();

  constructor(options: AiGatewayOptions) {
    this.#repos = options.repos;
    this.#registry = options.registry;
    this.#events = options.events;
    this.#config = options.config;

    this.#router = new ModelRouter({
      catalog: options.catalog,
      getProvider: (id) => options.registry.get(id),
      routes: [],
      breaker: this.#breaker,
      onFallback: (event) => {
        // §53 — fallback không bao giờ được im lặng.
        console.warn(
          `[ai-gateway] ${event.agentRole}: ${event.from.provider}/${event.from.model} lỗi ` +
            `(${event.reason}) → chuyển sang ${event.to.provider}/${event.to.model}`,
        );
        if (event.reason.startsWith('quota:')) this.#alertQuota(event.from.provider, event.from.model, event.reason.slice(7));
        else if (event.reason.startsWith('auth:')) this.#alertQuota(event.from.provider, event.from.model, event.reason.slice(6), 'auth');
      },
    });
  }

  setRoutes(routes: Array<Omit<RouteConfig, 'agentRole'> & { agentRole: AgentRole }>): void {
    for (const route of routes) this.#router.setRoute(route as RouteConfig);
  }

  setMode(mode: RoutingMode): void {
    this.#router.setMode(mode);
  }

  setSmartRouting(enabled: boolean): void {
    this.#router.setSmartRouting(enabled);
  }

  getRoute(role: AgentRole): RouteConfig | undefined {
    return this.#router.getRoute(role);
  }

  /** Trạng thái cầu dao để hiển thị ở Integration Health (§68, §80). */
  breakerSnapshot(): ReturnType<CircuitBreaker['snapshot']> {
    return this.#breaker.snapshot();
  }

  /* ---------------------------------------------------------------------- */
  /* Đường đi chính                                                          */
  /* ---------------------------------------------------------------------- */

  async generate(request: GatewayRequest): Promise<GatewayResponse> {
    await this.#assertBudget(request.projectId ?? null);

    const signals: RouteSignals = {
      ...(request.taskKind ? { taskKind: request.taskKind } : {}),
      estimatedInputTokens: estimateTokens(request),
    };

    const decision = this.#router.resolve(request.agentRole, signals);

    // Lần gọi hỏng của RIÊNG request này (nhiều lượt chạy song song nên không giữ ở biến chung của gateway).
    const failures: AttemptFailure[] = [];
    const startedAt = Date.now();
    try {
      const result = request.overrideModel
        ? await this.#generateWithOverride(request)
        : await this.#router.generate(
            request.agentRole,
            {
              messages: request.messages,
              ...(request.system ? { system: request.system } : {}),
              ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
              ...(request.signal ? { signal: request.signal } : {}),
            },
            signals,
            request.avoidModels ?? [],
            (failure) => {
              failures.push(failure);
              void this.#recordAttemptFailure(request, failure);
            },
          );

      const fellBackTo = fellBack(failures, result) ? `${result.provider}/${result.model}` : null;
      await this.#recordSuccess(request, result, fellBackTo);

      return { ...result, routing: { reason: decision.reason, fellBackTo } };
    } catch (error) {
      await this.#recordFailure(request, error, Date.now() - startedAt, failures.length > 0);
      throw error;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Nội bộ                                                                  */
  /* ---------------------------------------------------------------------- */

  /** Đường ghi đè model: bỏ qua routing nhưng vẫn qua đủ ghi nhận chi phí. */
  async #generateWithOverride(request: GatewayRequest): Promise<GenerateResult> {
    const route = this.#router.getRoute(request.agentRole);
    if (!route) throw new NoRouteError(request.agentRole);

    const provider = this.#registry.get(route.provider);
    return provider.generate({
      model: request.overrideModel!,
      messages: request.messages,
      ...(request.system ? { system: request.system } : {}),
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  /**
   * §54, §55 — kiểm tra ngân sách trước khi gọi. Cảnh báo ở ngưỡng và chặn khi
   * chạm trần nếu chính sách bật hard stop.
   */
  async #assertBudget(projectId: Uuid | null): Promise<void> {
    const global = await this.#repos.budgets.globalStatus('MONTH');
    if (global?.exceeded && global.hardStop) {
      await this.#events.publish('BUDGET_EXCEEDED', {
        scope: 'GLOBAL/MONTH',
        spentUsd: global.spentUsd,
        limitUsd: global.limitUsd,
        paused: true,
      });
      throw new BudgetExceededError('toàn hệ thống (tháng)', global.spentUsd, global.limitUsd);
    }

    if (!projectId) return;

    // Dự án CEO đã dừng: không mở lời gọi AI nào nữa (lượt chạy ở tiến trình worker không nghe được nút Dừng ở API).
    if (isHalted((await this.#repos.projects.findById(projectId))?.status)) {
      throw new Error('Dự án đã dừng — bấm Tiếp tục để chạy lại.');
    }

    const project = await this.#repos.budgets.projectStatus(projectId);
    if (!project) return;

    if (project.exceeded) {
      await this.#events.publish(
        'BUDGET_EXCEEDED',
        {
          scope: `PROJECT:${projectId}`,
          spentUsd: project.spentUsd,
          limitUsd: project.limitUsd,
          paused: project.hardStop,
        },
        { projectId },
      );
      if (project.hardStop) {
        // §55 — dự án bị đánh dấu tạm dừng để dashboard và Telegram thấy ngay.
        await this.#repos.projects.updateStatus(projectId, 'PAUSED_BUDGET');
        throw new BudgetExceededError('dự án', project.spentUsd, project.limitUsd);
      }
    } else if (project.warned) {
      await this.#events.publish(
        'BUDGET_WARNING',
        {
          scope: `PROJECT:${projectId}`,
          spentUsd: project.spentUsd,
          limitUsd: project.limitUsd,
          ratio: project.ratio,
        },
        { projectId },
      );
    }
  }

  /** §16 + §81 — ghi chi phí và metadata của lần gọi thành công. */
  async #recordSuccess(request: GatewayRequest, result: GenerateResult, fellBackTo: string | null): Promise<void> {
    await this.#repos.costs.record({
      agentId: request.agentId ?? null,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      provider: result.provider,
      model: result.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cachedTokens: result.usage.cachedTokens,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
    });

    if (request.projectId && result.costUsd !== null) {
      await this.#repos.projects.addSpend(request.projectId, result.costUsd);
    }

    await this.#repos.requestLogs.record({
      provider: result.provider,
      model: result.model,
      agentRole: request.agentRole,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      ok: true,
      latencyMs: result.latencyMs,
      fellBackTo,
    });
  }

  /** Một dòng nhật ký cho mỗi lần gọi hỏng trong chuỗi thử lại / chuyển hãng — đúng hãng, đúng model đã gọi. */
  async #recordAttemptFailure(request: GatewayRequest, failure: AttemptFailure): Promise<void> {
    const llmError = failure.error instanceof LlmError ? failure.error : null;
    await this.#repos.requestLogs.record({
      provider: failure.target.provider,
      model: failure.target.model,
      agentRole: request.agentRole,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      ok: false,
      latencyMs: failure.latencyMs,
      statusCode: llmError?.status ?? null,
      errorKind: llmError?.kind ?? classify(failure.error),
      errorText: truncate(failure.error instanceof Error ? failure.error.message : String(failure.error)),
      retryCount: failure.retry,
    });
  }

  /**
   * Hãng hết tiền: báo CEO qua event (notifier đẩy Telegram), mỗi hãng một lần mỗi đợt né.
   * Gọi từ cả lúc chuyển hãng lẫn lúc hãng cuối chuỗi cũng hết tiền — im lặng là để CEO
   * tưởng công ty đang chạy trong khi mọi lượt đều bị từ chối (6 lượt OpenAI hết credit).
   */
  #alertQuota(provider: AiProviderId, model: string, detail: string, kind: 'quota' | 'auth' = 'quota'): void {
    const now = Date.now();
    const cooldownMs = kind === 'quota' ? QUOTA_COOLDOWN_MS : AUTH_COOLDOWN_MS;
    const key = `${provider}:${kind}`;
    const last = this.#quotaAlerted.get(key);
    if (last !== undefined && now - last < cooldownMs) return;
    this.#quotaAlerted.set(key, now);
    void this.#events.publish('PROVIDER_ALERT', { provider, model, kind, detail: truncate(detail, 300), cooldownMs }, {});
  }

  /** §81 — lỗi cũng phải để lại dấu vết, nhưng chỉ metadata đã redact. */
  async #recordFailure(request: GatewayRequest, error: unknown, latencyMs: number, attemptsLogged: boolean): Promise<void> {
    const llmError = error instanceof LlmError ? error : null;
    if (llmError?.kind === 'quota' || llmError?.kind === 'auth') {
      this.#alertQuota(llmError.provider, this.#router.getRoute(request.agentRole)?.model ?? '', llmError.message, llmError.kind);
    }
    // Từng lần gọi hỏng đã có dòng riêng; ghi thêm dòng tổng là đếm trùng.
    if (attemptsLogged) return;
    const provider = llmError?.provider ?? this.#router.getRoute(request.agentRole)?.provider ?? 'unknown';

    await this.#repos.requestLogs.record({
      provider,
      model: this.#router.getRoute(request.agentRole)?.model ?? null,
      agentRole: request.agentRole,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      ok: false,
      latencyMs,
      statusCode: llmError?.status ?? null,
      errorKind: llmError?.kind ?? classify(error),
      errorText: truncate(error instanceof Error ? error.message : String(error)),
    });
  }

  /** Môi trường đang chạy, dùng cho các route cần biết ngữ cảnh. */
  get environment(): ApiConfig['environment'] {
    return this.#config.environment;
  }
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ước lượng số token đầu vào để router tránh chọn model có context quá nhỏ.
 * Đây chỉ là ước lượng thô (~4 ký tự/token); con số chính xác do provider trả về
 * sau khi gọi và mới là con số được ghi vào `cost_records`.
 */
function estimateTokens(request: GatewayRequest): number {
  const chars =
    (request.system?.length ?? 0) +
    request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(chars / 4);
}

/** Kết quả đến từ một hãng/model khác với lần gọi đã hỏng trước đó → có chuyển hãng. */
function fellBack(failures: readonly AttemptFailure[], result: GenerateResult): boolean {
  return failures.some((failure) => failure.target.provider !== result.provider || failure.target.model !== result.model);
}

function classify(error: unknown): string {
  if (error instanceof ProviderNotConfiguredError) return 'not_configured';
  if (error instanceof NoRouteError) return 'no_route';
  if (error instanceof BudgetExceededError) return 'budget';
  return 'unknown';
}

function truncate(text: string, max = 2000): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
