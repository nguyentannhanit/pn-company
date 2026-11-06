/**
 * §4, §92, §93 — pipeline phải khác nhau theo loại sản phẩm, và mỗi vai trò
 * trong pipeline phải có agent thật nhận việc.
 *
 * Test cuối là quan trọng nhất: workflow liệt kê một vai trò mà không ai hiện
 * thực thì task rơi vào trạng thái bị chặn với lời nhắn "chưa được triển khai",
 * và người dùng là người phát hiện hộ.
 */

import { describe, expect, it } from 'vitest';

describe('workflowFor — phần mềm desktop', () => {
  it('có đủ bước tới dựng .exe, không có Mobile và Red Team', async () => {
    const { workflowFor } = await import('./workflow.js');
    const stages = workflowFor('DESKTOP_APPLICATION');
    const ids = stages.map((stage) => stage.id);
    expect(ids).toEqual(['intake', 'product', 'analysis', 'architecture', 'design', 'build', 'qa', 'security', 'devops', 'staging', 'production']);
    expect(stages.find((stage) => stage.id === 'build')?.roles).toEqual(['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER']);
    expect(stages.find((stage) => stage.id === 'devops')?.dependsOn).toEqual(['security']);
  });
});

describe('workflowFor — web app (§92)', () => {
  it('stage build của WEB_APPLICATION không có Mobile Developer', async () => {
    const { workflowFor } = await import('./workflow.js');
    const build = workflowFor('WEB_APPLICATION').find((stage) => stage.id === 'build');
    expect(build?.roles).toEqual(['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER']);
    const mobile = workflowFor('MOBILE_APPLICATION').find((stage) => stage.id === 'build');
    expect(mobile?.roles).toContain('MOBILE_DEVELOPER');
  });
});

import { coreAgents, webAgents } from '@pn/agents';
import { PRODUCT_TYPES } from '@pn/shared';

import { rolesFor, stageForRole, stagesBefore, workflowFor } from './workflow.js';

const IMPLEMENTED = new Set(
  [...coreAgents(), ...webAgents()].map((agent) => agent.definition.role),
);

describe('workflow theo loại sản phẩm (§92)', () => {
  it('mọi loại sản phẩm đều có pipeline bắt đầu bằng CTO', () => {
    for (const productType of PRODUCT_TYPES) {
      const workflow = workflowFor(productType);
      expect(workflow[0]!.id).toBe('intake');
      expect(workflow[0]!.roles).toEqual(['CTO_ORCHESTRATOR']);
    }
  });

  it('website có bước rà SEO / hiệu năng / tiếp cận, web app thì không (§93)', () => {
    const website = workflowFor('CORPORATE_WEBSITE').map((stage) => stage.id);
    const webApp = workflowFor('WEB_APPLICATION').map((stage) => stage.id);

    expect(website).toContain('web_review');
    expect(webApp).not.toContain('web_review');
  });

  it('chỉ dự án mobile mới gọi tới Mobile Developer', () => {
    expect(rolesFor('MOBILE_APPLICATION')).toContain('MOBILE_DEVELOPER');
    expect(rolesFor('CORPORATE_WEBSITE')).not.toContain('MOBILE_DEVELOPER');
  });

  it('landing page không cần Backend — một trang thì không có gì để dựng phía sau', () => {
    expect(rolesFor('LANDING_PAGE')).not.toContain('BACKEND_DEVELOPER');
    expect(rolesFor('LANDING_PAGE')).toContain('FRONTEND_DEVELOPER');
  });

  it('mọi loại sản phẩm đều có cổng duyệt trước khi lên production (§20, §38)', () => {
    for (const productType of PRODUCT_TYPES) {
      const production = workflowFor(productType).find((stage) => stage.id === 'production');
      expect(production?.requiresApproval).toBe(true);
      expect(production?.approvalKind).toBe('PRODUCTION_DEPLOY');
    }
  });

  it('mọi stage đều phụ thuộc vào stage có thật trong cùng pipeline', () => {
    for (const productType of PRODUCT_TYPES) {
      const workflow = workflowFor(productType);
      const ids = new Set(workflow.map((stage) => stage.id));
      for (const stage of workflow) {
        for (const parent of stage.dependsOn) {
          expect(ids, `${productType}/${stage.id} phụ thuộc ${parent}`).toContain(parent);
        }
      }
    }
  });

  it('mọi vai trò trong mọi pipeline đều có agent thật nhận việc', () => {
    for (const productType of PRODUCT_TYPES) {
      for (const role of rolesFor(productType)) {
        expect(IMPLEMENTED, `${productType} cần ${role}`).toContain(role);
      }
    }
  });
});

describe('tra cứu stage', () => {
  it('tìm đúng stage phụ trách một vai trò', () => {
    const workflow = workflowFor('WEB_APPLICATION');
    expect(stageForRole(workflow, 'QA')?.id).toBe('qa');
    expect(stageForRole(workflow, 'SOLUTION_ARCHITECT')?.id).toBe('architecture');
  });

  it('vai trò ngoài pipeline trả null thay vì đoán bừa', () => {
    expect(stageForRole(workflowFor('WEB_APPLICATION'), 'SEO')).toBeNull();
  });

  it('các stage trước tính bắc cầu, không chỉ lấy cha trực tiếp', () => {
    const before = stagesBefore(workflowFor('WEB_APPLICATION'), 'qa');

    expect(before).toContain('build');
    expect(before).toContain('intake');
  });

  it('stage đầu tiên không có stage nào đứng trước', () => {
    expect(stagesBefore(workflowFor('WEB_APPLICATION'), 'intake')).toEqual([]);
  });
});
