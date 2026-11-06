/**
 * P&N — API Center / Integration Center (§44–§56, §68, §69, §73, §74, §88).
 *
 * Ba quy tắc chi phối toàn bộ file này:
 *   §88.3 — làm mới trang không bao giờ trả về key thô; chỉ `keyPreview`;
 *   §89   — Test Connection phải gọi thật, không được giả lập kết quả;
 *   §89   — key nhận từ client đi thẳng vào kho secret mã hoá, không lưu nơi khác.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { GitHubClient } from '@pn/github';
import {
  maskSecret,
  redactText,
  modelRouteSchema,
  upsertIntegrationSchema,
  upsertProviderSchema,
  budgetPolicySchema,
  AI_PROVIDERS,
  AGENT_ROLES,
  INTEGRATION_KINDS,
  MODEL_TIERS,
  ROUTING_MODES,
  branding,
  type Environment,
} from '@pn/shared';
import { secretRef } from '@pn/secrets';
import { DEFAULT_ROLE_TIERS, type ModelInfo } from '@pn/llm';

import type { AppContext } from '../context.js';
import { loadModelPricing, loadProviders, loadRoutes } from '../context.js';
import { testIntegration } from '../services/integration-tests.js';
import { reconcileAllocation } from '../services/allocation.js';
import { cancelLogin, cliLoggedIn, loginStatus, startLogin, submitLoginCode } from '../services/cli-login.js';
import { forgetRejectedVoices, prewarmOfficeLines } from '../services/voice.js';

const providerParam = z.object({ provider: z.enum(AI_PROVIDERS) });
const cliParam = z.object({ provider: z.enum(['claude-code', 'codex']) });

/** Tên hiển thị cố định cho từng provider, để UI không tự bịa. Ghi rõ CLI (gói, đăng nhập) hay API (key, trả theo token). */
export const PROVIDER_LABELS: Record<(typeof AI_PROVIDERS)[number], string> = {
  anthropic: 'Claude API (Anthropic)',
  openai: 'OpenAI API',
  google: 'Gemini API',
  'claude-code': 'Claude CLI (gói thuê bao)',
  codex: 'ChatGPT CLI (gói thuê bao)',
};

