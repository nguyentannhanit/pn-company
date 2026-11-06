/**
 * P&N — Phân bổ model cho nhân viên AI.
 *
 * Một nguồn quy tắc dùng chung cho hai nơi: API ghi bảng định tuyến theo quy tắc này, còn trang Cài đặt
 * dùng đúng hàm này để xem trước bốn combo trước khi CEO bấm. Lệch nhau là trang hứa một đằng, máy chạy
 * một nẻo — nên quy tắc chỉ được viết ở đây.
 *
 * Bậc model: `strong` (mạnh), `medium` (vừa), `cheap` (nhanh). Hãng nào nhận việc do thứ tự hãng quyết định;
 * combo chỉ quyết định mỗi vai trò dùng bậc nào.
 */

import { AGENT_ROLES, AI_PROVIDERS, type AgentRole, type AiProviderId, type ModelTier } from './enums.js';

/* -------------------------------------------------------------------------- */
/* Combo và chế độ                                                             */
/* -------------------------------------------------------------------------- */

export const ALLOCATION_COMBOS = ['economy', 'balanced', 'quality', 'speed'] as const;
export type AllocationCombo = (typeof ALLOCATION_COMBOS)[number];

/** Tự động: máy chọn bậc theo combo. Thủ công: CEO chọn hẳn hãng + bậc cho từng vai trò muốn sửa. */
export const ALLOCATION_MODES = ['auto', 'manual'] as const;
export type AllocationMode = (typeof ALLOCATION_MODES)[number];

export const COMBO_INFO: Record<AllocationCombo, { name: string; description: string }> = {
  economy: {
    name: 'Tiết kiệm hạn mức',
    description: 'Vai trò ngốn từ 10% token trở lên hạ một bậc. Vai trò chưa chạy lần nào dùng bậc rẻ hơn.',
  },
  balanced: {
    name: 'Cân bằng',
    description: 'Theo độ khó từng vai trò: việc khó dùng model mạnh, việc nhẹ dùng model nhanh.',
  },
  quality: {
    name: 'Chất lượng tối đa',
    description: 'Mọi vai trò dùng model mạnh nhất, kể cả việc tóm tắt. Hạn mức gói hết nhanh nhất.',
  },
  speed: {
    name: 'Tốc độ',
    description: 'Mọi vai trò hạ một bậc để trả lời nhanh hơn. Hợp khi cần bản nháp gấp.',
  },
};

export const TIER_NAME: Record<ModelTier, string> = { strong: 'mạnh', medium: 'vừa', cheap: 'nhanh' };

/** Thứ tự hãng mặc định: gói thuê bao trước (không tính theo token), rồi API. */
export const DEFAULT_PROVIDER_ORDER: readonly AiProviderId[] = ['claude-code', 'codex', 'google', 'anthropic', 'openai'];

/** Giữ hãng hợp lệ, bỏ trùng, hãng còn thiếu nối vào cuối theo thứ tự mặc định — lưu hỏng cũng không mất hãng. */
export function normalizeProviderOrder(order: readonly string[] | null | undefined): AiProviderId[] {
  const valid = new Set<string>(AI_PROVIDERS);
  const seen = new Set<AiProviderId>();
  for (const id of order ?? []) if (valid.has(id)) seen.add(id as AiProviderId);
  for (const id of DEFAULT_PROVIDER_ORDER) seen.add(id);
  return [...seen];
}

/* -------------------------------------------------------------------------- */
/* Số liệu dùng để phân tích                                                   */
/* -------------------------------------------------------------------------- */

/** Mức dùng của một vai trò trong cửa sổ phân tích (mặc định 30 ngày). */
export interface RoleUsage {
  role: AgentRole;
  calls: number;
  ok: number;
  avgLatencyMs: number | null;
  /** Token vào + ra đã ghi chi phí. */
  tokens: number;
  costUsd: number;
}

/** Ngưỡng "ngốn token": từ 10% tổng token trở lên thì combo Tiết kiệm hạ một bậc. */
export const HEAVY_TOKEN_SHARE = 0.1;

/** Phần token của từng vai trò trên tổng; tổng bằng 0 thì mọi vai trò là 0. */
export function tokenShares(usage: readonly RoleUsage[]): Map<AgentRole, number> {
  const total = usage.reduce((sum, row) => sum + row.tokens, 0);
  return new Map(usage.map((row) => [row.role, total > 0 ? row.tokens / total : 0]));
}

