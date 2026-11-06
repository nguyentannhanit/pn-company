/**
 * P&N — Repository cho các bảng lõi: user, project, task, agent, run, message, bug.
 *
 * Toàn bộ truy vấn dùng tham số hoá ($1, $2…) — không nối chuỗi SQL.
 */

import type {
  AccessMap,
  Agent,
  AgentRole,
  AgentState,
  Bug,
  Message,
  Project,
  ProjectStatus,
  Task,
  TaskStatus,
  User,
  Uuid,
  AgentRun,
  RunStatus,
} from '@pn/shared';

import type { Database } from '../pool.js';
import { buildUpdate, mapMaybe, mapRow, mapRows } from './mapper.js';

/* -------------------------------------------------------------------------- */
/* Người dùng                                                                  */
/* -------------------------------------------------------------------------- */

/** Bản ghi user kèm hash mật khẩu — chỉ dùng trong luồng đăng nhập, không trả ra API. */
export interface UserWithSecret extends User {
  passwordHash: string;
}

const USER_COLUMNS = `id, email, display_name, role, telegram_chat_id, is_active,
  last_login_at, access, must_change_password, invite_expires_at, session_version, created_at, updated_at`;

/** Mật khẩu chưa đặt (người được mời chưa nhận lời): không khớp với bất kỳ mật khẩu nào vì không phải dạng scrypt. */
export const NO_PASSWORD = 'invite$';

