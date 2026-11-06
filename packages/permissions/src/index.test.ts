/** §20 — bảo đảm nguyên tắc quyền tối thiểu cho agent. */

import { describe, expect, it } from 'vitest';

import { AGENT_CAPABILITIES, ROLE_ACCESS, assertCan, can, capabilitiesOf, effectiveAccess } from './index.js';
import { AGENT_ROLES } from '@pn/shared';

describe('RBAC (§20)', () => {
  it('CEO có toàn quyền', () => {
    expect(can({ role: 'CEO' }, 'deploy:production')).toBe(true);
    expect(can({ role: 'CEO' }, 'approval:decide')).toBe(true);
  });

  it('VIEWER chỉ được đọc', () => {
    expect(can({ role: 'VIEWER' }, 'project:read')).toBe(true);
    expect(can({ role: 'VIEWER' }, 'task:write')).toBe(false);
  });

  it('mọi vai trò agent đều bị chặn các quyền cấm', () => {
    for (const agentRole of AGENT_ROLES) {
      const principal = { role: 'AGENT' as const, agentRole };
      expect(can(principal, 'secrets:read')).toBe(false);
      expect(can(principal, 'db:production:write')).toBe(false);
      expect(can(principal, 'deploy:production')).toBe(false);
      expect(can(principal, 'approval:decide')).toBe(false);
      expect(can(principal, 'settings:write')).toBe(false);
    }
  });

  it('developer chỉ được ghi trong lớp của mình (ví dụ ở §20)', () => {
    const frontend = { role: 'AGENT' as const, agentRole: 'FRONTEND_DEVELOPER' as const };
    expect(can(frontend, 'code:write:frontend')).toBe(true);
    expect(can(frontend, 'code:write:backend')).toBe(false);
    expect(can(frontend, 'tests:run')).toBe(true);
    expect(can(frontend, 'git:create_branch')).toBe(true);
    expect(can(frontend, 'git:create_pr')).toBe(true);
  });

  it('QA được tạo bug nhưng không được viết code sản phẩm (§3.9)', () => {
    const qa = { role: 'AGENT' as const, agentRole: 'QA' as const };
    expect(can(qa, 'bug:write')).toBe(true);
    expect(can(qa, 'tests:run')).toBe(true);
    expect(can(qa, 'code:write:backend')).toBe(false);
  });

  it('DevOps chạm được staging nhưng không bao giờ chạm production (§3.12, §38)', () => {
    const devops = { role: 'AGENT' as const, agentRole: 'DEVOPS' as const };
    expect(can(devops, 'deploy:staging')).toBe(true);
    expect(can(devops, 'deploy:production')).toBe(false);
  });

  it('mọi vai trò agent khai báo đều có định nghĩa quyền', () => {
    for (const role of AGENT_ROLES) {
      expect(AGENT_CAPABILITIES[role], `missing capabilities for ${role}`).toBeDefined();
    }
  });

  it('khi từ chối thì ném lỗi tiếng Việt, chỉ đúng chỗ xin thêm quyền', () => {
    expect(() => assertCan({ role: 'AGENT', agentRole: 'QA' }, 'deploy:production')).toThrow(/Tài khoản & quyền/);
  });

  it('principal AGENT không có vai trò thì trả về tập rỗng', () => {
    expect(capabilitiesOf({ role: 'AGENT' }).size).toBe(0);
  });
});

describe('Chín khu, bốn nấc — quyền của NGƯỜI', () => {
  it('Quản lý dự án giao việc, duyệt được; không chạm khoá bí mật, tiền, tài khoản', () => {
    const pm = { role: 'PROJECT_MANAGER' as const, access: effectiveAccess('PROJECT_MANAGER') };
    expect(can(pm, 'task:assign')).toBe(true);
    expect(can(pm, 'approval:decide')).toBe(true);
    expect(can(pm, 'secrets:write')).toBe(false);
    expect(can(pm, 'settings:read')).toBe(false);
    expect(can(pm, 'budget:write')).toBe(false);
    expect(can(pm, 'users:read')).toBe(false);
  });

  it('Kế toán đặt hạn mức được nhưng không xoá số liệu chi phí, không giao việc', () => {
    const acc = { role: 'ACCOUNTANT' as const, access: effectiveAccess('ACCOUNTANT') };
    expect(can(acc, 'budget:write')).toBe(true);
    expect(can(acc, 'budget:reset')).toBe(false);
    expect(can(acc, 'task:write')).toBe(false);
    expect(can(acc, 'project:read')).toBe(true);
  });

  it('chỉnh riêng: nấc không hợp lệ hạ xuống nấc hợp lệ gần nhất; tài khoản chỉ CEO mới toàn quyền', () => {
    const tuned = effectiveAccess('CTO', { code: 2, audit: 3, accounts: 3, budget: 3 });
    expect(tuned.code).toBe(1);
    expect(tuned.audit).toBe(1);
    expect(tuned.accounts).toBe(1);
    expect(tuned.budget).toBe(3);
    expect(can({ role: 'CTO', access: tuned }, 'users:manage')).toBe(false);
  });

  it('CEO luôn toàn quyền, phần chỉnh riêng không hạ được', () => {
    expect(effectiveAccess('CEO', { ai: 0, accounts: 0 })).toEqual(ROLE_ACCESS.CEO);
    expect(can({ role: 'CEO', access: effectiveAccess('CEO', { ai: 0 }) }, 'secrets:write')).toBe(true);
  });

  it('người được hạ về Không ở một khu thì mất cả quyền xem khu đó', () => {
    const viewer = { role: 'VIEWER' as const, access: effectiveAccess('VIEWER', { projects: 0 }) };
    expect(can(viewer, 'project:read')).toBe(false);
  });

  it('nhân viên AI không bao giờ có quyền tài khoản hay khoá bí mật', () => {
    for (const role of AGENT_ROLES) {
      const agent = { role: 'AGENT' as const, agentRole: role };
      expect(can(agent, 'users:manage')).toBe(false);
      expect(can(agent, 'secrets:write')).toBe(false);
    }
  });
});
