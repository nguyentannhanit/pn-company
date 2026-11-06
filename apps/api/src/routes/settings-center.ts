/**
 * P&N — Số liệu và thao tác cho bốn trang Cài đặt bản 4:
 *   - Kết nối AI: thứ tự hãng, phân bổ model cho nhân viên, mức dùng từng nguồn AI;
 *   - Ngân sách: toàn cảnh chi phí cả tháng theo ngày, hãng, vai trò, dự án;
 *   - Nhật ký: số liệu tổng, tách phần bot lặp máy móc;
 *   - Số đếm trên thanh thẻ Cài đặt.
 * Mọi con số ở đây là truy vấn thật; chỗ nào máy không đo được (hạn mức gói) thì không bịa số.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  AGENT_ROLES,
  AI_PROVIDERS,
  ALLOCATION_COMBOS,
  ALLOCATION_MODES,
  INTEGRATION_KINDS,
  MODEL_TIERS,
  isCliProvider,
  planAllocation,
} from '@pn/shared';
import { DEFAULT_ROLE_TIERS } from '@pn/llm';

import type { AppContext } from '../context.js';
import { loadRoutes } from '../context.js';
import {
  ANALYSIS_WINDOW_DAYS,
  applyAllocation,
  pickModel,
  readAllocation,
  roleUsage,
  saveAllocation,
  usableProviders,
} from '../services/allocation.js';
import { PROVIDER_LABELS } from './api-center.js';

/** Hành động lặp máy móc của bot Telegram (lấy cấu hình mỗi 2 phút) — tách riêng để nhật ký đọc được. */
export const AUDIT_NOISE_ACTIONS = ['POST /internal/telegram/bootstrap', 'TELEGRAM_BOOTSTRAP'];
/** Phí gói thuê bao mỗi tháng (USD) CEO nhập tay; null là chưa nhập. */
const PLAN_FEES_KEY = 'budget.planFees';
type PlanFees = { 'claude-code': number | null; codex: number | null };
/** Hành động đếm theo tháng cho thẻ Telegram. */
const TELEGRAM_ACTIONS = ['TELEGRAM_WEBAPP_LOGIN', 'LOGIN_LINK_ISSUED', 'TELEGRAM_ACCESS_DENIED'];
/** Loại lỗi do phía hãng (quá tải, giới hạn tốc độ, máy chủ hãng, hết lượt) — không phải do model trả lời kém. */
const PROVIDER_SIDE_ERRORS = new Set(['rate_limit', 'overloaded', 'server', 'quota']);

const overrideSchema = z.object({ provider: z.enum(AI_PROVIDERS), tier: z.enum(MODEL_TIERS) });
const allocationPatchSchema = z.object({
  order: z.array(z.enum(AI_PROVIDERS)).max(AI_PROVIDERS.length).optional(),
  mode: z.enum(ALLOCATION_MODES).optional(),
  combo: z.enum(ALLOCATION_COMBOS).optional(),
  overrides: z.record(z.enum(AGENT_ROLES), overrideSchema).optional(),
  smartRouting: z.boolean().optional(),
});

