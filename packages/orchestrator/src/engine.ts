/**
 * P&N — Engine điều phối (§3.1, §4, §18, §43).
 *
 * Đây là vòng sản xuất thật của công ty:
 *
 *   CEO gửi yêu cầu → CTO phân rã → task vào hàng đợi → agent chạy trong sandbox
 *   → QA kiểm thử → fail thì vào fix loop → pass thì commit và mở PR
 *
 * Mỗi bước đều: đổi trạng thái agent (nên nhân vật 3D động theo, §9), ghi bản
 * ghi run kèm log (§18), và phát event để dashboard cập nhật (§21, §22).
 */

import type {
  Agent,
  AgentGatewayClient,
  AgentOutcome,
  AgentRegistry,
  ProposedTask,
  AgentContext,
} from '@pn/agents';
import {
  DECISIONS_DOC,
  DEPARTMENT_DOCS,
  answerQuestions,
  describeDocuments,
  formatDecisions,
  readProjectDocs,
  recommendedDecision,
  type AgentQuestion,
  type Decision,
} from '@pn/agents';
import type { Repositories } from '@pn/database';
import { stageNeedsHuman } from '@pn/permissions';
import type { EventBus } from '@pn/events';
import type { GitHubClient } from '@pn/github';
import type { SandboxDriver, SandboxSession } from '@pn/sandbox';
import type { AgentRole, AgentState, ProductType, Project, ProjectStatus, Task, Uuid } from '@pn/shared';
import { agentProfile, explainFailure, slugify, type FailureKind } from '@pn/shared';
import { randomUUID } from 'node:crypto';

import { InMemoryJobQueue, type JobHandler, type JobQueue } from './queue.js';
import {
  MAX_FIX_LOOP_ITERATIONS,
  decideFixLoop,
  rolesFor,
  stageForRole,
  stagesBefore,
  workflowFor,
  type WorkflowStage,
} from './workflow.js';

/* -------------------------------------------------------------------------- */
/* Phụ thuộc                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Engine không tự đổi cột `state` trong database. Nó đi qua interface này để
 * việc "ghi state + phát event" luôn xảy ra cùng nhau (§9).
 */
export interface AgentStateChanger {
  transition(
    role: AgentRole,
    to: AgentState,
    context?: { taskId?: Uuid | null; projectId?: Uuid | null },
  ): Promise<{ id: Uuid }>;
}

export interface OrchestratorDeps {
  repos: Repositories;
  events: EventBus;
  agents: AgentRegistry;
  agentState: AgentStateChanger;
  gateway: AgentGatewayClient;
  sandbox: SandboxDriver;
  /** GitHub chỉ có khi đã cấu hình tích hợp; chưa có thì bỏ qua bước commit. */
  github: () => Promise<GitHubClient | null>;
  /** Trần thời gian cho một lần chạy agent (§18). */
  runTimeoutMs?: number;
  /**
   * §23 — nơi cắm hàng đợi khác. Không truyền thì dùng hàng đợi trong bộ nhớ,
   * chạy được trên máy không có Redis. Truyền `BullMqJobQueue` thì API chỉ xếp
   * việc còn tiến trình worker gánh phần chạy.
   */
  queue?: QueueFactory;
  /**
   * §38, §144 — dựng bản staging cho dự án (API cắm bộ dựng tại chỗ). Có nó thì
   * stage `staging` do hệ thống làm: dựng, hỏng thì giao DevOps sửa rồi dựng
   * lại, xong thì CEO nhận link — không giao cho agent DevOps "deploy" bằng lời.
   */
  deployStaging?: StagingDeployer;
}

export type StagingDeployer = (
  project: Project,
  signal?: AbortSignal,
) => Promise<{ status: 'SUCCESS' | 'FAILED' | 'CANCELLED'; reason?: string; url?: string | null; file?: string | null }>;

/** Tên hai task hệ thống của stage staging; dashboard và API nhận ra chúng qua tên. */
export const STAGING_BUILD_TITLE = 'Dựng bản staging';
export const STAGING_FIX_TITLE = 'Sửa để staging dựng được';

/** Một task được hỏi Phòng điều hành tối đa chừng này vòng; quá thì lấy phương án phòng đề xuất. */
export const MAX_QUESTION_ROUNDS = 2;
/**
 * Lượt hết giờ thì tự chạy tiếp tối đa chừng này lần liền nhau (tiến độ đã lưu, lượt sau viết nốt tệp còn thiếu),
 * quá nữa mới chặn và báo CEO — việc đó có lẽ quá lớn cho một lượt. Trước đây hết giờ là chặn ngay.
 */
export const MAX_TIMEOUT_RESUMES = 2;
/** Lý do huỷ khi CEO dừng dự án — để phân biệt với hết giờ (hết giờ thì tự chạy tiếp, dừng thì đứng yên). */
const STOP_REASON = 'pn:project-stopped';
/** CEO dừng riêng một việc: tạm dừng thì việc chờ bấm Tiếp tục, dừng hẳn thì dự án bỏ qua nó. */
const TASK_PAUSE_REASON = 'pn:task-paused';
const TASK_CANCEL_REASON = 'pn:task-cancelled';
/** Bản dựng staging của mã cũ — người rà soát vừa mở lại mã nên bản dựng đang chạy vô nghĩa. */
const STALE_REASON = 'pn:staging-stale';
const STOP_REASONS = new Set<unknown>([STOP_REASON, TASK_PAUSE_REASON, TASK_CANCEL_REASON]);

/** Loại lỗi tạm của nguồn AI — tự chạy lại được (xem `autoRetryBlocked`). */
const AUTO_RETRY_KINDS = new Set<FailureKind>(['quota', 'overloaded', 'auth', 'credit', 'no-route', 'restart', 'bad-output']);
export const MAX_AUTO_RETRIES = 3;
/** Trần cứng số vòng sửa khi Phòng điều hành tự cho sửa thêm (lỗi còn giảm) — quá nữa thì hỏi CEO dù đang tiến triển. */
export const HARD_FIX_LOOP_CAP = 6;
/** Đầu tin hệ thống ghi mỗi lần tự chạy lại — đếm lại để giữ trần 3 lần/ngày. */
const AUTO_RETRY_MARK = '↻ Tự chạy lại';

/** Dự án CEO đã dừng (tạm hay hẳn) hoặc cất đi: không mở bước mới, không chạy việc, không dựng. */
export function isHalted(status: ProjectStatus | null | undefined): boolean {
  return status === 'PAUSED' || status === 'CANCELLED' || status === 'ARCHIVED';
}
/** Đầu câu trả lời của Phòng điều hành trong trao đổi — dùng để đếm số vòng đã hỏi. */
const ANSWER_PREFIX = 'Phòng điều hành trả lời';
/** Đầu tin hệ thống đánh dấu lần làm lại dự án; lịch sử trao đổi đưa agent chỉ tính từ đây. */
export const REDO_MARKER = '↻ Làm lại dự án';

/** Mốc nào đáng báo CEO khi stage đó xong, và nói thế nào. */
/** Vai trò viết mã — lỗi rà soát được giao về task gần nhất của họ. Trước đây thiếu MOBILE/DEVOPS nên lỗi app di động bị giao cho dev web. */
const CODE_ROLES = new Set<AgentRole>(['BACKEND_DEVELOPER', 'FRONTEND_DEVELOPER', 'MOBILE_DEVELOPER', 'DEVOPS']);

