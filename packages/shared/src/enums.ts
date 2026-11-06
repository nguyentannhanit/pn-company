/**
 * P&N — Các enum của domain.
 *
 * Mọi literal trong file này đều truy được về một mục đánh số trong
 * AI_SOFTWARE_COMPANY_PROJECT_SPEC.md. Không thêm giá trị mới nếu không có
 * tham chiếu spec kèm theo.
 */

/* -------------------------------------------------------------------------- */
/* Phân quyền RBAC — §20                                                       */
/* -------------------------------------------------------------------------- */

export const RBAC_ROLES = ['CEO', 'CTO', 'PROJECT_MANAGER', 'ACCOUNTANT', 'AGENT', 'VIEWER', 'SYSTEM'] as const;
export type RbacRole = (typeof RBAC_ROLES)[number];

/** Vai trò của NGƯỜI (tài khoản đăng nhập) — năm vai trò. AGENT/SYSTEM là tiến trình, không cấp cho người. */
export const HUMAN_ROLES = ['CEO', 'CTO', 'PROJECT_MANAGER', 'ACCOUNTANT', 'VIEWER'] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];

/**
 * Chín "khu" của công ty mà quyền người dùng được chia theo: mỗi khu một nấc 0 Không · 1 Xem · 2 Làm ·
 * 3 Toàn quyền. Nấc nào ứng với quyền kỹ thuật nào nằm ở `@pn/permissions`.
 */
export const ACCESS_AREAS = ['projects', 'approvals', 'agents', 'code', 'deploy', 'ai', 'budget', 'accounts', 'audit'] as const;
export type AccessArea = (typeof ACCESS_AREAS)[number];
export type AccessLevel = 0 | 1 | 2 | 3;
export type AccessMap = Record<AccessArea, AccessLevel>;

/* -------------------------------------------------------------------------- */
/* Danh sách agent — §3 (lõi), §94–§97 (phòng Web), §99 (Knowledge & R&D)      */
/* -------------------------------------------------------------------------- */

/** Nhóm agent làm ra phần mềm — §3.1 … §3.12 */
export const CORE_AGENT_ROLES = [
  'CTO_ORCHESTRATOR', // §3.1
  'PRODUCT_MANAGER', // §3.2
  'BUSINESS_ANALYST', // §3.3
  'SOLUTION_ARCHITECT', // §3.4
  'UIUX_DESIGNER', // §3.5
  'FRONTEND_DEVELOPER', // §3.6
  'BACKEND_DEVELOPER', // §3.7
  'MOBILE_DEVELOPER', // §3.8
  'QA', // §3.9
  'SECURITY', // §3.10
  'RED_TEAM', // §3.11
  'DEVOPS', // §3.12
] as const;

/** Phòng Web Development — §93–§97 */
export const WEB_AGENT_ROLES = [
  'WEB_PRODUCT_LEAD', // §94
  'SEO', // §95
  'WEB_PERFORMANCE', // §96
  'ACCESSIBILITY', // §97
] as const;

/** Phòng Knowledge & R&D — §99 */
export const KNOWLEDGE_AGENT_ROLES = [
  'KNOWLEDGE_DIRECTOR', // §100
  'GITHUB_SCOUT', // §101
  'TECHNOLOGY_RADAR', // §103
  'SKILL_SCOUT', // §104
  'RESEARCH', // §105
  'KNOWLEDGE_CURATOR', // §99
  'KNOWLEDGE_SECURITY_REVIEW', // §99, §117
  'SANDBOX_EVALUATION', // §99, §116
  'DEPARTMENT_TRAINER', // §99, §113
  'KNOWLEDGE_AUDITOR', // §99, §121
] as const;

