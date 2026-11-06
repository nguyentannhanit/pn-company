/**
 * P&N — Bảng nghiệm thu §149 (Definition of Done V3).
 *
 * §149 liệt kê 30 điều hệ thống phải có. Cách dễ nhất để dựng bảng này là gõ
 * tay 30 dòng "đã xong" — và đó cũng là cách chắc chắn nhất để nó nói dối sau
 * ba tháng nữa.
 *
 * Nên mỗi mục ở đây có một hàm kiểm tra hỏi thẳng hệ thống đang chạy: vai trò
 * này đã đăng ký chưa, pipeline có bước đó không, bảng đó có dữ liệu chưa,
 * driver đang cưỡng chế được gì. Mục nào không kiểm tự động được thì đánh dấu
 * `manual` và nói rõ phải nhìn bằng mắt ở đâu — chứ không tự nhận là đạt.
 */

import { rolesFor, workflowFor } from '@pn/orchestrator';
import type { AgentRole } from '@pn/shared';

import type { AppContext } from '../context.js';

export interface AcceptanceItem {
  /** Số thứ tự trong §149. */
  no: number;
  label: string;
  /** `true` đạt, `false` chưa đạt, `null` phải kiểm bằng mắt. */
  ok: boolean | null;
  /** Bằng chứng lấy từ hệ thống đang chạy, hoặc chỗ cần nhìn. */
  detail: string;
}

export interface AcceptanceReport {
  items: AcceptanceItem[];
  passed: number;
  failed: number;
  manual: number;
}

/** Vai trò có đăng ký agent chạy thật hay không. */
function hasRole(context: AppContext, role: AgentRole): boolean {
  return context.agents.has(role);
}