/** Đường dẫn file mã nêu trong nội dung lỗi, ví dụ `src/renderer/app.ts:23`. */
const FILE_IN_TEXT = /[\w@.-]+(?:\/[\w@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|html?|css|scss|py|kt|swift|dart)\b/gi;

/** Phòng sở hữu file đầu tiên nêu trong lỗi, đoán theo thư mục và đuôi file; không đoán được thì null. */
function ownerRoleOf(text: string): AgentRole | null {
  for (const match of text.match(FILE_IN_TEXT) ?? []) {
    const file = match.toLowerCase();
    if (/(^|\/)(android|ios|mobile)\//.test(file) || /\.(kt|swift|dart)$/.test(file)) return 'MOBILE_DEVELOPER';
    if (/(^|\/)api\//.test(file)) return 'BACKEND_DEVELOPER';
    if (
      /(^|\/)(renderer|ui|components?|pages?|views?|screens?|styles?|public|client|frontend|web)\//.test(file) ||
      /\.(tsx|jsx|vue|svelte|html?|css|scss)$/.test(file)
    ) {
      return 'FRONTEND_DEVELOPER';
    }
    if (/(^|\/)(main|preload|ipc|server|routes?|db|database|storage|backend|services?)(\/|\.)/.test(file)) {
      return 'BACKEND_DEVELOPER';
    }
  }
  return null;
}

/**
 * Việc có dòng "Phạm vi tệp:" (CTO ghi khi chia việc) chứa tệp nêu trong lỗi — khớp thư mục dài nhất thắng. Nhiều việc
 * cùng một phòng thì đoán theo phòng không đủ: lỗi màn chơi phải về việc "Các màn hình", không về việc xong gần nhất.
 */
function scopeOwner(tasks: Task[], text: string): Task | null {
  let best: { task: Task; length: number } | null = null;
  for (const match of text.match(FILE_IN_TEXT) ?? []) {
    const file = match.toLowerCase();
    for (const task of tasks) {
      const scope = /phạm vi tệp\s*:([^\n]*)/i.exec(task.description)?.[1];
      if (!scope) continue;
      for (const entry of scope.split(/[,;]/).map((item) => item.trim().toLowerCase().replace(/^\.\//, ''))) {
        const hit = entry && (entry.endsWith('/') ? file.startsWith(entry) : file === entry);
        if (hit && (!best || entry.length > best.length)) best = { task, length: entry.length };
      }
    }
  }
  return best?.task ?? null;
}

const MILESTONE_TITLES: Record<string, string> = {
  architecture: 'Kiến trúc đã chốt',
  design: 'Thiết kế giao diện xong',
  build: 'Dựng xong, chuyển sang kiểm thử',
  qa: 'Kiểm thử đạt',
  security: 'Rà soát bảo mật xong',
  web_review: 'Rà SEO / hiệu năng / tiếp cận xong',
};

/** Việc trong hàng đợi: chạy một task rồi đẩy dự án của nó tiến tiếp. */
export interface RunJob {
  taskId: Uuid;
  projectId: Uuid;
}

export type QueueFactory = (
  handler: JobHandler<RunJob>,
  onError: (error: unknown, payload: RunJob | null) => void,
) => JobQueue<RunJob>;

export interface IntakeRequest {
  goal: string;
  productType: ProductType;
  requestedByUserId: Uuid;
  name?: string;
  budgetUsd?: number;
  repoFullName?: string | null;
  /**
   * §26 — CEO Command Center cho CEO xem kế hoạch rồi mới bấm duyệt, nên ở luồng
   * đó dự án được lập kế hoạch xong nhưng chưa chạy. Mặc định vẫn chạy ngay để
   * luồng Telegram không đổi hành vi.
   */
  autoStart?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                      */
/* -------------------------------------------------------------------------- */

export class OrchestratorEngine {
  readonly #deps: OrchestratorDeps;
  readonly #queue: JobQueue<RunJob>;
  /** Lượt đang chạy của từng dự án (dự án → việc → công tắc huỷ) — nút Dừng dự án cắt đúng các lượt này. */
  readonly #running = new Map<Uuid, Map<Uuid, AbortController>>();
  /** Bản dựng staging đang chạy của từng dự án — mỗi dự án một bản, nút Dừng cắt đúng bản này. */
  readonly #staging = new Map<Uuid, AbortController>();

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;

    // Chỉ một chỗ duy nhất đẩy dự án tiến tiếp: ngay sau khi một task chạy xong.
    // Trước đây `advance` được gọi rải rác kiểu bắn-quên nên thứ tự không đoán được.
    const handler: JobHandler<RunJob> = async ({ taskId, projectId }) => {
      await this.runTask(taskId);
      await this.advance(projectId);
    };
    const onError = (error: unknown, payload: RunJob | null): void => {
      console.error(`[orchestrator] task ${payload?.taskId ?? '?'} lỗi:`, error);
    };

    this.#queue = deps.queue
      ? deps.queue(handler, onError)
      : new InMemoryJobQueue(handler, (error, payload) => onError(error, payload));
  }

  /** Cho phép người gọi đợi hàng đợi rỗng — dùng trong test và lúc tắt tiến trình. */
  async drain(): Promise<void> {
    await this.#queue.drain();
  }

  queueSize(): number {
    return this.#queue.size();
  }

  /**
   * CEO bấm "Chạy lại" (web, Telegram): xếp việc vào hàng đợi của dự án thay vì chạy thẳng. Trước đây đường này
   * gọi runTask trực tiếp: việc vẫn hiện "kẹt" dù đang chạy, và bấm hai nơi là hai lượt cùng ghi một thư mục.
   */
  async retryTask(taskId: Uuid): Promise<{ status: 'queued' | 'running' | 'done' | 'paused'; task: Task } | { status: 'not_found' }> {
    const { repos } = this.#deps;
    const task = await repos.tasks.findById(taskId);
    if (!task) return { status: 'not_found' };
    if (task.status === 'DONE') return { status: 'done', task };
    if (task.status === 'IN_PROGRESS') return { status: 'running', task };
    const project = await repos.projects.findById(task.projectId);
    if (!project || isHalted(project.status)) return { status: 'paused', task };
    // Bước dựng staging do hệ thống làm: xếp nó như việc thường thì DevOps "viết code" cho việc dựng.
    if (task.title === STAGING_BUILD_TITLE && this.#deps.deployStaging) {
      void this.#attemptStaging(project, task).catch((error: unknown) => console.error('[orchestrator] dựng staging lỗi:', error));
      return { status: 'queued', task };
    }
    await this.#requeue(task);
    return { status: 'queued', task: (await repos.tasks.findById(taskId)) ?? task };
  }

  /**
   * Việc kẹt vì lỗi tạm của nguồn AI (hết lượt, quá tải, đang đăng nhập lại, chưa cấu hình, trả sai khuôn) thì tự chạy
   * lại — trước đây đứng im tới khi CEO bấm "Chạy lại" (Backend từng kẹt 4 lượt lúc đăng nhập lại Claude).
   * Chỉ việc hỏng từ `minAgeMs` trở lên (mặc định 10 phút, cho nguồn kịp hồi), tối đa 3 lần/ngày mỗi việc rồi để CEO
   * xem. Lỗi mã, ngân sách, hết giờ thì không: đã có vòng sửa và nút riêng. Trả số việc đã xếp chạy lại.
   */
  async autoRetryBlocked(options: { minAgeMs?: number } = {}): Promise<number> {
    const { repos } = this.#deps;
    const minAgeMs = options.minAgeMs ?? 10 * 60_000;
    const now = Date.now();
    let queued = 0;
    for (const project of await repos.projects.list({ status: 'IN_PROGRESS' })) {
      for (const task of await repos.tasks.listByProject(project.id)) {
        if (task.status !== 'BLOCKED') continue;
        const [last] = await repos.runs.listByTask(task.id);
        if (!last || last.status !== 'FAILED') continue;
        const explained = explainFailure(last.errorMessage);
        if (!AUTO_RETRY_KINDS.has(explained.kind)) continue;
        if (now - Date.parse(last.finishedAt ?? last.createdAt) < minAgeMs) continue;
        const messages = await repos.messages.listByTask(task.id);
        const tries = messages.filter(
          (message) => message.content.startsWith(AUTO_RETRY_MARK) && now - Date.parse(message.createdAt) < 86_400_000,
        ).length;
        if (tries >= MAX_AUTO_RETRIES) continue;
        await repos.messages.append({
          projectId: task.projectId,
          taskId: task.id,
          author: 'SYSTEM',
          role: 'system',
          content: `${AUTO_RETRY_MARK} (lần ${tries + 1}/${MAX_AUTO_RETRIES}) sau lỗi tạm của nguồn AI: ${explained.title}`,
        });
        if ((await this.retryTask(task.id)).status === 'queued') queued += 1;
      }
    }
    return queued;
  }

  /**
   * CEO dừng riêng một việc. Tạm dừng: cắt lượt đang chạy, tiến độ giữ lại, việc chờ bấm Tiếp tục.
   * Dừng hẳn: cắt và bỏ việc — việc phía sau không đợi nó nữa. Bước dựng staging cũng dừng qua đây.
   */
  async stopTask(taskId: Uuid, mode: 'pause' | 'cancel'): Promise<{ status: 'stopped' | 'done'; task: Task } | { status: 'not_found' }> {
    const { repos } = this.#deps;
    const task = await repos.tasks.findById(taskId);
    if (!task) return { status: 'not_found' };
    if (task.status === 'DONE') return { status: 'done', task };
    const reason = mode === 'cancel' ? TASK_CANCEL_REASON : TASK_PAUSE_REASON;
    // Ghi trạng thái trước: việc đang xếp hàng chưa tới lượt thấy trạng thái này và không chạy.
    await repos.tasks.setStatus(task.id, mode === 'cancel' ? 'CANCELLED' : 'PAUSED');
    if (task.title === STAGING_BUILD_TITLE) this.#staging.get(task.projectId)?.abort(reason);
    else this.#running.get(task.projectId)?.get(task.id)?.abort(reason);
    return { status: 'stopped', task: (await repos.tasks.findById(taskId)) ?? task };
  }

  /**
   * Đưa việc vào hàng đợi dự án: đánh dấu đang làm ngay (dashboard hết hiện "kẹt", bấm lần nữa không xếp trùng),
   * nhân viên đang "kẹt" vì chính việc này thì về rảnh chờ tới lượt.
   */
  async #requeue(task: Task): Promise<void> {
    const { repos, agentState } = this.#deps;
    await repos.tasks.setStatus(task.id, 'IN_PROGRESS');
    if (task.assignedRole) {
      const agent = await repos.agents.findByRole(task.assignedRole);
      if (agent?.state === 'blocked') {
        await agentState.transition(task.assignedRole, 'idle', { taskId: task.id, projectId: task.projectId });
      }
    }
    await this.#queue.enqueue({ key: task.projectId, payload: { taskId: task.id, projectId: task.projectId } });
  }

  /**
   * CEO bấm "Dừng dự án": không nhận việc mới, cắt ngay mọi lượt đang chạy (tiến trình CLI bị kill cả cây,
   * lời gọi API bị huỷ). Việc đang làm dở về "Chờ làm" — không tính là lỗi, không báo lỗi Telegram. Tệp đã viết và tiến
   * độ theo lô vẫn nằm trong workspace, và lịch sử việc ghi dừng ở đâu, nên lúc Tiếp tục agent làm nối từ đó.
   */
  async stopProject(projectId: Uuid, mode: 'pause' | 'cancel' = 'pause'): Promise<{ aborted: number; reset: number }> {
    const { repos } = this.#deps;
    // Dừng hẳn: như tạm dừng nhưng không có Tiếp tục — làm tiếp thì bấm "Làm lại dự án".
    await repos.projects.updateStatus(projectId, mode === 'cancel' ? 'CANCELLED' : 'PAUSED');
    const running = this.#running.get(projectId);
    const build = this.#staging.get(projectId);
    const aborted = (running?.size ?? 0) + (build ? 1 : 0);
    for (const controller of running?.values() ?? []) controller.abort(STOP_REASON);
    // Bản dựng staging cũng bị cắt — trước đây nó dựng tiếp vài phút rồi còn tự đánh dấu dự án hoàn thành.
    build?.abort(STOP_REASON);
    // Việc đã xếp hàng mà chưa tới lượt (đang ghi "đang làm"): về chờ làm. Việc đang chạy thì tự về khi lượt của nó dừng.
    const reset = await this.#releaseQueued(projectId);
    return { aborted, reset };
  }

  /** Tiếp tục dự án đã dừng: về "đang làm" rồi xếp lại việc — việc dở chạy nối từ tiến độ đã lưu. */
  async resumeProject(projectId: Uuid): Promise<number> {
    const { repos } = this.#deps;
    await repos.projects.updateStatus(projectId, 'IN_PROGRESS');
    // Còn việc ghi "đang làm" mà không có lượt nào chạy (máy tắt giữa lúc dừng chẳng hạn) thì trả về chờ làm trước.
    await this.#releaseQueued(projectId);
    // Tiếp tục dự án = chạy tiếp mọi thứ, kể cả việc tạm dừng riêng lẻ. Bản dựng bị cắt thì dựng lại từ đầu, chạy nền.
    let build: Task | null = null;
    for (const task of await repos.tasks.listByProject(projectId)) {
      if (task.status !== 'PAUSED') continue;
      if (task.title === STAGING_BUILD_TITLE) build = task;
      else await repos.tasks.setStatus(task.id, 'TODO');
    }
    const queued = await this.advance(projectId);
    const project = await repos.projects.findById(projectId);
    if (build && project && this.#deps.deployStaging) {
      void this.#attemptStaging(project, build).catch((error: unknown) => console.error('[orchestrator] dựng staging lỗi:', error));
    }
    return queued;
  }

  /** Việc ghi IN_PROGRESS mà không có lượt nào đang chạy → TODO. Bỏ qua bước dựng staging (hệ thống tự dựng, không phải việc của agent). */
  async #releaseQueued(projectId: Uuid): Promise<number> {
    const { repos } = this.#deps;
    const live = this.#running.get(projectId);
    let reset = 0;
    for (const task of await repos.tasks.listByProject(projectId)) {
      if (task.status !== 'IN_PROGRESS' || live?.has(task.id) || task.title === STAGING_BUILD_TITLE) continue;
      await repos.tasks.setStatus(task.id, 'TODO');
      reset += 1;
    }
    return reset;
  }

  /** Số lượt HẾT GIỜ liền nhau gần nhất của việc (tính cả lượt vừa xong). */
  async #timeoutStreak(taskId: Uuid): Promise<number> {
    const runs = await this.#deps.repos.runs.listByTask(taskId);
    const other = runs.findIndex((run) => run.status !== 'TIMEOUT');
    return other === -1 ? runs.length : other;
  }

  /**
   * Gọi một lần khi API khởi động. Tiến trình cũ chết mang theo hàng đợi trong bộ
   * nhớ: lượt chạy vẫn ghi RUNNING, task vẫn IN_PROGRESS, nhưng không ai làm nữa —
   * dự án đứng im mà văn phòng 3D không có gì để hiện. Ở đây chốt các lượt đó là
   * thất bại, trả task về TODO rồi `advance` từng dự án để việc tự chạy tiếp.
   */
  async recover(): Promise<{ runs: number; projects: Uuid[]; restaged: number }> {
    const { repos } = this.#deps;
    const reason = 'API khởi động lại giữa chừng, lượt chạy bị cắt';
    const runs = await repos.runs.failOrphans(reason);
    await repos.deployments.failOrphans(reason);
    const active = await repos.projects.list({ status: 'IN_PROGRESS' });

    // Dựng staging bị cắt không phải việc để agent viết code: giữ nguyên IN_PROGRESS (để advance không
    // xếp nó như task thường) rồi cho hệ thống dựng lại. Trả về TODO từng khiến DevOps "làm" việc dựng.
    const interrupted: Array<{ project: Project; build: Task }> = [];
    for (const project of active) {
      const build = (await repos.tasks.listByStage(project.id, 'staging')).find(
        (task) => task.title === STAGING_BUILD_TITLE && task.status === 'IN_PROGRESS',
      );
      if (build) interrupted.push({ project, build });
    }

    const requeued = await repos.tasks.requeueInProgress(interrupted.map(({ build }) => build.id));
    // Đẩy cả dự án đang chạy mà không có task treo: việc TODO đã hết phụ thuộc (kể cả task CEO vừa mở lại) chạy ngay.
    const projects = [...new Set([...requeued, ...active.map((project) => project.id)])];
    for (const projectId of projects) await this.advance(projectId);
    if (this.#deps.deployStaging) {
      for (const { project, build } of interrupted) await this.#attemptStaging(project, build);
    }
    return { runs, projects, restaged: this.#deps.deployStaging ? interrupted.length : 0 };
  }

  /* ---------------------------------------------------------------------- */
  /* Tiếp nhận yêu cầu — §3.1                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Biến một câu yêu cầu của CEO thành dự án có task. CTO chạy ngay tại đây
   * (đồng bộ) vì CEO đang đợi câu trả lời "đã nhận việc, đây là kế hoạch".
   */
  async intake(request: IntakeRequest): Promise<{ projectId: Uuid; taskIds: Uuid[]; summary: string }> {
    const { projectId, planningTaskId } = await this.openIntake(request);
    return this.planIntake(projectId, planningTaskId, request.autoStart !== false);
  }

  /**
   * Nửa nhanh của `intake`: tạo dự án (PLANNING) và task phân rã cho CTO, chưa chạy gì. Tách ra để trang
   * web trả lời ngay rồi CTO lập kế hoạch nền: CTO chạy qua Claude (gói) mất vài phút, trong khi đường hầm
   * Cloudflare cắt mọi request chờ quá 100 giây — CEO nhận lỗi, không thấy kế hoạch, không có nút duyệt
   * (dự án kẹt ở PLANNING).
   */
  async openIntake(request: IntakeRequest): Promise<{ projectId: Uuid; planningTaskId: Uuid }> {
    const { repos, events } = this.#deps;

    const name = request.name ?? deriveName(request.goal);
    let slug = slugify(name);
    for (let suffix = 2; await repos.projects.findBySlug(slug); suffix += 1) {
      slug = `${slugify(name)}-${suffix}`;
    }

    const project = await repos.projects.create({
      name,
      slug,
      description: request.goal,
      productType: request.productType,
      ownerId: request.requestedByUserId,
      repoFullName: request.repoFullName ?? null,
      budgetUsd: request.budgetUsd ?? 20,
    });

    await events.publish(
      'PROJECT_CREATED',
      { projectId: project.id, name: project.name, productType: project.productType },
      { projectId: project.id, actor: `user:${request.requestedByUserId}` },
    );
    await repos.projects.updateStatus(project.id, 'PLANNING');

    // CTO lập kế hoạch. Task "lập kế hoạch" cũng là một task thật để có bản ghi run.
    const workflow = workflowFor(request.productType);
    const planningTask = await repos.tasks.create({
      projectId: project.id,
      title: 'Phân rã yêu cầu của CEO',
      description: request.goal,
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: stageForRole(workflow, 'CTO_ORCHESTRATOR')?.id ?? null,
    });
    // CEO giao thẳng (fromRole null): văn phòng 3D cho Khang ở quầy lễ tân mang hồ sơ lên bàn CTO — CEO
    // bấm "Giao việc" là thấy việc chạy tới phòng Điều hành.
    await events.publish(
      'TASK_CREATED',
      {
        taskId: planningTask.id,
        title: planningTask.title,
        assignedRole: 'CTO_ORCHESTRATOR',
        fromRole: null,
        priority: planningTask.priority,
        step: planningTask.stageId ? workflow.findIndex((stage) => stage.id === planningTask.stageId) : null,
      },
      { projectId: project.id, taskId: planningTask.id },
    );

    return { projectId: project.id, planningTaskId: planningTask.id };
  }

  /** Nửa chậm của `intake`: CTO phân rã; `autoStart` thì chạy luôn, không thì đứng ở PLANNING chờ CEO duyệt. */
  async planIntake(
    projectId: Uuid,
    planningTaskId: Uuid,
    autoStart: boolean,
  ): Promise<{ projectId: Uuid; taskIds: Uuid[]; summary: string }> {
    const { repos } = this.#deps;
    const outcome = await this.runTask(planningTaskId);
    const tasks = await repos.tasks.listByProject(projectId);

    // Chưa duyệt thì dự án đứng ở PLANNING: kế hoạch đã có, chưa tiêu đồng nào
    // cho việc thực thi. CEO bấm duyệt thì `advance` mới chạy (§26).
    const stopped = isHalted((await repos.projects.findById(projectId))?.status);
    if (autoStart && !stopped) {
      await repos.projects.updateStatus(projectId, 'IN_PROGRESS');
      await this.advance(projectId);
    }

    return {
      projectId,
      taskIds: tasks.map((task) => task.id),
      summary: outcome?.summary ?? 'CTO chưa đưa ra kế hoạch.',
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Đẩy dự án tiến lên — §4                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Xếp vào hàng đợi mọi task đã hết bị chặn. Không chạy trùng task đang chạy.
   *
   * §4 + §27 — task còn phải qua cổng duyệt của stage nó thuộc về. Đây là chỗ
   * duy nhất cưỡng chế điều đó: stage `requiresApproval` (kiến trúc, deploy
   * production) không mở khi CEO chưa duyệt, dù task đã hết phụ thuộc.
   */
  async advance(projectId: Uuid): Promise<number> {
    const { repos } = this.#deps;
    const project = await repos.projects.findById(projectId);
    // Dự án đã dừng: không mở bước mới, không dựng lại staging, không xếp việc — mọi ngả tự chạy tiếp đều đi qua đây.
    if (!project || isHalted(project.status)) return 0;

    const workflow = workflowFor(project.productType);

    // §38 — vòng tự chủ: hết việc thì tự mở stage kế tiếp, không đợi CEO bấm.
    await this.#seedNextStage(projectId, workflow);
    await this.#retryStaging(projectId);

    const ready = await repos.tasks.listReady(projectId);

    let queued = 0;
    for (const task of ready) {
      if (!(await this.#stageGateOpen(project.id, workflow, task))) continue;
      // Đánh dấu IN_PROGRESS ngay để lần `advance` kế tiếp không xếp lại task này.
      await repos.tasks.setStatus(task.id, 'IN_PROGRESS');
      await this.#queue.enqueue({ key: projectId, payload: { taskId: task.id, projectId } });
      queued += 1;
    }
    // Không còn gì để chạy: dự án đã xong mà chưa ai chốt (việc cuối xong sau lúc dựng) thì chốt ở đây.
    if (queued === 0 && project.status === 'IN_PROGRESS' && !this.#staging.has(projectId)) {
      await this.#completeIfDone(project, null, null);
    }
    return queued;
  }

  /**
   * §38 — mở stage kế tiếp khi stage trước đã xong.
   *
   * Không có bước này thì pipeline dừng lại ở chỗ CTO hết ý tưởng giao việc:
   * CTO thường chỉ đề xuất tới bước viết mã và kiểm thử, nên các stage bảo mật,
   * triển khai và staging không bao giờ có task nào và dự án đứng im mà không
   * có gì báo lỗi. Đó là khoảng cách giữa "chạy được một vòng" và "tự chạy".
   *
   * Ba điều kiện để mở một stage, phải đủ cả ba:
   *   - stage đó chưa có task nào (không tạo trùng);
   *   - mọi stage nó phụ thuộc đã có task và tất cả đều DONE;
   *   - stage đó nằm trong vòng tự chủ — `production` thì không (§147).
   *
   * Chỉ mở MỘT stage mỗi lần gọi: mở hàng loạt thì các stage sau chạy trước khi
   * stage trước kịp sinh ra thứ chúng cần đọc.
   */
  async #seedNextStage(projectId: Uuid, workflow: WorkflowStage[]): Promise<void> {
    const { repos, events, agents } = this.#deps;

    for (const stage of workflow) {
      if (stageNeedsHuman(stage.id)) continue;

      const existing = await repos.tasks.listByStage(projectId, stage.id);
      if (existing.length > 0) continue;

      // Stage trước phải xong hẳn. Chưa có task nào ở stage trước nghĩa là
      // pipeline chưa chạy tới đó, không phải nó đã xong.
      const previous = stagesBefore(workflow, stage.id);
      let ready = true;
      for (const parentId of previous) {
        const tasks = await repos.tasks.listByStage(projectId, parentId);
        if (tasks.length === 0 || tasks.some((task) => task.status !== 'DONE' && task.status !== 'CANCELLED')) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;

      await this.#milestones(projectId, stage);

      // §144 — stage staging do hệ thống dựng khi API đã cắm bộ dựng.
      if (stage.id === 'staging' && this.#deps.deployStaging) {
        await this.#runStaging(projectId, stage, previous);
        return;
      }

      const seeded: Uuid[] = [];
      for (const role of stage.roles) {
        // Vai trò chưa có agent thì bỏ qua, đừng tạo task để nó nằm chặn.
        if (!agents.has(role)) continue;

        const task = await repos.tasks.create({
          projectId,
          title: stage.description,
          description:
            `Bước "${stage.description}" của quy trình. Không có agent nào đề xuất ` +
            'việc cho bước này nên hệ thống mở nó theo pipeline (§38).',
          priority: 'MEDIUM',
          assignedRole: role,
          stageId: stage.id,
          dependsOn: (
            await Promise.all(previous.map((parent) => repos.tasks.listByStage(projectId, parent)))
          )
            .flat()
            .map((item) => item.id),
        });

        await events.publish(
          'TASK_CREATED',
          {
            taskId: task.id,
            title: task.title,
            assignedRole: role,
            fromRole: 'CTO_ORCHESTRATOR',
            priority: task.priority,
            step: workflow.indexOf(stage),
          },
          { projectId, taskId: task.id },
        );
        seeded.push(task.id);
      }
      await this.#holdLaterStages(projectId, workflow, stage.id, seeded);
      return; // mỗi lần chỉ mở một stage
    }
  }

  /**
   * Việc mới ở một stage thì việc chưa xong ở mọi stage SAU phải đợi nó. Không có bước này, stage được mở bù (CTO
   * không giao việc Kiểm thử, pipeline tự mở) chạy song song với việc Bảo mật / DevOps CTO đã giao sẵn — từng
   * xảy ra: Bảo mật rà bản chưa qua Kiểm thử, DevOps đóng gói trước khi Kiểm thử xong.
   */
  async #holdLaterStages(projectId: Uuid, workflow: WorkflowStage[], stageId: string, taskIds: Uuid[]): Promise<void> {
    const { repos } = this.#deps;
    if (taskIds.length === 0) return;
    for (const later of workflow) {
      if (!stagesBefore(workflow, later.id).includes(stageId)) continue;
      for (const task of await repos.tasks.listByStage(projectId, later.id)) {
        if (task.status === 'DONE' || task.status === 'CANCELLED') continue;
        await repos.tasks.addDependencies(task.id, taskIds);
      }
    }
  }

  /** Cắm bộ dựng staging sau khi dựng engine (API cần app đã có JWT để ký vé xem). */
  useStagingDeployer(deployer: StagingDeployer): void {
    this.#deps.deployStaging = deployer;
  }

  /**
   * Báo CEO khi một stage đáng chú ý vừa xong (ngay lúc pipeline chuẩn bị mở
   * stage kế tiếp, nên mỗi mốc chỉ phát đúng một lần).
   */
  async #milestones(projectId: Uuid, next: WorkflowStage): Promise<void> {
    const { repos, events } = this.#deps;
    const project = await repos.projects.findById(projectId);
    if (!project) return;
    for (const stageId of next.dependsOn) {
      const title = MILESTONE_TITLES[stageId];
      if (!title) continue;
      const done = await repos.tasks.listByStage(projectId, stageId);
      const detail = done.map((task) => task.title).join('; ').slice(0, 300) || null;
      await events.publish(
        'PROJECT_MILESTONE',
        { projectId, stageId, title, detail, spentUsd: project.spentUsd },
        { projectId },
      );
    }
  }

  /** Mở stage staging: tạo task hệ thống rồi dựng ngay. */
  async #runStaging(projectId: Uuid, stage: WorkflowStage, previous: string[]): Promise<void> {
    const { repos } = this.#deps;
    const project = await repos.projects.findById(projectId);
    if (!project) return;
    const dependsOn = (
      await Promise.all(previous.map((parent) => repos.tasks.listByStage(projectId, parent)))
    )
      .flat()
      .map((item) => item.id);
    const build = await repos.tasks.create({
      projectId,
      title: STAGING_BUILD_TITLE,
      description:
        'Hệ thống dựng bản staging trong workspace (npm run build nếu có) và phục vụ tại ' +
        '/product/<slug>/ (§38, §144). Hỏng thì tự giao DevOps sửa rồi dựng lại.',
      priority: 'HIGH',
      assignedRole: 'DEVOPS',
      stageId: stage.id,
      dependsOn,
    });
    await this.#attemptStaging(project, build);
  }

  /** Một lần dựng: xong thì task DONE, hỏng thì giao DevOps (tối đa MAX_FIX_LOOP_ITERATIONS lần), CEO dừng thì chờ. */
  async #attemptStaging(project: Project, build: Task): Promise<void> {
    const { repos, agents, agentState } = this.#deps;
    // Mỗi dự án một bản dựng: bấm hai lần, hay nút bấm trùng lúc stage tự động đang dựng, không dựng chồng một thư mục.
    if (this.#staging.has(project.id)) return;
    const controller = new AbortController();
    this.#staging.set(project.id, controller);
    try {
      await repos.tasks.setStatus(build.id, 'IN_PROGRESS');
      // Dựng staging do hệ thống chạy (npm install + build, bản desktop mất vài phút)
      // nhưng việc đứng tên DevOps: cho DevOps ngồi làm trên văn phòng 3D suốt lúc dựng.
      // Trước đây không ai đổi trạng thái, dự án đứng "11/12" mà cả văn phòng ngồi rảnh.
      const shown = agents.has('DEVOPS')
        ? await agentState.transition('DEVOPS', 'working', { taskId: build.id, projectId: project.id }).then(() => true, () => false)
        : false;
      let result: Awaited<ReturnType<NonNullable<OrchestratorDeps['deployStaging']>>>;
      try {
        result = await this.#deps.deployStaging!(project, controller.signal);
      } finally {
        if (shown) await agentState.transition('DEVOPS', 'idle', { taskId: null, projectId: null });
      }
      if (controller.signal.aborted || result.status === 'CANCELLED') {
        await this.#settleStagingStopped(project, build, controller.signal.reason);
        return;
      }
      if (result.status === 'SUCCESS') await this.#stagingSucceeded(project, build, result.url ?? null, result.file ?? null);
      else await this.#stagingFailed(project, build, result.reason ?? 'không rõ');
    } finally {
      this.#staging.delete(project.id);
    }
  }

  /** Bản dựng bị cắt: bỏ (mã cũ) thì thôi, dừng hẳn thì bỏ bước dựng, còn lại chờ Tiếp tục / Dựng bản thử dựng lại từ đầu. */
  async #settleStagingStopped(project: Project, build: Task, reason: unknown): Promise<void> {
    const { repos } = this.#deps;
    if (reason === STALE_REASON || !(await repos.tasks.findById(build.id))) return;
    const cancelled = reason === TASK_CANCEL_REASON;
    await repos.tasks.setStatus(build.id, cancelled ? 'CANCELLED' : 'PAUSED');
    await repos.messages.append({
      projectId: project.id,
      taskId: build.id,
      author: 'SYSTEM',
      role: 'system',
      content: cancelled
        ? 'CEO dừng hẳn bước dựng. Dự án không tự dựng lại; muốn dựng thì bấm "Dựng bản thử".'
        : 'CEO dừng bản dựng giữa chừng. Bấm Tiếp tục hoặc "Dựng bản thử" để dựng lại từ đầu.',
    });
  }

  /**
   * Người rà soát vừa mở lại mã: bước staging đang có (kể cả bản đang dựng) là của mã cũ — cắt và bỏ, pipeline tự mở
   * lại bước staging khi các bước trước xong lại. Từng xảy ra: bước staging nằm từ lượt trước, mỗi lần API khởi
   * động lại là dựng lại trong khi QA vẫn đang rớt.
   */
  async #dropStaleStaging(projectId: Uuid): Promise<void> {
    const { repos } = this.#deps;
    const staging = await repos.tasks.listByStage(projectId, 'staging');
    if (staging.length === 0) return;
    this.#staging.get(projectId)?.abort(STALE_REASON);
    for (const task of staging) await repos.tasks.delete(task.id);
  }

  /**
   * Nút "Dựng bản thử" đi cùng đường với stage staging tự động: một bản dựng mỗi dự án, dừng được, hỏng thì DevOps
   * sửa rồi `advance` tự dựng lại, xong thì task dựng DONE. Chạy nền vì bản desktop dựng mất vài phút. Trước đây
   * nút này dựng riêng: không dừng được, bấm hai lần là hai bản dựng cùng ghi một thư mục.
   */
  async buildStaging(projectId: Uuid): Promise<'started' | 'running' | 'halted' | 'unavailable' | 'not_found'> {
    const { repos } = this.#deps;
    if (!this.#deps.deployStaging) return 'unavailable';
    const project = await repos.projects.findById(projectId);
    if (!project) return 'not_found';
    if (isHalted(project.status)) return 'halted';
    if (this.#staging.has(projectId)) return 'running';
    let build = (await repos.tasks.listByStage(projectId, 'staging')).find((task) => task.title === STAGING_BUILD_TITLE);
    if (!build) {
      build = await repos.tasks.create({
        projectId,
        title: STAGING_BUILD_TITLE,
        description: 'Bản staging dựng từ nút "Dựng bản thử" (§38, §144).',
        priority: 'HIGH',
        assignedRole: 'DEVOPS',
        stageId: 'staging',
      });
    }
    void this.#attemptStaging(project, build).catch((error: unknown) => console.error('[orchestrator] dựng staging lỗi:', error));
    return 'started';
  }

  /** Dự án có đang dựng staging không — trang Triển khai dựa vào đây để hiện nút Dừng thay cho nút Dựng. */
  isBuildingStaging(projectId: Uuid): boolean {
    return this.#staging.has(projectId);
  }

  async #stagingSucceeded(project: Project, build: Task, url: string | null, file: string | null): Promise<void> {
    const { repos, events } = this.#deps;
    await repos.tasks.setStatus(build.id, 'DONE');
    await repos.messages.append({
      projectId: project.id,
      taskId: build.id,
      author: 'SYSTEM',
      role: 'system',
      content: `Bản staging đã dựng và phục vụ tại ${url ?? '(không có URL)'}.`,
    });

    // Đã dựng được: việc "sửa để dựng được" còn treo không cần nữa. Để nó chạy nốt thì lúc chốt hoàn thành nó chưa
    // xong, rồi không ai chốt lại — từng có dự án xong hết mà kẹt "Đang chạy".
    for (const task of await repos.tasks.listByStage(project.id, 'staging')) {
      if (task.title !== STAGING_FIX_TITLE || task.status === 'DONE' || task.status === 'CANCELLED') continue;
      this.#running.get(project.id)?.get(task.id)?.abort(TASK_CANCEL_REASON);
      await repos.tasks.setStatus(task.id, 'CANCELLED');
    }

    // Staging là bước tự động cuối (phát hành chính thức cần CEO duyệt riêng): dựng
    // xong mà không còn việc nào dở thì dự án hoàn thành, và báo CEO qua Telegram.
    const openBugs = await repos.bugs.countOpen(project.id);
    if (openBugs > 0) {
      // Không được gọi là hoàn thành khi còn lỗi chưa ai xác nhận đã sửa.
      await events.publish(
        'PROJECT_MILESTONE',
        {
          projectId: project.id,
          stageId: 'staging',
          title: `Bản staging chạy được nhưng còn ${openBugs} lỗi mở: ${project.name}`,
          detail: 'Dự án chưa hoàn thành. Xem danh sách lỗi trong tab Dự án; CEO muốn bỏ qua thì từ chối phiếu sửa lỗi.',
          spentUsd: project.spentUsd,
        },
        { projectId: project.id },
      );
      return;
    }
    await this.#completeIfDone(project, url, file);
  }

  /**
   * Chốt hoàn thành khi mọi việc đã xong hoặc bỏ, bước dựng staging đã xong và không còn lỗi mở: dự án COMPLETED, báo
   * CEO bàn giao. Gọi lúc dựng xong và ở mỗi lần `advance` — việc cuối cùng có thể xong SAU lúc dựng.
   */
  async #completeIfDone(project: Project, url: string | null, file: string | null): Promise<void> {
    const { repos, events } = this.#deps;
    const tasks = await repos.tasks.listByProject(project.id);
    const built = tasks.some((task) => task.title === STAGING_BUILD_TITLE && task.status === 'DONE');
    if (!built || (await repos.bugs.countOpen(project.id)) > 0) return;
    if (tasks.every((task) => task.status === 'DONE' || task.status === 'CANCELLED')) {
      await repos.projects.updateStatus(project.id, 'COMPLETED');
      await events.publish(
        'PROJECT_MILESTONE',
        {
          projectId: project.id,
          stageId: 'staging',
          title: `Dự án hoàn thành: ${project.name}`,
          detail: `${tasks.length}/${tasks.length} việc xong. Phát hành chính thức vẫn chờ anh duyệt ở tab Triển khai.`,
          spentUsd: project.spentUsd,
        },
        { projectId: project.id },
      );
      // Bàn giao thật về Telegram: link, ảnh, tệp — không chỉ dòng "hoàn thành".
      await events.publish(
        'PROJECT_DELIVERED',
        { projectId: project.id, slug: project.slug, name: project.name, url, file, spentUsd: project.spentUsd, taskCount: tasks.length },
        { projectId: project.id },
      );
    }
  }

  async #stagingFailed(project: Project, build: Task, reason: string): Promise<void> {
    const { repos, events } = this.#deps;
    const attempt = await repos.tasks.incrementFixLoop(build.id);
    await repos.tasks.setStatus(build.id, 'BLOCKED');
    await repos.messages.append({
      projectId: project.id,
      taskId: build.id,
      author: 'SYSTEM',
      role: 'system',
      content: `Dựng staging lần ${attempt} thất bại: ${reason}`,
    });

    if (attempt > MAX_FIX_LOOP_ITERATIONS) {
      await events.publish(
        'TASK_FAILED',
        { taskId: build.id, reason: `Dựng staging thất bại ${attempt} lần. Lần cuối: ${reason}` },
        { projectId: project.id, taskId: build.id },
      );
      return;
    }
    const fix = await repos.tasks.create({
      projectId: project.id,
      title: STAGING_FIX_TITLE,
      description:
        `Triển khai staging thất bại (lần ${attempt}): ${reason}\n\n` +
        'Sửa trong workspace để "npm run build" chạy xanh và index.html mở lên có logic. ' +
        'Giữ nguyên giao diện và các file khác; chỉ đổi những gì cần cho việc dựng.',
      priority: 'HIGH',
      assignedRole: 'DEVOPS',
      stageId: build.stageId,
    });
    await events.publish(
      'TASK_CREATED',
      { taskId: fix.id, title: fix.title, assignedRole: 'DEVOPS', fromRole: 'DEVOPS', priority: fix.priority },
      { projectId: project.id, taskId: fix.id },
    );
  }

  /** DevOps sửa xong thì dựng lại: mỗi lần hỏng sinh một task sửa, sửa xong hết mới thử lại. */
  async #retryStaging(projectId: Uuid): Promise<void> {
    if (!this.#deps.deployStaging) return;
    const { repos } = this.#deps;
    const staging = await repos.tasks.listByStage(projectId, 'staging');
    const build = staging.find((task) => task.title === STAGING_BUILD_TITLE);
    if (!build || build.status !== 'BLOCKED' || build.fixLoopCount > MAX_FIX_LOOP_ITERATIONS) return;
    const fixes = staging.filter((task) => task.title === STAGING_FIX_TITLE);
    const fixed = fixes.filter((task) => task.status === 'DONE').length;
    if (fixes.length === 0 || fixed < fixes.length || fixed < build.fixLoopCount) return;
    const project = await repos.projects.findById(projectId);
    if (project) await this.#attemptStaging(project, build);
  }

  /**
   * §20, §27, §38 — cổng duyệt của stage.
   *
   * Chưa có phiếu thì tạo phiếu rồi để task nằm yên ở TODO: nó không hỏng, nó
   * đang chờ người duyệt. Bị từ chối thì chặn hẳn, vì hỏi lại vòng vô tận một
   * câu CEO đã trả lời là cách nhanh nhất để đốt ngân sách.
   */
  async #stageGateOpen(projectId: Uuid, workflow: WorkflowStage[], task: Task): Promise<boolean> {
    if (!task.stageId) return true;

    const stage = workflow.find((item) => item.id === task.stageId);
    if (!stage?.requiresApproval) return true;

    const { repos, events } = this.#deps;
    const existing = await repos.approvals.findLatestForStage(projectId, stage.id);

    if (existing?.status === 'APPROVED') return true;
    if (existing?.status === 'PENDING') return false;
    if (existing?.status === 'REJECTED') {
      await this.#block(task, `CEO đã từ chối bước "${stage.description}", task không chạy tiếp.`);
      return false;
    }

    const approval = await repos.approvals.create({
      kind: stage.approvalKind ?? 'PROJECT_PLAN',
      title: `Cần CEO duyệt: ${stage.description}`,
      summary:
        `Bước "${stage.description}" đang chờ CEO duyệt mới được chạy.\n` +
        `Task đầu tiên trong bước: "${task.title}".`,
      projectId,
      taskId: task.id,
      context: { stageId: stage.id },
    });

    await events.publish(
      'APPROVAL_REQUIRED',
      { approvalId: approval.id, kind: approval.kind, title: approval.title },
      { projectId, taskId: task.id },
    );
    return false;
  }

  /* ---------------------------------------------------------------------- */
  /* Chạy một task                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * CEO duyệt phiếu "QA vẫn không đạt" = cho sửa thêm một vòng: task code và
   * task QA về TODO, QA đợi dev. Trước đây duyệt xong không ai đụng tới hai task
   * đang BLOCKED nên `advance` không có gì để chạy — CEO bấm Duyệt trên Telegram
   * mà dự án vẫn đứng im. Trả `false` khi phiếu không phải loại này.
   */
  async resumeFixLoop(approval: { taskId: Uuid | null; context: Record<string, unknown> }): Promise<boolean> {
    const { repos } = this.#deps;
    if (approval.context['escalation'] !== 'FIX_LOOP' || !approval.taskId) return false;

    const target = await repos.tasks.findById(approval.taskId);
    if (!target) return false;
    await repos.tasks.setStatus(target.id, 'TODO');
    // Đếm vòng về 0: CEO cho "thêm một vòng" nghĩa là được sửa đủ số lần như ban đầu, không phải leo thang ngay lần rớt kế.
    await repos.tasks.resetFixLoop(target.id);

    for (const reviewerId of reviewerTaskIds(approval.context)) {
      await repos.tasks.setStatus(reviewerId, 'TODO');
      await repos.tasks.addDependencies(reviewerId, [target.id]);
    }

    await repos.messages.append({
      projectId: target.projectId,
      taskId: target.id,
      author: 'CEO',
      role: 'user',
      content: 'CEO cho sửa thêm một vòng. Đọc lại các lỗi QA nêu ở trên rồi sửa cho đạt.',
    });
    return true;
  }

  /**
   * CEO từ chối phiếu "QA vẫn không đạt" = chấp nhận hiện trạng: task code và
   * các task rà soát coi như xong, dự án đi tiếp. Không có lối này thì một
   * ngưỡng do QA tự đặt (ví dụ 100ms cho 10.000 phép tính) giữ cả dự án đứng
   * mãi, và CEO không có cách nào nói "đủ tốt rồi" ngoài sửa tay database.
   */
  async waiveFixLoop(approval: { taskId: Uuid | null; context: Record<string, unknown> }): Promise<boolean> {
    const { repos } = this.#deps;
    if (approval.context['escalation'] !== 'FIX_LOOP' || !approval.taskId) return false;

    const target = await repos.tasks.findById(approval.taskId);
    if (!target) return false;
    await repos.tasks.setStatus(target.id, 'DONE');
    for (const reviewerId of reviewerTaskIds(approval.context)) {
      await repos.tasks.setStatus(reviewerId, 'DONE');
    }
    const waived = await repos.bugs.waiveForTask(target.projectId, target.id);

    await repos.messages.append({
      projectId: target.projectId,
      taskId: target.id,
      author: 'CEO',
      role: 'user',
      content: `CEO chấp nhận hiện trạng, không sửa thêm. ${waived} lỗi còn mở được đánh dấu bỏ qua (WONTFIX).`,
    });
    return true;
  }

  /**
   * Vòng đời đầy đủ của một lần agent làm việc. Trả về kết quả để `intake` dùng,
   * và `null` khi task không chạy được (không có agent phù hợp chẳng hạn).
   */
  async runTask(taskId: Uuid): Promise<AgentOutcome | null> {
    const { repos, events, agents, agentState, sandbox } = this.#deps;

    const task = await repos.tasks.findById(taskId);
    // Việc CEO tạm dừng hay bỏ lúc còn trong hàng đợi thì không chạy.
    if (!task || task.status === 'PAUSED' || task.status === 'CANCELLED') return null;

    const role = task.assignedRole;
    if (!role) {
      await this.#block(task, 'Task chưa được giao cho vai trò nào.');
      return null;
    }

    const agent = agents.get(role);
    if (!agent) {
      // Vai trò thuộc phase sau — nói thẳng thay vì im lặng bỏ qua.
      await this.#block(
        task,
        `Vai trò ${role} chưa được triển khai ở giai đoạn này. Task đang chờ.`,
      );
      return null;
    }

    const project = await repos.projects.findById(task.projectId);
    const agentRow = await repos.agents.findByRole(role);
    if (!project || !agentRow) return null;
    // Việc đã xếp hàng trước lúc dừng dự án (hàng đợi, BullMQ còn giữ sau khởi động lại): không chạy, trả về chờ làm.
    if (isHalted(project.status)) {
      if (task.status === 'IN_PROGRESS') await repos.tasks.setStatus(task.id, 'TODO');
      return null;
    }
    // Việc sau bước phân rã đã chạy thì dự án đang làm thật, dù nó được đẩy tiến bằng
    // "chạy lại" chứ không qua nút duyệt kế hoạch; dự án đã xong mà có việc mới cũng vậy.
    // Trước đây dự án chạy hết 12/12 task vẫn ghi "Lập kế hoạch".
    if ((project.status === 'PLANNING' && task.stageId !== 'intake') || project.status === 'COMPLETED') {
      await repos.projects.updateStatus(project.id, 'IN_PROGRESS');
    }

    const run = await repos.runs.create({
      agentId: agentRow.id,
      taskId: task.id,
      projectId: project.id,
    });

    await events.publish(
      'AGENT_STARTED',
      { agentRole: role, runId: run.id },
      { agentId: agentRow.id, projectId: project.id, taskId: task.id },
    );
    await events.publish(
      'TASK_STARTED',
      { taskId: task.id, agentRole: role },
      { projectId: project.id, taskId: task.id },
    );
    await agentState.transition(role, 'working', { taskId: task.id, projectId: project.id });

    // §18 — timeout cứng cho mỗi lần chạy agent. Tín hiệu đi tới lời gọi model và lệnh trong sandbox.
    const runTimeoutMs = this.#deps.runTimeoutMs ?? 900_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), runTimeoutMs);
    const live = this.#running.get(project.id) ?? new Map<Uuid, AbortController>();
    live.set(task.id, controller);
    this.#running.set(project.id, live);

    let session: SandboxSession | null = null;
    let outcome: AgentOutcome | null = null;
    let runFailed = false;

    try {
      if (agent.definition.needsSandbox) {
        session = await sandbox.create({
          runId: run.id,
          taskId: task.id,
          projectId: project.id,
          // Cùng dự án dùng chung một cây thư mục để QA thấy được code vừa viết.
          workspaceKey: project.slug,
          env: { PN_PROJECT: project.slug, PN_TASK_ID: task.id },
          signal: controller.signal,
        });
        await repos.runs.markRunning(run.id, session.workspace);
      } else {
        await repos.runs.markRunning(run.id, '(không dùng sandbox)');
      }

      // Dự án đã làm lại: bỏ trao đổi của lần trước, chỉ giữ từ dấu làm lại trở đi.
      const allHistory = await repos.messages.listByTask(task.id, 200);
      const redoAt = allHistory.map((message) => message.content.startsWith(REDO_MARKER)).lastIndexOf(true);
      const history = (redoAt >= 0 ? allHistory.slice(redoAt) : allHistory).slice(-20);

      outcome = await agent.run({
        runId: run.id,
        agentId: agentRow.id,
        projectId: project.id,
        taskId: task.id,
        project: {
          id: project.id,
          name: project.name,
          description: project.description,
          productType: project.productType,
          repoFullName: project.repoFullName,
          defaultBranch: project.defaultBranch,
        },
        task: {
          id: task.id,
          title: task.title,
          description: task.description,
          fixLoopCount: task.fixLoopCount,
        },
        events,
        gateway: this.#deps.gateway,
        sandbox: session,
        history: history.map((message) => ({ author: message.author, content: message.content })),
        priorWork: await this.#priorWork(project.id, task.id),
        // Tài liệu các phòng đã viết trong docs/ — đọc nguyên văn, không qua tóm tắt.
        documents: session ? await readProjectDocs(session) : [],
        // §92 — đội hình phụ thuộc loại sản phẩm, không phải danh sách cố định.
        allowedRoles: rolesFor(project.productType),
        // §142 — kiến thức đã được CEO duyệt và kích hoạt cho đúng vai trò này.
        // Đây là chỗ công ty "học được" thể hiện ra thành hành vi khác đi.
        knowledge: (await repos.knowledgeItems.activeForRole(role)).map((item) => ({
          title: item.title,
          body: item.body,
        })),
        signal: controller.signal,
      });
      // Agent tự nuốt lỗi huỷ rồi trả về "chưa xong": vẫn là dừng, không phải kết quả thật.
      if (STOP_REASONS.has(controller.signal.reason) && outcome.status !== 'completed') throw new Error('CEO đã dừng');

      await this.#applyOutcome(task, role, agentRow.id, run.id, outcome, session, project);

      await repos.runs.finish(run.id, {
        status: outcome.status === 'completed' ? 'SUCCEEDED' : 'FAILED',
        commandLog: session ? formatCommandLog(session) : null,
        stdout: session ? lastStdout(session) : null,
        exitCode: session ? lastExitCode(session) : null,
      });

      return outcome;
    } catch (error) {
      runFailed = true;
      // Dừng dự án: bởi nút Dừng ở tiến trình này, hoặc (worker chạy tiến trình riêng) cổng AI từ chối vì dự án đã dừng.
      const reason: unknown = controller.signal.reason;
      if (reason === TASK_PAUSE_REASON || reason === TASK_CANCEL_REASON) {
        await this.#settleStopped(task, role, run.id, session, reason === TASK_CANCEL_REASON ? 'CANCELLED' : 'PAUSED');
        return null;
      }
      const stopped = reason === STOP_REASON || isHalted((await repos.projects.findById(project.id))?.status);
      if (stopped) {
        await this.#settleStopped(task, role, run.id, session, 'TODO');
        return null;
      }
      const timedOut = controller.signal.aborted;
      const message = timedOut
        ? `Hết giờ: lượt chạy vượt ${Math.round(runTimeoutMs / 60_000)} phút nên đã dừng. Tệp đã viết và tiến độ vẫn giữ.`
        : error instanceof Error
          ? error.message
          : String(error);
      await repos.runs.finish(run.id, {
        status: timedOut ? 'TIMEOUT' : 'FAILED',
        errorMessage: message,
        commandLog: session ? formatCommandLog(session) : null,
      });

      // Hết giờ mà chưa quá số lần tự chạy tiếp: xếp lại ngay, không chặn, không làm phiền CEO.
      const streak = timedOut ? await this.#timeoutStreak(task.id) : 0;
      if (timedOut && streak <= MAX_TIMEOUT_RESUMES) {
        await repos.messages.append({
          projectId: project.id,
          taskId: task.id,
          runId: run.id,
          author: role,
          role: 'system',
          content: `${message} Tự chạy tiếp phần còn lại (lần ${streak}/${MAX_TIMEOUT_RESUMES}).`,
        });
        await agentState.transition(role, 'idle', { taskId: task.id, projectId: project.id });
        await this.#requeue(task);
        return null;
      }

      await repos.tasks.setStatus(task.id, 'BLOCKED');
      await repos.messages.append({
        projectId: project.id,
        taskId: task.id,
        runId: run.id,
        author: role,
        role: 'system',
        content: timedOut
          ? `Lần chạy thất bại: ${message} Đã tự chạy tiếp ${MAX_TIMEOUT_RESUMES} lần vẫn chưa xong — việc có thể quá lớn cho một lượt.`
          : `Lần chạy thất bại: ${message}`,
      });
      await events.publish(
        'TASK_FAILED',
        { taskId: task.id, reason: message },
        { projectId: project.id, taskId: task.id },
      );
      await agentState.transition(role, 'blocked', { taskId: task.id, projectId: project.id });
      return null;
    } finally {
      clearTimeout(timeout);
      live.delete(task.id);
      if (live.size === 0) this.#running.delete(project.id);
      await session?.dispose();
      await events.publish(
        'AGENT_STOPPED',
        { agentRole: role, runId: run.id, status: runFailed ? 'failed' : outcome?.status ?? 'failed' },
        { agentId: agentRow.id, projectId: project.id, taskId: task.id },
      );
      // Lỗi phải giữ nguyên trạng thái và task bị chặn để CEO còn nhìn thấy lý do.
      if (!runFailed) {
        const finalState = outcome?.status !== 'completed'
          ? 'blocked'
          : (outcome.reportedBugs?.length ?? 0) > 0 ? 'alert' : 'idle';
        await agentState.transition(role, finalState, finalState === 'idle'
          ? { taskId: null, projectId: null }
          : { taskId: task.id, projectId: project.id });
      }
    }
  }

  /**
   * Chốt một lượt bị CEO cắt: lượt ghi "đã huỷ", việc về chờ làm (dừng dự án), tạm dừng hoặc bỏ (dừng riêng việc), nhân
   * viên về rảnh. Ghi vào lịch sử việc dừng ở đâu (đọc tiến độ theo lô trong workspace nếu có) — lượt sau đọc lịch sử này
   * nên biết mình đang làm tới đâu.
   */
  async #settleStopped(
    task: Task,
    role: AgentRole,
    runId: Uuid,
    session: SandboxSession | null,
    next: 'TODO' | 'PAUSED' | 'CANCELLED',
  ): Promise<void> {
    const { repos, agentState } = this.#deps;
    let where = '';
    const saved = await session?.readFile(`.pn/tien-do/${task.id}.json`).catch(() => null);
    if (saved) {
      try {
        const progress = JSON.parse(saved) as { plan?: { files?: unknown[] }; done?: unknown[] };
        const total = progress.plan?.files?.length ?? 0;
        if (total > 0) where = ` Đã viết xong ${progress.done?.length ?? 0}/${total} tệp theo kế hoạch; lần tiếp tục viết nốt phần còn lại.`;
      } catch {
        /* tệp tiến độ hỏng thì chỉ ghi câu chung */
      }
    }
    const note =
      next === 'CANCELLED'
        ? 'CEO dừng hẳn việc này — lượt bị cắt, dự án bỏ qua việc này và đi tiếp. Tệp đã ghi trong workspace vẫn giữ nguyên.'
        : `${next === 'PAUSED' ? 'CEO tạm dừng việc này' : 'CEO dừng dự án'} — lượt này bị cắt giữa chừng.${where} ` +
          'Tệp đã ghi trong workspace vẫn giữ nguyên.';
    await repos.runs.finish(runId, { status: 'CANCELLED', errorMessage: note, commandLog: session ? formatCommandLog(session) : null });
    await repos.tasks.setStatus(task.id, next);
    await repos.messages.append({ projectId: task.projectId, taskId: task.id, runId, author: role, role: 'system', content: note });
    await agentState.transition(role, 'idle', { taskId: null, projectId: null });
  }

  /* ---------------------------------------------------------------------- */
  /* Áp dụng kết quả                                                         */
  /* ---------------------------------------------------------------------- */

  async #applyOutcome(
    task: Task,
    role: AgentRole,
    agentId: Uuid,
    runId: Uuid,
    outcome: AgentOutcome,
    session: SandboxSession | null,
    project: {
      id: Uuid;
      slug: string;
      repoFullName: string | null;
      defaultBranch: string;
      productType: ProductType;
    },
  ): Promise<void> {
    const { repos, events } = this.#deps;

    await repos.messages.append({
      projectId: project.id,
      taskId: task.id,
      runId,
      author: role,
      role: 'assistant',
      content: outcome.summary,
    });

    // Phòng còn điều chưa rõ: chưa chốt task. Phòng điều hành trả lời (câu có chi
    // phí thì lên CEO), ghi Sổ quyết định, rồi phòng làm lại với câu trả lời.
    if (outcome.questions?.length) {
      await this.#handleQuestions(task, role, outcome.questions, session, project);
      return;
    }

    // Task mới do agent đề xuất (§3.1). Chỉ lần phân rã đầu tiên của CTO được
    // tạo task: nếu mọi agent lập kế hoạch đều đẻ thêm việc, rồi việc đó chạy
    // lại đẻ tiếp, dự án nở không kiểm soát (một demo lên 166 task trong 20
    // phút). Các stage sau do #seedNextStage mở theo quy trình, bug QA đi đường
    // riêng; đề xuất còn lại ghi vào trao đổi để CEO đọc chứ không thành task.
    if (outcome.proposedTasks?.length) {
      const existing = await repos.tasks.listByProject(project.id);
      const planned = existing.some((item) => item.assignedRole !== 'CTO_ORCHESTRATOR');
      if (role === 'CTO_ORCHESTRATOR' && !planned) {
        await this.#createProposedTasks(
          project.id,
          outcome.proposedTasks,
          role,
          workflowFor(project.productType),
        );
      } else {
        // Ghi dưới tên SYSTEM: ghi dưới tên vai trò thì nó thành "tin mới nhất của
        // phòng" và phòng sau đọc dòng này thay cho kết quả thật.
        await repos.messages.append({
          projectId: project.id,
          taskId: task.id,
          runId,
          author: 'SYSTEM',
          role: 'system',
          content:
            `Đề xuất ${outcome.proposedTasks.length} việc không được tạo thành task: kế hoạch ` +
            'đã có. Chỉ lần phân rã đầu tiên của CTO tạo task (§3.1); các bước sau mở theo ' +
            'quy trình. Đề xuất: ' +
            outcome.proposedTasks.map((item) => item.title).join('; '),
        });
      }
    }

    // Bug do QA phát hiện → fix loop (§4).
    if (outcome.reportedBugs?.length) {
      await this.#handleBugs(task, agentId, role, outcome.reportedBugs, project.id);
    }

    // Code vừa viết → commit lên GitHub nếu dự án có repo (§17).
    if (outcome.producedFiles?.length && project.repoFullName) {
      await this.#commitFiles(project, task, role, agentId, outcome.producedFiles);
    }

    // Yêu cầu phê duyệt của CEO (§27).
    if (outcome.requiresApproval) {
      const approval = await repos.approvals.create({
        kind: outcome.requiresApproval.kind as never,
        title: outcome.requiresApproval.title,
        summary: outcome.requiresApproval.summary,
        projectId: project.id,
        taskId: task.id,
        requestedByAgentId: agentId,
      });
      await events.publish(
        'APPROVAL_REQUIRED',
        { approvalId: approval.id, kind: approval.kind, title: approval.title },
        { projectId: project.id, taskId: task.id },
      );
    }

    // Chốt trạng thái task. QA báo lỗi thì task không thể DONE.
    const failed = (outcome.reportedBugs?.length ?? 0) > 0 || outcome.status !== 'completed';
    if (!failed) {
      // Người rà soát (QA, bảo mật…) trả danh sách lỗi rỗng = đạt: lỗi họ từng nêu coi như đã sửa xong.
      // Không có bước này thì lỗi không bao giờ đóng (242 lỗi mở, 0 lỗi đóng).
      if (outcome.reportedBugs !== undefined) {
        const closed = await repos.bugs.resolveByReporter(project.id, agentId, 'VERIFIED');
        if (closed > 0) {
          await repos.messages.append({
            projectId: project.id,
            taskId: task.id,
            author: role,
            role: 'assistant',
            content: `Đã kiểm lại: ${closed} lỗi nêu trước đó đã được sửa, đóng lỗi.`,
          });
        }
      }
      const done = await repos.tasks.setStatus(task.id, 'DONE');
      const durationMs = done.startedAt
        ? Date.parse(done.completedAt ?? new Date().toISOString()) - Date.parse(done.startedAt)
        : 0;
      await events.publish(
        'TASK_COMPLETED',
        { taskId: task.id, durationMs, agentRole: role },
        { projectId: project.id, taskId: task.id },
      );
    } else if (outcome.status !== 'completed') {
      await repos.tasks.setStatus(task.id, 'BLOCKED');
      await events.publish(
        'TASK_FAILED',
        { taskId: task.id, reason: outcome.summary },
        { projectId: project.id, taskId: task.id },
      );
    }

    if (session) {
      void session;
    }
  }

  /**
   * Tạo task đề xuất, dịch `dependsOnIndexes` thành quan hệ phụ thuộc thật, và
   * gắn mỗi task vào stage của workflow theo vai trò được giao (§4, §92) —
   * lùi về stage muộn hơn nếu nó phụ thuộc vào task ở stage sau.
   *
   * Vai trò nằm ngoài workflow của loại sản phẩm này thì task vẫn được tạo
   * nhưng không có stage — nó chạy tự do thay vì bị kẹt, và hiện rõ trên bảng
   * task là việc ngoài quy trình.
   */
  async #createProposedTasks(
    projectId: Uuid,
    proposed: ProposedTask[],
    fromRole: AgentRole,
    workflow: WorkflowStage[],
  ): Promise<Uuid[]> {
    const { repos, events } = this.#deps;
    const created: Uuid[] = [];
    const stageOf: Array<string | null> = [];

    for (const [index, item] of proposed.entries()) {
      // Chỉ phụ thuộc vào task đứng trước trong cùng danh sách; chỉ số trỏ tới
      // task phía sau sẽ tạo vòng lặp nên bị bỏ qua.
      const depIndexes = (item.dependsOnIndexes ?? []).filter(
        (depIndex) => depIndex < index && created[depIndex],
      );
      const dependsOn = depIndexes.map((depIndex) => created[depIndex]!);

      // Stage theo vai trò, nhưng không được sớm hơn stage của task nó phụ thuộc.
      // CTO hay tự giao cho mình một task "tổng hợp trình CEO" phụ thuộc vào
      // phân tích và thiết kế; để nó ở stage intake thì vòng hai bắt mọi task
      // sau phụ thuộc ngược vào nó — hai bên chờ nhau, không task nào chạy.
      const stageId = latestStage(workflow, [
        stageForRole(workflow, item.assignedRole)?.id ?? null,
        ...depIndexes.map((depIndex) => stageOf[depIndex] ?? null),
      ]);
      const task = await repos.tasks.create({
        projectId,
        title: item.title,
        description: item.description,
        priority: item.priority,
        assignedRole: item.assignedRole,
        dependsOn,
        stageId,
      });
      created.push(task.id);
      stageOf.push(stageId);

      await events.publish(
        'TASK_CREATED',
        {
          taskId: task.id,
          title: task.title,
          assignedRole: task.assignedRole,
          fromRole,
          priority: task.priority,
          step: stageId ? workflow.findIndex((stage) => stage.id === stageId) : null,
        },
        { projectId, taskId: task.id },
      );
    }

    // Vòng hai — nối thứ tự pipeline. Phải làm sau khi tạo hết lô: CTO hay đề
    // xuất task QA đứng trước task code trong danh sách, lúc tạo task QA thì
    // task code chưa tồn tại để mà trỏ vào. Đọc lại task theo stage từ database
    // nên bắt được cả task do lượt chạy trước tạo ra.
    for (const [index, id] of created.entries()) {
      const stageId = stageOf[index];
      if (!stageId) continue;

      const earlier: Uuid[] = [];
      for (const previous of stagesBefore(workflow, stageId)) {
        const tasks = await repos.tasks.listByStage(projectId, previous);
        earlier.push(...tasks.map((task) => task.id));
      }
      await repos.tasks.addDependencies(id, earlier);
      // Chiều ngược lại: việc đã có ở stage sau (lượt giao trước) cũng phải đợi việc mới này.
      await this.#holdLaterStages(projectId, workflow, stageId, [id]);
    }

    return created;
  }

  /**
   * §4 — người rà soát báo lỗi thì tạo bug, tăng số vòng fix loop, và giao lại cho chủ sở hữu file bị lỗi.
   * Quá số vòng cho phép thì escalate lên CEO thay vì lặp vô hạn (§55).
   */
  async #handleBugs(
    task: Task,
    reporterAgentId: Uuid,
    reporterRole: AgentRole,
    bugs: NonNullable<AgentOutcome['reportedBugs']>,
    projectId: Uuid,
  ): Promise<void> {
    const { repos } = this.#deps;

    // Số lỗi người rà này còn giữ mở từ vòng trước — để biết vòng sửa có đang tiến triển không.
    const previous = (await repos.bugs.listByProject(projectId)).filter(
      (bug) => bug.reportedByAgentId === reporterAgentId && (bug.status === 'OPEN' || bug.status === 'IN_PROGRESS'),
    ).length;
    const trend = { improving: bugs.length < previous, previous };

    // Lượt rà mới là danh sách đầy đủ của người rà: lỗi cũ không được nêu lại coi như đã sửa. Trước đây mỗi lượt
    // cộng thêm lỗi cùng nội dung khác tiêu đề — từng có dự án 39 lỗi mở, một lỗi "thiếu src/main.ts" mở 5 bản.
    await repos.bugs.resolveByReporter(projectId, reporterAgentId, 'VERIFIED', bugs.map((bug) => bug.title));

    // Mã sắp được sửa: bản staging đang có là của mã cũ.
    await this.#dropStaleStaging(projectId);

    let blocked = false;
    for (const group of await this.#routeBugs(task, bugs)) {
      const waiting = await this.#sendBack(task, reporterAgentId, reporterRole, group.target, group.bugs, projectId, trend);
      blocked ||= waiting;
    }
    // Người rà đợi mọi task sửa xong mới chấm lại; còn task chờ CEO thì người rà cũng chờ.
    await repos.tasks.setStatus(task.id, blocked ? 'BLOCKED' : 'TODO');
  }

  /**
   * Một nhóm lỗi về một task code: ghi lỗi, báo cho dev, đưa task về làm lại — hoặc leo thang khi hết vòng.
   * Trả `true` khi người rà phải chờ (không tìm được task sửa, hoặc đang chờ CEO).
   */
  async #sendBack(
    task: Task,
    reporterAgentId: Uuid,
    reporterRole: AgentRole,
    target: Task | null,
    bugs: NonNullable<AgentOutcome['reportedBugs']>,
    projectId: Uuid,
    trend: { improving: boolean; previous: number },
  ): Promise<boolean> {
    const { repos, events } = this.#deps;

    // Lỗi gắn vào task code sẽ sửa (không phải task QA), trùng tiêu đề thì cập nhật, không chèn thêm.
    const bugIds: Uuid[] = [];
    for (const bug of bugs) {
      const { bug: row, created } = await repos.bugs.upsertOpen({
        projectId,
        taskId: target?.id ?? task.id,
        title: bug.title,
        description: bug.description,
        severity: bug.severity,
        reportedByAgentId: reporterAgentId,
      });
      bugIds.push(row.id);
      if (!created) continue;
      // Event nói lỗi đẩy về cho ai — dashboard 3D dựa vào đó vẽ đường chuyển giao.
      await events.publish(
        'BUG_CREATED',
        {
          bugId: row.id,
          severity: row.severity,
          title: row.title,
          fromRole: reporterRole,
          toRole: target?.assignedRole ?? null,
        },
        { projectId, taskId: task.id },
      );
    }

    if (!target) return true;

    const iteration = await repos.tasks.incrementFixLoop(target.id);
    const decision = decideFixLoop(iteration - 1, target.assignedRole ?? 'BACKEND_DEVELOPER');

    const bugSummary = bugs.map((bug) => `- [${bug.severity}] ${bug.title}: ${bug.description}`).join('\n');
    await repos.messages.append({
      projectId,
      taskId: target.id,
      author: 'QA',
      role: 'user',
      content: `QA chưa duyệt. Cần sửa các lỗi sau:\n${bugSummary}`,
    });

    // Quá trần vòng sửa mà lỗi vẫn đang giảm: Phòng điều hành tự cho sửa thêm tới trần cứng, không làm phiền CEO
    // (công ty tự vận hành, chỉ hỏi khi sửa mãi không tiến triển).
    const extend = decision.action !== 'reassign' && trend.improving && iteration <= HARD_FIX_LOOP_CAP;
    if (extend) {
      await repos.messages.append({
        projectId,
        taskId: target.id,
        author: 'CTO_ORCHESTRATOR',
        role: 'system',
        content:
          `Phòng điều hành cho sửa thêm vòng ${iteration}/${HARD_FIX_LOOP_CAP}: lỗi ${reporterRole} nêu đã giảm từ ` +
          `${trend.previous} xuống ${bugs.length}, vẫn đang tiến triển.`,
      });
    }

    if (decision.action === 'reassign' || extend) {
      // Đưa task code về TODO để vòng `advance` kế tiếp chạy lại nó. QA phải
      // đợi dev sửa xong: không có phụ thuộc này thì hai task chạy song song,
      // QA kiểm đúng bản chưa sửa và đốt thêm một vòng (đã xảy ra thật).
      await repos.tasks.setStatus(target.id, 'TODO');
      await repos.tasks.addDependencies(task.id, [target.id]);
      // Lỗi đã có người sửa: IN_PROGRESS cho tới khi người rà soát chấm lại.
      for (const id of bugIds) await repos.bugs.setStatus(id, 'IN_PROGRESS');
      return false;
    }

    await repos.tasks.setStatus(target.id, 'BLOCKED');

    // QA và Security cùng chấm rớt một task thì CEO nhận MỘT phiếu, không phải
    // ba phiếu giống nhau phải bấm ba lần (đã xảy ra thật).
    const pending = (await repos.approvals.listPending()).find(
      (item) => item.taskId === target.id && item.context['escalation'] === 'FIX_LOOP',
    );
    if (pending) {
      const ids = reviewerTaskIds(pending.context);
      if (!ids.includes(task.id)) {
        await repos.approvals.mergeContext(pending.id, { qaTaskIds: [...ids, task.id] });
      }
      return true;
    }

    const approval = await repos.approvals.create({
      kind: 'PROJECT_PLAN',
      title: 'QA vẫn không đạt sau nhiều vòng sửa',
      summary:
        `Task "${target.title}" đã sửa ${MAX_FIX_LOOP_ITERATIONS} lần mà ${reporterRole} vẫn chưa duyệt.\n` +
        'Duyệt = cho đội sửa thêm một vòng. Từ chối = chấp nhận hiện trạng và đi tiếp, rủi ro do bạn nhận.' +
        `\n\n${bugSummary}`,
      projectId,
      taskId: target.id,
      context: { escalation: 'FIX_LOOP', qaTaskIds: [task.id] },
    });
    await events.publish(
      'APPROVAL_REQUIRED',
      { approvalId: approval.id, kind: approval.kind, title: approval.title },
      { projectId, taskId: target.id },
    );
    return true;
  }

  /**
   * Chia lỗi theo task code sẽ sửa. Lỗi nêu file thì về task của phòng sở hữu file đó; không nêu được thì về task
   * code vừa xong gần nhất. Trước đây mọi lỗi về task xong gần nhất — lỗi cú pháp ở renderer (Frontend) bị giao
   * cho Backend sáu lần liền, Backend sửa phần mình rồi QA lại rớt vì cùng lỗi đó.
   */
  async #routeBugs(
    reviewTask: Task,
    bugs: NonNullable<AgentOutcome['reportedBugs']>,
  ): Promise<Array<{ target: Task | null; bugs: NonNullable<AgentOutcome['reportedBugs']> }>> {
    const { repos } = this.#deps;
    // Task rà soát sinh ra riêng cho một task code thì mọi lỗi về đúng task đó.
    if (reviewTask.parentTaskId) {
      return [{ target: await repos.tasks.findById(reviewTask.parentTaskId), bugs }];
    }

    const tasks = await repos.tasks.listByProject(reviewTask.projectId);
    const at = (task: Task): number => (task.completedAt ? Date.parse(task.completedAt) : 0);
    const codeTasks = tasks
      .filter((task) => task.id !== reviewTask.id && task.assignedRole !== null && CODE_ROLES.has(task.assignedRole))
      .sort((a, b) => at(b) - at(a));
    const fallback = codeTasks[0] ?? null;

    const groups = new Map<string, { target: Task | null; bugs: NonNullable<AgentOutcome['reportedBugs']> }>();
    for (const bug of bugs) {
      // QA đặt lỗi giao diện tiêu đề "Giao diện:" (prompt QA) — không nêu file thì vẫn biết là việc của Frontend.
      const role = /^giao diện\s*:/i.test(bug.title) ? 'FRONTEND_DEVELOPER' : ownerRoleOf(`${bug.title}\n${bug.description}`);
      // Chỉ nhận task đã từng xong: kéo task còn chờ ở stage sau (DevOps đóng gói) về thì nó và người rà đợi nhau mãi.
      const done = codeTasks.filter((task) => task.completedAt);
      const target =
        scopeOwner(done, `${bug.title}\n${bug.description}`) ||
        (role && done.find((task) => task.assignedRole === role)) ||
        fallback;
      const key = target?.id ?? '';
      const group = groups.get(key) ?? { target, bugs: [] };
      group.bugs.push(bug);
      groups.set(key, group);
    }
    return [...groups.values()];
  }

  /** §17 — tạo branch, commit và mở PR. Không bao giờ ghi thẳng vào production. */
  async #commitFiles(
    project: { id: Uuid; slug: string; repoFullName: string | null; defaultBranch: string },
    task: Task,
    role: AgentRole,
    agentId: Uuid,
    files: NonNullable<AgentOutcome['producedFiles']>,
  ): Promise<void> {
    const { repos } = this.#deps;
    const github = await this.#deps.github();
    if (!github || !project.repoFullName) return;

    const kind = task.fixLoopCount > 0 ? 'fix' : 'feature';
    const branch = await github.createBranch(project.repoFullName, kind, task.title, {
      fromBranch: project.defaultBranch,
      suffix: task.id.slice(0, 8),
    });

    await repos.gitEvents.record({
      projectId: project.id,
      type: 'branch_created',
      branch,
      actorAgentId: agentId,
      summary: `Tạo branch ${branch} cho task "${task.title}"`,
    });

    const commit = await github.commitFiles(
      project.repoFullName,
      branch,
      files.map((file) => ({ path: file.path, content: file.content })),
      `${kind}: ${task.title}\n\nDo ${role} của P&N thực hiện (task ${task.id}).`,
    );

    await repos.gitEvents.record({
      projectId: project.id,
      type: 'commit',
      branch,
      commitSha: commit.commitSha,
      actorAgentId: agentId,
      summary: `Commit ${commit.filesChanged} file lên ${branch}`,
    });

    // Chỉ mở PR một lần cho mỗi branch.
    const open = await github.listOpenPullRequests(project.repoFullName);
    if (open.some((pr) => pr.headBranch === branch)) return;

    const pr = await github.createPullRequest(project.repoFullName, {
      head: branch,
      base: project.defaultBranch,
      title: task.title,
      body:
        `Task: ${task.title}\n\n${task.description}\n\n` +
        `File thay đổi:\n${files.map((file) => `- ${file.path}`).join('\n')}\n\n` +
        '— P&N',
    });

    await repos.gitEvents.record({
      projectId: project.id,
      type: 'pull_request',
      branch,
      pullRequestNumber: pr.number,
      actorAgentId: agentId,
      summary: `Mở PR #${pr.number}: ${pr.url}`,
    });
  }

  /**
   * Tóm tắt các task đã xong của dự án (mới nhất trước) để agent sau đọc được
   * việc của agent trước — thiết kế, kiến trúc, tiêu chí nghiệm thu. Trước đây
   * mỗi agent chỉ thấy file trong workspace và trao đổi của chính task mình.
   */
  async #priorWork(projectId: Uuid, currentTaskId: Uuid): Promise<AgentContext['priorWork']> {
    const { repos } = this.#deps;
    const at = (task: Task): number => (task.completedAt ? Date.parse(task.completedAt) : 0);
    const done = (await repos.tasks.listByProject(projectId))
      .filter((task) => task.id !== currentTaskId && task.status === 'DONE' && task.assignedRole)
      .sort((a, b) => at(b) - at(a))
      .slice(0, 12);
    const result: AgentContext['priorWork'] = [];
    for (const task of done) {
      const messages = await repos.messages.listByTask(task.id, 200);
      const own = [...messages].reverse().find((message) => message.author === task.assignedRole);
      if (own) result.push({ role: task.assignedRole!, title: task.title, summary: own.content });
    }
    return result;
  }

  /**
   * Hỏi đáp nội bộ: câu không liên quan chi phí do Phòng điều
   * hành quyết ngay; câu có chi phí thành phiếu duyệt cho CEO. Mỗi task được hỏi
   * tối đa MAX_QUESTION_ROUNDS vòng, sau đó lấy phương án phòng tự đề xuất — để
   * một phòng hay hỏi không kéo dự án vòng mãi.
   */
  async #handleQuestions(
    task: Task,
    role: AgentRole,
    questions: AgentQuestion[],
    session: SandboxSession | null,
    project: { id: Uuid; slug: string; name?: string; description?: string; productType: ProductType },
  ): Promise<void> {
    const { repos, events, agents, agentState } = this.#deps;
    const label = agentProfile(role).displayName;
    const history = await repos.messages.listByTask(task.id, 200);
    const rounds = history.filter((message) => message.author === 'CTO_ORCHESTRATOR' && message.content.startsWith(ANSWER_PREFIX)).length;
    const internal = questions.filter((item) => !item.costImpact);
    const costly = questions.filter((item) => item.costImpact);

    await repos.messages.append({
      projectId: project.id,
      taskId: task.id,
      author: 'SYSTEM',
      role: 'system',
      content: `❓ ${label} hỏi Phòng điều hành:\n` + questions.map((item) => `- ${item.question}`).join('\n'),
    });

    if (internal.length > 0) {
      let decisions: Decision[];
      if (rounds >= MAX_QUESTION_ROUNDS) {
        decisions = internal.map((item) => recommendedDecision(item, `Đã hỏi đủ ${MAX_QUESTION_ROUNDS} vòng — dùng phương án phòng đề xuất.`));
      } else {
        // Phòng điều hành "đang làm" trên văn phòng 3D lúc suy nghĩ trả lời. CTO có thể
        // đang bận việc khác (chuyển trạng thái không hợp lệ) — khi đó chỉ bỏ phần hiển thị.
        const shown = agents.has('CTO_ORCHESTRATOR')
          ? await agentState.transition('CTO_ORCHESTRATOR', 'working', { taskId: task.id, projectId: project.id }).then(() => true, () => false)
          : false;
        try {
          const full = await repos.projects.findById(project.id);
          const docs = session ? describeDocuments(await readProjectDocs(session)) : '';
          decisions = (
            await answerQuestions(this.#deps.gateway, {
              askedBy: role,
              project: { id: project.id, name: full?.name ?? '', description: full?.description ?? '', productType: project.productType },
              taskId: task.id,
              documents: docs,
              questions: internal,
            })
          ).decisions;
        } finally {
          if (shown) await agentState.transition('CTO_ORCHESTRATOR', 'idle', { taskId: null, projectId: null }).catch(() => undefined);
        }
      }
      await this.#recordDecisions(project, `${label} hỏi — "${task.title}"`, decisions, session);
      await repos.messages.append({
        projectId: project.id,
        taskId: task.id,
        author: 'CTO_ORCHESTRATOR',
        role: 'assistant',
        content: `${ANSWER_PREFIX} ${label}:\n` + decisions.map((item) => `- ${item.question}\n  → ${item.answer}`).join('\n'),
      });
    }

    if (costly.length > 0) {
      const approval = await repos.approvals.create({
        kind: 'BUDGET_INCREASE',
        title: `Cần anh quyết chi phí: ${costly[0]!.question.slice(0, 140)}`,
        summary: costly
          .map((item) => `${item.question}\n${item.why}\n• Duyệt = ${item.options[0]}\n• Từ chối = ${item.options[1] ?? 'không chi thêm'}`)
          .join('\n\n'),
        projectId: project.id,
        taskId: task.id,
        context: { costQuestions: costly },
      });
      await events.publish(
        'APPROVAL_REQUIRED',
        { approvalId: approval.id, kind: approval.kind, title: approval.title },
        { projectId: project.id, taskId: task.id },
      );
      await repos.tasks.setStatus(task.id, 'BLOCKED');
      return;
    }

    // Làm lại bước này với câu trả lời đã ghi trong Sổ quyết định.
    await repos.tasks.setStatus(task.id, 'TODO');
  }

  /**
   * CEO trả lời câu hỏi chi phí (duyệt = phương án tốn tiền, từ chối = phương án
   * không tốn): ghi Sổ quyết định và cho phòng hỏi làm lại. Không phải phiếu câu
   * hỏi chi phí thì trả về false để route xử lý như phiếu thường.
   */
  async answerCostQuestion(
    approval: { taskId: Uuid | null; projectId: Uuid | null; context: Record<string, unknown> },
    approved: boolean,
  ): Promise<boolean> {
    const questions = approval.context['costQuestions'] as AgentQuestion[] | undefined;
    if (!questions?.length || !approval.taskId) return false;
    const { repos } = this.#deps;
    const task = await repos.tasks.findById(approval.taskId);
    const project = task ? await repos.projects.findById(task.projectId) : null;
    if (!task || !project) return false;

    const decisions: Decision[] = questions.map((item) => ({
      question: item.question,
      answer: approved ? item.options[0]! : (item.options[1] ?? 'Không chi thêm — làm theo cách không tốn tiền.'),
      reason: approved ? 'CEO đồng ý chi.' : 'CEO không đồng ý chi thêm.',
      by: 'CEO',
    }));
    await this.#recordDecisions(project, `CEO quyết chi phí — "${task.title}"`, decisions, null);
    await repos.messages.append({
      projectId: project.id,
      taskId: task.id,
      author: 'CEO',
      role: 'user',
      content: decisions.map((item) => `- ${item.question}\n  → ${item.answer}`).join('\n'),
    });
    await repos.tasks.setStatus(task.id, 'TODO');
    return true;
  }

  /** Ghi thêm một đoạn vào Sổ quyết định trong workspace (mở workspace tạm nếu phòng hỏi không có). */
  async #recordDecisions(
    project: { id: Uuid; slug: string },
    heading: string,
    decisions: Decision[],
    session: SandboxSession | null,
  ): Promise<void> {
    const workspace =
      session ??
      (await this.#deps.sandbox.create({ runId: randomUUID(), taskId: null, projectId: project.id, workspaceKey: project.slug }));
    try {
      const current = await workspace.readFile(DECISIONS_DOC.path).catch(
        () => '# Sổ quyết định\n\nCâu trả lời của Phòng điều hành (và của CEO về chi phí) cho câu hỏi của các phòng. Mọi phòng làm theo sổ này.\n',
      );
      await workspace.writeFile(DECISIONS_DOC.path, current + formatDecisions(heading, decisions));
    } finally {
      if (!session) await workspace.dispose();
    }
  }

  /**
   * Làm lại dự án từ một bước của quy trình: mọi task từ bước
   * đó trở đi về "chưa làm", task hệ thống của bước dựng staging bị xoá để lần sau
   * dựng mới. Không tự chạy — bên gọi cất mã cũ (nếu cần) rồi mới `advance`.
   * `keepDocs` là tài liệu của các bước KHÔNG làm lại, cần giữ khi cất workspace.
   */
  async redoProject(
    projectId: Uuid,
    fromStageId: string,
  ): Promise<{ reset: number; removed: number; redoesBuild: boolean; keepDocs: string[] }> {
    const { repos } = this.#deps;
    const project = await repos.projects.findById(projectId);
    if (!project) throw new Error('Không tìm thấy dự án');
    const workflow = workflowFor(project.productType);
    const start = workflow.findIndex((stage) => stage.id === fromStageId);
    if (start < 0) throw new Error(`Bước "${fromStageId}" không có trong quy trình của dự án này`);
    const redo = new Set(workflow.slice(start).map((stage) => stage.id));
    const label = workflow[start]!.description;

    let reset = 0;
    let removed = 0;
    for (const task of await repos.tasks.listByProject(projectId)) {
      if (!task.stageId || !redo.has(task.stageId)) continue;
      if (task.stageId === 'staging') {
        await repos.tasks.delete(task.id);
        removed += 1;
        continue;
      }
      await repos.tasks.resetForRedo(task.id);
      await repos.messages.append({
        projectId,
        taskId: task.id,
        author: 'SYSTEM',
        role: 'system',
        content: `${REDO_MARKER} từ bước "${label}". Kết quả cũ phía trên chỉ để tham khảo — làm lại theo tài liệu dự án và quy trình hiện tại.`,
      });
      reset += 1;
    }
    await repos.projects.updateStatus(projectId, 'IN_PROGRESS');

    const keepDocs = [
      DECISIONS_DOC.path,
      ...Object.entries(DEPARTMENT_DOCS)
        .filter(([role]) => {
          const stage = stageForRole(workflow, role as AgentRole);
          return stage !== null && !redo.has(stage.id);
        })
        .map(([, doc]) => doc!.path),
    ];
    return { reset, removed, redoesBuild: redo.has('build'), keepDocs };
  }

  /** Chặn task lại kèm lý do đọc được, thay vì để nó im lặng treo. */
  async #block(task: Task, reason: string): Promise<void> {
    await this.#deps.repos.tasks.setStatus(task.id, 'BLOCKED');
    await this.#deps.repos.messages.append({
      projectId: task.projectId,
      taskId: task.id,
      author: 'SYSTEM',
      role: 'system',
      content: reason,
    });
    await this.#deps.events.publish(
      'TASK_FAILED',
      { taskId: task.id, reason },
      { projectId: task.projectId, taskId: task.id },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/** Đặt tên dự án từ câu yêu cầu khi CEO không đặt tên. */
