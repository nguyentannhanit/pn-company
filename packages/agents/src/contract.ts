/**
 * P&N — Hợp đồng runtime của agent (§3).
 *
 * Phase 0 chốt hình dạng chung; Phase 1 bổ sung đúng những thứ một agent thật
 * cần để làm việc: cổng gọi model, phiên sandbox, và ngữ cảnh dự án/task.
 * Những trường đó là bắt buộc chứ không tuỳ chọn — một agent không có ngữ cảnh
 * thì không làm được việc gì có ích.
 */

import type { EventBus } from '@pn/events';
import type { SandboxSession } from '@pn/sandbox';
import type { AgentRole, AgentState, BugSeverity, Department, ProductType, Uuid } from '@pn/shared';

import type { AgentGatewayClient } from './gateway-client.js';
import type { PromptRole } from './prompts.js';
import type { AgentQuestion } from './questions.js';

/** Định nghĩa tĩnh của một vai trò — prompt, phòng ban, và được làm gì. */
export interface AgentDefinition {
  role: AgentRole;
  displayName: string;
  department: Department;
  /** Khoá prompt trong `AGENT_PROMPTS`; kiến thức nối thêm lúc chạy (§142). */
  promptRole: PromptRole;
  /** Dạng công việc mặc định, dùng cho smart routing (§52). */
  defaultTaskKind: 'code' | 'debugging' | 'architecture_review' | 'summarization' | 'general';
  /** Agent này có cần workspace để chạy lệnh không (§18). */
  needsSandbox: boolean;
}

/** Ngữ cảnh dự án mà agent cần biết để làm đúng việc. */
export interface ProjectContext {
  id: Uuid;
  name: string;
  description: string;
  productType: ProductType;
  repoFullName: string | null;
  defaultBranch: string;
}

/** Ngữ cảnh task đang được giao. */
export interface TaskContext {
  id: Uuid;
  title: string;
  description: string;
  fixLoopCount: number;
}

export interface AgentContext {
  runId: Uuid;
  agentId: Uuid;
  projectId: Uuid | null;
  taskId: Uuid | null;
  project: ProjectContext | null;
  task: TaskContext | null;
  events: EventBus;
  /** §89 — đường duy nhất agent chạm tới model. */
  gateway: AgentGatewayClient;
  /** Chỉ có với agent `needsSandbox`; agent khác nhận `null`. */
  sandbox: SandboxSession | null;
  /** Trao đổi trước đó trong cùng task, để agent không hỏi lại thứ đã biết. */
  history: Array<{ author: string; content: string }>;
  /**
   * Kết quả các bước trước trong cùng dự án (thiết kế, kiến trúc, tiêu chí…),
   * mới nhất trước. Không có nó thì dev không biết Designer đã vẽ gì và QA không
   * biết nghiệm thu theo cái gì — sản phẩm trần là hậu quả trực tiếp.
   */
  priorWork: Array<{ role: AgentRole; title: string; summary: string }>;
  /**
   * Tài liệu các phòng đã viết trong `docs/` của dự án (yêu cầu, kiến trúc,
   * thiết kế, sổ quyết định…), nguyên văn. Engine đọc từ workspace; agent không
   * có sandbox thì nhận mảng rỗng.
   */
  documents?: Array<{ path: string; title: string; content: string }>;
  /**
   * §92 — các vai trò được phép nhận việc trong dự án này, lấy từ workflow của
   * loại sản phẩm. Agent nào đề xuất task (CTO, PM) phải giao trong danh sách
   * này; ngoài danh sách thì task sinh ra không có ai nhận.
   */
  allowedRoles: AgentRole[];
  /**
   * §142 — kiến thức phòng ban đang áp dụng cho vai trò này, đã được duyệt và
   * kích hoạt. Rỗng là bình thường: công ty chưa học được gì thì agent làm việc
   * bằng đúng prompt vai trò.
   */
  knowledge: Array<{ title: string; body: string }>;
  /** Huỷ lần chạy khi sandbox timeout hoặc chạm ngưỡng ngân sách (§18, §55). */
  signal: AbortSignal;
}

/** Task mà agent đề xuất tạo thêm (§3.1, §3.2). */
export interface ProposedTask {
  title: string;
  description: string;
  assignedRole: AgentRole;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Chỉ số của các task khác trong cùng danh sách mà task này phải chờ. */
  dependsOnIndexes?: number[];
}

export interface ReportedBug {
  title: string;
  description: string;
  severity: BugSeverity;
}

/** File mà coding agent tạo hoặc sửa trong lần chạy này. */
export interface ProducedFile {
  path: string;
  content: string;
}

export interface AgentOutcome {
  status: 'completed' | 'blocked' | 'failed';
  /** Tóm tắt ngắn, ghi vào `messages` và hiển thị trên dashboard (§11). */
  summary: string;
  proposedTasks?: ProposedTask[];
  reportedBugs?: ReportedBug[];
  producedFiles?: ProducedFile[];
  /**
   * Câu hỏi gửi Phòng điều hành (câu có chi phí thì lên CEO). Có câu hỏi thì
   * engine chưa chốt task: trả lời, ghi Sổ quyết định rồi cho phòng làm lại.
   */
  questions?: AgentQuestion[];
  /** Phê duyệt agent cần xin CEO trước khi đi tiếp (§27). */
  requiresApproval?: { kind: string; title: string; summary: string } | null;
  /** Trạng thái agent kết thúc ở — điều khiển digital twin 3D (§9). */
  endState: AgentState;
  /** Chi phí model của riêng lần chạy này, để ghi vào bản ghi run. */
  costUsd?: number;
}

export interface Agent {
  readonly definition: AgentDefinition;
  run(context: AgentContext): Promise<AgentOutcome>;
}

/** Sổ đăng ký để orchestrator tra vai trò mà không phải import từng agent. */
export class AgentRegistry {
  readonly #agents = new Map<AgentRole, Agent>();

  register(agent: Agent): void {
    this.#agents.set(agent.definition.role, agent);
  }

  get(role: AgentRole): Agent | undefined {
    return this.#agents.get(role);
  }

  has(role: AgentRole): boolean {
    return this.#agents.has(role);
  }

  roles(): AgentRole[] {
    return [...this.#agents.keys()];
  }
}

/**
 * §8.1 / §9 — các chuyển trạng thái hợp lệ duy nhất. Lớp 3D tin rằng agent không
 * bao giờ nhảy sang `celebrate` nếu phía sau không có một lần deploy thành công
 * thật sự.
 */
export const ALLOWED_TRANSITIONS: Record<AgentState, readonly AgentState[]> = {
  idle: ['working', 'meeting', 'offline'],
  working: ['reviewing', 'blocked', 'alert', 'completed', 'idle', 'offline'],
  reviewing: ['working', 'completed', 'blocked', 'alert', 'idle'],
  meeting: ['idle', 'working'],
  blocked: ['working', 'idle', 'offline'],
  alert: ['working', 'blocked', 'idle'],
  completed: ['celebrate', 'idle'],
  celebrate: ['idle'],
  offline: ['idle'],
};

export function canTransition(from: AgentState, to: AgentState): boolean {
  return from === to || (ALLOWED_TRANSITIONS[from]?.includes(to) ?? false);
}
