/**
 * §3.1–§3.12 — bộ agent lõi phải phủ đủ mười hai vai trò, và mỗi agent phải
 * khai đúng phòng ban của mình.
 *
 * Không có test này thì việc thêm một vai trò vào enum mà quên viết agent cho
 * nó chỉ lộ ra lúc chạy thật, dưới dạng task bị chặn với lời nhắn "chưa được
 * triển khai" — nghĩa là người dùng phát hiện hộ.
 */

import { describe, expect, it } from 'vitest';

import { CORE_AGENT_ROLES, agentProfile } from '@pn/shared';

import { AGENT_PROMPTS } from './prompts.js';
import { coreAgents, planSchema, webAgents } from './roles.js';

describe('bộ agent lõi (§3)', () => {
  const agents = coreAgents();

  it('phủ đủ mười hai vai trò lõi, không thừa không thiếu', () => {
    const covered = agents.map((agent) => agent.definition.role).sort();
    expect(covered).toEqual([...CORE_AGENT_ROLES].sort());
  });

  it('không đăng ký trùng vai trò', () => {
    const roles = agents.map((agent) => agent.definition.role);
    expect(new Set(roles).size).toBe(roles.length);
  });

  it('khai đúng phòng ban và tên hiển thị của vai trò', () => {
    for (const agent of agents) {
      const profile = agentProfile(agent.definition.role);
      expect(agent.definition.department).toBe(profile.department);
      expect(agent.definition.displayName).toBe(profile.displayName);
    }
  });

  it('mỗi vai trò có prompt riêng', () => {
    for (const agent of agents) {
      expect(AGENT_PROMPTS[agent.definition.promptRole]).toBeTypeOf('string');
    }
  });

  it('chỉ vai trò thật sự ghi file mới xin sandbox (§18) — phòng lập kế hoạch ghi tài liệu vào docs/', () => {
    const needsSandbox = agents
      .filter((agent) => agent.definition.needsSandbox)
      .map((agent) => agent.definition.role)
      .sort();

    expect(needsSandbox).toEqual([
      'BACKEND_DEVELOPER',
      'BUSINESS_ANALYST',
      'DEVOPS',
      'FRONTEND_DEVELOPER',
      'MOBILE_DEVELOPER',
      'PRODUCT_MANAGER',
      'QA',
      'RED_TEAM',
      'SECURITY',
      'SOLUTION_ARCHITECT',
      'UIUX_DESIGNER',
    ]);
  });
});

describe('phòng Web Development (§93–§97)', () => {
  const agents = webAgents();

  it('phủ đủ bốn vai trò web', () => {
    expect(agents.map((agent) => agent.definition.role).sort()).toEqual([
      'ACCESSIBILITY',
      'SEO',
      'WEB_PERFORMANCE',
      'WEB_PRODUCT_LEAD',
    ]);
  });

  it('cả bốn đều thuộc phòng WEB_DEVELOPMENT', () => {
    for (const agent of agents) {
      expect(agent.definition.department).toBe('WEB_DEVELOPMENT');
    }
  });

  it('ba vai trò rà soát cần đọc mã, Lead cần ghi tài liệu — cả bốn cần sandbox', () => {
    const needsSandbox = agents
      .filter((agent) => agent.definition.needsSandbox)
      .map((agent) => agent.definition.role)
      .sort();

    expect(needsSandbox).toEqual(['ACCESSIBILITY', 'SEO', 'WEB_PERFORMANCE', 'WEB_PRODUCT_LEAD']);
  });
});

describe('kế hoạch CTO trả về (§3.1)', () => {
  const plan = {
    summary: 'Kế hoạch',
    tasks: [{ title: 'Việc', description: '...', assignedRole: 'BUSINESS_ANALYST' }],
  };

  it('câu hỏi cho CEO dài quá thì cắt bớt, không vứt cả kế hoạch', () => {
    const parsed = planSchema.parse({ ...plan, needsCeoDecision: 'x'.repeat(3000) });
    expect(parsed.needsCeoDecision).toHaveLength(2001);
    expect(parsed.needsCeoDecision?.endsWith('…')).toBe(true);
  });

  it('không có câu hỏi thì là null', () => {
    expect(planSchema.parse(plan).needsCeoDecision).toBeNull();
  });
});