/** "44,8%" — phần trăm một chữ số thập phân kiểu Việt. */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1).replace('.', ',')}%`;
}

const TIERS: readonly ModelTier[] = ['strong', 'medium', 'cheap'];
const oneDown = (tier: ModelTier): ModelTier => TIERS[Math.min(2, TIERS.indexOf(tier) + 1)]!;

/* -------------------------------------------------------------------------- */
/* Định tuyến thông minh tự nâng bậc                                           */
/* -------------------------------------------------------------------------- */

/**
 * Vai trò mà bộ định tuyến tự nâng lên bậc mạnh khi "định tuyến thông minh" bật (router.ts §52): các agent
 * này gửi kèm loại việc code / debugging / architecture_review, và loại việc đó có sàn là bậc mạnh. Phải nói
 * rõ trên trang, không thì combo Tiết kiệm hứa hạ bậc mà thực tế vẫn chạy model mạnh.
 */
export const SMART_RAISE: Partial<Record<AgentRole, string>> = {
  CTO_ORCHESTRATOR: 'rà kiến trúc',
  SOLUTION_ARCHITECT: 'rà kiến trúc',
  FRONTEND_DEVELOPER: 'viết code',
  BACKEND_DEVELOPER: 'viết code',
  MOBILE_DEVELOPER: 'viết code',
  DEVOPS: 'viết code',
  QA: 'tìm lỗi',
};

/* -------------------------------------------------------------------------- */
/* Quy tắc từng combo                                                          */
/* -------------------------------------------------------------------------- */

/** Bậc theo combo cho một vai trò, kèm lý do viết từ số liệu để CEO đọc là hiểu. */
export function planRole(
  defaultTier: ModelTier,
  usage: RoleUsage | undefined,
  share: number,
  combo: AllocationCombo,
): { tier: ModelTier; reason: string } {
  const calls = usage?.calls ?? 0;
  if (combo === 'quality') return { tier: 'strong', reason: 'Ưu tiên chất lượng, dùng bậc mạnh' };
  if (combo === 'speed') {
    return defaultTier === 'cheap'
      ? { tier: 'cheap', reason: 'Đã ở bậc nhanh nhất' }
      : { tier: oneDown(defaultTier), reason: 'Hạ một bậc để trả lời nhanh hơn' };
  }
  if (combo === 'economy') {
    if (share >= HEAVY_TOKEN_SHARE) return { tier: oneDown(defaultTier), reason: `Ngốn ${formatShare(share)} token, hạ một bậc` };
    if (calls === 0) {
      return defaultTier === 'cheap'
        ? { tier: 'cheap', reason: 'Việc nhẹ, bậc nhanh' }
        : { tier: oneDown(defaultTier), reason: 'Chưa chạy lần nào trong kỳ, dùng bậc rẻ hơn' };
    }
    return {
      tier: defaultTier,
      reason: share > 0 ? `Dùng ít (${formatShare(share)} token), giữ bậc theo vai trò` : 'Giữ bậc theo vai trò',
    };
  }
  const base = { strong: 'Việc khó theo vai trò, bậc mạnh', medium: 'Việc vừa, bậc vừa', cheap: 'Việc nhẹ và lặp lại, bậc nhanh' }[defaultTier];
  return { tier: defaultTier, reason: share >= HEAVY_TOKEN_SHARE ? `${base} · dùng ${formatShare(share)} token` : base };
}

/** Lựa chọn tay của CEO cho một vai trò (chế độ Thủ công). */
export interface RoleOverride {
  provider: AiProviderId;
  tier: ModelTier;
}

export interface RolePlan {
  /** Bậc ghi vào bảng định tuyến. */
  tier: ModelTier;
  /** Bậc thật sự chạy sau khi định tuyến thông minh nâng (nếu bật). */
  effectiveTier: ModelTier;
  reason: string;
  /** Loại việc khiến bộ định tuyến tự nâng bậc, null nếu không nâng. */
  raisedFor: string | null;
  /** Hãng chọn tay; null là theo thứ tự hãng chung. */
  provider: AiProviderId | null;
  manual: boolean;
}

/** Phân bổ cho cả 26 vai trò. Chế độ Thủ công chỉ đè những vai trò có trong `overrides`. */
export function planAllocation(input: {
  usage: readonly RoleUsage[];
  combo: AllocationCombo;
  defaultTiers: Record<AgentRole, ModelTier>;
  smartRouting: boolean;
  overrides?: Partial<Record<AgentRole, RoleOverride>>;
}): Record<AgentRole, RolePlan> {
  const shares = tokenShares(input.usage);
  const byRole = new Map(input.usage.map((row) => [row.role, row]));
  const plans = {} as Record<AgentRole, RolePlan>;
  for (const role of AGENT_ROLES) {
    const override = input.overrides?.[role];
    const planned = override
      ? { tier: override.tier, reason: 'Chọn tay' }
      : planRole(input.defaultTiers[role], byRole.get(role), shares.get(role) ?? 0, input.combo);
    const raise = input.smartRouting ? (SMART_RAISE[role] ?? null) : null;
    const raised = raise !== null && planned.tier !== 'strong';
    plans[role] = {
      tier: planned.tier,
      effectiveTier: raised ? 'strong' : planned.tier,
      reason: raised ? `${planned.reason} · việc ${raise} vẫn tự nâng lên bậc mạnh` : planned.reason,
      raisedFor: raised ? raise : null,
      provider: override?.provider ?? null,
      manual: Boolean(override),
    };
  }
  return plans;
}

/** Hệ số tiêu hao hạn mức ước tính theo bậc (mạnh 5, vừa 3, nhanh 1) — theo tỉ lệ giá API quy đổi. */
const LOAD_WEIGHT: Record<ModelTier, number> = { strong: 5, medium: 3, cheap: 1 };

/** Tải lên hạn mức gói: tổng phần token × hệ số bậc thật sự chạy. Chỉ dùng để so sánh giữa các combo. */
export function allocationLoad(plans: Record<AgentRole, RolePlan>, usage: readonly RoleUsage[]): number {
  const shares = tokenShares(usage);
  return AGENT_ROLES.reduce((sum, role) => sum + (shares.get(role) ?? 0) * LOAD_WEIGHT[plans[role].effectiveTier], 0);
}

/** Đếm số vai trò theo bậc thật sự chạy: [mạnh, vừa, nhanh]. */
export function tierMix(plans: Record<AgentRole, RolePlan>): [number, number, number] {
  const mix: [number, number, number] = [0, 0, 0];
  for (const role of AGENT_ROLES) mix[TIERS.indexOf(plans[role].effectiveTier) as 0 | 1 | 2] += 1;
  return mix;
}

/** Combo từ chế độ định tuyến cũ (quality/balanced/economy/custom) để lần đầu giữ đúng lựa chọn trước đây. */
export function comboFromRoutingMode(mode: string | null | undefined): AllocationCombo {
  return mode === 'quality' || mode === 'economy' ? mode : 'balanced';
}