export class UserRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    email: string;
    passwordHash: string;
    displayName: string;
    role: User['role'];
    telegramChatId?: string | null;
  }): Promise<User> {
    const rows = await this.db.query(
      `INSERT INTO users (email, password_hash, display_name, role, telegram_chat_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.passwordHash, input.displayName, input.role, input.telegramChatId ?? null],
    );
    return mapRow<User>(rows[0]!);
  }

  /** Trả kèm password_hash, chỉ để so khớp lúc đăng nhập. */
  async findByEmailWithSecret(email: string): Promise<UserWithSecret | null> {
    const row = await this.db.one(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    return mapMaybe<UserWithSecret>(row);
  }

  async findById(id: Uuid): Promise<User | null> {
    return mapMaybe<User>(await this.db.one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]));
  }

  /** §58 — dùng để đối chiếu allow-list chat Telegram. */
  async findByTelegramChatId(chatId: string): Promise<User | null> {
    return mapMaybe<User>(
      await this.db.one(`SELECT ${USER_COLUMNS} FROM users WHERE telegram_chat_id = $1`, [chatId]),
    );
  }

  async list(): Promise<User[]> {
    return mapRows<User>(await this.db.query(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at`));
  }

  /** §58 — gắn một chat Telegram vào đúng một người; ai đang giữ chat đó thì nhả ra. */
  async linkTelegramChat(id: Uuid, chatId: string): Promise<User> {
    await this.db.query(
      'UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = $1 AND id <> $2',
      [chatId, id],
    );
    const rows = await this.db.query(
      `UPDATE users SET telegram_chat_id = $2, updated_at = now() WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, chatId],
    );
    return mapRow<User>(rows[0]!);
  }

  async touchLogin(id: Uuid): Promise<void> {
    await this.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
  }

  /** Tạo người mới do CEO mời: chưa có mật khẩu (lời mời) hoặc mật khẩu tạm phải đổi. */
  async createInvited(input: {
    email: string;
    displayName: string;
    role: User['role'];
    access: Partial<AccessMap> | null;
    passwordHash: string;
    mustChangePassword: boolean;
    inviteTokenHash: string | null;
    inviteExpiresAt: Date | null;
    createdBy: Uuid;
  }): Promise<User> {
    const rows = await this.db.query(
      `INSERT INTO users (email, password_hash, display_name, role, access, must_change_password,
                          invite_token_hash, invite_expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${USER_COLUMNS}`,
      [
        input.email,
        input.passwordHash,
        input.displayName,
        input.role,
        input.access ? JSON.stringify(input.access) : null,
        input.mustChangePassword,
        input.inviteTokenHash,
        input.inviteExpiresAt,
        input.createdBy,
      ],
    );
    return mapRow<User>(rows[0]!);
  }

  /** Đổi vai trò / quyền riêng / tên. Đổi quyền không cần đăng xuất: mỗi yêu cầu tra quyền mới từ database. */
  async updateProfile(id: Uuid, input: { role?: User['role']; access?: Partial<AccessMap> | null; displayName?: string }): Promise<User | null> {
    const rows = await this.db.query(
      `UPDATE users SET
         role = COALESCE($2, role),
         access = CASE WHEN $3::boolean THEN $4::jsonb ELSE access END,
         display_name = COALESCE($5, display_name),
         updated_at = now()
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [
        id,
        input.role ?? null,
        input.access !== undefined,
        input.access ? JSON.stringify(input.access) : null,
        input.displayName ?? null,
      ],
    );
    return mapMaybe<User>(rows[0]);
  }

  /** Khoá / mở khoá. Khoá thì mọi phiên cũ hết hiệu lực ngay. */
  async setActive(id: Uuid, active: boolean): Promise<User | null> {
    const rows = await this.db.query(
      `UPDATE users SET is_active = $2,
         session_version = session_version + CASE WHEN $2 THEN 0 ELSE 1 END,
         updated_at = now()
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, active],
    );
    return mapMaybe<User>(rows[0]);
  }

  /** "Đăng xuất mọi thiết bị": mọi token đã cấp cho người này hết hiệu lực. */
  async revokeSessions(id: Uuid): Promise<void> {
    await this.db.query('UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1', [id]);
  }

  /** Gắn mã mời mới (mời lại, hoặc đặt lại mật khẩu — mật khẩu cũ vẫn dùng tới khi người đó đặt mật khẩu mới). */
  async setInvite(id: Uuid, tokenHash: string | null, expiresAt: Date | null): Promise<void> {
    await this.db.query(
      'UPDATE users SET invite_token_hash = $2, invite_expires_at = $3, updated_at = now() WHERE id = $1',
      [id, tokenHash, expiresAt],
    );
  }

  /** Người có mã mời còn hạn (mã đã băm). */
  async findByInviteHash(tokenHash: string): Promise<User | null> {
    return mapMaybe<User>(
      await this.db.one(
        `SELECT ${USER_COLUMNS} FROM users WHERE invite_token_hash = $1 AND invite_expires_at > now()`,
        [tokenHash],
      ),
    );
  }

  /** Đặt mật khẩu mới (nhận lời mời, đổi mật khẩu tạm, đặt lại): xoá mã mời, bỏ cờ phải đổi. */
  async setPassword(id: Uuid, passwordHash: string): Promise<User | null> {
    const rows = await this.db.query(
      `UPDATE users SET password_hash = $2, must_change_password = false,
         invite_token_hash = NULL, invite_expires_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING ${USER_COLUMNS}`,
      [id, passwordHash],
    );
    return mapMaybe<User>(rows[0]);
  }

  async unlinkTelegram(id: Uuid): Promise<void> {
    await this.db.query('UPDATE users SET telegram_chat_id = NULL, updated_at = now() WHERE id = $1', [id]);
  }

  /**
   * Xoá hẳn tài khoản. Dự án người đó tạo chuyển sang `transferTo` (bảng dự án không cho mồ côi người tạo).
   * Nhật ký kiểm toán vẫn giữ (ghi theo id, không khoá ngoại).
   */
  async remove(id: Uuid, transferTo: Uuid): Promise<void> {
    await this.db.query('UPDATE projects SET owner_id = $2 WHERE owner_id = $1', [id, transferTo]);
    await this.db.query('DELETE FROM users WHERE id = $1', [id]);
  }

  async count(): Promise<number> {
    const row = await this.db.one<{ count: string }>('SELECT count(*)::text AS count FROM users');
    return Number(row?.count ?? 0);
  }
}

/* -------------------------------------------------------------------------- */
/* Dự án                                                                       */
/* -------------------------------------------------------------------------- */

const PROJECT_COLUMNS = `id, name, slug, description, product_type, status, owner_id,
  repo_full_name, default_branch, budget_usd, spent_usd, started_at, completed_at,
  created_at, updated_at`;

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    name: string;
    slug: string;
    description: string;
    productType: Project['productType'];
    ownerId: Uuid;
    repoFullName?: string | null;
    budgetUsd: number;
  }): Promise<Project> {
    const rows = await this.db.query(
      `INSERT INTO projects (name, slug, description, product_type, owner_id, repo_full_name, budget_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${PROJECT_COLUMNS}`,
      [
        input.name,
        input.slug,
        input.description,
        input.productType,
        input.ownerId,
        input.repoFullName ?? null,
        input.budgetUsd,
      ],
    );
    return mapRow<Project>(rows[0]!);
  }

  async findById(id: Uuid): Promise<Project | null> {
    return mapMaybe<Project>(
      await this.db.one(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = $1`, [id]),
    );
  }

  async findBySlug(slug: string): Promise<Project | null> {
    return mapMaybe<Project>(
      await this.db.one(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE slug = $1`, [slug]),
    );
  }

  async list(filter: { status?: ProjectStatus } = {}): Promise<Project[]> {
    if (filter.status) {
      return mapRows<Project>(
        await this.db.query(
          `SELECT ${PROJECT_COLUMNS} FROM projects WHERE status = $1 ORDER BY created_at DESC`,
          [filter.status],
        ),
      );
    }
    return mapRows<Project>(
      await this.db.query(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC`),
    );
  }

  async updateStatus(id: Uuid, status: ProjectStatus): Promise<void> {
    // Đánh dấu mốc thời gian ngay trong câu lệnh để không cần đọc lại bản ghi.
    await this.db.query(
      `UPDATE projects SET status = $2,
         started_at   = COALESCE(started_at, CASE WHEN $2 = 'IN_PROGRESS' THEN now() END),
         completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() ELSE completed_at END
       WHERE id = $1`,
      [id, status],
    );
  }

  async setRepo(id: Uuid, repoFullName: string, defaultBranch: string): Promise<void> {
    await this.db.query(
      'UPDATE projects SET repo_full_name = $2, default_branch = $3 WHERE id = $1',
      [id, repoFullName, defaultBranch],
    );
  }

  /**
   * Xoá hẳn dự án (dự án lỗi không muốn giữ). Task, trao đổi,
   * bug, phiếu duyệt, bản triển khai xoá theo (ON DELETE CASCADE); lượt chạy và
   * chi phí giữ lại, chỉ mất liên kết dự án (ON DELETE SET NULL) — tiền đã tiêu là thật.
   */
  /**
   * Xoá dự án và MỌI dấu vết của nó ("xoá là xoá hết"). Task, tin nhắn, lỗi, triển khai,
   * phiếu duyệt, sản phẩm… đã đi theo khoá ngoại ON DELETE CASCADE; bốn bảng dưới cố tình để SET NULL
   * (chi phí và nhật ký gọi model là sổ sách của cả công ty) nên phải xoá tay trong cùng một giao dịch.
   */
  async delete(id: Uuid): Promise<void> {
    await this.db.transaction(async (client) => {
      for (const table of ['cost_records', 'api_request_logs', 'agent_runs', 'department_xp']) {
        await client.query(`DELETE FROM ${table} WHERE project_id = $1`, [id]);
      }
      await client.query('UPDATE agents SET current_project_id = NULL WHERE current_project_id = $1', [id]);
      await client.query('DELETE FROM projects WHERE id = $1', [id]);
    });
  }

  /** §16 — cộng dồn chi phí vào dự án; nguồn chuẩn vẫn là cost_records. */
  async addSpend(id: Uuid, costUsd: number): Promise<{ spentUsd: number; budgetUsd: number }> {
    const row = await this.db.one<{ spent_usd: string; budget_usd: string }>(
      `UPDATE projects SET spent_usd = spent_usd + $2 WHERE id = $1
       RETURNING spent_usd, budget_usd`,
      [id, costUsd],
    );
    return { spentUsd: Number(row?.spent_usd ?? 0), budgetUsd: Number(row?.budget_usd ?? 0) };
  }
}

