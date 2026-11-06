/**
 * P&N — Thứ tự hãng + phân bổ model cho 26 nhân viên AI.
 *
 * CEO chỉnh hai thứ trên trang Cài đặt: THỨ TỰ HÃNG (ai nhận việc trước, ai dự phòng) và CÁCH PHÂN BỔ (combo
 * tự động hoặc chọn tay từng vai trò). File này biến hai thứ đó thành bảng định tuyến thật: mỗi vai trò có
 * hãng chính = hãng đầu tiên dùng được trong thứ tự, model = model của hãng đó ở bậc combo chọn, dự phòng =
 * các hãng dùng được còn lại theo đúng thứ tự.
 *
 * Tự phân tích lại khi tập hãng dùng được thay đổi (đăng nhập xong, tắt, xoá key) — `reconcileAllocation`.
 * Hết lượt thì KHÔNG cần ghi lại bảng: bộ định tuyến đã tự né hãng đó 6 giờ và đi sang dự phòng.
 */

import {
  AGENT_ROLES,
  normalizeProviderOrder,
  planAllocation,
  comboFromRoutingMode,
  type AgentRole,
  type AiProviderId,
  type AllocationCombo,
  type AllocationMode,
  type ModelTier,
  type RoleOverride,
  type RoleUsage,
} from '@pn/shared';
import { DEFAULT_ROLE_TIERS, type ModelCatalog } from '@pn/llm';

import type { AppContext } from '../context.js';
import { loadRoutes } from '../context.js';

export const ALLOCATION_KEYS = {
  order: 'routing.order',
  allocation: 'routing.allocation',
  /** Tập hãng dùng được lần phân tích trước — đổi thì phân tích lại. */
  signature: 'routing.providersSignature',
} as const;

/** Phân tích trên 30 ngày gần nhất: đủ dài để có số liệu, đủ ngắn để phản ánh cách dùng hiện tại. */
export const ANALYSIS_WINDOW_DAYS = 30;

export interface AllocationState {
  order: AiProviderId[];
  mode: AllocationMode;
  combo: AllocationCombo;
  overrides: Partial<Record<AgentRole, RoleOverride>>;
  analyzedAt: string | null;
  trigger: string | null;
}

interface StoredAllocation {
  mode?: AllocationMode;
  combo?: AllocationCombo;
  overrides?: Partial<Record<AgentRole, RoleOverride>>;
  analyzedAt?: string | null;
  trigger?: string | null;
}

/**
 * Đọc thứ tự + phân bổ đã lưu. Chưa từng lưu (máy đang chạy từ trước bản này) thì suy ra thứ tự từ bảng định
 * tuyến đang chạy và combo từ chế độ định tuyến cũ — lần phân tích đầu không đảo lộn những gì CEO đã chọn.
 */
export async function readAllocation(context: AppContext): Promise<AllocationState> {
  const env = context.config.environment;
  const [order, stored, legacyMode, routes] = await Promise.all([
    context.repos.settings.get<string[]>(ALLOCATION_KEYS.order),
    context.repos.settings.get<StoredAllocation>(ALLOCATION_KEYS.allocation),
    context.repos.settings.get<string>('routing.mode'),
    context.repos.routes.list(env),
  ]);
  const sample = routes.find((route) => route.agentRole === 'CTO_ORCHESTRATOR') ?? routes[0];
  const fromRoutes = sample ? [sample.provider, ...(sample.fallbacks ?? []).map((target) => target.provider)] : [];
  return {
    order: normalizeProviderOrder(order ?? fromRoutes),
    mode: stored?.mode ?? 'auto',
    combo: stored?.combo ?? comboFromRoutingMode(legacyMode),
    overrides: stored?.overrides ?? {},
    analyzedAt: stored?.analyzedAt ?? null,
    trigger: stored?.trigger ?? null,
  };
}

