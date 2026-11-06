/**
 * P&N — Hợp đồng event (§21, §129).
 *
 * §9 + §22: dashboard 3D chỉ phản ứng với các event ở đây, không gì khác.
 * Animation không bao giờ được kích hoạt bởi timer hay dữ liệu ngẫu nhiên — nó
 * luôn là hệ quả của một event phát ra từ trạng thái agent thật.
 */

import type {
  AgentRole,
  AgentState,
  AiProviderId,
  BugSeverity,
  DeployEnvironment,
  TaskPriority,
  Uuid,
} from '@pn/shared';

/* -------------------------------------------------------------------------- */
/* Tên event — §21 (vòng sản xuất) + §129 (vòng học hỏi)                        */
/* -------------------------------------------------------------------------- */

/** §21 — event của vòng sản xuất. */
export const PRODUCTION_EVENT_TYPES = [
  'PROJECT_CREATED',
  'PROJECT_MILESTONE',
  'TASK_CREATED',
  'TASK_STARTED',
  'TASK_COMPLETED',
  'TASK_FAILED',
  'BUG_CREATED',
  'AGENT_STARTED',
  'AGENT_STOPPED',
  'AGENT_STATE_CHANGED',
  'APPROVAL_REQUIRED',
  'APPROVED',
  'REJECTED',
  'DEPLOY_STARTED',
  'DEPLOY_SUCCESS',
  'DEPLOY_FAILED',
  'BUDGET_WARNING',
  'BUDGET_EXCEEDED',
  'PROVIDER_ALERT',
  'PROJECT_DELIVERED',
  'AGENT_PROGRESS',
  'PROJECT_PAUSED',
  'PROJECT_RESUMED',
] as const;

/** §129 — event của Knowledge / R&D. */
export const KNOWLEDGE_EVENT_TYPES = [
  'KNOWLEDGE_DISCOVERED',
  'KNOWLEDGE_SCREENED',
  'KNOWLEDGE_EVALUATED',
  'KNOWLEDGE_APPROVAL_REQUIRED',
  'KNOWLEDGE_APPROVED',
  'KNOWLEDGE_REJECTED',
  'KNOWLEDGE_ACTIVATED',
  'KNOWLEDGE_ROLLED_BACK',
  'KNOWLEDGE_DEPRECATED',
  'DEPARTMENT_XP_GAINED',
  'DEPARTMENT_LEVEL_UP',
  'AGENT_PROFILE_UPGRADED',
] as const;

export const EVENT_TYPES = [...PRODUCTION_EVENT_TYPES, ...KNOWLEDGE_EVENT_TYPES] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/* -------------------------------------------------------------------------- */
/* Phong bì event                                                              */
/* -------------------------------------------------------------------------- */

/** Ai gây ra event: `user:<id>`, `agent:<id>` hoặc `system`. */
export type EventActor = `user:${string}` | `agent:${string}` | 'system';

export interface EventEnvelope<T extends EventType = EventType, P = unknown> {
  readonly id: Uuid;
  readonly type: T;
  /** Thời điểm, ISO-8601 UTC. */
  readonly ts: string;
  readonly actor: EventActor;
  readonly projectId: Uuid | null;
  readonly taskId: Uuid | null;
  readonly agentId: Uuid | null;
  readonly payload: P;
}

/* -------------------------------------------------------------------------- */
/* Nội dung payload                                                            */
/* -------------------------------------------------------------------------- */