export const AGENT_ROLES = [
  ...CORE_AGENT_ROLES,
  ...WEB_AGENT_ROLES,
  ...KNOWLEDGE_AGENT_ROLES,
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Nhóm agent bắt buộc cho MVP Phase 1 — §35. */
export const MVP_AGENT_ROLES: readonly AgentRole[] = [
  'CTO_ORCHESTRATOR',
  'PRODUCT_MANAGER',
  'BACKEND_DEVELOPER',
  'FRONTEND_DEVELOPER',
  'QA',
] as const;

/* -------------------------------------------------------------------------- */
/* Phòng ban / các khu trong văn phòng 3D — §7, §93, §98, §145                 */
/* -------------------------------------------------------------------------- */

export const DEPARTMENTS = [
  'COMMAND_CENTER', // §7.1  — phòng CEO / Command Center
  'PRODUCT', // §7.2
  'BUSINESS_ANALYSIS', // §7.3
  'UIUX_STUDIO', // §7.4
  'FRONTEND', // §7.5
  'BACKEND', // §7.6
  'MOBILE', // §7.7
  'QA_LAB', // §7.8
  'SECURITY_OPS', // §7.9
  'DEVOPS', // §7.10
  'MEETING_ROOM', // §7.11
  'WEB_DEVELOPMENT', // §93
  'KNOWLEDGE_RND', // §98, §126
] as const;
export type Department = (typeof DEPARTMENTS)[number];

/* -------------------------------------------------------------------------- */
/* Trạng thái agent lúc chạy — điều khiển animation 3D, §8.1 + §9              */
/* -------------------------------------------------------------------------- */

/**
 * §9: animation phải gắn với trạng thái THẬT của agent — không random, không
 * trang trí. Union này là hợp đồng duy nhất giữa state ở backend và lớp 3D.
 */
export const AGENT_STATES = [
  'idle', // §8.2
  'working', // §8.3
  'reviewing', // §8.4
  'meeting', // §8.1
  'blocked', // §8.5
  'alert', // §8.6 — có bug
  'completed', // §8.7
  'celebrate', // §8.8 — deploy thành công
  'offline', // §8.1
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Dự án & công việc — §12, §13, §92                                           */
/* -------------------------------------------------------------------------- */

/** §92 — CTO chọn workflow dựa trên loại sản phẩm. */
export const PRODUCT_TYPES = [
  'CORPORATE_WEBSITE', // §92 Corporate Website
  'WEB_APPLICATION', // §92 Web Application
  'MOBILE_APPLICATION', // §92 Mobile Application
  'LANDING_PAGE', // §92 Landing Page
  'DESKTOP_APPLICATION', // Phần mềm máy tính (.exe)
] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PROJECT_STATUSES = [
  'DRAFT',
  'PLANNING',
  'IN_PROGRESS',
  'BLOCKED',
  'REVIEW',
  'DEPLOYING',
  'COMPLETED',
  'ARCHIVED',
  'PAUSED_BUDGET', // §55 — tự động tạm dừng khi chạm ngưỡng ngân sách
  'PAUSED', // CEO bấm Dừng dự án: không nhận việc mới, lượt đang chạy bị cắt
  'CANCELLED', // CEO bấm Dừng hẳn: cắt mọi thứ, không tự chạy tiếp; mã giữ nguyên, làm tiếp bằng "Làm lại dự án"
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** §13 — các cột trên bảng task. */
export const TASK_STATUSES = [
  'BACKLOG',
  'TODO',
  'IN_PROGRESS',
  'REVIEW',
  'BLOCKED',
  'DONE',
  'CANCELLED', // CEO bấm Dừng hẳn một việc: dự án bỏ qua việc này và đi tiếp
  'PAUSED', // CEO tạm dừng một việc: lượt đang chạy bị cắt, tiến độ giữ lại, chờ bấm Tiếp tục
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/* -------------------------------------------------------------------------- */
/* Lần chạy agent & sandbox — §18                                              */
/* -------------------------------------------------------------------------- */

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMEOUT',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Lỗi — §3.9, §8.6                                                            */
/* -------------------------------------------------------------------------- */

export const BUG_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const BUG_STATUSES = ['OPEN', 'IN_PROGRESS', 'FIXED', 'VERIFIED', 'WONTFIX'] as const;
export type BugStatus = (typeof BUG_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Phê duyệt — §27, §108                                                       */
/* -------------------------------------------------------------------------- */

export const APPROVAL_KINDS = [
  'PROJECT_PLAN', // §27
  'ARCHITECTURE', // §3.4
  'PRODUCTION_DEPLOY', // §20, §38
  'BUDGET_INCREASE', // §55
  'SECRET_ACCESS', // §19
  'KNOWLEDGE_ITEM', // §108
  'DEPARTMENT_UPGRADE', // §113
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Triển khai — §62, §38                                                       */
/* -------------------------------------------------------------------------- */

export const DEPLOY_ENVIRONMENTS = ['PREVIEW', 'STAGING', 'PRODUCTION'] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

export const DEPLOY_STATUSES = [
  'PENDING',
  'AWAITING_APPROVAL',
  'IN_PROGRESS',
  'SUCCESS',
  'FAILED',
  'ROLLED_BACK',
  'CANCELLED', // CEO bấm Dừng giữa lúc dựng
] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Nhà cung cấp AI & routing — §45, §50, §51                                   */
/* -------------------------------------------------------------------------- */

/**
 * §45.1 — các provider hệ thống bắt buộc hỗ trợ, cộng hai "hãng" chạy qua CLI đăng nhập gói thuê bao
 *: `claude-code` = Claude Code CLI với gói Claude Pro/Max, `codex` = Codex CLI với gói ChatGPT.
 * Cùng model nhưng khác cách trả tiền (trừ hạn mức gói, không tính theo token), nên là provider riêng
 * để đứng đầu chuỗi định tuyến và lùi về API khi gói hết lượt.
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'google', 'claude-code', 'codex'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** Provider chạy qua CLI trên máy: không cần API key, đăng nhập bằng tài khoản gói thuê bao. */
export const CLI_PROVIDERS = ['claude-code', 'codex'] as const satisfies readonly AiProviderId[];

export function isCliProvider(provider: string): provider is (typeof CLI_PROVIDERS)[number] {
  return (CLI_PROVIDERS as readonly string[]).includes(provider);
}

/** §15 — phân hạng năng lực để router dùng, nhờ đó không hard-code vendor. */
export const MODEL_TIERS = ['strong', 'medium', 'cheap'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** §51 — các chế độ routing. */
export const ROUTING_MODES = ['quality', 'balanced', 'economy', 'custom'] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export const INTEGRATION_STATUSES = [
  'NOT_CONFIGURED',
  'CONNECTED',
  'ERROR',
  'DISABLED',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

/* -------------------------------------------------------------------------- */
/* Tích hợp ngoài — §44, §68                                                   */
/* -------------------------------------------------------------------------- */

export const INTEGRATION_KINDS = [
  'AI_PROVIDER', // §45
  'TELEGRAM', // §57
  'GITHUB', // §59
  'DATABASE', // §61
  'DEPLOYMENT', // §62
  'APP_STORE_CONNECT', // §63
  'GOOGLE_PLAY', // §64
  'OBJECT_STORAGE', // §65
  'SMTP', // §66
  'WEBHOOK', // §67
  'VOICE', // Giọng đọc Vbee cho văn phòng
] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Môi trường — §76                                                            */
/* -------------------------------------------------------------------------- */

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];
