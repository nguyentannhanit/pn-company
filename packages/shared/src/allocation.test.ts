/**
 * Kiểm quy tắc phân bổ model: số liệu lấy từ tháng 9/2026 thật (Lập trình giao diện ngốn ~45% token),
 * kết quả mong đợi khớp với thiết kế màn Cài đặt.
 */

import { describe, expect, it } from 'vitest';

import {
  allocationLoad,
  comboFromRoutingMode,
  normalizeProviderOrder,
  planAllocation,
  planRole,
  tierMix,
  type RoleUsage,
} from './allocation.js';
import type { AgentRole, ModelTier } from './enums.js';
import { AGENT_ROLES } from './enums.js';

// Hạng mặc định giống DEFAULT_ROLE_TIERS của @pn/llm (8 mạnh, 14 vừa, 4 nhanh).
const STRONG: AgentRole[] = ['CTO_ORCHESTRATOR', 'SOLUTION_ARCHITECT', 'SECURITY', 'RED_TEAM', 'BACKEND_DEVELOPER', 'FRONTEND_DEVELOPER', 'MOBILE_DEVELOPER', 'KNOWLEDGE_SECURITY_REVIEW'];
const CHEAP: AgentRole[] = ['GITHUB_SCOUT', 'TECHNOLOGY_RADAR', 'SKILL_SCOUT', 'KNOWLEDGE_CURATOR'];
const TIERS = Object.fromEntries(
  AGENT_ROLES.map((role) => [role, STRONG.includes(role) ? 'strong' : CHEAP.includes(role) ? 'cheap' : 'medium']),
) as Record<AgentRole, ModelTier>;

const use = (role: AgentRole, calls: number, tokens: number): RoleUsage => ({ role, calls, ok: calls, avgLatencyMs: 1000, tokens, costUsd: 0 });
const SEPTEMBER: RoleUsage[] = [
  use('FRONTEND_DEVELOPER', 121, 2_218_810),
  use('DEVOPS', 34, 564_236),
  use('SECURITY', 48, 522_762),
  use('PRODUCT_MANAGER', 35, 349_151),
  use('SOLUTION_ARCHITECT', 20, 262_551),
  use('UIUX_DESIGNER', 20, 249_443),
  use('QA', 28, 222_576),
  use('CTO_ORCHESTRATOR', 66, 210_805),
  use('BUSINESS_ANALYST', 19, 153_145),
  use('BACKEND_DEVELOPER', 14, 145_856),
  use('WEB_PRODUCT_LEAD', 4, 34_598),
  use('MOBILE_DEVELOPER', 1, 10_562),
  use('RED_TEAM', 1, 7_626),
  use('TECHNOLOGY_RADAR', 3, 0),
];

describe('Quy tắc từng combo', () => {
  it('Cân bằng giữ đúng hạng theo vai trò: 8 mạnh, 14 vừa, 4 nhanh', () => {
    const plans = planAllocation({ usage: SEPTEMBER, combo: 'balanced', defaultTiers: TIERS, smartRouting: false });
    expect(tierMix(plans)).toEqual([8, 14, 4]);
  });

  it('Tiết kiệm hạ vai trò ngốn từ 10% token và vai trò chưa chạy: 5 mạnh, 8 vừa, 13 nhanh', () => {
    const plans = planAllocation({ usage: SEPTEMBER, combo: 'economy', defaultTiers: TIERS, smartRouting: false });
    expect(plans.FRONTEND_DEVELOPER.tier).toBe('medium');
    expect(plans.FRONTEND_DEVELOPER.reason).toContain('44,8%');
    expect(plans.DEVOPS.tier).toBe('cheap');
    expect(plans.SEO.tier).toBe('cheap');
    expect(plans.KNOWLEDGE_SECURITY_REVIEW.tier).toBe('medium');
    expect(plans.CTO_ORCHESTRATOR.tier).toBe('strong');
    expect(tierMix(plans)).toEqual([5, 8, 13]);
  });

  it('Chất lượng tối đa dùng bậc mạnh cho mọi vai trò', () => {
    const plans = planAllocation({ usage: SEPTEMBER, combo: 'quality', defaultTiers: TIERS, smartRouting: false });
    expect(tierMix(plans)).toEqual([26, 0, 0]);
  });

  it('Tốc độ hạ mọi vai trò một bậc, bậc nhanh giữ nguyên', () => {
    const plans = planAllocation({ usage: SEPTEMBER, combo: 'speed', defaultTiers: TIERS, smartRouting: false });
    expect(tierMix(plans)).toEqual([0, 8, 18]);
    expect(planRole('cheap', undefined, 0, 'speed').tier).toBe('cheap');
  });
});

describe('Định tuyến thông minh và chọn tay', () => {
  it('bật định tuyến thông minh thì vai trò viết code vẫn chạy bậc mạnh, lý do nói rõ', () => {
    const plans = planAllocation({ usage: SEPTEMBER, combo: 'economy', defaultTiers: TIERS, smartRouting: true });
    expect(plans.FRONTEND_DEVELOPER.tier).toBe('medium');
    expect(plans.FRONTEND_DEVELOPER.effectiveTier).toBe('strong');
    expect(plans.FRONTEND_DEVELOPER.reason).toContain('viết code vẫn tự nâng lên bậc mạnh');
    expect(plans.SECURITY.effectiveTier).toBe('medium');
  });

  it('chọn tay đè đúng vai trò đó, vai trò khác vẫn theo combo', () => {
    const plans = planAllocation({
      usage: SEPTEMBER,
      combo: 'balanced',
      defaultTiers: TIERS,
      smartRouting: false,
      overrides: { QA: { provider: 'codex', tier: 'strong' } },
    });
    expect(plans.QA).toMatchObject({ tier: 'strong', provider: 'codex', manual: true });
    expect(plans.PRODUCT_MANAGER).toMatchObject({ tier: 'medium', provider: null, manual: false });
  });

  it('tải hạn mức: Tiết kiệm nhẹ hơn Cân bằng, Chất lượng nặng nhất', () => {
    const load = (combo: 'economy' | 'balanced' | 'quality' | 'speed'): number =>
      allocationLoad(planAllocation({ usage: SEPTEMBER, combo, defaultTiers: TIERS, smartRouting: false }), SEPTEMBER);
    expect(load('economy')).toBeLessThan(load('balanced'));
    expect(load('speed')).toBeLessThan(load('economy'));
    expect(load('quality')).toBeGreaterThan(load('balanced'));
  });
});

describe('Thứ tự hãng', () => {
  it('bỏ hãng lạ và hãng trùng, thêm hãng thiếu vào cuối', () => {
    expect(normalizeProviderOrder(['openai', 'khong-co', 'openai', 'codex'])).toEqual(['openai', 'codex', 'claude-code', 'google', 'anthropic']);
    expect(normalizeProviderOrder(null)).toHaveLength(5);
  });

  it('chế độ cũ custom quy về Cân bằng', () => {
    expect(comboFromRoutingMode('custom')).toBe('balanced');
    expect(comboFromRoutingMode('economy')).toBe('economy');
  });
});