export async function settingsCenterRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const env = context.config.environment;
  const guard = { preHandler: [app.authenticate, app.requireCapability('settings:write')] };
  const read = { preHandler: [app.authenticate, app.requireCapability('settings:read')] };
  const budgetRead = { preHandler: [app.authenticate, app.requireCapability('budget:read')] };
  const budgetWrite = { preHandler: [app.authenticate, app.requireCapability('budget:write')] };
  const auditRead = { preHandler: [app.authenticate, app.requireCapability('audit:read')] };

  /** Toàn bộ số liệu trang Kết nối AI trong một lượt tải. */
  const allocationPayload = async (): Promise<Record<string, unknown>> => {
    const now = Date.now();
    const state = await readAllocation(context);
    const since = (ms: number): Date => new Date(now - ms);
    const [usable, usage, smart, routes, providerRows, month, week, hours5, errorKinds, budget] = await Promise.all([
      usableProviders(context, state.order),
      roleUsage(context),
      context.repos.settings.get<boolean>('routing.smart'),
      context.repos.routes.list(env),
      context.repos.providers.list(env),
      context.repos.requestLogs.byProvider(since(ANALYSIS_WINDOW_DAYS * 86_400_000)),
      context.repos.requestLogs.byProvider(since(7 * 86_400_000)),
      context.repos.requestLogs.byProvider(since(5 * 3_600_000)),
      context.repos.requestLogs.errorKinds(since(ANALYSIS_WINDOW_DAYS * 86_400_000)),
      context.repos.budgets.globalStatus('MONTH'),
    ]);
    const smartRouting = smart ?? true;
    const plans = planAllocation({
      usage,
      combo: state.combo,
      defaultTiers: DEFAULT_ROLE_TIERS,
      smartRouting,
      overrides: state.mode === 'manual' ? state.overrides : {},
    });
    const breakers = context.gateway.breakerSnapshot().filter((b) => b.state !== 'closed');
    const failures = errorKinds.reduce((sum, row) => sum + row.count, 0);

    return {
      ...state,
      smartRouting,
      windowDays: ANALYSIS_WINDOW_DAYS,
      defaultTiers: DEFAULT_ROLE_TIERS,
      usage,
      plans,
      usable,
      totals: {
        calls: month.reduce((sum, row) => sum + row.calls, 0),
        ok: month.reduce((sum, row) => sum + row.ok, 0),
        failures,
        providerSideFailures: errorKinds.filter((row) => PROVIDER_SIDE_ERRORS.has(row.kind)).reduce((sum, row) => sum + row.count, 0),
      },
      budget,
      routes: routes.map((route) => ({ agentRole: route.agentRole, tier: route.tier, provider: route.provider, model: route.model, fallbacks: route.fallbacks })),
      providers: AI_PROVIDERS.map((id) => {
        const row = providerRows.find((p) => p.provider === id);
        const usageIn = (list: typeof month) => list.find((p) => p.provider === id) ?? { calls: 0, ok: 0, avgLatencyMs: null };
        return {
          provider: id,
          label: PROVIDER_LABELS[id],
          kind: isCliProvider(id) ? 'plan' : 'api',
          usable: usable.includes(id),
          isEnabled: row?.isEnabled ?? false,
          status: row?.status ?? 'NOT_CONFIGURED',
          hasKey: Boolean(row?.keyPreview),
          keyPreview: row?.keyPreview ?? null,
          lastError: row?.lastError ?? null,
          lastTestedAt: row?.lastTestedAt ?? null,
          usage: { window: usageIn(month), week: usageIn(week), hours5: usageIn(hours5) },
          // Model của hãng ở từng bậc — trang hiện "Opus / Sonnet / Haiku" thay vì mã bậc.
          models: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, pickModel(context.catalog, id, tier)])),
          breakers: breakers.filter((b) => b.key.startsWith(`${id}:`)),
        };
      }),
    };
  };

  app.get('/api-center/allocation', read, async (_request, reply) => reply.send(await allocationPayload()));

  /** Lưu thứ tự hãng / chế độ / combo / chọn tay / định tuyến thông minh rồi ghi lại bảng định tuyến ngay. */
  app.put('/api-center/allocation', guard, async (request, reply) => {
    const patch = allocationPatchSchema.parse(request.body ?? {});
    const by = request.principal!.email;
    if (patch.smartRouting !== undefined) {
      await context.repos.settings.set('routing.smart', patch.smartRouting, by);
      await loadRoutes(context);
    }
    const what = [
      patch.order && 'thứ tự hãng',
      patch.mode && 'cách phân bổ',
      patch.combo && 'combo',
      patch.overrides && 'chọn tay',
      patch.smartRouting !== undefined && 'định tuyến thông minh',
    ].filter(Boolean);
    const { written } = await saveAllocation(context, patch, `CEO đổi ${what.join(', ') || 'phân bổ'}`, by);
    return reply.send({ written, ...(await allocationPayload()) });
  });

  /** Nút "Phân tích lại": đọc số liệu mới nhất và ghi lại bảng theo combo đang chọn. */
  app.post('/api-center/allocation/analyze', guard, async (request, reply) => {
    const { written } = await applyAllocation(context, 'CEO bấm Phân tích lại', request.principal!.email);
    return reply.send({ written, ...(await allocationPayload()) });
  });

  /** Trang Ngân sách: tiền cả tháng (thật đã trả), phần tính vào hạn mức, chính sách, dự án, phí gói. */
  app.get('/api-center/budget-overview', budgetRead, async (_request, reply) => {
    const [month, globalMonth, policies, countFrom, projects, totals, planFees] = await Promise.all([
      context.repos.costs.monthOverview(),
      context.repos.budgets.globalStatus('MONTH'),
      context.repos.budgets.list(),
      context.repos.costs.countFrom(),
      context.repos.projects.list(),
      context.repos.costs.projectTotals(),
      context.repos.settings.get<PlanFees>(PLAN_FEES_KEY),
    ]);
    return reply.send({
      planFees: planFees ?? { 'claude-code': null, codex: null },
      month,
      globalMonth,
      countFrom,
      policies,
      projects: projects.map((project) => {
        const total = totals.find((row) => row.projectId === project.id);
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          createdAt: project.createdAt,
          budgetUsd: Number(project.budgetUsd),
          spentUsd: total?.costUsd ?? 0,
          calls: total?.calls ?? 0,
        };
      }),
    });
  });

  /**
   * Phí gói thuê bao mỗi tháng do CEO nhập (tuỳ chọn): chỉ để trang Ngân sách cộng ra tổng tiền AI thật sự trả.
   * Không tính vào hạn mức chặn — hạn mức chỉ canh tiền trả theo token.
   */
  app.put('/api-center/plan-fees', budgetWrite, async (request, reply) => {
    const fee = z.number().nonnegative().max(10_000).nullable();
    const fees = z.object({ 'claude-code': fee, codex: fee }).parse(request.body);
    await context.repos.settings.set(PLAN_FEES_KEY, fees, request.principal!.email);
    return reply.send({ planFees: fees });
  });

  /** Số liệu tổng của nhật ký: bot lặp máy móc tách riêng, 5 ngày gần nhất, lỗi, lượt đăng nhập Telegram. */
  app.get('/audit/stats', auditRead, async (request, reply) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(31).default(5) }).parse(request.query);
    const stats = await context.repos.audit.stats(days, AUDIT_NOISE_ACTIONS, TELEGRAM_ACTIONS);
    return reply.send({ ...stats, noiseActions: AUDIT_NOISE_ACTIONS });
  });

  /** Số đếm nhỏ trên thanh thẻ Cài đặt: nguồn AI dùng được, tích hợp đã nối, % hạn mức, tổng nhật ký. */
  app.get('/api-center/settings-summary', read, async (_request, reply) => {
    const state = await readAllocation(context);
    const [usable, integrations, budget, audit] = await Promise.all([
      usableProviders(context, state.order),
      context.repos.integrations.list(env),
      context.repos.budgets.globalStatus('MONTH'),
      context.repos.audit.stats(1, AUDIT_NOISE_ACTIONS, []),
    ]);
    const external = INTEGRATION_KINDS.filter((kind) => kind !== 'AI_PROVIDER');
    return reply.send({
      ai: { usable: usable.length, total: AI_PROVIDERS.length },
      integrations: {
        connected: integrations.filter((row) => row.kind !== 'AI_PROVIDER' && row.status === 'CONNECTED').length,
        total: external.length,
      },
      budget: budget ? { ratio: budget.ratio, warned: budget.warned, exceeded: budget.exceeded } : null,
      audit: { total: audit.total },
    });
  });
}

