/**
 * P&N — RBAC và cấp quyền cho agent (§20, §83).
 *
 * §20: "Agent chỉ có quyền tối thiểu cần thiết." Mỗi vai trò agent có một
 * allow-list tường minh; thứ gì không nằm trong đó là bị từ chối. Danh sách cấm
 * là tuyệt đối, allow-list của vai trò không ghi đè được — truy cập DB
 * production, đọc secret và deploy production bị chặn ngay từ thiết kế (§20).
 */

import { ACCESS_AREAS, type AccessArea, type AccessLevel, type AccessMap, type AgentRole, type HumanRole, type RbacRole } from '@pn/shared';

export * from './governance.js';

/* -------------------------------------------------------------------------- */
/* Danh mục quyền                                                              */
/* -------------------------------------------------------------------------- */

export const CAPABILITIES = [
  // repo và mã nguồn
  'code:read',
  'code:write:frontend',
  'code:write:backend',
  'code:write:mobile',
  'code:write:infra',
  'code:write:docs',
  'tests:run',
  'git:create_branch',
  'git:commit',
  'git:create_pr',
  'git:merge',
  // nền tảng
  'project:read',
  'project:write',
  'task:read',
  'task:write',
  'task:assign',
  'bug:read',
  'bug:write',
  'approval:read',
  'approval:request',
  'approval:decide',
  'agent:read',
  'agent:control',
  // triển khai
  'deploy:read',
  'deploy:preview',
  'deploy:staging',
  'deploy:production',
  // nhạy cảm
  'secrets:read',
  /** Dán, xoá khoá API / token tích hợp, đăng nhập CLI gói thuê bao. */
  'secrets:write',
  'db:production:read',
  'db:production:write',
  'settings:read',
  'settings:write',
  'budget:read',
  'budget:write',
  /** Xoá số liệu chi phí đã ghi (đặt lại đếm tiền). */
  'budget:reset',
  // tài khoản và nhật ký
  'users:read',
  'users:manage',
  'audit:read',
  // kiến thức (dùng từ Phase 4)
  'knowledge:discover',
  'knowledge:evaluate',
  'knowledge:activate',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * §20 — những quyền mà AGENT không bao giờ được giữ, dù vai trò có cấp.
 * Chỉ vai trò người (CEO/CTO) hoặc SYSTEM mới được phép.
 */
export const AGENT_FORBIDDEN_CAPABILITIES: readonly Capability[] = [
  'secrets:read',
  'secrets:write',
  'db:production:read',
  'db:production:write',
  'deploy:production',
  'settings:write',
  'budget:write',
  'budget:reset',
  'approval:decide',
  'users:manage',
] as const;

/* -------------------------------------------------------------------------- */
/* Chín khu và bốn nấc — cách CEO cấp quyền cho NGƯỜI             */
/* -------------------------------------------------------------------------- */

/** Nấc dùng được của từng khu: code chỉ có Xem/Toàn quyền, tài khoản không có nấc Làm, nhật ký chỉ có Xem. */
export const AREA_LEVELS: Record<AccessArea, readonly AccessLevel[]> = {
  projects: [0, 1, 2, 3],
  approvals: [0, 1, 3],
  agents: [0, 1, 2, 3],
  code: [0, 1, 3],
  deploy: [0, 1, 2, 3],
  ai: [0, 1, 2, 3],
  budget: [0, 1, 2, 3],
  accounts: [0, 1, 3],
  audit: [0, 1],
};

/** Quyền THÊM VÀO ở từng nấc (nấc cao gồm cả quyền của nấc thấp hơn). */
const AREA_GRANTS: Record<AccessArea, Partial<Record<AccessLevel, readonly Capability[]>>> = {
  projects: {
    1: ['project:read', 'task:read', 'bug:read'],
    2: ['task:write', 'task:assign', 'bug:write', 'approval:request'],
    3: ['project:write'],
  },
  approvals: { 1: ['approval:read'], 3: ['approval:decide'] },
  agents: { 1: ['agent:read'], 2: ['agent:control'], 3: ['knowledge:discover', 'knowledge:evaluate', 'knowledge:activate'] },
  code: { 1: ['code:read'], 3: ['git:merge'] },
  deploy: { 1: ['deploy:read'], 2: ['deploy:preview', 'deploy:staging'], 3: ['deploy:production'] },
  ai: { 1: ['settings:read'], 2: ['settings:write'], 3: ['secrets:write'] },
  budget: { 1: ['budget:read'], 2: ['budget:write'], 3: ['budget:reset'] },
  accounts: { 1: ['users:read'], 3: ['users:manage'] },
  audit: { 1: ['audit:read'] },
};

const access = (levels: readonly AccessLevel[]): AccessMap =>
  Object.fromEntries(ACCESS_AREAS.map((area, index) => [area, levels[index] ?? 0])) as AccessMap;

/** Năm vai trò có sẵn (thứ tự khu theo `ACCESS_AREAS`). */
export const ROLE_ACCESS: Record<HumanRole, AccessMap> = {
  CEO: access([3, 3, 3, 3, 3, 3, 3, 3, 1]),
  CTO: access([3, 3, 3, 3, 3, 3, 1, 1, 1]),
  PROJECT_MANAGER: access([3, 3, 2, 1, 1, 0, 1, 0, 0]),
  ACCOUNTANT: access([1, 0, 0, 0, 0, 0, 2, 0, 1]),
  VIEWER: access([1, 0, 1, 1, 0, 0, 0, 0, 0]),
};

export const isHumanRole = (role: RbacRole): role is HumanRole => role in ROLE_ACCESS;

/**
 * Mức thật của một người: vai trò + phần chỉnh riêng. Nấc không hợp lệ với khu thì hạ xuống nấc hợp lệ gần nhất;
 * toàn quyền về tài khoản chỉ dành cho CEO (người khác mà cấp được tài khoản thì tự nâng quyền được), và CEO luôn đủ
 * quyền của vai trò — không hạ được CEO bằng phần chỉnh riêng.
 */
export function effectiveAccess(role: HumanRole, overrides?: Partial<AccessMap> | null): AccessMap {
  const base = ROLE_ACCESS[role];
  if (role === 'CEO') return { ...base };
  const result = { ...base };
  for (const area of ACCESS_AREAS) {
    const wanted = overrides?.[area] ?? base[area];
    const allowed = AREA_LEVELS[area].filter((level) => level <= wanted);
    let level = allowed[allowed.length - 1] ?? 0;
    if (area === 'accounts' && level > 1) level = 1;
    result[area] = level;
  }
  return result;
}

/** Tập quyền kỹ thuật ứng với một bộ mức theo khu. */
export function capabilitiesForAccess(map: AccessMap): ReadonlySet<Capability> {
  const granted = new Set<Capability>();
  for (const area of ACCESS_AREAS) {
    for (const level of [1, 2, 3] as const) {
      if (level > map[area]) break;
      for (const capability of AREA_GRANTS[area][level] ?? []) granted.add(capability);
    }
  }
  return granted;
}

/* -------------------------------------------------------------------------- */
/* Vai trò người dùng — §20                                                    */
/* -------------------------------------------------------------------------- */

const ALL: readonly Capability[] = CAPABILITIES;

export const ROLE_CAPABILITIES: Record<RbacRole, readonly Capability[]> = {
  CEO: ALL,
  // Người khác CEO: suy từ chín khu của vai trò (không còn danh sách tay — tránh lệch với trang Tài khoản).
  CTO: [...capabilitiesForAccess(ROLE_ACCESS.CTO)],
  PROJECT_MANAGER: [...capabilitiesForAccess(ROLE_ACCESS.PROJECT_MANAGER)],
  ACCOUNTANT: [...capabilitiesForAccess(ROLE_ACCESS.ACCOUNTANT)],
  AGENT: [], // quyết định theo từng vai trò agent, xem AGENT_CAPABILITIES
  VIEWER: [...capabilitiesForAccess(ROLE_ACCESS.VIEWER)],
  SYSTEM: ALL,
};

/* -------------------------------------------------------------------------- */
/* Vai trò agent — quyền tối thiểu (§20)                                       */
/* -------------------------------------------------------------------------- */

const READ_ONLY_BASE: readonly Capability[] = ['project:read', 'task:read', 'code:read'];

const DEV_BASE: readonly Capability[] = [
  ...READ_ONLY_BASE,
  'bug:read',
  'tests:run',
  'git:create_branch',
  'git:commit',
  'git:create_pr',
  'approval:request',
];

export const AGENT_CAPABILITIES: Record<AgentRole, readonly Capability[]> = {
  // §3.1 — orchestrator lập kế hoạch và giao việc, không tự viết code.
  CTO_ORCHESTRATOR: [
    ...READ_ONLY_BASE,
    'project:write',
    'task:write',
    'task:assign',
    'bug:read',
    'agent:control',
    'approval:request',
    'deploy:staging',
  ],
  PRODUCT_MANAGER: [...READ_ONLY_BASE, 'task:write', 'task:assign', 'approval:request'],
  BUSINESS_ANALYST: [...READ_ONLY_BASE, 'task:write', 'code:write:docs', 'approval:request'],
  SOLUTION_ARCHITECT: [...READ_ONLY_BASE, 'code:write:docs', 'task:write', 'approval:request'],
  UIUX_DESIGNER: [...READ_ONLY_BASE, 'code:write:docs', 'approval:request'],

  // §3.6 / §3.7 — chỉ được ghi trong đúng lớp của mình.
  FRONTEND_DEVELOPER: [...DEV_BASE, 'code:write:frontend'],
  BACKEND_DEVELOPER: [...DEV_BASE, 'code:write:backend'],
  MOBILE_DEVELOPER: [...DEV_BASE, 'code:write:mobile'],

  // §3.9 — QA chạy test và tạo bug, không viết code sản phẩm.
  QA: [...READ_ONLY_BASE, 'tests:run', 'bug:read', 'bug:write', 'approval:request'],

  // §3.10 / §3.11 — rà soát và báo cáo; không có quyền ghi code sản phẩm.
  SECURITY: [...READ_ONLY_BASE, 'bug:read', 'bug:write', 'approval:request'],
  RED_TEAM: [...READ_ONLY_BASE, 'bug:read', 'bug:write', 'approval:request'],

  // §3.12 — code hạ tầng + deploy staging; deploy production vẫn thuộc về người.
  DEVOPS: [
    ...DEV_BASE,
    'code:write:infra',
    'deploy:preview',
    'deploy:staging',
  ],

  // §93–§97 — phòng Web.
  WEB_PRODUCT_LEAD: [...READ_ONLY_BASE, 'task:write', 'task:assign', 'approval:request'],
  SEO: [...READ_ONLY_BASE, 'code:write:frontend', 'code:write:docs', 'bug:write'],
  WEB_PERFORMANCE: [...READ_ONLY_BASE, 'code:write:frontend', 'tests:run', 'bug:write'],
  ACCESSIBILITY: [...READ_ONLY_BASE, 'code:write:frontend', 'tests:run', 'bug:write'],

  // §99 — Knowledge & R&D. Chỉ được phát hiện và đánh giá; việc kích hoạt cần
  // CEO duyệt (§108) và do vai trò SYSTEM thực thi, không phải các agent này.
  KNOWLEDGE_DIRECTOR: [...READ_ONLY_BASE, 'knowledge:discover', 'knowledge:evaluate', 'approval:request'],
  GITHUB_SCOUT: ['knowledge:discover'],
  TECHNOLOGY_RADAR: ['knowledge:discover'],
  SKILL_SCOUT: ['knowledge:discover'],
  RESEARCH: ['knowledge:discover'],
  KNOWLEDGE_CURATOR: ['knowledge:discover', 'knowledge:evaluate'],
  KNOWLEDGE_SECURITY_REVIEW: ['knowledge:evaluate', 'approval:request'],
  SANDBOX_EVALUATION: ['knowledge:evaluate', 'tests:run'],
  DEPARTMENT_TRAINER: ['knowledge:evaluate', 'approval:request'],
  KNOWLEDGE_AUDITOR: ['knowledge:evaluate', ...READ_ONLY_BASE],
};

/* -------------------------------------------------------------------------- */
/* Phân giải quyền                                                             */
/* -------------------------------------------------------------------------- */

export interface Principal {
  role: RbacRole;
  /** Chỉ có khi `role === 'AGENT'`. */
  agentRole?: AgentRole;
  id?: string;
  /** Mức theo khu đã tính cho NGƯỜI (vai trò + chỉnh riêng); không có thì dùng mặc định của vai trò. */
  access?: AccessMap;
}

export class PermissionDeniedError extends Error {
  constructor(
    readonly principal: Principal,
    readonly capability: Capability,
  ) {
    const who = principal.role === 'AGENT' ? `agent ${principal.agentRole}` : principal.role;
    super(`Tài khoản này không có quyền "${capability}" (${who}). Nhờ CEO cấp thêm quyền ở Cài đặt → Tài khoản & quyền.`);
    this.name = 'PermissionDeniedError';
  }
}

/** Tập quyền thực tế của một principal, đã trừ đi danh sách cấm với agent. */
export function capabilitiesOf(principal: Principal): ReadonlySet<Capability> {
  if (principal.role !== 'AGENT') {
    if (principal.access && isHumanRole(principal.role) && principal.role !== 'CEO') return capabilitiesForAccess(principal.access);
    return new Set(ROLE_CAPABILITIES[principal.role]);
  }
  if (!principal.agentRole) return new Set();

  const granted = AGENT_CAPABILITIES[principal.agentRole] ?? [];
  const forbidden = new Set<Capability>(AGENT_FORBIDDEN_CAPABILITIES);
  return new Set(granted.filter((capability) => !forbidden.has(capability)));
}

export function can(principal: Principal, capability: Capability): boolean {
  return capabilitiesOf(principal).has(capability);
}

export function assertCan(principal: Principal, capability: Capability): void {
  if (!can(principal, capability)) {
    throw new PermissionDeniedError(principal, capability);
  }
}
