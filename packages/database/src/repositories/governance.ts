/**
 * P&N — Repository cho lớp quản trị: phê duyệt, triển khai, audit, thông báo,
 * sự kiện Git (§17, §27, §28, §62, §71).
 */

import type {
  Approval,
  ApprovalKind,
  ApprovalStatus,
  AuditLog,
  Deployment,
  DeployEnvironment,
  DeployStatus,
  Environment,
  GitEvent,
  Notification,
  Uuid,
} from '@pn/shared';
import { redactDeep } from '@pn/shared';

import type { Database } from '../pool.js';
import { mapMaybe, mapRow, mapRows } from './mapper.js';

/* -------------------------------------------------------------------------- */
/* Phê duyệt — §27                                                             */
/* -------------------------------------------------------------------------- */

const APPROVAL_COLUMNS = `id, kind, status, project_id, task_id, title, summary, context,
  requested_by_agent_id, decided_by_user_id, decided_at, decision_note, expires_at,
  created_at, updated_at`;

export class ApprovalRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    kind: ApprovalKind;
    title: string;
    summary: string;
    projectId?: Uuid | null;
    taskId?: Uuid | null;
    context?: Record<string, unknown>;
    requestedByAgentId?: Uuid | null;
    expiresInMinutes?: number | null;
  }): Promise<Approval> {
    // §19 — context hiển thị trong Telegram nên phải đi qua redaction trước khi lưu.
    const safeContext = redactDeep(input.context ?? {});
    const rows = await this.db.query(
      `INSERT INTO approvals (kind, title, summary, project_id, task_id, context,
                              requested_by_agent_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8::int IS NULL THEN NULL ELSE now() + ($8 || ' minutes')::interval END)
       RETURNING ${APPROVAL_COLUMNS}`,
      [
        input.kind,
        input.title,
        input.summary,
        input.projectId ?? null,
        input.taskId ?? null,
        JSON.stringify(safeContext),
        input.requestedByAgentId ?? null,
        input.expiresInMinutes ?? null,
      ],
    );
    return mapRow<Approval>(rows[0]!);
  }

  /** Gộp thêm vào context — nhiều reviewer cùng leo thang một task thì dùng chung một phiếu. */
  async mergeContext(id: Uuid, patch: Record<string, unknown>): Promise<void> {
    await this.db.query(
      'UPDATE approvals SET context = context || $2::jsonb, updated_at = now() WHERE id = $1',
      [id, JSON.stringify(redactDeep(patch))],
    );
  }

  async findById(id: Uuid): Promise<Approval | null> {
    return mapMaybe<Approval>(
      await this.db.one(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1`, [id]),
    );
  }

  async listPending(): Promise<Approval[]> {
    return mapRows<Approval>(
      await this.db.query(
        `SELECT ${APPROVAL_COLUMNS} FROM approvals
         WHERE status = 'PENDING' AND (expires_at IS NULL OR expires_at > now())
         ORDER BY created_at`,
      ),
    );
  }

  async listByProject(projectId: Uuid): Promise<Approval[]> {
    return mapRows<Approval>(
      await this.db.query(
        `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE project_id = $1 ORDER BY created_at DESC`,
        [projectId],
      ),
    );
  }

  /**
   * §4, §27 — cổng duyệt của một stage. Orchestrator hỏi hàm này trước khi cho
   * task của stage đó chạy: chưa có bản ghi thì tạo phiếu chờ, có mà chưa duyệt
   * thì task đứng yên, bị từ chối thì dừng hẳn.
   *
   * Lấy bản mới nhất chứ không phải bản đầu tiên, để CEO từ chối rồi duyệt lại
   * thì quyết định sau cùng là quyết định có hiệu lực.
   */
  async findLatestForStage(projectId: Uuid, stageId: string): Promise<Approval | null> {
    return mapMaybe<Approval>(
      await this.db.one(
        `SELECT ${APPROVAL_COLUMNS} FROM approvals
         WHERE project_id = $1 AND context->>'stageId' = $2
           AND status <> 'EXPIRED'
         ORDER BY created_at DESC LIMIT 1`,
        [projectId, stageId],
      ),
    );
  }

  /**
   * Ghi quyết định của CEO. Dùng `WHERE status = 'PENDING'` để hai lần bấm nút
   * trong Telegram không ghi đè lẫn nhau — lần thứ hai trả về null.
   */
  async decide(
    id: Uuid,
    decision: Extract<ApprovalStatus, 'APPROVED' | 'REJECTED'>,
    userId: Uuid,
    note?: string,
  ): Promise<Approval | null> {
    const rows = await this.db.query(
      `UPDATE approvals SET status = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4
       WHERE id = $1 AND status = 'PENDING'
       RETURNING ${APPROVAL_COLUMNS}`,
      [id, decision, userId, note ?? null],
    );
    return rows[0] ? mapRow<Approval>(rows[0]) : null;
  }

  /** Đánh dấu hết hạn các phê duyệt quá thời gian, chạy định kỳ. */
  async expireOverdue(): Promise<number> {
    const rows = await this.db.query(
      "UPDATE approvals SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= now() RETURNING id",
    );
    return rows.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Triển khai — §62                                                            */
/* -------------------------------------------------------------------------- */

const DEPLOYMENT_COLUMNS = `id, project_id, environment, status, commit_sha, url,
  triggered_by_agent_id, approval_id, started_at, finished_at, log_excerpt,
  created_at, updated_at`;

export class DeploymentRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    projectId: Uuid;
    environment: DeployEnvironment;
    commitSha?: string | null;
    triggeredByAgentId?: Uuid | null;
    approvalId?: Uuid | null;
  }): Promise<Deployment> {
    const rows = await this.db.query(
      `INSERT INTO deployments (project_id, environment, commit_sha, triggered_by_agent_id, approval_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${DEPLOYMENT_COLUMNS}`,
      [
        input.projectId,
        input.environment,
        input.commitSha ?? null,
        input.triggeredByAgentId ?? null,
        input.approvalId ?? null,
      ],
    );
    return mapRow<Deployment>(rows[0]!);
  }

  async setStatus(
    id: Uuid,
    status: DeployStatus,
    extra: { url?: string | null; logExcerpt?: string | null } = {},
  ): Promise<void> {
    await this.db.query(
      `UPDATE deployments SET status = $2,
              url         = COALESCE($3, url),
              log_excerpt = COALESCE($4, log_excerpt),
              started_at  = COALESCE(started_at, CASE WHEN $2 = 'IN_PROGRESS' THEN now() END),
              finished_at = CASE WHEN $2 IN ('SUCCESS','FAILED','ROLLED_BACK') THEN now() ELSE finished_at END
       WHERE id = $1`,
      [id, status, extra.url ?? null, extra.logExcerpt ?? null],
    );
  }

  /** Lần dựng còn IN_PROGRESS khi tiến trình đã chết thì không bao giờ xong — chốt FAILED kèm lý do. */
  async failOrphans(reason: string): Promise<number> {
    const rows = await this.db.query(
      `UPDATE deployments SET status = 'FAILED', finished_at = now(),
              log_excerpt = concat_ws(E'\n', log_excerpt, $1::text)
       WHERE status = 'IN_PROGRESS' RETURNING id`,
      [reason],
    );
    return rows.length;
  }

  async findById(id: Uuid): Promise<Deployment | null> {
    return mapMaybe<Deployment>(
      await this.db.one(`SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE id = $1`, [id]),
    );
  }

  async listByProject(projectId: Uuid, limit = 50): Promise<Deployment[]> {
    return mapRows<Deployment>(
      await this.db.query(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments WHERE project_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [projectId, limit],
      ),
    );
  }

  async listRecent(limit = 50): Promise<Deployment[]> {
    return mapRows<Deployment>(
      await this.db.query(
        `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments ORDER BY created_at DESC LIMIT $1`,
        [limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Nhật ký kiểm toán — §28, §71                                                */
/* -------------------------------------------------------------------------- */

export class AuditRepository {
  constructor(private readonly db: Database) {}

  /**
   * §89 — metadata luôn đi qua redaction trước khi ghi. Không có đường nào ghi
   * audit mà bỏ qua bước này.
   */
  async record(input: {
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    metadata?: Record<string, unknown>;
    ipAddress?: string | null;
    environment?: Environment;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (actor, action, target_type, target_id, metadata, ip_address, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.actor,
        input.action,
        input.targetType,
        input.targetId ?? null,
        JSON.stringify(redactDeep(input.metadata ?? {})),
        input.ipAddress ?? null,
        input.environment ?? 'development',
      ],
    );
  }

  /**
   * Đọc nhật ký mới nhất trước. `excludeActions` bỏ các dòng lặp máy móc (bot lấy cấu hình mỗi 2 phút chiếm
   * hơn 90% bảng); `before` để trang "Hiện thêm" đọc tiếp các dòng cũ hơn dòng cuối đang có.
   */
  async list(
    filter: { targetType?: string; targetId?: string; limit?: number; excludeActions?: string[]; before?: string } = {},
  ): Promise<AuditLog[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.targetType && filter.targetId) {
      params.push(filter.targetType, filter.targetId);
      where.push(`target_type = $${params.length - 1} AND target_id = $${params.length}`);
    }
    if (filter.excludeActions?.length) {
      params.push(filter.excludeActions);
      where.push(`action <> ALL($${params.length}::text[])`);
    }
    if (filter.before) {
      params.push(filter.before);
      where.push(`created_at < $${params.length}`);
    }
    params.push(filter.limit ?? 100);
    return mapRows<AuditLog>(
      await this.db.query(
        `SELECT * FROM audit_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      ),
    );
  }

  /**
   * Số liệu tổng cho trang Nhật ký: tổng bản ghi, phần là việc lặp máy móc (`noiseActions`), từng ngày trong
   * `days` ngày gần nhất, mã lỗi 4xx/5xx trong cùng kỳ, người làm, và số lần của vài hành động đáng đếm
   * trong tháng (đăng nhập qua Telegram, bị từ chối).
   */
  async stats(days: number, noiseActions: string[], countActions: string[]): Promise<{
    total: number;
    noise: number;
    since: string | null;
    days: Array<{ day: string; total: number; noise: number }>;
    errors: { clientErrors: number; serverErrors: number };
    actors: { ceo: number; telegram: number };
    monthActions: Record<string, number>;
  }> {
    const [total, perDay, errors, actors, month] = await Promise.all([
      this.db.one<{ total: number; noise: number; since: Date | null }>(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE action = ANY($1::text[]))::int AS noise, MIN(created_at) AS since
         FROM audit_logs`,
        [noiseActions],
      ),
      this.db.query<{ day: string; total: number; noise: number }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE action = ANY($2::text[]))::int AS noise
         FROM audit_logs WHERE created_at >= date_trunc('day', now()) - (($1::int - 1) || ' days')::interval
         GROUP BY 1 ORDER BY 1`,
        [days, noiseActions],
      ),
      this.db.one<{ client: number; server: number }>(
        `SELECT COUNT(*) FILTER (WHERE (metadata->>'statusCode')::int BETWEEN 400 AND 499)::int AS client,
                COUNT(*) FILTER (WHERE (metadata->>'statusCode')::int >= 500)::int AS server
         FROM audit_logs WHERE created_at >= date_trunc('day', now()) - (($1::int - 1) || ' days')::interval
           AND metadata->>'statusCode' ~ '^[0-9]+$'`,
        [days],
      ),
      this.db.one<{ ceo: number; telegram: number }>(
        `SELECT COUNT(*) FILTER (WHERE actor LIKE 'user:%')::int AS ceo,
                COUNT(*) FILTER (WHERE actor LIKE 'telegram:%')::int AS telegram
         FROM audit_logs`,
      ),
      this.db.query<{ action: string; count: number }>(
        `SELECT action, COUNT(*)::int AS count FROM audit_logs
         WHERE created_at >= date_trunc('month', now()) AND action = ANY($1::text[]) GROUP BY action`,
        [countActions],
      ),
    ]);
    return {
      total: total!.total,
      noise: total!.noise,
      since: total!.since ? total!.since.toISOString() : null,
      days: perDay,
      errors: { clientErrors: errors!.client, serverErrors: errors!.server },
      actors: { ceo: actors!.ceo, telegram: actors!.telegram },
      monthActions: Object.fromEntries(month.map((row) => [row.action, row.count])),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Thông báo — §134                                                            */
/* -------------------------------------------------------------------------- */

const NOTIFICATION_COLUMNS = `id, user_id, channel, severity, title, body, project_id,
  read_at, delivered_at, created_at, updated_at`;

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    userId: Uuid;
    channel: Notification['channel'];
    severity: Notification['severity'];
    title: string;
    body: string;
    projectId?: Uuid | null;
  }): Promise<Notification> {
    const rows = await this.db.query(
      `INSERT INTO notifications (user_id, channel, severity, title, body, project_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${NOTIFICATION_COLUMNS}`,
      [input.userId, input.channel, input.severity, input.title, input.body, input.projectId ?? null],
    );
    return mapRow<Notification>(rows[0]!);
  }

  async markDelivered(id: Uuid): Promise<void> {
    await this.db.query('UPDATE notifications SET delivered_at = now() WHERE id = $1', [id]);
  }

  async listForUser(userId: Uuid, limit = 50): Promise<Notification[]> {
    return mapRows<Notification>(
      await this.db.query(
        `SELECT ${NOTIFICATION_COLUMNS} FROM notifications WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2`,
        [userId, limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Sự kiện Git — §17                                                           */
/* -------------------------------------------------------------------------- */

export class GitEventRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    projectId: Uuid;
    type: GitEvent['type'];
    branch?: string | null;
    commitSha?: string | null;
    pullRequestNumber?: number | null;
    actorAgentId?: Uuid | null;
    summary: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO git_events (project_id, type, branch, commit_sha, pull_request_number,
                               actor_agent_id, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.projectId,
        input.type,
        input.branch ?? null,
        input.commitSha ?? null,
        input.pullRequestNumber ?? null,
        input.actorAgentId ?? null,
        input.summary,
      ],
    );
  }

  async listByProject(projectId: Uuid, limit = 100): Promise<GitEvent[]> {
    return mapRows<GitEvent>(
      await this.db.query(
        'SELECT * FROM git_events WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2',
        [projectId, limit],
      ),
    );
  }
}

export interface GovernanceRepositories {
  approvals: ApprovalRepository;
  deployments: DeploymentRepository;
  audit: AuditRepository;
  notifications: NotificationRepository;
  gitEvents: GitEventRepository;
}

export function createGovernanceRepositories(db: Database): GovernanceRepositories {
  return {
    approvals: new ApprovalRepository(db),
    deployments: new DeploymentRepository(db),
    audit: new AuditRepository(db),
    notifications: new NotificationRepository(db),
    gitEvents: new GitEventRepository(db),
  };
}