/* -------------------------------------------------------------------------- */
/* Agent                                                                       */
/* -------------------------------------------------------------------------- */

const AGENT_COLUMNS = `id, role, display_name, department, state, current_task_id,
  current_project_id, is_enabled, profile_version, xp, state_changed_at,
  created_at, updated_at`;

export class AgentRepository {
  constructor(private readonly db: Database) {}

  /** Tạo agent nếu chưa có; dùng lúc seed để chạy lại nhiều lần vẫn an toàn. */
  async upsert(input: {
    role: AgentRole;
    displayName: string;
    department: Agent['department'];
  }): Promise<Agent> {
    const rows = await this.db.query(
      `INSERT INTO agents (role, display_name, department)
       VALUES ($1, $2, $3)
       ON CONFLICT (role) DO UPDATE SET display_name = EXCLUDED.display_name,
                                        department   = EXCLUDED.department
       RETURNING ${AGENT_COLUMNS}`,
      [input.role, input.displayName, input.department],
    );
    return mapRow<Agent>(rows[0]!);
  }

  async findByRole(role: AgentRole): Promise<Agent | null> {
    return mapMaybe<Agent>(await this.db.one(`SELECT ${AGENT_COLUMNS} FROM agents WHERE role = $1`, [role]));
  }

  async findById(id: Uuid): Promise<Agent | null> {
    return mapMaybe<Agent>(await this.db.one(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = $1`, [id]));
  }

  async list(): Promise<Agent[]> {
    return mapRows<Agent>(await this.db.query(`SELECT ${AGENT_COLUMNS} FROM agents ORDER BY department, role`));
  }

  /**
   * §9 — đổi trạng thái agent. Đây là hành động khiến nhân vật 3D đổi animation,
   * nên nó phải luôn đi kèm việc phát event ở tầng service.
   */
  async setState(
    id: Uuid,
    state: AgentState,
    context: { taskId?: Uuid | null; projectId?: Uuid | null } = {},
  ): Promise<Agent> {
    const rows = await this.db.query(
      `UPDATE agents SET state = $2, state_changed_at = now(),
              current_task_id    = $3,
              current_project_id = $4
       WHERE id = $1
       RETURNING ${AGENT_COLUMNS}`,
      [id, state, context.taskId ?? null, context.projectId ?? null],
    );
    return mapRow<Agent>(rows[0]!);
  }

  async setEnabled(id: Uuid, isEnabled: boolean): Promise<void> {
    await this.db.query('UPDATE agents SET is_enabled = $2 WHERE id = $1', [id, isEnabled]);
  }

  /** §112 — cộng XP cho agent, kèm bằng chứng ghi ở bảng department_xp. */
  async addXp(id: Uuid, amount: number): Promise<void> {
    await this.db.query('UPDATE agents SET xp = xp + $2 WHERE id = $1', [id, amount]);
  }
}

/* -------------------------------------------------------------------------- */
/* Task                                                                        */
/* -------------------------------------------------------------------------- */

const TASK_COLUMNS = `id, project_id, title, description, status, priority, assigned_role,
  assigned_agent_id, parent_task_id, estimate_minutes, started_at, completed_at,
  fix_loop_count, stage_id, created_at, updated_at`;

export class TaskRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    projectId: Uuid;
    title: string;
    description: string;
    priority: Task['priority'];
    assignedRole?: AgentRole | null;
    parentTaskId?: Uuid | null;
    estimateMinutes?: number | null;
    dependsOn?: Uuid[];
    /** Stage của workflow (§4, §92); null với task ngoài pipeline. */
    stageId?: string | null;
  }): Promise<Task> {
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO tasks (project_id, title, description, priority, assigned_role,
                            parent_task_id, estimate_minutes, stage_id, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'TODO')
         RETURNING ${TASK_COLUMNS}`,
        [
          input.projectId,
          input.title,
          input.description,
          input.priority,
          input.assignedRole ?? null,
          input.parentTaskId ?? null,
          input.estimateMinutes ?? null,
          input.stageId ?? null,
        ],
      );
      const task = mapRow<Task>(result.rows[0]!);

      for (const dependency of input.dependsOn ?? []) {
        await client.query(
          'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [task.id, dependency],
        );
      }
      return task;
    });
  }

  async findById(id: Uuid): Promise<Task | null> {
    return mapMaybe<Task>(await this.db.one(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = $1`, [id]));
  }

  async listByProject(projectId: Uuid): Promise<Task[]> {
    return mapRows<Task>(
      await this.db.query(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE project_id = $1 ORDER BY created_at`,
        [projectId],
      ),
    );
  }

  /**
   * Trả về các task đã sẵn sàng chạy: đang TODO và mọi task phụ thuộc đã DONE.
   * Đây là hàm mà orchestrator dùng để biết bước nào vừa hết bị chặn.
   */
  async listReady(projectId: Uuid): Promise<Task[]> {
    return mapRows<Task>(
      await this.db.query(
        `SELECT ${TASK_COLUMNS} FROM tasks t
         WHERE t.project_id = $1
           AND t.status = 'TODO'
           AND NOT EXISTS (
             SELECT 1 FROM task_dependencies d
             JOIN tasks dep ON dep.id = d.depends_on_task_id
             -- Việc CEO bỏ (CANCELLED) không chặn việc phía sau.
             WHERE d.task_id = t.id AND dep.status NOT IN ('DONE', 'CANCELLED')
           )
         ORDER BY CASE t.priority
                    WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1
                    WHEN 'MEDIUM'   THEN 2 ELSE 3 END,
                  t.created_at`,
        [projectId],
      ),
    );
  }

  async setStatus(id: Uuid, status: TaskStatus): Promise<Task> {
    const rows = await this.db.query(
      `UPDATE tasks SET status = $2,
              started_at   = COALESCE(started_at, CASE WHEN $2 = 'IN_PROGRESS' THEN now() END),
              completed_at = CASE WHEN $2 = 'DONE' THEN now() ELSE completed_at END
       WHERE id = $1
       RETURNING ${TASK_COLUMNS}`,
      [id, status],
    );
    return mapRow<Task>(rows[0]!);
  }

  async assign(id: Uuid, agentId: Uuid, role: AgentRole): Promise<void> {
    await this.db.query('UPDATE tasks SET assigned_agent_id = $2, assigned_role = $3 WHERE id = $1', [
      id,
      agentId,
      role,
    ]);
  }

  /** Làm lại dự án: task về chưa làm, xoá mốc thời gian và số vòng sửa của lần trước. */
  async resetForRedo(id: Uuid): Promise<void> {
    await this.db.query(
      `UPDATE tasks SET status = 'TODO', fix_loop_count = 0, started_at = NULL, completed_at = NULL WHERE id = $1`,
      [id],
    );
  }

  /**
   * Sau khi API khởi động lại: task IN_PROGRESS của dự án đang chạy không còn ai làm
   * (hàng đợi nằm trong bộ nhớ) — trả về TODO để `advance` xếp lại. Trả về id các dự án bị đụng.
   */
  async requeueInProgress(exceptIds: Uuid[] = []): Promise<Uuid[]> {
    const rows = await this.db.query<{ project_id: Uuid }>(
      `UPDATE tasks t SET status = 'TODO'
       FROM projects p
       WHERE p.id = t.project_id AND t.status = 'IN_PROGRESS' AND p.status = 'IN_PROGRESS'
         AND NOT (t.id = ANY($1::uuid[]))
       RETURNING t.project_id`,
      [exceptIds],
    );
    return [...new Set(rows.map((row) => row.project_id))];
  }

  /** Xoá một task (task hệ thống của lần dựng trước, để lần làm lại tạo mới). */
  async delete(id: Uuid): Promise<void> {
    await this.db.query('DELETE FROM tasks WHERE id = $1', [id]);
  }

  /** CEO cho sửa thêm: đếm vòng về 0, không thì lần rớt kế tiếp leo thang ngay. */
  async resetFixLoop(id: Uuid): Promise<void> {
    await this.db.query('UPDATE tasks SET fix_loop_count = 0 WHERE id = $1', [id]);
  }

  /** §43.6 — tăng số vòng fix loop và trả về giá trị mới để quyết định escalate. */
  async incrementFixLoop(id: Uuid): Promise<number> {
    const row = await this.db.one<{ fix_loop_count: number }>(
      'UPDATE tasks SET fix_loop_count = fix_loop_count + 1 WHERE id = $1 RETURNING fix_loop_count',
      [id],
    );
    return row?.fix_loop_count ?? 0;
  }

  async dependencies(taskId: Uuid): Promise<Uuid[]> {
    const rows = await this.db.query<{ depends_on_task_id: string }>(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1',
      [taskId],
    );
    return rows.map((row) => row.depends_on_task_id);
  }

  /**
   * Thêm phụ thuộc sau khi task đã tạo. Cần vì thứ tự stage chỉ biết được khi
   * cả lô task đã tạo xong: CTO có thể đề xuất task QA trước task code, lúc tạo
   * task QA thì task code chưa tồn tại để mà trỏ vào.
   */
  async addDependencies(taskId: Uuid, dependsOn: Uuid[]): Promise<void> {
    for (const dependency of dependsOn) {
      if (dependency === taskId) continue;
      await this.db.query(
        'INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [taskId, dependency],
      );
    }
  }

  /** Task của một stage trong dự án — dùng cho cổng duyệt stage (§4, §27). */
  async listByStage(projectId: Uuid, stageId: string): Promise<Task[]> {
    return mapRows<Task>(
      await this.db.query(
        `SELECT ${TASK_COLUMNS} FROM tasks WHERE project_id = $1 AND stage_id = $2 ORDER BY created_at`,
        [projectId, stageId],
      ),
    );
  }

  /** Đếm task theo trạng thái, phục vụ KPI bar và báo cáo CEO (§29). */
  async countByStatus(projectId: Uuid): Promise<Record<string, number>> {
    const rows = await this.db.query<{ status: string; count: string }>(
      'SELECT status, count(*)::text AS count FROM tasks WHERE project_id = $1 GROUP BY status',
      [projectId],
    );
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
  }
}

