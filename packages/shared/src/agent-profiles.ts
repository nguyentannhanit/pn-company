/**
 * P&N — Tên hiển thị và phòng ban của từng vai trò agent (§3, §7, §93, §98).
 *
 * Một nguồn duy nhất, vì cùng bảng này được ba nơi dùng và ba nơi đó phải khớp
 * nhau tuyệt đối: API seed agent vào database, runtime agent khai báo mình
 * thuộc phòng nào, và văn phòng 3D xếp nhân vật vào phòng. Lệch một dòng là
 * nhân vật đứng nhầm phòng mà không có gì báo lỗi.
 */

import type { AgentRole, Department } from './enums.js';

export interface AgentProfile {
  displayName: string;
  department: Department;
}

export const AGENT_PROFILES: Record<AgentRole, AgentProfile> = {
  CTO_ORCHESTRATOR: { displayName: 'Giám đốc kỹ thuật (CTO)', department: 'COMMAND_CENTER' },
  PRODUCT_MANAGER: { displayName: 'Quản lý sản phẩm', department: 'PRODUCT' },
  BUSINESS_ANALYST: { displayName: 'Phân tích nghiệp vụ', department: 'BUSINESS_ANALYSIS' },
  SOLUTION_ARCHITECT: { displayName: 'Kiến trúc sư giải pháp', department: 'COMMAND_CENTER' },
  UIUX_DESIGNER: { displayName: 'Thiết kế giao diện', department: 'UIUX_STUDIO' },
  FRONTEND_DEVELOPER: { displayName: 'Lập trình giao diện', department: 'FRONTEND' },
  BACKEND_DEVELOPER: { displayName: 'Lập trình máy chủ', department: 'BACKEND' },
  MOBILE_DEVELOPER: { displayName: 'Lập trình di động', department: 'MOBILE' },
  QA: { displayName: 'Kiểm thử', department: 'QA_LAB' },
  SECURITY: { displayName: 'Kỹ sư an ninh', department: 'SECURITY_OPS' },
  RED_TEAM: { displayName: 'Đội tấn công thử', department: 'SECURITY_OPS' },
  DEVOPS: { displayName: 'Kỹ sư vận hành', department: 'DEVOPS' },

  WEB_PRODUCT_LEAD: { displayName: 'Trưởng sản phẩm web', department: 'WEB_DEVELOPMENT' },
  SEO: { displayName: 'Chuyên viên SEO', department: 'WEB_DEVELOPMENT' },
  WEB_PERFORMANCE: { displayName: 'Tối ưu tốc độ web', department: 'WEB_DEVELOPMENT' },
  ACCESSIBILITY: { displayName: 'Chuyên viên dễ tiếp cận', department: 'WEB_DEVELOPMENT' },

  KNOWLEDGE_DIRECTOR: { displayName: 'Giám đốc tri thức', department: 'KNOWLEDGE_RND' },
  GITHUB_SCOUT: { displayName: 'Trinh sát GitHub', department: 'KNOWLEDGE_RND' },
  TECHNOLOGY_RADAR: { displayName: 'Radar công nghệ', department: 'KNOWLEDGE_RND' },
  SKILL_SCOUT: { displayName: 'Trinh sát kỹ năng', department: 'KNOWLEDGE_RND' },
  RESEARCH: { displayName: 'Nghiên cứu', department: 'KNOWLEDGE_RND' },
  KNOWLEDGE_CURATOR: { displayName: 'Biên tập tri thức', department: 'KNOWLEDGE_RND' },
  KNOWLEDGE_SECURITY_REVIEW: { displayName: 'Rà soát an ninh tri thức', department: 'KNOWLEDGE_RND' },
  SANDBOX_EVALUATION: { displayName: 'Đánh giá thử nghiệm', department: 'KNOWLEDGE_RND' },
  DEPARTMENT_TRAINER: { displayName: 'Huấn luyện phòng ban', department: 'KNOWLEDGE_RND' },
  KNOWLEDGE_AUDITOR: { displayName: 'Kiểm toán tri thức', department: 'KNOWLEDGE_RND' },
};

export function agentProfile(role: AgentRole): AgentProfile {
  return AGENT_PROFILES[role];
}