export async function apiCenterRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const env = context.config.environment;
  const guard = { preHandler: [app.authenticate, app.requireCapability('settings:write')] };
  // Chín khu: xem cấu hình AI chỉ cần nấc Xem; dán/xoá khoá API, token, đăng nhập CLI cần Toàn quyền.
  const read = { preHandler: [app.authenticate, app.requireCapability('settings:read')] };
  const secret = { preHandler: [app.authenticate, app.requireCapability('secrets:write')] };
  const budgetRead = { preHandler: [app.authenticate, app.requireCapability('budget:read')] };
  const budgetWrite = { preHandler: [app.authenticate, app.requireCapability('budget:write')] };

  /* ---------------------------------------------------------------------- */
  /* Provider AI — §45, §46, §47                                             */
  /* ---------------------------------------------------------------------- */

  /** §88.3 — danh sách provider chỉ chứa preview đã mask. */
  app.get('/api-center/providers', read, async (_request, reply) => {
    const providers = await context.repos.providers.list(env);

    // Bổ sung các provider chưa cấu hình để UI hiện đủ ba lựa chọn (§46).
    const configured = new Set(providers.map((p) => p.provider));
    const missing = AI_PROVIDERS.filter((id) => !configured.has(id)).map((id) => ({
      provider: id,
      displayName: PROVIDER_LABELS[id],
      status: 'NOT_CONFIGURED' as const,
      isEnabled: false,
      keyPreview: null,
    }));

    return reply.send({
      providers: providers.map(toSafeProvider),
      unconfigured: missing,
      loaded: context.registry.configured(),
    });
  });

  /**
   * §47 — lưu key. Key đi thẳng vào kho secret; bảng cấu hình chỉ giữ tham chiếu
   * và chuỗi preview. Sau khi lưu, client provider được nạp lại ngay.
   */
  app.put('/api-center/providers/:provider', secret, async (request, reply) => {
    const { provider } = providerParam.parse(request.params);
    const input = upsertProviderSchema.parse({ ...(request.body as object), provider });

    let ref: string | null = null;
    let preview: string | null = null;

    if (input.apiKey) {
      ref = secretRef.aiProvider(provider, env);
      const saved = await context.secrets.set(ref, input.apiKey);
      preview = saved.preview;
    }

    const saved = await context.repos.providers.upsert({
      provider,
      displayName: PROVIDER_LABELS[provider],
      isEnabled: input.isEnabled,
      environment: env,
      keyPreview: preview,
      secretRef: ref,
      baseUrl: input.baseUrl ?? null,
      defaultModel: input.defaultModel ?? null,
    });

    await loadProviders(context);
    // Tập nguồn AI dùng được đổi thì phân tích lại phân bổ model cho 26 vai trò (Cài đặt bản 4).
    await reconcileAllocation(context, `Lưu cấu hình ${PROVIDER_LABELS[provider]}`, request.principal?.email);

    // §88.3 — response không chứa key, chỉ preview.
    return reply.send({ provider: toSafeProvider(saved) });
  });

  /**
   * Xoá hẳn key của một hãng: gỡ khỏi kho secret, xoá tham chiếu, tắt hãng, rút client khỏi
   * bộ nhớ. Bảng định tuyến giữ nguyên để nạp key lại là dùng lại được; trong lúc chờ, router tự bỏ qua
   * hãng không có key và đi sang dự phòng. Trả số vai trò đang lấy hãng này làm hãng chính để UI nhắc.
   */
  app.delete('/api-center/providers/:provider', secret, async (request, reply) => {
    const { provider } = providerParam.parse(request.params);
    const existing = await context.repos.providers.find(provider, env);
    if (!existing?.secretRef) return reply.code(404).send({ error: `${PROVIDER_LABELS[provider]} chưa có key để xoá` });

    await context.secrets.delete(existing.secretRef);
    await context.repos.providers.clearKey(provider, env);
    context.registry.revoke(provider);

    const routes = await context.repos.routes.list(env);
    const primaryRoles = routes.filter((route) => route.provider === provider).map((route) => route.agentRole);
    await reconcileAllocation(context, `Xoá key ${PROVIDER_LABELS[provider]}`, request.principal?.email);
    return reply.send({ ok: true, provider, primaryRoles });
  });

  /** §88.6 — tắt provider mà không xoá cấu hình. */
  app.patch('/api-center/providers/:provider/enabled', guard, async (request, reply) => {
    const { provider } = providerParam.parse(request.params);
    const { isEnabled } = z.object({ isEnabled: z.boolean() }).parse(request.body);

    await context.repos.providers.setEnabled(provider, env, isEnabled);
    if (!isEnabled) context.registry.revoke(provider);
    else await loadProviders(context);
    await reconcileAllocation(context, `${isEnabled ? 'Bật' : 'Tắt'} ${PROVIDER_LABELS[provider]}`, request.principal?.email);

    return reply.send({ ok: true, provider, isEnabled });
  });

  /* ---------------------------------------------------------------------- */
  /* Đăng nhập CLI gói thuê bao từ trang Cài đặt                   */
  /* ---------------------------------------------------------------------- */

  /** CLI trên máy chủ đã đăng nhập chưa + lượt đăng nhập đang chờ (nếu có). */
  app.get('/api-center/providers/:provider/login', read, async (request, reply) => {
    const { provider } = cliParam.parse(request.params);
    return reply.send({ loggedIn: await cliLoggedIn(provider), session: loginStatus(provider) });
  });

  /** Mở lượt đăng nhập. Đang đăng nhập thì từ chối: `codex login` xoá phiên đang có ngay lúc bắt đầu. */
  app.post('/api-center/providers/:provider/login', secret, async (request, reply) => {
    const { provider } = cliParam.parse(request.params);
    if (await cliLoggedIn(provider)) {
      return reply.code(409).send({ error: 'CLI trên máy chủ đang đăng nhập rồi. Đăng nhập lại sẽ xoá phiên đang dùng.' });
    }
    await context.repos.audit.record({
      actor: `user:${request.principal!.id}`,
      action: 'CLI_LOGIN_START',
      targetType: 'ai_provider',
      targetId: provider,
      metadata: {},
      environment: env,
    });
    return reply.send({ session: await startLogin(provider) });
  });

  /** Claude: mã trang đăng nhập hiện ra sau khi CEO đăng nhập — đưa vào CLI đang chờ. */
  app.post('/api-center/providers/:provider/login/code', secret, async (request, reply) => {
    const { provider } = cliParam.parse(request.params);
    const { code } = z.object({ code: z.string().trim().min(8).max(400).regex(/^[!-~]+$/, 'Mã chỉ gồm chữ, số và ký hiệu, không có khoảng trắng') }).parse(request.body);
    const session = submitLoginCode(provider, code);
    if (!session) return reply.code(409).send({ error: 'Không có lượt đăng nhập nào đang chờ mã. Bấm Đăng nhập để mở lượt mới.' });
    return reply.send({ session });
  });

  app.delete('/api-center/providers/:provider/login', secret, async (request, reply) => {
    const { provider } = cliParam.parse(request.params);
    cancelLogin(provider);
    return reply.send({ ok: true });
  });

  /**
   * §48, §89 — Test Connection gọi thật tới provider. Không có nhánh nào trả
   * "ok" mà không có request thực sự đi ra ngoài.
   */
  app.post('/api-center/providers/:provider/test', guard, async (request, reply) => {
    const { provider } = providerParam.parse(request.params);

    if (!context.registry.has(provider)) {
      await context.repos.providers.recordTest(provider, env, {
        ok: false,
        error: 'Chưa cấu hình API key',
      });
      return reply.code(400).send({ ok: false, error: 'Chưa cấu hình API key cho provider này' });
    }

    const raw = await context.registry.get(provider).testConnection();
    // §89 — thông báo lỗi của provider có thể chứa chính API key vừa nhập.
    const result = { ...raw, error: raw.error === null ? null : redactText(raw.error) };

    await context.repos.providers.recordTest(provider, env, {
      ok: result.ok,
      error: result.error,
    });

    // Kết nối xong mà chưa có bảng định tuyến thì tạo luôn. Không có bước này,
    // người dùng cấu hình xong provider rồi giao việc và task chết ngay với lỗi
    // "No model route configured" — họ chỉ thấy màn hình đứng im (§50).
    // Hỏi danh sách model thật và trộn vào catalog trước: provider ngừng cấp tên
    // cũ mà không báo, catalog khởi tạo có thể đã lỗi thời. Discovery hỏng thì
    // vẫn định tuyến từ catalog — thà có bảng còn hơn để task chết im.
    // Từ Cài đặt bản 4: nguồn AI vừa đăng nhập được (hoặc vừa hỏng) thì phân tích lại phân bổ theo thứ tự
    // hãng + combo CEO chọn; bấm Kiểm tra lần nữa mà không có gì đổi thì không đụng tới bảng.
    if (result.ok) await discoverModels(context, provider).catch(() => undefined);
    const written = await reconcileAllocation(
      context,
      `${PROVIDER_LABELS[provider]} ${result.ok ? 'kiểm tra thành công' : 'kiểm tra lỗi'}`,
      request.principal?.email,
    );
    const routingSeeded = result.ok ? written : null;
    // Nguồn vừa chạy được: việc kẹt vì lỗi tạm của nguồn AI chạy lại ngay, không đợi lượt quét 5 phút.
    if (result.ok) {
      void context.orchestrator.autoRetryBlocked({ minAgeMs: 0 }).catch((error: unknown) => request.log.error({ err: error }, 'tự chạy lại lỗi'));
    }

    return reply.send({ ...result, routingSeeded });
  });

  /* ---------------------------------------------------------------------- */
  /* Model — §49, §54                                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/api-center/models', read, async (request, reply) => {
    const { provider } = z.object({ provider: z.enum(AI_PROVIDERS).optional() }).parse(request.query);
    const stored = await context.repos.models.list(provider);

    return reply.send({
      models: stored,
      // Nói rõ model nào chưa có giá để CEO biết cost đang thiếu chỗ nào (§16).
      unpriced: stored.filter((m) => m.inputPerMtok === null).map((m) => m.id),
    });
  });

  /** §49 — hỏi provider xem hiện có model nào, rồi trộn vào catalog. */
  app.post('/api-center/models/discover', guard, async (request, reply) => {
    const { provider } = providerParam.parse(request.body ?? {});
    if (!context.registry.has(provider)) {
      return reply.code(400).send({ error: 'Chưa cấu hình provider này' });
    }

    const discovered = await discoverModels(context, provider);
    return reply.send({ discovered: discovered.length, models: discovered.map((m) => m.id) });
  });

  /** §54 — người vận hành nhập giá cho model mà catalog chưa biết. */
  app.put('/api-center/models/:id/pricing', guard, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(120) }).parse(request.params);
    const pricing = z
      .object({
        inputPerMtok: z.number().nonnegative(),
        outputPerMtok: z.number().nonnegative(),
        cachedInputPerMtok: z.number().nonnegative().nullish(),
      })
      .parse(request.body);

    await context.repos.models.setPricing(id, pricing);
    await loadModelPricing(context);

    // Lượt gọi trước lúc nhập giá đang ghi null: tính lại và cộng vào dự án,
    // để trần ngân sách nhìn thấy cả phần đã tiêu trước đó (§54).
    const repriced = await context.repos.costs.repriceUnpriced(id, pricing);
    for (const row of repriced) {
      if (row.projectId) await context.repos.projects.addSpend(row.projectId, row.costUsd);
    }
    const calls = repriced.reduce((sum, row) => sum + row.calls, 0);

    return reply.send({ ok: true, model: id, repricedCalls: calls });
  });

  /* ---------------------------------------------------------------------- */
  /* Định tuyến — §50, §51, §52, §53                                         */
  /* ---------------------------------------------------------------------- */

  app.get('/api-center/routing', read, async (_request, reply) => {
    const [routes, mode, smart] = await Promise.all([
      context.repos.routes.list(env),
      context.repos.settings.get<string>('routing.mode'),
      context.repos.settings.get<boolean>('routing.smart'),
    ]);

    return reply.send({
      routes,
      mode: mode ?? 'balanced',
      smartRouting: smart ?? true,
      // Gợi ý hạng mặc định theo §15 để UI điền sẵn khi tạo route mới.
      defaultTiers: DEFAULT_ROLE_TIERS,
      roles: AGENT_ROLES,
      tiers: MODEL_TIERS,
      modes: ROUTING_MODES,
    });
  });

  /** §50 — chọn model cho từng agent, kèm chuỗi fallback (§53). */
  app.put('/api-center/routing/:role', guard, async (request, reply) => {
    const { role } = z.object({ role: z.enum(AGENT_ROLES) }).parse(request.params);
    const input = modelRouteSchema.parse({ ...(request.body as object), agentRole: role, environment: env });

    const route = await context.repos.routes.upsert({
      agentRole: input.agentRole,
      mode: input.mode,
      tier: input.tier,
      provider: input.provider,
      model: input.model,
      fallbacks: input.fallbacks,
      maxInputTokens: input.maxInputTokens ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      environment: env,
    });

    await loadRoutes(context);
    return reply.send({ route });
  });

  /** §51, §52 — đổi chế độ routing và bật/tắt smart routing cho toàn hệ thống. */
  app.put('/api-center/routing-mode', guard, async (request, reply) => {
    const input = z
      .object({ mode: z.enum(ROUTING_MODES), smartRouting: z.boolean().optional() })
      .parse(request.body);

    await context.repos.settings.set('routing.mode', input.mode, request.principal!.email);
    if (input.smartRouting !== undefined) {
      await context.repos.settings.set('routing.smart', input.smartRouting, request.principal!.email);
    }
    await loadRoutes(context);

    return reply.send({ mode: input.mode, smartRouting: input.smartRouting ?? true });
  });

  /* ---------------------------------------------------------------------- */
  /* Tích hợp ngoài — §57–§67                                                */
  /* ---------------------------------------------------------------------- */

  app.get('/api-center/integrations', read, async (_request, reply) => {
    const integrations = await context.repos.integrations.list(env);
    const configured = new Set(integrations.map((i) => i.kind));

    return reply.send({
      integrations: integrations.map((integration) => ({
        ...integration,
        // Không trả `secretRefs` ra ngoài — chỉ cần biết đã có secret hay chưa.
        secretRefs: undefined,
        hasSecrets: integration.secretRefs.length > 0,
      })),
      unconfigured: INTEGRATION_KINDS.filter((kind) => !configured.has(kind)),
    });
  });

  /**
   * §57–§67 — lưu cấu hình tích hợp. Phần `settings` là dữ liệu thường; phần
   * `secrets` được tách ra đưa vào kho mã hoá và chỉ còn lại tham chiếu.
   */
  app.put('/api-center/integrations/:kind', secret, async (request, reply) => {
    const { kind } = z.object({ kind: z.enum(INTEGRATION_KINDS) }).parse(request.params);
    const input = upsertIntegrationSchema.parse({ ...(request.body as object), kind });

    const refs: string[] = [];
    for (const [name, value] of Object.entries(input.secrets)) {
      if (!value) continue;
      const ref = secretRef.integration(kind, name, env);
      await context.secrets.set(ref, value);
      refs.push(ref);
    }

    const existing = await context.repos.integrations.find(kind, env);
    const saved = await context.repos.integrations.upsert({
      kind,
      displayName: kind,
      isEnabled: input.isEnabled,
      settings: input.settings,
      // Giữ lại ref cũ nếu lần này người dùng không nhập lại secret.
      secretRefs: refs.length > 0 ? refs : (existing?.secretRefs ?? []),
      environment: env,
    });

    // §58 — người lưu cấu hình Telegram chính là người sẽ ra lệnh qua chat đó:
    // gắn Chat ID đầu tiên vào tài khoản này ngay, khỏi thêm một bước "gắn".
    // Giọng nói: đổi giọng/tốc độ là đổi khoá đệm — đọc sẵn lại các câu văn phòng bằng cấu hình mới (chạy nền).
    if (kind === 'VOICE') {
      forgetRejectedVoices();
      void prewarmOfficeLines(context, (message) => app.log.info({ msg: message })).catch(() => undefined);
    }

    if (kind === 'TELEGRAM' && request.principal) {
      const [first] = (input.settings as { allowedChatIds?: string[] }).allowedChatIds ?? [];
      if (first && !(await context.repos.users.findByTelegramChatId(first))) {
        await context.repos.users.linkTelegramChat(request.principal.id, first);
      }
    }

    return reply.send({
      integration: { ...saved, secretRefs: undefined, hasSecrets: saved.secretRefs.length > 0 },
    });
  });

  /** §48 — Test Connection cho tích hợp: mọi loại đều gọi thật, không có kết quả giả. */
  app.post('/api-center/integrations/:kind/test', guard, async (request, reply) => {
    const { kind } = z.object({ kind: z.enum(INTEGRATION_KINDS) }).parse(request.params);

    if (kind === 'GITHUB') {
      const client = await context.github();
      if (!client) {
        await context.repos.integrations.recordTest(kind, env, { ok: false, error: 'Chưa cấu hình token' });
        return reply.code(400).send({ ok: false, error: 'Chưa cấu hình GitHub token' });
      }
      const raw = await client.testConnection();
      const result = { ...raw, error: raw.error === null ? null : redactText(raw.error) };
      await context.repos.integrations.recordTest(kind, env, result);
      return reply.send(result);
    }

    if (kind === 'DATABASE') {
      const health = await context.db.healthCheck();
      await context.repos.integrations.recordTest(kind, env, { ok: health.ok, error: health.error });
      return reply.send(health);
    }

    if (kind === 'TELEGRAM') {
      const result = await testTelegram(context, env);
      await context.repos.integrations.recordTest(kind, env, result);
      return reply.code(result.ok ? 200 : 400).send(result);
    }

    // Các loại còn lại gọi thật tới dịch vụ ngoài (services/integration-tests.ts).
    const result = await testIntegration(context, kind, env);
    await context.repos.integrations.recordTest(kind, env, { ok: result.ok, error: result.error });
    return reply.code(result.ok ? 200 : 400).send(result);
  });

  /* ---------------------------------------------------------------------- */
  /* Ngân sách — §54, §55                                                    */
  /* ---------------------------------------------------------------------- */

  app.get('/api-center/budgets', budgetRead, async (_request, reply) => {
    const [policies, month] = await Promise.all([
      context.repos.budgets.list(),
      context.repos.budgets.globalStatus('MONTH'),
    ]);
    return reply.send({ policies, globalMonth: month });
  });

  app.put('/api-center/budgets', budgetWrite, async (request, reply) => {
    const input = budgetPolicySchema.parse(request.body);
    await context.repos.budgets.upsert({
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      limitUsd: input.limitUsd,
      period: input.period,
      warnThreshold: input.warnThreshold,
      hardStop: input.hardStop,
    });
    return reply.send({ ok: true });
  });

  /* ---------------------------------------------------------------------- */
  /* Sức khoẻ hệ thống — §68, §74                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * §74 — bảng kiểm tra hệ thống đã sẵn sàng chưa. Mỗi mục là một phép kiểm tra
   * thật (query database, gọi provider đã nạp, ghi thử vào thư mục sandbox).
   */
  app.get('/api-center/health', { preHandler: app.authenticate }, async (_request, reply) => {
    const [dbHealth, sandboxHealth, providerHealth, integrations, userCount, routes] =
      await Promise.all([
        context.db.healthCheck(),
        context.sandbox.healthCheck(),
        context.repos.requestLogs.health(24),
        context.repos.integrations.list(env),
        context.repos.users.count(),
        context.repos.routes.list(env),
      ]);

    const providers = await context.repos.providers.list(env);
    // §16, §54 — model chưa có giá thì chi phí ghi null và trần ngân sách không
    // chặn được gì. Một demo đã tiêu 190 nghìn token với "$0" trên màn hình.
    const unpriced = [
      ...new Set(
        routes
          .map((route) => route.model)
          .filter((model) => context.catalog.get(model)?.pricing == null),
      ),
    ];
    const checks = [
      { id: 'database', label: 'Database', ok: dbHealth.ok, detail: dbHealth.error ?? `${dbHealth.latencyMs}ms` },
      { id: 'sandbox', label: 'Sandbox', ok: sandboxHealth.ok, detail: sandboxHealth.detail },
      {
        id: 'ai_provider',
        label: 'AI Provider',
        ok: context.registry.configured().length > 0,
        detail: context.registry.configured().length > 0
          ? `Đã nạp: ${context.registry.configured().join(', ')}`
          : 'Chưa cấu hình provider AI nào',
      },
      {
        id: 'routing',
        label: 'Định tuyến model',
        ok: routes.length > 0,
        // Báo đỏ mà không nói cách sửa thì người dùng phải đi hỏi. Bảng định
        // tuyến tự tạo khi Test Connection thành công lần đầu, nhưng không ai
        // đoán ra điều đó — nên nói thẳng.
        detail:
          routes.length > 0
            ? `${routes.length} route đang hoạt động`
            : context.registry.configured().length > 0
              ? 'Đã có API key nhưng chưa có bảng định tuyến. Vào Cài đặt → AI Providers, ' +
                'bấm "Test Connection" — bảng sẽ tự tạo.'
              : 'Chưa có provider nào. Vào Cài đặt → AI Providers, dán API key rồi Test Connection.',
      },
      {
        id: 'accounts',
        label: 'Tài khoản',
        ok: userCount > 0,
        detail: `${userCount} tài khoản`,
      },
    ];

    if (routes.length > 0) {
      checks.push({
        id: 'pricing',
        label: 'Giá model',
        ok: unpriced.length === 0,
        detail:
          unpriced.length === 0
            ? 'Mọi model đang định tuyến đều có giá'
            : `${unpriced.length} model đang định tuyến chưa có giá (${unpriced.join(', ')}): chi phí ` +
              'ghi $0 và trần ngân sách không chặn được. Nhập giá ở bảng Model (§54).',
      });
    }

    // §23, §74 — chỉ có ý nghĩa khi chạy qua Redis. Không có Redis thì API tự
    // chạy agent và không có gì để hỏi.
    if (context.jobQueue) {
      const queue = await context.jobQueue.health();
      checks.push({
        id: 'queue',
        label: 'Hàng đợi công việc',
        ok: queue.ok,
        detail: queue.detail,
      });
    }

    return reply.send({
      company: branding.companyName,
      environment: env,
      ready: checks.every((check) => check.ok),
      checks,
      providers: providers.map(toSafeProvider),
      integrations: integrations.map((i) => ({ kind: i.kind, status: i.status, lastError: i.lastError })),
      // §80 — cầu dao nào đang mở thì hiện ra, đó là tín hiệu provider đang có vấn đề.
      circuitBreakers: context.gateway.breakerSnapshot(),
      providerCalls24h: providerHealth,
      sandboxEnforcement: context.sandbox.enforcement,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Setup wizard — §73                                                      */
  /* ---------------------------------------------------------------------- */

  /** Trạng thái từng bước của wizard, để UI biết còn thiếu gì. */
  app.get('/setup/status', async (_request, reply) => {
    const [userCount, providers, routes, integrations] = await Promise.all([
      context.repos.users.count(),
      context.repos.providers.list(env),
      context.repos.routes.list(env),
      context.repos.integrations.list(env),
    ]);
    const dbHealth = await context.db.healthCheck();

    const steps = [
      { id: 'database', label: 'Kết nối database', done: dbHealth.ok },
      { id: 'account', label: 'Tạo tài khoản CEO', done: userCount > 0 },
      {
        id: 'provider',
        label: 'Cấu hình AI Provider',
        done: providers.some((p) => p.status === 'CONNECTED'),
      },
      { id: 'routing', label: 'Định tuyến model cho agent', done: routes.length > 0 },
      {
        id: 'telegram',
        label: 'Kết nối Telegram',
        done: integrations.some((i) => i.kind === 'TELEGRAM' && i.status === 'CONNECTED'),
      },
      {
        id: 'github',
        label: 'Kết nối GitHub',
        done: integrations.some((i) => i.kind === 'GITHUB' && i.status === 'CONNECTED'),
      },
    ];

    return reply.send({
      welcome: branding.welcomeHeadline,
      company: branding.companyName,
      tagline: branding.companyTagline,
      completed: steps.every((step) => step.done),
      steps,
    });
  });

  /**
   * §15, §50 — điền sẵn bảng định tuyến mặc định cho toàn bộ agent, dùng đúng
   * hạng model mà spec đề nghị. Giúp wizard xong nhanh mà vẫn đúng nguyên tắc
   * "không dùng model mạnh nhất cho mọi việc".
   */
  app.post('/setup/seed-routing', guard, async (request, reply) => {
    const { provider } = providerParam.parse(request.body ?? {});
    if (!context.registry.has(provider)) {
      return reply.code(400).send({ error: 'Provider chưa được cấu hình, không thể tạo route' });
    }

    const result = await seedRouting(context, provider);
    if (!result.ok) return reply.code(400).send({ error: result.error });

    return reply.send({ created: result.created, provider, models: result.models });
  });
}

/* -------------------------------------------------------------------------- */
/* Test Connection cho Telegram — §48, §57                                     */
/* -------------------------------------------------------------------------- */

/**
 * Gọi `getMe` bằng token đã lưu. Đây là phép thử thật: token sai thì Telegram
 * trả 401 và ta nói đúng câu nó nói, không tự bịa ra kết quả (§89).
 *
 * Thông báo lỗi đi qua redaction vì token nằm trong URL, và Telegram có trả lại
 * nguyên URL trong một số lỗi mạng.
 */
async function testTelegram(
  context: AppContext,
  env: Environment,
): Promise<{ ok: boolean; detail?: string; error: string | null }> {
  const ref = secretRef.integration('TELEGRAM', 'botToken', env);
  const token = await context.secrets.reveal(ref).catch(() => null);
  if (!token) return { ok: false, error: 'Chưa lưu bot token trong API Center' };

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as {
      ok?: boolean;
      result?: { username?: string };
      description?: string;
    };

    if (!response.ok || !body.ok) {
      return { ok: false, error: redactText(body.description ?? `HTTP ${response.status}`) };
    }
    return { ok: true, detail: `Bot @${body.result?.username ?? 'không rõ tên'}`, error: null };
  } catch (error) {
    return { ok: false, error: redactText(error instanceof Error ? error.message : String(error)) };
  }
}

/* -------------------------------------------------------------------------- */
/* Tạo bảng định tuyến mặc định — §15, §50                                     */
/* -------------------------------------------------------------------------- */

export type SeedRoutingResult =
  | { ok: true; created: number; models: Record<string, string | null> }
  | { ok: false; error: string };

type Tier = (typeof MODEL_TIERS)[number];

/** §49 — hỏi provider model nào đang có thật, trộn vào catalog và lưu bảng model. */
export async function discoverModels(
  context: AppContext,
  provider: (typeof AI_PROVIDERS)[number],
): Promise<ModelInfo[]> {
  const discovered = await context.registry.get(provider).listModels();
  context.catalog.upsert(discovered);
  // Ghi xuống bản đã trộn: discovery không có giá, catalog có — bảng model
  // phải phản ánh đúng giá mà gateway đang tính.
  const merged = discovered.map((model) => context.catalog.get(model.id) ?? model);
  await context.repos.models.upsertMany(
    merged.map((model) => ({
      id: model.id,
      provider: model.provider,
      displayName: model.displayName,
      tier: model.tier,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      inputPerMtok: model.pricing?.inputPerMTok ?? null,
      outputPerMtok: model.pricing?.outputPerMTok ?? null,
      cachedInputPerMtok: model.pricing?.cachedInputPerMTok ?? null,
      pricingSource: model.pricingSource,
      pricingAsOf: model.pricingAsOf,
      isAvailable: true,
    })),
  );
  return discovered;
}

/**
 * Gán model cho toàn bộ vai trò agent theo đúng hạng mà §15 đề nghị: CTO và
 * Architect dùng hạng mạnh, PM và QA hạng trung, việc cơ học hạng rẻ.
 *
 * Tách thành hàm riêng vì nó được gọi từ hai chỗ: nút bấm trong Cài đặt, và
 * TỰ ĐỘNG ngay sau khi một provider kết nối thành công. Lý do phải tự động:
 * người dùng cấu hình xong provider rồi giao việc, và task chết với lỗi
 * "No model route configured" nằm khuất trong luồng tin nhắn — họ chỉ thấy
 * "chẳng có gì xảy ra". Một bước bắt buộc mà không ai biết là một bước sai.
 */
export async function seedRouting(
  context: AppContext,
  provider: (typeof AI_PROVIDERS)[number],
  models: readonly ModelInfo[] = context.catalog.list(provider),
): Promise<SeedRoutingResult> {
  const env = context.config.environment;
  // Thiếu hạng nào thì lấy hạng gần nhất: provider chỉ có model hạng trung vẫn
  // phải định tuyến được; CEO đổi lại sau trong API Center.
  const NEAREST: Record<Tier, Tier[]> = {
    strong: ['strong', 'medium', 'cheap'],
    medium: ['medium', 'cheap', 'strong'],
    cheap: ['cheap', 'medium', 'strong'],
  };
  const pick = (tier: Tier): string | null =>
    NEAREST[tier]
      .map((candidate) => models.find((model) => model.tier === candidate)?.id)
      .find((id) => id !== undefined) ?? null;

  const chosen = { strong: pick('strong'), medium: pick('medium'), cheap: pick('cheap') };
  if (!chosen.strong) {
    return {
      ok: false,
      error: `${provider} không có model nào để định tuyến. Hãy chạy Model Discovery trước.`,
    };
  }

  // Dự phòng khác hãng (Anthropic rồi OpenAI; Gemini miễn phí đứng trước nếu nó là hãng
  // phụ): mỗi hãng đã có key góp một model cùng hạng. Trước đây bảng mặc định chỉ có một hãng, Gemini
  // nghẽn là cả công ty kẹt dù key hãng khác đã nhập.
  // Gói thuê bao (CLI) đứng trước: không tính theo token; hết lượt thì router lùi tiếp sang API.
  const FALLBACK_ORDER: Array<(typeof AI_PROVIDERS)[number]> = ['claude-code', 'codex', 'google', 'anthropic', 'openai'];
  const fallbackFor = (tier: Tier): Array<{ provider: (typeof AI_PROVIDERS)[number]; model: string }> =>
    FALLBACK_ORDER.filter((other) => other !== provider && context.registry.has(other)).flatMap((other) => {
      const list = context.catalog.list(other);
      const id = NEAREST[tier].map((candidate) => list.find((m) => m.tier === candidate)?.id).find((x) => x !== undefined);
      return id ? [{ provider: other, model: id }] : [];
    });

  let created = 0;
  for (const role of AGENT_ROLES) {
    const tier = DEFAULT_ROLE_TIERS[role];
    const model = chosen[tier] ?? chosen.strong;
    await context.repos.routes.upsert({
      agentRole: role,
      mode: 'balanced',
      tier,
      provider,
      model,
      fallbacks: fallbackFor(tier),
      maxInputTokens: null,
      maxOutputTokens: null,
      environment: env,
    });
    created += 1;
  }

  await loadRoutes(context);
  return { ok: true, created, models: chosen };
}

/**
 * §88.3 — hàm duy nhất được dùng để serialize cấu hình provider ra ngoài.
 * Nó cố tình bỏ `secretRef` và không bao giờ chạm tới key thật.
 */
function toSafeProvider(provider: {
  id: string;
  provider: string;
  displayName: string;
  isEnabled: boolean;
  status: string;
  keyPreview: string | null;
  baseUrl: string | null;
  defaultModel: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  environment: string;
}): Record<string, unknown> {
  return {
    id: provider.id,
    provider: provider.provider,
    displayName: provider.displayName,
    isEnabled: provider.isEnabled,
    status: provider.status,
    keyPreview: provider.keyPreview,
    hasKey: provider.keyPreview !== null,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    lastTestedAt: provider.lastTestedAt,
    lastError: provider.lastError,
    environment: provider.environment,
  };
}

export { maskSecret, GitHubClient };
