/**
 * §147, §149.27, §149.28 — bốn điều hệ thống không được tự làm.
 *
 * Đây là bộ test quan trọng nhất của cả dự án theo nghĩa hậu quả: mọi test khác
 * canh việc hệ thống làm đúng, bộ này canh việc hệ thống không tự nới luật cho
 * chính nó. Một dòng nào đó đỏ ở đây nghĩa là §147 đã mất hiệu lực.
 */

import { describe, expect, it } from 'vitest';

import {
  AUTONOMOUS_STAGES,
  GovernanceDeniedError,
  assertGovernance,
  checkGovernance,
  stageNeedsHuman,
  type GovernanceRequest,
  type SelfModifyingAction,
} from './governance.js';

const ALL_ACTIONS: SelfModifyingAction[] = [
  'policy:write',
  'permission:grant',
  'knowledge:activate',
  'agent_profile:upgrade',
  'platform_code:write',
];

function request(overrides: Partial<GovernanceRequest> = {}): GovernanceRequest {
  return {
    action: 'policy:write',
    actorRole: 'CEO',
    hasHumanApproval: true,
    sandboxEvaluated: true,
    securityReviewed: true,
    ...overrides,
  };
}

describe('§147 — không hành động tự sửa nào chạy tự động', () => {
  it('AGENT không làm được bất kỳ hành động nào trong danh sách', () => {
    for (const action of ALL_ACTIONS) {
      const verdict = checkGovernance(request({ action, actorRole: 'AGENT' }));
      expect(verdict.allowed, action).toBe(false);
    }
  });

  it('SYSTEM cũng không làm được — nếu không thì chỉ cần đi vòng qua tiến trình nền', () => {
    for (const action of ALL_ACTIONS) {
      const verdict = checkGovernance(request({ action, actorRole: 'SYSTEM' }));
      expect(verdict.allowed, action).toBe(false);
    }
  });

  it('VIEWER cũng không', () => {
    expect(checkGovernance(request({ actorRole: 'VIEWER' })).allowed).toBe(false);
  });

  it('người có quyền nhưng chưa có quyết định tường minh thì vẫn không được', () => {
    for (const action of ALL_ACTIONS) {
      const verdict = checkGovernance(request({ action, hasHumanApproval: false }));
      expect(verdict.allowed, action).toBe(false);
    }
  });
});

describe('§147.1, §147.2 — chính sách và quyền', () => {
  it('CEO đã duyệt thì sửa được chính sách', () => {
    expect(checkGovernance(request({ action: 'policy:write' })).allowed).toBe(true);
  });

  it('CTO cũng là người, cũng ký được', () => {
    expect(checkGovernance(request({ action: 'permission:grant', actorRole: 'CTO' })).allowed).toBe(
      true,
    );
  });
});

describe('§147.3, §117 — kiến thức từ ngoài', () => {
  it('chưa rà soát bảo mật thì không kích hoạt, KỂ CẢ khi CEO đã duyệt', () => {
    const verdict = checkGovernance(
      request({ action: 'knowledge:activate', securityReviewed: false }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.spec).toBe('§117');
    expect(verdict.reason).toContain('kể cả khi CEO duyệt');
  });

  it('đủ cả hai điều kiện thì kích hoạt được', () => {
    expect(
      checkGovernance(request({ action: 'knowledge:activate', securityReviewed: true })).allowed,
    ).toBe(true);
  });
});

describe('§147.4, §116 — nâng cấp hồ sơ agent', () => {
  it('chưa chạy thử trong sandbox thì không nâng cấp', () => {
    const verdict = checkGovernance(
      request({ action: 'agent_profile:upgrade', sandboxEvaluated: false }),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.spec).toBe('§116');
  });

  it('chạy thử đạt và CEO duyệt thì nâng cấp được', () => {
    expect(
      checkGovernance(request({ action: 'agent_profile:upgrade', sandboxEvaluated: true })).allowed,
    ).toBe(true);
  });
});

describe('§149.27 — mã nguồn nền tảng', () => {
  it('không ai sửa được, kể cả CEO đã duyệt — hệ thống không tự viết lại luật của nó', () => {
    for (const actorRole of ['CEO', 'CTO', 'SYSTEM', 'AGENT'] as const) {
      const verdict = checkGovernance(
        request({ action: 'platform_code:write', actorRole, hasHumanApproval: true }),
      );
      expect(verdict.allowed, actorRole).toBe(false);
    }
  });
});

describe('assertGovernance', () => {
  it('ném lỗi mang theo cả lý do lẫn mục spec, để log truy được', () => {
    try {
      assertGovernance(request({ actorRole: 'AGENT' }));
      throw new Error('lẽ ra phải ném lỗi');
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceDeniedError);
      expect((error as GovernanceDeniedError).message).toContain('§147.1');
    }
  });

  it('không ném khi hợp lệ', () => {
    expect(() => assertGovernance(request())).not.toThrow();
  });
});

describe('§38 — vòng tự chủ dừng trước production', () => {
  it('production KHÔNG nằm trong các bước tự chạy', () => {
    expect(AUTONOMOUS_STAGES).not.toContain('production');
    expect(stageNeedsHuman('production')).toBe(true);
  });

  it('các bước còn lại của §38 đều tự chạy được', () => {
    for (const stage of ['build', 'qa', 'devops', 'staging']) {
      expect(stageNeedsHuman(stage), stage).toBe(false);
    }
  });
});