/**
 * Hãng dùng được: đã nạp client (có key, hoặc CLI đã bật), không bị tắt, và lần kiểm tra gần nhất không báo
 * lỗi. Key vừa dán chưa kiểm tra vẫn tính (như bảng mặc định trước đây); kiểm tra hỏng thì rút ra ngay.
 */
export async function usableProviders(context: AppContext, order: readonly AiProviderId[]): Promise<AiProviderId[]> {
  const rows = await context.repos.providers.list(context.config.environment);
  const blocked = new Set(rows.filter((row) => !row.isEnabled || row.status === 'ERROR').map((row) => row.provider));
  return order.filter((id) => context.registry.has(id) && !blocked.has(id));
}

/** Gộp lượt gọi (api_request_logs) và token/tiền (cost_records) theo vai trò trong cửa sổ phân tích. */
export async function roleUsage(context: AppContext, days = ANALYSIS_WINDOW_DAYS): Promise<RoleUsage[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const [requests, costs] = await Promise.all([context.repos.requestLogs.byRole(since), context.repos.costs.byRole(since)]);
  const valid = new Set<string>(AGENT_ROLES);
  const merged = new Map<AgentRole, RoleUsage>();
  const row = (role: AgentRole): RoleUsage => {
    const existing = merged.get(role) ?? { role, calls: 0, ok: 0, avgLatencyMs: null, tokens: 0, costUsd: 0 };
    merged.set(role, existing);
    return existing;
  };
  for (const r of requests) if (valid.has(r.role)) Object.assign(row(r.role as AgentRole), { calls: r.calls, ok: r.ok, avgLatencyMs: r.avgLatencyMs });
  for (const c of costs) if (valid.has(c.role)) Object.assign(row(c.role as AgentRole), { tokens: c.tokens, costUsd: c.costUsd });
  return [...merged.values()];
}

const NEAREST: Record<ModelTier, ModelTier[]> = {
  strong: ['strong', 'medium', 'cheap'],
  medium: ['medium', 'cheap', 'strong'],
  cheap: ['cheap', 'medium', 'strong'],
};

/**
 * Model của một hãng ở bậc cần dùng (thiếu bậc thì lấy bậc gần nhất). Ưu tiên model có giá: discovery kéo về
 * cả trăm model ảnh/giọng nói không có giá — chọn nhầm là chi phí ghi null và ngân sách không chặn được.
 */
export function pickModel(catalog: ModelCatalog, provider: AiProviderId, tier: ModelTier): { id: string; name: string } | null {
  const all = catalog.list(provider);
  const priced = all.filter((model) => model.pricing !== null);
  const pool = priced.length > 0 ? priced : all;
  for (const candidate of NEAREST[tier]) {
    const found = pool.find((model) => model.tier === candidate);
    if (found) return { id: found.id, name: found.displayName };
  }
  return null;
}

/** Chế độ router tương ứng combo: Chất lượng giữ `quality` (không tự hạ bậc việc tóm tắt), còn lại để nguyên bậc đã ghi. */
const routerModeFor = (combo: AllocationCombo): 'quality' | 'balanced' => (combo === 'quality' ? 'quality' : 'balanced');

/**
 * Ghi lại bảng định tuyến cho cả 26 vai trò theo thứ tự + phân bổ hiện tại. Không có hãng nào dùng được thì
 * giữ nguyên bảng cũ (thà còn đường đi cũ hơn xoá trắng). Trả số vai trò đã ghi.
 */