/* -------------------------------------------------------------------------- */
/* Lần chạy agent                                                              */
/* -------------------------------------------------------------------------- */

const RUN_COLUMNS = `id, agent_id, task_id, project_id, status, workspace, command_log,
  stdout, stderr, exit_code, started_at, finished_at, error_message, created_at, updated_at`;

export class RunRepository {
  constructor(private readonly db: Database) {}

  async create(input: { agentId: Uuid; taskId: Uuid | null; projectId: Uuid | null }): Promise<AgentRun> {
    const rows = await this.db.query(
      `INSERT INTO agent_runs (agent_id, task_id, project_id, status)
       VALUES ($1, $2, $3, 'QUEUED')
       RETURNING ${RUN_COLUMNS}`,
      [input.agentId, input.taskId, input.projectId],
    );
    return mapRow<AgentRun>(rows[0]!);
  }

  async markRunning(id: Uuid, workspace: string): Promise<void> {
    await this.db.query(
      "UPDATE agent_runs SET status = 'RUNNING', workspace = $2, started_at = now() WHERE id = $1",
      [id, workspace],
    );
  }

  /** §18 — chốt kết quả lần chạy kèm toàn bộ log để truy vết. */
  async finish(
    id: Uuid,
    result: {
      status: RunStatus;
      commandLog?: string | null;
      stdout?: string | null;
      stderr?: string | null;
      exitCode?: number | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE agent_runs SET status = $2, command_log = $3, stdout = $4, stderr = $5,
              exit_code = $6, error_message = $7, finished_at = now()
       WHERE id = $1`,
      [
        id,
        result.status,
        result.commandLog ?? null,
        result.stdout ?? null,
        result.stderr ?? null,
        result.exitCode ?? null,
        result.errorMessage ?? null,
      ],
    );
  }

  /** Lượt chạy còn ghi QUEUED/RUNNING khi tiến trình đã chết là lượt mồ côi — chốt FAILED kèm lý do. */
  async failOrphans(reason: string): Promise<number> {
    const rows = await this.db.query(
      `UPDATE agent_runs SET status = 'FAILED', error_message = $1, finished_at = now()
       WHERE status IN ('QUEUED', 'RUNNING') RETURNING id`,
      [reason],
    );
    return rows.length;
  }

  async findById(id: Uuid): Promise<AgentRun | null> {
    return mapMaybe<AgentRun>(
      await this.db.one(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = $1`, [id]),
    );
  }

  async listByTask(taskId: Uuid): Promise<AgentRun[]> {
    return mapRows<AgentRun>(
      await this.db.query(
        `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE task_id = $1 ORDER BY created_at DESC`,
        [taskId],
      ),
    );
  }

  async listRecentByAgent(agentId: Uuid, limit = 20): Promise<AgentRun[]> {
    return mapRows<AgentRun>(
      await this.db.query(
        `SELECT ${RUN_COLUMNS} FROM agent_runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [agentId, limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tin nhắn hội thoại                                                          */
/* -------------------------------------------------------------------------- */

const MESSAGE_COLUMNS = `id, project_id, task_id, run_id, author, role, content,
  created_at, updated_at`;

export class MessageRepository {
  constructor(private readonly db: Database) {}

  async append(input: {
    projectId?: Uuid | null;
    taskId?: Uuid | null;
    runId?: Uuid | null;
    author: string;
    role: Message['role'];
    content: string;
  }): Promise<Message> {
    const rows = await this.db.query(
      `INSERT INTO messages (project_id, task_id, run_id, author, role, content)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        input.projectId ?? null,
        input.taskId ?? null,
        input.runId ?? null,
        input.author,
        input.role,
        input.content,
      ],
    );
    return mapRow<Message>(rows[0]!);
  }

  async listByTask(taskId: Uuid, limit = 200): Promise<Message[]> {
    return mapRows<Message>(
      await this.db.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE task_id = $1 ORDER BY created_at LIMIT $2`,
        [taskId, limit],
      ),
    );
  }

  async listByProject(projectId: Uuid, limit = 200): Promise<Message[]> {
    return mapRows<Message>(
      await this.db.query(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE project_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [projectId, limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Lỗi                                                                         */
/* -------------------------------------------------------------------------- */

const BUG_COLUMNS = `id, project_id, task_id, title, description, severity, status,
  reported_by_agent_id, assigned_agent_id, resolved_at, created_at, updated_at`;

export class BugRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    projectId: Uuid;
    taskId?: Uuid | null;
    title: string;
    description: string;
    severity: Bug['severity'];
    reportedByAgentId?: Uuid | null;
  }): Promise<Bug> {
    const rows = await this.db.query(
      `INSERT INTO bugs (project_id, task_id, title, description, severity, reported_by_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${BUG_COLUMNS}`,
      [
        input.projectId,
        input.taskId ?? null,
        input.title,
        input.description,
        input.severity,
        input.reportedByAgentId ?? null,
      ],
    );
    return mapRow<Bug>(rows[0]!);
  }

  /**
   * Lỗi cùng tiêu đề đang mở trong dự án thì cập nhật chứ không chèn thêm — mỗi vòng QA rớt
   * từng chèn lại nguyên danh sách (242 lỗi mở, phần lớn trùng). Trả `created`
   * để engine biết có phát event lỗi mới hay không.
   */
  async upsertOpen(input: {
    projectId: Uuid;
    taskId?: Uuid | null;
    title: string;
    description: string;
    severity: Bug['severity'];
    reportedByAgentId?: Uuid | null;
  }): Promise<{ bug: Bug; created: boolean }> {
    const rows = await this.db.query(
      `UPDATE bugs SET description = $3, severity = $4, task_id = COALESCE($5, task_id), status = 'OPEN', resolved_at = NULL
       WHERE project_id = $1 AND lower(title) = lower($2) AND status IN ('OPEN', 'IN_PROGRESS')
       RETURNING ${BUG_COLUMNS}`,
      [input.projectId, input.title, input.description, input.severity, input.taskId ?? null],
    );
    if (rows[0]) return { bug: mapRow<Bug>(rows[0]), created: false };
    return { bug: await this.create(input), created: true };
  }

  /**
   * Người rà soát kiểm lại → lỗi người đó còn giữ mở mà lượt này không nêu lại coi như đã sửa. `keepTitles` rỗng
   * (rà đạt) thì đóng hết. Trả số lỗi đóng.
   */
  async resolveByReporter(
    projectId: Uuid,
    reporterAgentId: Uuid,
    status: 'VERIFIED' | 'WONTFIX',
    keepTitles: string[] = [],
  ): Promise<number> {
    const rows = await this.db.query(
      `UPDATE bugs SET status = $3, resolved_at = now()
       WHERE project_id = $1 AND reported_by_agent_id = $2 AND status IN ('OPEN', 'IN_PROGRESS')
         AND NOT (lower(title) = ANY($4::text[])) RETURNING id`,
      [projectId, reporterAgentId, status, keepTitles.map((title) => title.toLowerCase())],
    );
    return rows.length;
  }

  /** CEO chấp nhận hiện trạng của một task: lỗi mở gắn với task đó thành WONTFIX. Trả số lỗi. */
  async waiveForTask(projectId: Uuid, taskId: Uuid): Promise<number> {
    const rows = await this.db.query(
      `UPDATE bugs SET status = 'WONTFIX', resolved_at = now()
       WHERE project_id = $1 AND task_id = $2 AND status IN ('OPEN', 'IN_PROGRESS') RETURNING id`,
      [projectId, taskId],
    );
    return rows.length;
  }

  async findById(id: Uuid): Promise<Bug | null> {
    return mapMaybe<Bug>(await this.db.one(`SELECT ${BUG_COLUMNS} FROM bugs WHERE id = $1`, [id]));
  }

  async listByProject(projectId: Uuid, status?: Bug['status']): Promise<Bug[]> {
    if (status) {
      return mapRows<Bug>(
        await this.db.query(
          `SELECT ${BUG_COLUMNS} FROM bugs WHERE project_id = $1 AND status = $2 ORDER BY created_at DESC`,
          [projectId, status],
        ),
      );
    }
    return mapRows<Bug>(
      await this.db.query(
        `SELECT ${BUG_COLUMNS} FROM bugs WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      ),
    );
  }

  async setStatus(id: Uuid, status: Bug['status']): Promise<void> {
    await this.db.query(
      `UPDATE bugs SET status = $2,
              resolved_at = CASE WHEN $2 IN ('FIXED','VERIFIED','WONTFIX') THEN now() ELSE NULL END
       WHERE id = $1`,
      [id, status],
    );
  }

  async assign(id: Uuid, agentId: Uuid): Promise<void> {
    await this.db.query("UPDATE bugs SET assigned_agent_id = $2, status = 'IN_PROGRESS' WHERE id = $1", [
      id,
      agentId,
    ]);
  }

  /** Số lỗi đang mở của một dự án — dùng cho KPI bar và điều kiện nghiệm thu. */
  async countOpen(projectId: Uuid): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      "SELECT count(*)::text AS count FROM bugs WHERE project_id = $1 AND status IN ('OPEN','IN_PROGRESS')",
      [projectId],
    );
    return Number(row?.count ?? 0);
  }
}

/** Gom mọi repository lõi để service chỉ nhận một object. */
export interface CoreRepositories {
  users: UserRepository;
  projects: ProjectRepository;
  agents: AgentRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  messages: MessageRepository;
  bugs: BugRepository;
}

export function createCoreRepositories(db: Database): CoreRepositories {
  return {
    users: new UserRepository(db),
    projects: new ProjectRepository(db),
    agents: new AgentRepository(db),
    tasks: new TaskRepository(db),
    runs: new RunRepository(db),
    messages: new MessageRepository(db),
    bugs: new BugRepository(db),
  };
}

// `buildUpdate` được các repository mở rộng dùng lại khi cần cập nhật động.
export { buildUpdate };
