/**
 * P&N — Kiểu dữ liệu thực thể của domain.
 *
 * Mỗi interface tương ứng một bảng khai báo ở §14 (và các bảng API Center
 * §44–§56). File này phản chiếu `packages/database/migrations` — sửa bên nào
 * cũng phải đồng bộ bên kia.
 */

import type {
  AgentRole,
  AgentState,
  AiProviderId,
  ApprovalKind,
  ApprovalStatus,
  AccessMap,
  BugSeverity,
  BugStatus,
  Department,
  DeployEnvironment,
  DeployStatus,
  Environment,
  IntegrationKind,
  IntegrationStatus,
  ModelTier,
  ProductType,
  ProjectStatus,
  RbacRole,
  RoutingMode,
  RunStatus,
  TaskPriority,
  TaskStatus,
} from './enums.js';

export type Uuid = string;
export type IsoTimestamp = string;

interface Entity {
  readonly id: Uuid;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Người dùng — §14, §20                                                       */
/* -------------------------------------------------------------------------- */

export interface User extends Entity {
  email: string;
  displayName: string;
  role: RbacRole;
  telegramChatId: string | null;
  isActive: boolean;
  lastLoginAt: IsoTimestamp | null;
  /** Chỉnh riêng từng khu so với vai trò; null = theo đúng vai trò. */
  access: Partial<AccessMap> | null;
  /** Đăng nhập bằng mật khẩu tạm: phải đặt mật khẩu mới trước khi vào công ty. */
  mustChangePassword: boolean;
  /** Lời mời chưa nhận còn hạn tới lúc này; null = không có lời mời đang chờ. */
  inviteExpiresAt: IsoTimestamp | null;
  /** Tăng lên là mọi phiên cũ của người này hết hiệu lực (khoá, đăng xuất mọi thiết bị). */
  sessionVersion: number;
}

/* -------------------------------------------------------------------------- */
/* Dự án — §14, §12, §92                                                       */
/* -------------------------------------------------------------------------- */

export interface Project extends Entity {
  name: string;
  slug: string;
  description: string;
  productType: ProductType;
  status: ProjectStatus;
  ownerId: Uuid;
  /** Tên đầy đủ repo GitHub, ví dụ `org/repo` (§17). */
  repoFullName: string | null;
  defaultBranch: string;
  /** §16 — trần ngân sách của dự án, tính bằng USD. */
  budgetUsd: number;
  /** Tổng chi tạm tính; nguồn chuẩn vẫn là bảng `cost_records` (§16). */
  spentUsd: number;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Agent — §14, §3, §8                                                         */
/* -------------------------------------------------------------------------- */

export interface Agent extends Entity {
  role: AgentRole;
  displayName: string;
  department: Department;
  /** Trạng thái sống, điều khiển digital twin 3D — §9. */
  state: AgentState;
  /** Task agent đang gắn vào, nếu có (§9, §11). */
  currentTaskId: Uuid | null;
  currentProjectId: Uuid | null;
  isEnabled: boolean;
  /** §114 — phiên bản profile đang dùng (prompt + tập kiến thức). */
  profileVersion: number;
  /** §112 — XP tích luỹ cho phòng ban của agent. */
  xp: number;
  stateChangedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Task và phụ thuộc giữa các task — §14, §13                                  */
/* -------------------------------------------------------------------------- */

export interface Task extends Entity {
  projectId: Uuid;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Vai trò agent được giao task (§3). */
  assignedRole: AgentRole | null;
  assignedAgentId: Uuid | null;
  parentTaskId: Uuid | null;
  estimateMinutes: number | null;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  /** Số vòng fix loop QA đã dùng (§43.6). */
  fixLoopCount: number;
  /**
   * Stage của workflow mà task thuộc về (§4, §92). `null` nghĩa là task nằm
   * ngoài pipeline — task lập kế hoạch hoặc task tạo tay. Stage là chỗ neo cho
   * cổng duyệt: task thuộc stage `requiresApproval` không chạy khi CEO chưa duyệt.
   */
  stageId: string | null;
}

export interface TaskDependency {
  readonly taskId: Uuid;
  readonly dependsOnTaskId: Uuid;
  readonly createdAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Lần chạy agent — §14, §18                                                   */
/* -------------------------------------------------------------------------- */

export interface AgentRun extends Entity {
  agentId: Uuid;
  taskId: Uuid | null;
  projectId: Uuid | null;
  status: RunStatus;
  /** Đường dẫn workspace sandbox cô lập của lần chạy này (§18). */
  workspace: string | null;
  commandLog: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  errorMessage: string | null;
}

/* -------------------------------------------------------------------------- */
/* Tin nhắn hội thoại — §14                                                    */
/* -------------------------------------------------------------------------- */

export interface Message extends Entity {
  projectId: Uuid | null;
  taskId: Uuid | null;
  runId: Uuid | null;
  /** Ai tạo tin nhắn: một vai trò agent, `CEO`, hoặc `SYSTEM`. */
  author: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/* -------------------------------------------------------------------------- */
/* Sản phẩm sinh ra — §14                                                      */
/* -------------------------------------------------------------------------- */

export interface Artifact extends Entity {
  projectId: Uuid;
  taskId: Uuid | null;
  runId: Uuid | null;
  kind: 'document' | 'design' | 'code' | 'report' | 'diagram' | 'test_result';
  title: string;
  /** Con trỏ lưu trữ (key object storage hoặc đường dẫn trong repo) — §65. */
  location: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

/* -------------------------------------------------------------------------- */
/* Lỗi — §14, §8.6                                                             */
/* -------------------------------------------------------------------------- */

export interface Bug extends Entity {
  projectId: Uuid;
  taskId: Uuid | null;
  title: string;
  description: string;
  severity: BugSeverity;
  status: BugStatus;
  reportedByAgentId: Uuid | null;
  assignedAgentId: Uuid | null;
  resolvedAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Phê duyệt — §14, §27                                                        */
/* -------------------------------------------------------------------------- */

export interface Approval extends Entity {
  kind: ApprovalKind;
  status: ApprovalStatus;
  projectId: Uuid | null;
  taskId: Uuid | null;
  title: string;
  /** Tóm tắt cho người đọc, hiển thị ở Telegram và dashboard (§5.2, §27). */
  summary: string;
  /** Ngữ cảnh có cấu trúc để ra quyết định — tuyệt đối không chứa secret (§19). */
  context: Record<string, unknown>;
  requestedByAgentId: Uuid | null;
  decidedByUserId: Uuid | null;
  decidedAt: IsoTimestamp | null;
  decisionNote: string | null;
  expiresAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Triển khai — §14, §62                                                       */
/* -------------------------------------------------------------------------- */

export interface Deployment extends Entity {
  projectId: Uuid;
  environment: DeployEnvironment;
  status: DeployStatus;
  commitSha: string | null;
  url: string | null;
  triggeredByAgentId: Uuid | null;
  approvalId: Uuid | null;
  startedAt: IsoTimestamp | null;
  finishedAt: IsoTimestamp | null;
  logExcerpt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Bản ghi chi phí — §16                                                       */
/* -------------------------------------------------------------------------- */

export interface CostRecord {
  readonly id: Uuid;
  readonly createdAt: IsoTimestamp;
  agentId: Uuid | null;
  projectId: Uuid | null;
  taskId: Uuid | null;
  runId: Uuid | null;
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  /** Độ trễ của lần gọi provider, tính bằng mili-giây (§77). */
  latencyMs: number | null;
}

/* -------------------------------------------------------------------------- */
/* Sự kiện Git — §14, §17                                                      */
/* -------------------------------------------------------------------------- */

export interface GitEvent {
  readonly id: Uuid;
  readonly createdAt: IsoTimestamp;
  projectId: Uuid;
  type: 'branch_created' | 'commit' | 'push' | 'pull_request' | 'merge' | 'review';
  branch: string | null;
  commitSha: string | null;
  pullRequestNumber: number | null;
  actorAgentId: Uuid | null;
  summary: string;
}

/* -------------------------------------------------------------------------- */
/* Thông báo — §14, §134                                                       */
/* -------------------------------------------------------------------------- */

export interface Notification extends Entity {
  userId: Uuid;
  channel: 'telegram' | 'dashboard' | 'email';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  projectId: Uuid | null;
  readAt: IsoTimestamp | null;
  deliveredAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Tệp đính kèm — §14, §5.3                                                    */
/* -------------------------------------------------------------------------- */

export interface Attachment extends Entity {
  projectId: Uuid | null;
  taskId: Uuid | null;
  uploadedByUserId: Uuid | null;
  source: 'telegram' | 'dashboard' | 'agent';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Key trong object storage — mặc định không phải URL công khai (§65). */
  storageKey: string;
  /** Bản gỡ băng cho tin nhắn thoại (§37 voice Telegram). */
  transcript: string | null;
}

/* -------------------------------------------------------------------------- */
/* Nhật ký kiểm toán — §28, §71                                                */
/* -------------------------------------------------------------------------- */

export interface AuditLog {
  readonly id: Uuid;
  readonly createdAt: IsoTimestamp;
  /** `user:<id>`, `agent:<id>` hoặc `system`. */
  actor: string;
  action: string;
  /** Loại thực thể và id mà hành động tác động tới. */
  targetType: string;
  targetId: string | null;
  /** Payload đã redact — §89 cấm secret xuất hiện trong output audit. */
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  environment: Environment;
}

/* -------------------------------------------------------------------------- */
/* API Center — §44–§56, §69                                                   */
/* -------------------------------------------------------------------------- */

export interface ProviderConfig extends Entity {
  provider: AiProviderId;
  displayName: string;
  isEnabled: boolean;
  status: IntegrationStatus;
  /** Chỉ là chuỗi đã mask — key thật không bao giờ rời kho secret (§47, §88.3). */
  keyPreview: string | null;
  /** Tham chiếu tới kho secret đã mã hoá (§69). */
  secretRef: string | null;
  baseUrl: string | null;
  defaultModel: string | null;
  lastTestedAt: IsoTimestamp | null;
  lastError: string | null;
  environment: Environment;
}

export interface ModelRoute extends Entity {
  /** Route này áp dụng cho vai trò agent nào (§50). */
  agentRole: AgentRole;
  mode: RoutingMode;
  tier: ModelTier;
  provider: AiProviderId;
  model: string;
  /** Chuỗi fallback theo thứ tự — §53. */
  fallbacks: Array<{ provider: AiProviderId; model: string }>;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  environment: Environment;
}

export interface IntegrationConfig extends Entity {
  kind: IntegrationKind;
  displayName: string;
  status: IntegrationStatus;
  isEnabled: boolean;
  /** Chỉ chứa cấu hình không nhạy cảm. Secret nằm ở kho secret (§69). */
  settings: Record<string, unknown>;
  secretRefs: string[];
  lastTestedAt: IsoTimestamp | null;
  lastError: string | null;
  environment: Environment;
}

export interface BudgetPolicy extends Entity {
  scope: 'GLOBAL' | 'PROJECT' | 'AGENT' | 'RND';
  scopeId: Uuid | null;
  limitUsd: number;
  period: 'DAY' | 'MONTH' | 'PROJECT';
  warnThreshold: number;
  /** §55 — tự động tạm dừng agent khi chạm trần. */
  hardStop: boolean;
}