/** Stage đứng sau cùng trong pipeline giữa các stage cho trước; null khi không có stage nào. */
function latestStage(workflow: WorkflowStage[], stageIds: Array<string | null>): string | null {
  let best: string | null = null;
  let bestAt = -1;
  for (const id of stageIds) {
    const at = id ? workflow.findIndex((stage) => stage.id === id) : -1;
    if (at > bestAt) {
      best = id;
      bestAt = at;
    }
  }
  return best;
}

function deriveName(goal: string): string {
  const firstLine = goal.split('\n')[0]!.trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 77)}…`;
}

function formatCommandLog(session: SandboxSession): string {
  return session
    .commandLog()
    .map(
      (entry) =>
        `$ ${entry.command}\n(exit ${entry.exitCode}, ${entry.durationMs}ms${entry.timedOut ? ', TIMEOUT' : ''})`,
    )
    .join('\n');
}

function lastStdout(session: SandboxSession): string | null {
  const log = session.commandLog();
  return log.length > 0 ? log[log.length - 1]!.stdout : null;
}

function lastExitCode(session: SandboxSession): number | null {
  const log = session.commandLog();
  return log.length > 0 ? log[log.length - 1]!.exitCode : null;
}

export type { Agent, AgentRegistry };

/** Các task rà soát (QA, Security…) đang treo trên một phiếu leo thang. */
function reviewerTaskIds(context: Record<string, unknown>): Uuid[] {
  const many = Array.isArray(context['qaTaskIds']) ? (context['qaTaskIds'] as Uuid[]) : [];
  const one = typeof context['qaTaskId'] === 'string' ? [context['qaTaskId'] as Uuid] : [];
  return [...new Set([...many, ...one])];
}