export interface EventPayloads {
  PROJECT_CREATED: { projectId: Uuid; name: string; productType: string };
  /** §38 — mốc lớn của dự án để báo CEO: thiết kế xong, dựng xong, kiểm thử đạt… */
  PROJECT_MILESTONE: { projectId: Uuid; stageId: string; title: string; detail: string | null; spentUsd: number };
  // `fromRole`/`toRole` cho biết việc đi từ phòng ban nào sang phòng ban nào.
  // Dashboard 3D vẽ đường chuyển giao từ đúng hai đầu này (§9) — thiếu chúng
  // thì mọi chuyển động trên màn hình đều là bịa. `null` nghĩa là do CEO làm
  // trực tiếp chứ không phải agent nào chuyển giao.
  TASK_CREATED: {
    taskId: Uuid;
    title: string;
    assignedRole: AgentRole | null;
    fromRole: AgentRole | null;
    /** Người đưa việc trong 3D gom nhiều hồ sơ một vòng: việc gấp đưa trước, rồi theo thứ tự bước quy trình. */
    priority?: TaskPriority;
    /** Vị trí bước (stage) trong quy trình của loại sản phẩm; `null` là việc ngoài quy trình. */
    step?: number | null;
  };
  TASK_STARTED: { taskId: Uuid; agentRole: AgentRole };
  /** Tiến độ thật giữa chừng một lượt dài (dev viết theo lô tệp): bong bóng 3D hiện thanh phần trăm. */
  AGENT_PROGRESS: { taskId: Uuid; agentRole: AgentRole; pct: number; text: string };
  TASK_COMPLETED: { taskId: Uuid; durationMs: number; agentRole: AgentRole | null };
  TASK_FAILED: { taskId: Uuid; reason: string };
  BUG_CREATED: {
    bugId: Uuid;
    severity: BugSeverity;
    title: string;
    fromRole: AgentRole | null;
    toRole: AgentRole | null;
  };
  AGENT_STARTED: { agentRole: AgentRole; runId: Uuid };
  AGENT_STOPPED: { agentRole: AgentRole; runId: Uuid; status: string };
  /** Điều khiển animation của nhân vật 3D (§9). */
  AGENT_STATE_CHANGED: { agentRole: AgentRole; from: AgentState; to: AgentState };
  APPROVAL_REQUIRED: { approvalId: Uuid; kind: string; title: string };
  APPROVED: { approvalId: Uuid; decidedBy: string };
  REJECTED: { approvalId: Uuid; decidedBy: string; note: string | null };
  DEPLOY_STARTED: { deploymentId: Uuid; environment: DeployEnvironment };
  /** `screenshot`: đường dẫn ảnh cửa sổ thật lúc khởi động thử (bản desktop), gửi kèm tin cho CEO. */
  DEPLOY_SUCCESS: { deploymentId: Uuid; environment: DeployEnvironment; url: string | null; screenshot?: string | null };
  DEPLOY_FAILED: { deploymentId: Uuid; environment: DeployEnvironment; reason: string };
  BUDGET_WARNING: { scope: string; spentUsd: number; limitUsd: number; ratio: number };
  BUDGET_EXCEEDED: { scope: string; spentUsd: number; limitUsd: number; paused: boolean };
  /** Một hãng model hết tiền/hạn mức: công ty tạm né hãng đó `cooldownMs`, CEO cần nạp tiền. */
  PROVIDER_ALERT: { provider: AiProviderId; model: string; kind: 'quota' | 'auth'; detail: string; cooldownMs: number };
  /** Dự án hoàn thành, có sản phẩm để giao: link xem (vé 12 giờ), file .exe nếu là phần mềm desktop. */
  /** CEO bấm Dừng dự án / Tiếp tục — dashboard tải lại, văn phòng 3D thôi hiện người đang làm dự án này. */
  PROJECT_PAUSED: { projectId: Uuid; aborted: number; by: string; cancelled?: boolean };
  PROJECT_RESUMED: { projectId: Uuid; queued: number; by: string };
  PROJECT_DELIVERED: { projectId: Uuid; slug: string; name: string; url: string | null; file: string | null; spentUsd: number; taskCount: number };

  KNOWLEDGE_DISCOVERED: { itemId: Uuid; source: string; title: string };
  KNOWLEDGE_SCREENED: { itemId: Uuid; passed: boolean; reason: string | null };
  KNOWLEDGE_EVALUATED: { itemId: Uuid; score: number };
  KNOWLEDGE_APPROVAL_REQUIRED: { itemId: Uuid; approvalId: Uuid; title: string };
  KNOWLEDGE_APPROVED: { itemId: Uuid; approvalId: Uuid };
  KNOWLEDGE_REJECTED: { itemId: Uuid; approvalId: Uuid; note: string | null };
  KNOWLEDGE_ACTIVATED: { itemId: Uuid; department: string };
  KNOWLEDGE_ROLLED_BACK: { itemId: Uuid; department: string; reason: string };
  KNOWLEDGE_DEPRECATED: { itemId: Uuid; reason: string };
  DEPARTMENT_XP_GAINED: { department: string; xp: number; total: number };
  DEPARTMENT_LEVEL_UP: { department: string; level: number };
  AGENT_PROFILE_UPGRADED: { agentRole: AgentRole; fromVersion: number; toVersion: number };
}

export type PnEvent = {
  [K in EventType]: EventEnvelope<K, EventPayloads[K]>;
}[EventType];