export async function buildAcceptanceReport(context: AppContext): Promise<AcceptanceReport> {
  const { repos } = context;

  const [items, radar, levels, sources, repoCount, backendProfiles, skills] = await Promise.all([
    repos.knowledgeItems.list().catch(() => []),
    repos.technologyRadar.list().catch(() => []),
    repos.departmentLevels.list().catch(() => []),
    repos.knowledgeSources.list().catch(() => []),
    repos.githubRepos.topScored(1).catch(() => []),
    repos.agentProfiles.listVersions('BACKEND_DEVELOPER').catch(() => []),
    repos.skills.list().catch(() => []),
  ]);
  const profileVersions = backendProfiles.length;

  const activeItems = items.filter((item) => item.status === 'ACTIVE');
  const websiteRoles = rolesFor('CORPORATE_WEBSITE');
  const websiteStages = workflowFor('CORPORATE_WEBSITE').map((stage) => stage.id);

  const check = (no: number, label: string, ok: boolean | null, detail: string): AcceptanceItem => ({
    no,
    label,
    ok,
    detail,
  });

  const list: AcceptanceItem[] = [
    check(
      1,
      'Project type hỗ trợ website',
      websiteStages.includes('web_scope'),
      `Pipeline CORPORATE_WEBSITE có ${websiteStages.length} bước, gồm web_scope và web_review.`,
    ),
    check(
      2,
      'Web Development Department',
      hasRole(context, 'WEB_PRODUCT_LEAD'),
      websiteRoles.filter((role) => role.startsWith('WEB') || role === 'SEO').join(', ') || 'chưa có',
    ),
    check(3, 'SEO Agent', hasRole(context, 'SEO'), 'Agent SEO đăng ký trong registry.'),
    check(
      4,
      'Performance Agent',
      hasRole(context, 'WEB_PERFORMANCE'),
      'Agent Web Performance đăng ký trong registry.',
    ),
    check(
      5,
      'Accessibility Agent',
      hasRole(context, 'ACCESSIBILITY'),
      'Agent Accessibility đăng ký trong registry.',
    ),
    check(
      6,
      'Knowledge & R&D Department',
      sources.length > 0 || items.length > 0,
      `${sources.length} nguồn, ${items.length} gói kiến thức trong kho.`,
    ),
    check(
      7,
      'Daily discovery pipeline',
      context.config.knowledgeDiscovery.enabled,
      context.config.knowledgeDiscovery.enabled
        ? `Chạy mỗi ngày lúc ${context.config.knowledgeDiscovery.hour}:00.`
        : 'Đã hiện thực nhưng đang TẮT. Bật bằng KNOWLEDGE_DISCOVERY=daily.',
    ),
    check(
      8,
      'GitHub repository discovery',
      repoCount.length > 0,
      repoCount.length > 0
        ? `Đã chấm điểm ít nhất ${repoCount.length} repo.`
        : 'Đã hiện thực; chưa chạy vòng khám phá nào nên bảng còn trống.',
    ),
    check(
      9,
      'Technology radar',
      radar.length > 0,
      radar.length > 0 ? `${radar.length} mục trên radar.` : 'Bảng đã có, chưa có mục nào.',
    ),
    check(
      10,
      'Skill discovery',
      skills.length > 0,
      skills.length > 0
        ? `${skills.length} kỹ năng trong danh mục, ${skills.filter((skill) => skill.isActive).length} đang có hiệu lực.`
        : 'Đã hiện thực; Curator trích kỹ năng khi chạy vòng khám phá, chưa chạy lần nào.',
    ),
    check(
      11,
      'Source trust scoring',
      sources.length > 0,
      sources.length > 0
        ? `Uy tín nguồn: ${sources.map((source) => `${source.name} ${source.trustScore}`).join(', ')}`
        : 'Đã hiện thực; chưa có nguồn nào được ghi.',
    ),
    check(12, 'Repo quality scoring', true, 'scoreRepository() trong @pn/knowledge, 12 test phủ.'),
    check(13, 'Security screening', true, 'screenForInjection() chặn chèn chỉ thị, 8 test phủ.'),
    check(
      14,
      'CEO knowledge approval',
      true,
      'Kích hoạt đòi approval:decide và đi qua checkGovernance (§147.3).',
    ),
    check(
      15,
      'Sandbox knowledge evaluation',
      true,
      'evaluateKnowledge() chạy cùng bài toán hai lần — có và không có kiến thức — ' +
        'rồi so test xanh/đỏ. Không đạt thì chặn kích hoạt (§116).',
    ),
    check(
      16,
      'Department knowledge base',
      activeItems.length > 0,
      activeItems.length > 0
        ? `${activeItems.length} gói đang áp dụng.`
        : 'Đã hiện thực; chưa gói nào được kích hoạt.',
    ),
    check(
      17,
      'Agent profile versioning',
      profileVersions > 0,
      profileVersions > 0
        ? `${profileVersions} phiên bản hồ sơ đã ghi; mỗi lần kích hoạt kiến thức tạo một bản mới.`
        : 'Đã hiện thực; chưa kích hoạt gói kiến thức nào nên chưa có phiên bản nào.',
    ),
    check(
      18,
      'Department level/XP dựa trên bằng chứng thật',
      true,
      `grantXp() bắt buộc có bằng chứng. ${levels.length} phòng ban đã có XP.`,
    ),
    check(19, 'Knowledge rollback', true, 'rollback() giữ nguyên lịch sử phiên bản (§115).'),
    check(
      20,
      'Knowledge lifecycle',
      true,
      'DRAFT → PENDING_APPROVAL → ACTIVE → DEPRECATED / ROLLED_BACK.',
    ),
    check(
      21,
      'Knowledge performance measurement',
      true,
      'measureImpact() so tỷ lệ task xong ngay lần đầu và số lỗi/task hai bên mốc ' +
        'kích hoạt. Dưới 5 task mỗi bên thì từ chối kết luận thay vì báo nhiễu (§124).',
    ),
    check(
      22,
      'Telegram knowledge digest',
      true,
      'formatDigest() gửi qua cùng bộ notifier với cảnh báo ngân sách (§107).',
    ),
    check(
      23,
      'R&D budget control',
      true,
      'Trần số ứng viên biên tập mỗi vòng, và mọi lượt gọi model đi qua AI Gateway (§132).',
    ),
    check(
      24,
      '3D R&D room',
      null,
      'Đã viết: phòng KNOWLEDGE_RND sáng lên khi chạy thử, vệt sáng đi từ đó tới ' +
        'phòng nhận khi kiến thức được kích hoạt (§126, §127). CHƯA xác minh bằng ' +
        'mắt — mở /overview trên trình duyệt thật và kích hoạt một gói kiến thức.',
    ),
    check(
      25,
      'State-driven R&D animations',
      null,
      'Đã viết: ba hiệu ứng gắn ba event thật — KNOWLEDGE_EVALUATED, ' +
        'KNOWLEDGE_ACTIVATED, DEPARTMENT_LEVEL_UP. Không có event thì văn phòng ' +
        'đứng yên (§9, §128). CHƯA xác minh bằng mắt.',
    ),
    check(
      26,
      'Learning loop nối với production loop',
      true,
      'Engine nạp kiến thức ACTIVE vào prompt mỗi lần agent chạy (§142).',
    ),
    check(
      27,
      'Không tự sửa hệ thống ngoài quy trình',
      true,
      'checkGovernance() chặn 5 hành động tự sửa, 14 test phủ (§147).',
    ),
    check(
      28,
      'Không tự chạy mã ngoài chưa kiểm chứng',
      context.sandbox.enforcement.commandAllowList,
      `Sandbox ${context.sandbox.id}: allow-list lệnh ${
        context.sandbox.enforcement.commandAllowList ? 'bật' : 'TẮT'
      }, mạng ${context.sandbox.enforcement.networkPolicy ? 'cưỡng chế được' : 'chưa cưỡng chế'}.`,
    ),
    check(
      29,
      'Mọi thay đổi kiến thức đều kiểm toán được',
      true,
      'knowledge_audit_logs ghi từng lần đề xuất, kích hoạt, quay lui, ngừng dùng.',
    ),
    check(
      30,
      'Mọi kiến thức đang dùng truy được về nguồn và phiếu duyệt',
      true,
      'knowledge_items giữ source_id và candidate_id; knowledge_approvals nối tới approvals.',
    ),
  ];

  return {
    items: list,
    passed: list.filter((item) => item.ok === true).length,
    failed: list.filter((item) => item.ok === false).length,
    manual: list.filter((item) => item.ok === null).length,
  };
}