export async function applyAllocation(context: AppContext, trigger: string, by?: string): Promise<{ written: number; state: AllocationState }> {
  const env = context.config.environment;
  const state = await readAllocation(context);
  const usable = await usableProviders(context, state.order);
  if (usable.length === 0) return { written: 0, state };

  const [usage, smart, routes] = await Promise.all([
    roleUsage(context),
    context.repos.settings.get<boolean>('routing.smart'),
    context.repos.routes.list(env),
  ]);
  const plans = planAllocation({
    usage,
    combo: state.combo,
    defaultTiers: DEFAULT_ROLE_TIERS,
    smartRouting: smart ?? true,
    overrides: state.mode === 'manual' ? state.overrides : {},
  });

  let written = 0;
  for (const role of AGENT_ROLES) {
    const plan = plans[role];
    // Chọn tay một hãng đang không dùng được thì vai trò đi theo thứ tự chung, không kẹt.
    const chain = plan.provider && usable.includes(plan.provider) ? [plan.provider, ...usable.filter((id) => id !== plan.provider)] : usable;
    const targets = chain.flatMap((provider) => {
      const model = pickModel(context.catalog, provider, plan.tier);
      return model ? [{ provider, model: model.id }] : [];
    });
    const [primary, ...fallbacks] = targets;
    if (!primary) continue;
    const existing = routes.find((route) => route.agentRole === role);
    await context.repos.routes.upsert({
      agentRole: role,
      mode: routerModeFor(state.combo),
      tier: plan.tier,
      provider: primary.provider,
      model: primary.model,
      fallbacks,
      maxInputTokens: existing?.maxInputTokens ?? null,
      maxOutputTokens: existing?.maxOutputTokens ?? null,
      environment: env,
    });
    written += 1;
  }

  const analyzedAt = new Date().toISOString();
  const saved: StoredAllocation = { mode: state.mode, combo: state.combo, overrides: state.overrides, analyzedAt, trigger };
  await Promise.all([
    context.repos.settings.set('routing.mode', routerModeFor(state.combo), by),
    context.repos.settings.set(ALLOCATION_KEYS.allocation, saved, by),
    context.repos.settings.set(ALLOCATION_KEYS.order, state.order, by),
    context.repos.settings.set(ALLOCATION_KEYS.signature, [...usable].sort().join(','), by),
  ]);
  await loadRoutes(context);
  return { written, state: { ...state, analyzedAt, trigger } };
}

/**
 * Gọi sau mỗi lần một hãng đổi trạng thái (lưu key, bật/tắt, xoá key, kiểm tra). Chỉ ghi lại bảng khi tập
 * hãng dùng được thật sự đổi, hoặc bảng còn trống — bấm "Kiểm tra" lần hai không được xoá lựa chọn của ai.
 * Trả số vai trò đã ghi, hoặc null khi không cần làm gì.
 */
export async function reconcileAllocation(context: AppContext, trigger: string, by?: string): Promise<number | null> {
  const state = await readAllocation(context);
  const [usable, previous, routes] = await Promise.all([
    usableProviders(context, state.order),
    context.repos.settings.get<string>(ALLOCATION_KEYS.signature),
    context.repos.routes.list(context.config.environment),
  ]);
  if (routes.length > 0 && previous === [...usable].sort().join(',')) return null;
  const { written } = await applyAllocation(context, trigger, by);
  return written > 0 ? written : null;
}

/** Lưu thay đổi CEO bấm trên trang (thứ tự, chế độ, combo, chọn tay) rồi ghi lại bảng ngay. */
export async function saveAllocation(
  context: AppContext,
  patch: { order?: string[]; mode?: AllocationMode; combo?: AllocationCombo; overrides?: Partial<Record<AgentRole, RoleOverride>> },
  trigger: string,
  by?: string,
): Promise<{ written: number }> {
  const state = await readAllocation(context);
  const next: StoredAllocation = {
    mode: patch.mode ?? state.mode,
    combo: patch.combo ?? state.combo,
    overrides: patch.overrides ?? state.overrides,
    analyzedAt: state.analyzedAt,
    trigger: state.trigger,
  };
  await context.repos.settings.set(ALLOCATION_KEYS.allocation, next, by);
  if (patch.order) await context.repos.settings.set(ALLOCATION_KEYS.order, normalizeProviderOrder(patch.order), by);
  const { written } = await applyAllocation(context, trigger, by);
  return { written };
}
