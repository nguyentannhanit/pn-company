/**
 * P&N — Tầng dữ liệu cho Knowledge & R&D (§98–§130).
 *
 * Bảng đã khai từ Phase 0 trong `0003_knowledge.sql`; đây là chỗ chúng bắt đầu
 * có dữ liệu. Trật tự vòng đời của một mẩu kiến thức:
 *
 *   nguồn → ứng viên (DISCOVERED) → sàng lọc (SCREENED) → chạy thử (EVALUATED)
 *         → gói kiến thức (DRAFT) → CEO duyệt → ACTIVE → gắn vào phòng ban
 *
 * Không bước nào được bỏ qua, vì mỗi bước là một cổng §133 và §108 yêu cầu.
 */

import type { AgentRole, Department, Uuid } from '@pn/shared';

import type { Database } from '../pool.js';
import { mapMaybe, mapRow, mapRows } from './mapper.js';

/* -------------------------------------------------------------------------- */
/* Kiểu dữ liệu                                                                */
/* -------------------------------------------------------------------------- */

export type CandidateStage = 'DISCOVERED' | 'SCREENED' | 'EVALUATED' | 'PROMOTED' | 'REJECTED';
export type KnowledgeStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'ACTIVE'
  | 'DEPRECATED'
  | 'ROLLED_BACK'
  | 'REJECTED';
export type KnowledgeKind =
  | 'pattern'
  | 'library'
  | 'tool'
  | 'skill'
  | 'guideline'
  | 'benchmark'
  | 'repo';

export interface KnowledgeSource {
  id: Uuid;
  kind: string;
  name: string;
  url: string;
  trustScore: number;
  isAllowed: boolean;
  lastScannedAt: string | null;
}

export interface KnowledgeCandidate {
  id: Uuid;
  sourceId: Uuid | null;
  discoveredBy: string;
  title: string;
  url: string | null;
  summary: string;
  raw: Record<string, unknown>;
  stage: CandidateStage;
  rejectReason: string | null;
  createdAt: string;
}

export interface KnowledgeItem {
  id: Uuid;
  candidateId: Uuid | null;
  sourceId: Uuid | null;
  title: string;
  kind: KnowledgeKind;
  summary: string;
  body: string;
  license: string | null;
  licenseApproved: boolean;
  status: KnowledgeStatus;
  activeVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScoredRepo {
  id: Uuid;
  fullName: string;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  lastCommitAt: string | null;
  license: string | null;
  language: string | null;
  score: number | null;
  scoreBreakdown: Record<string, unknown>;
  candidateId: Uuid | null;
  scannedAt: string;
}

export interface DepartmentLevel {
  department: Department;
  level: number;
  totalXp: number;
  leveledUpAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* Nguồn — §120                                                                */
/* -------------------------------------------------------------------------- */

const SOURCE_COLUMNS = `id, kind, name, url, trust_score, is_allowed, last_scanned_at`;

export class KnowledgeSourceRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    kind: string;
    name: string;
    url: string;
    trustScore?: number;
    isAllowed?: boolean;
  }): Promise<KnowledgeSource> {
    const rows = await this.db.query(
      `INSERT INTO knowledge_sources (kind, name, url, trust_score, is_allowed)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (url) DO UPDATE
         SET kind = EXCLUDED.kind, name = EXCLUDED.name
       RETURNING ${SOURCE_COLUMNS}`,
      [input.kind, input.name, input.url, input.trustScore ?? 50, input.isAllowed ?? true],
    );
    return mapRow<KnowledgeSource>(rows[0]!);
  }

  /** Chỉ nguồn được phép mới đưa vào vòng quét hằng ngày (§120, §133). */
  async listAllowed(): Promise<KnowledgeSource[]> {
    return mapRows<KnowledgeSource>(
      await this.db.query(
        `SELECT ${SOURCE_COLUMNS} FROM knowledge_sources
         WHERE is_allowed = true ORDER BY trust_score DESC, name`,
      ),
    );
  }

  async list(): Promise<KnowledgeSource[]> {
    return mapRows<KnowledgeSource>(
      await this.db.query(`SELECT ${SOURCE_COLUMNS} FROM knowledge_sources ORDER BY name`),
    );
  }

  async setTrust(id: Uuid, trustScore: number): Promise<void> {
    await this.db.query('UPDATE knowledge_sources SET trust_score = $2 WHERE id = $1', [
      id,
      Math.max(0, Math.min(100, Math.round(trustScore))),
    ]);
  }

  async markScanned(id: Uuid): Promise<void> {
    await this.db.query('UPDATE knowledge_sources SET last_scanned_at = now() WHERE id = $1', [id]);
  }
}

/* -------------------------------------------------------------------------- */
/* Ứng viên — §106, §133                                                       */
/* -------------------------------------------------------------------------- */

const CANDIDATE_COLUMNS = `id, source_id, discovered_by, title, url, summary, raw, stage,
  reject_reason, created_at`;

export class KnowledgeCandidateRepository {
  constructor(private readonly db: Database) {}

  /**
   * URL trùng thì không tạo bản ghi mới. §121 nói về chống trùng lặp, và cách
   * rẻ nhất là chặn ngay ở cửa vào thay vì phát hiện sau khi đã tốn tiền đọc.
   */
  async create(input: {
    sourceId?: Uuid | null;
    discoveredBy: string;
    title: string;
    url?: string | null;
    summary?: string;
    raw?: Record<string, unknown>;
  }): Promise<KnowledgeCandidate> {
    if (input.url) {
      const existing = await this.findByUrl(input.url);
      if (existing) return existing;
    }

    const rows = await this.db.query(
      `INSERT INTO knowledge_candidates (source_id, discovered_by, title, url, summary, raw)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${CANDIDATE_COLUMNS}`,
      [
        input.sourceId ?? null,
        input.discoveredBy,
        input.title,
        input.url ?? null,
        input.summary ?? '',
        JSON.stringify(input.raw ?? {}),
      ],
    );
    return mapRow<KnowledgeCandidate>(rows[0]!);
  }

  async findByUrl(url: string): Promise<KnowledgeCandidate | null> {
    return mapMaybe<KnowledgeCandidate>(
      await this.db.one(`SELECT ${CANDIDATE_COLUMNS} FROM knowledge_candidates WHERE url = $1`, [url]),
    );
  }

  async findById(id: Uuid): Promise<KnowledgeCandidate | null> {
    return mapMaybe<KnowledgeCandidate>(
      await this.db.one(`SELECT ${CANDIDATE_COLUMNS} FROM knowledge_candidates WHERE id = $1`, [id]),
    );
  }

  async listByStage(stage: CandidateStage, limit = 100): Promise<KnowledgeCandidate[]> {
    return mapRows<KnowledgeCandidate>(
      await this.db.query(
        `SELECT ${CANDIDATE_COLUMNS} FROM knowledge_candidates
         WHERE stage = $1 ORDER BY created_at DESC LIMIT $2`,
        [stage, limit],
      ),
    );
  }

  async advance(id: Uuid, stage: CandidateStage): Promise<void> {
    await this.db.query('UPDATE knowledge_candidates SET stage = $2 WHERE id = $1', [id, stage]);
  }

  /** Loại kèm lý do. Không có lý do thì không ai học được gì từ lần loại đó. */
  async reject(id: Uuid, reason: string): Promise<void> {
    await this.db.query(
      "UPDATE knowledge_candidates SET stage = 'REJECTED', reject_reason = $2 WHERE id = $1",
      [id, reason],
    );
  }

  async countByStage(): Promise<Record<string, number>> {
    const rows = await this.db.query<{ stage: string; count: string }>(
      'SELECT stage, count(*)::text AS count FROM knowledge_candidates GROUP BY stage',
    );
    return Object.fromEntries(rows.map((row) => [row.stage, Number(row.count)]));
  }
}

/* -------------------------------------------------------------------------- */
/* Gói kiến thức — §109, §110, §114, §115, §142                                */
/* -------------------------------------------------------------------------- */

const ITEM_COLUMNS = `id, candidate_id, source_id, title, kind, summary, body, license,
  license_approved, status, active_version, created_at, updated_at`;

export class KnowledgeItemRepository {
  constructor(private readonly db: Database) {}

  async create(input: {
    candidateId?: Uuid | null;
    sourceId?: Uuid | null;
    title: string;
    kind: KnowledgeKind;
    summary?: string;
    body: string;
    license?: string | null;
    licenseApproved?: boolean;
  }): Promise<KnowledgeItem> {
    return this.db.transaction(async (client) => {
      const result = await client.query(
        `INSERT INTO knowledge_items (candidate_id, source_id, title, kind, summary, body,
                                      license, license_approved, active_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1)
         RETURNING ${ITEM_COLUMNS}`,
        [
          input.candidateId ?? null,
          input.sourceId ?? null,
          input.title,
          input.kind,
          input.summary ?? '',
          input.body,
          input.license ?? null,
          input.licenseApproved ?? false,
        ],
      );
      const item = mapRow<KnowledgeItem>(result.rows[0]!);

      // §114 — mọi gói kiến thức có phiên bản ngay từ đầu, để §115 quay lui được.
      await client.query(
        `INSERT INTO knowledge_versions (item_id, version, body, changelog, created_by)
         VALUES ($1, 1, $2, 'Phiên bản đầu tiên', 'system')`,
        [item.id, input.body],
      );
      return item;
    });
  }

  async findById(id: Uuid): Promise<KnowledgeItem | null> {
    return mapMaybe<KnowledgeItem>(
      await this.db.one(`SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE id = $1`, [id]),
    );
  }

  async list(filter: { status?: KnowledgeStatus } = {}, limit = 200): Promise<KnowledgeItem[]> {
    const rows = filter.status
      ? await this.db.query(
          `SELECT ${ITEM_COLUMNS} FROM knowledge_items WHERE status = $1
           ORDER BY updated_at DESC LIMIT $2`,
          [filter.status, limit],
        )
      : await this.db.query(
          `SELECT ${ITEM_COLUMNS} FROM knowledge_items ORDER BY updated_at DESC LIMIT $1`,
          [limit],
        );
    return mapRows<KnowledgeItem>(rows);
  }

  async setStatus(id: Uuid, status: KnowledgeStatus): Promise<void> {
    await this.db.query('UPDATE knowledge_items SET status = $2 WHERE id = $1', [id, status]);
  }

  async setLicenseApproved(id: Uuid, approved: boolean): Promise<void> {
    await this.db.query('UPDATE knowledge_items SET license_approved = $2 WHERE id = $1', [
      id,
      approved,
    ]);
  }

  /** §114 — thêm phiên bản mới và chuyển sang dùng nó. */
  async addVersion(
    id: Uuid,
    body: string,
    changelog: string,
    createdBy: string,
  ): Promise<number> {
    return this.db.transaction(async (client) => {
      const next = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM knowledge_versions WHERE item_id = $1',
        [id],
      );
      const version = Number(next.rows[0]!.version);

      await client.query(
        `INSERT INTO knowledge_versions (item_id, version, body, changelog, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, version, body, changelog, createdBy],
      );
      await client.query(
        'UPDATE knowledge_items SET body = $2, active_version = $3 WHERE id = $1',
        [id, body, version],
      );
      return version;
    });
  }

  /**
   * §115 — quay lui về một phiên bản cũ.
   *
   * Không xoá phiên bản mới: lịch sử phải giữ nguyên để §149.30 truy vết được
   * "đã từng dùng cái gì, từ lúc nào tới lúc nào".
   */
  async rollback(id: Uuid, version: number): Promise<boolean> {
    const target = await this.db.one<{ body: string }>(
      'SELECT body FROM knowledge_versions WHERE item_id = $1 AND version = $2',
      [id, version],
    );
    if (!target) return false;

    await this.db.query(
      "UPDATE knowledge_items SET body = $2, active_version = $3, status = 'ROLLED_BACK' WHERE id = $1",
      [id, target.body, version],
    );
    return true;
  }

  async versions(id: Uuid): Promise<
    Array<{ version: number; changelog: string; createdBy: string; createdAt: string }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT version, changelog, created_by, created_at FROM knowledge_versions
         WHERE item_id = $1 ORDER BY version DESC`,
        [id],
      ),
    );
  }

  /**
   * §108, §136 — nối gói kiến thức với phiếu duyệt trong bảng `approvals` dùng
   * chung. Nhờ vậy CEO duyệt kiến thức ở đúng màn hình duyệt mọi thứ khác, chứ
   * không phải học thêm một chỗ nữa.
   */
  async linkApproval(itemId: Uuid, approvalId: Uuid): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_approvals (item_id, approval_id) VALUES ($1,$2)
       ON CONFLICT (item_id, approval_id) DO NOTHING`,
      [itemId, approvalId],
    );
  }

  /** Gói kiến thức gắn với một phiếu duyệt; dùng khi CEO bấm duyệt. */
  async findByApproval(approvalId: Uuid): Promise<KnowledgeItem | null> {
    return mapMaybe<KnowledgeItem>(
      await this.db.one(
        `SELECT ${ITEM_COLUMNS.split(', ')
          .map((column) => `i.${column.trim()}`)
          .join(', ')}
         FROM knowledge_items i
         JOIN knowledge_approvals a ON a.item_id = i.id
         WHERE a.approval_id = $1`,
        [approvalId],
      ),
    );
  }

  /* --- Gắn vào phòng ban và agent — §110, §142 --------------------------- */

  async attachToDepartment(id: Uuid, department: Department): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_departments (item_id, department, activated_at)
       VALUES ($1,$2,now()) ON CONFLICT (item_id, department) DO UPDATE SET activated_at = now()`,
      [id, department],
    );
  }

  async bindToRole(id: Uuid, agentRole: AgentRole, priority = 100): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_agent_bindings (item_id, agent_role, priority, is_active)
       VALUES ($1,$2,$3,true)
       ON CONFLICT (item_id, agent_role) DO UPDATE SET priority = EXCLUDED.priority, is_active = true`,
      [id, agentRole, priority],
    );
  }

  /**
   * §142 — kiến thức mà một vai trò đang nạp. Đây là hàm được gọi trước MỖI lần
   * agent chạy, nên nó chỉ lấy đúng thứ đang ACTIVE và có giới hạn số lượng:
   * nối cả kho vào prompt thì vừa tốn tiền vừa làm loãng chỉ dẫn vai trò.
   */
  async activeForRole(agentRole: AgentRole, limit = 10): Promise<KnowledgeItem[]> {
    return mapRows<KnowledgeItem>(
      await this.db.query(
        `SELECT ${ITEM_COLUMNS.split(', ')
          .map((column) => `i.${column.trim()}`)
          .join(', ')}
         FROM knowledge_items i
         JOIN knowledge_agent_bindings b ON b.item_id = i.id
         WHERE b.agent_role = $1 AND b.is_active = true AND i.status = 'ACTIVE'
         ORDER BY b.priority, i.updated_at DESC
         LIMIT $2`,
        [agentRole, limit],
      ),
    );
  }

  async listByDepartment(department: Department): Promise<KnowledgeItem[]> {
    return mapRows<KnowledgeItem>(
      await this.db.query(
        `SELECT ${ITEM_COLUMNS.split(', ')
          .map((column) => `i.${column.trim()}`)
          .join(', ')}
         FROM knowledge_items i
         JOIN knowledge_departments d ON d.item_id = i.id
         WHERE d.department = $1
         ORDER BY i.updated_at DESC`,
        [department],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Rà soát — §117, §118                                                        */
/* -------------------------------------------------------------------------- */

export class KnowledgeReviewRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    itemId: Uuid;
    reviewer: string;
    kind: 'security' | 'license' | 'quality' | 'duplication';
    passed: boolean;
    findings?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_reviews (item_id, reviewer, kind, passed, findings)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.itemId,
        input.reviewer,
        input.kind,
        input.passed,
        JSON.stringify(input.findings ?? {}),
      ],
    );
  }

  async listForItem(itemId: Uuid): Promise<
    Array<{ reviewer: string; kind: string; passed: boolean; findings: Record<string, unknown>; createdAt: string }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT reviewer, kind, passed, findings, created_at FROM knowledge_reviews
         WHERE item_id = $1 ORDER BY created_at DESC`,
        [itemId],
      ),
    );
  }

  /** §116 — các lần chạy thử của một gói, mới nhất trước. */
  async listEvaluations(itemId: Uuid): Promise<
    Array<{ score: number | null; passed: boolean; report: Record<string, unknown>; createdAt: string }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT score, passed, report, created_at FROM knowledge_evaluations
         WHERE item_id = $1 ORDER BY created_at DESC`,
        [itemId],
      ),
    );
  }

  /** §116 — kết quả chạy thử trong sandbox. */
  async recordEvaluation(input: {
    itemId: Uuid;
    runId?: Uuid | null;
    score?: number | null;
    passed: boolean;
    report?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_evaluations (item_id, run_id, score, passed, report)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.itemId,
        input.runId ?? null,
        input.score ?? null,
        input.passed,
        JSON.stringify(input.report ?? {}),
      ],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Repo GitHub đã chấm điểm — §101, §102                                       */
/* -------------------------------------------------------------------------- */

const REPO_COLUMNS = `id, full_name, url, stars, forks, open_issues, last_commit_at, license,
  language, score, score_breakdown, candidate_id, scanned_at`;

export class GithubRepoRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    fullName: string;
    url: string;
    stars: number;
    forks: number;
    openIssues: number;
    lastCommitAt?: string | null;
    license?: string | null;
    language?: string | null;
    score?: number | null;
    scoreBreakdown?: Record<string, unknown>;
    candidateId?: Uuid | null;
  }): Promise<ScoredRepo> {
    const rows = await this.db.query(
      `INSERT INTO github_repositories (full_name, url, stars, forks, open_issues, last_commit_at,
                                        license, language, score, score_breakdown, candidate_id, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (full_name) DO UPDATE
         SET stars = EXCLUDED.stars, forks = EXCLUDED.forks, open_issues = EXCLUDED.open_issues,
             last_commit_at = EXCLUDED.last_commit_at, license = EXCLUDED.license,
             language = EXCLUDED.language, score = EXCLUDED.score,
             score_breakdown = EXCLUDED.score_breakdown, scanned_at = now()
       RETURNING ${REPO_COLUMNS}`,
      [
        input.fullName,
        input.url,
        input.stars,
        input.forks,
        input.openIssues,
        input.lastCommitAt ?? null,
        input.license ?? null,
        input.language ?? null,
        input.score ?? null,
        JSON.stringify(input.scoreBreakdown ?? {}),
        input.candidateId ?? null,
      ],
    );
    return mapRow<ScoredRepo>(rows[0]!);
  }

  async topScored(limit = 20): Promise<ScoredRepo[]> {
    return mapRows<ScoredRepo>(
      await this.db.query(
        `SELECT ${REPO_COLUMNS} FROM github_repositories
         WHERE score IS NOT NULL ORDER BY score DESC LIMIT $1`,
        [limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Technology Radar — §103                                                     */
/* -------------------------------------------------------------------------- */

export class TechnologyRadarRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    name: string;
    category: string;
    ring: 'adopt' | 'trial' | 'assess' | 'hold';
    rationale?: string;
    itemId?: Uuid | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO technology_radar (name, category, ring, rationale, item_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name, category) DO UPDATE
         SET ring = EXCLUDED.ring, rationale = EXCLUDED.rationale, item_id = EXCLUDED.item_id`,
      [input.name, input.category, input.ring, input.rationale ?? '', input.itemId ?? null],
    );
  }

  async list(): Promise<
    Array<{ name: string; category: string; ring: string; rationale: string; updatedAt: string }>
  > {
    return mapRows(
      await this.db.query(
        'SELECT name, category, ring, rationale, updated_at FROM technology_radar ORDER BY category, name',
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Kỹ năng — §104                                                              */
/* -------------------------------------------------------------------------- */

export interface Skill {
  id: Uuid;
  name: string;
  description: string;
  itemId: Uuid | null;
  department: string | null;
  isActive: boolean;
}

export class SkillRepository {
  constructor(private readonly db: Database) {}

  /**
   * Tên kỹ năng là khoá duy nhất. Trùng tên thì cập nhật mô tả chứ không tạo
   * bản ghi thứ hai — hai dòng "React Server Components" trong danh mục kỹ năng
   * là một danh mục hỏng.
   */
  async upsert(input: {
    name: string;
    description?: string;
    itemId?: Uuid | null;
    department?: string | null;
    isActive?: boolean;
  }): Promise<Skill> {
    const rows = await this.db.query(
      `INSERT INTO skill_catalog (name, description, item_id, department, is_active)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (name) DO UPDATE
         SET description = COALESCE(NULLIF(EXCLUDED.description, ''), skill_catalog.description),
             item_id     = COALESCE(EXCLUDED.item_id, skill_catalog.item_id),
             department  = COALESCE(EXCLUDED.department, skill_catalog.department)
       RETURNING id, name, description, item_id, department, is_active`,
      [
        input.name,
        input.description ?? '',
        input.itemId ?? null,
        input.department ?? null,
        input.isActive ?? false,
      ],
    );
    return mapRow<Skill>(rows[0]!);
  }

  async list(): Promise<Skill[]> {
    return mapRows<Skill>(
      await this.db.query(
        'SELECT id, name, description, item_id, department, is_active FROM skill_catalog ORDER BY is_active DESC, name',
      ),
    );
  }

  /** Kỹ năng chỉ "đang có" khi gói kiến thức mang nó đã được kích hoạt. */
  async activateForItem(itemId: Uuid): Promise<number> {
    const rows = await this.db.query(
      'UPDATE skill_catalog SET is_active = true WHERE item_id = $1 RETURNING id',
      [itemId],
    );
    return rows.length;
  }
}

/* -------------------------------------------------------------------------- */
/* Cấp độ phòng ban — §111, §112, §113                                         */
/* -------------------------------------------------------------------------- */

export class DepartmentLevelRepository {
  constructor(private readonly db: Database) {}

  /**
   * Cộng XP kèm bằng chứng và tính lại cấp trong cùng một transaction.
   *
   * Hai việc phải đi cùng nhau: bảng `department_xp` là sổ cái, còn
   * `department_levels` là số dư. Lệch nhau thì không còn cách nào biết bên nào
   * đúng, và §112 đòi XP phải truy được về sự kiện sinh ra nó.
   */
  async addXp(input: {
    department: Department;
    amount: number;
    evidence: string;
    projectId?: Uuid | null;
    taskId?: Uuid | null;
    itemId?: Uuid | null;
    levelForXp: (totalXp: number) => number;
  }): Promise<{ totalXp: number; level: number; leveledUp: boolean }> {
    return this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO department_xp (department, amount, evidence, project_id, task_id, item_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          input.department,
          input.amount,
          input.evidence,
          input.projectId ?? null,
          input.taskId ?? null,
          input.itemId ?? null,
        ],
      );

      const current = await client.query<{ total_xp: number; level: number }>(
        `INSERT INTO department_levels (department, level, total_xp)
         VALUES ($1, 1, 0)
         ON CONFLICT (department) DO NOTHING
         RETURNING total_xp, level`,
        [input.department],
      );
      void current;

      const updated = await client.query<{ total_xp: number; level: number }>(
        `UPDATE department_levels SET total_xp = total_xp + $2
         WHERE department = $1 RETURNING total_xp, level`,
        [input.department, input.amount],
      );

      const totalXp = Number(updated.rows[0]!.total_xp);
      const previousLevel = Number(updated.rows[0]!.level);
      const level = input.levelForXp(totalXp);

      if (level !== previousLevel) {
        await client.query(
          'UPDATE department_levels SET level = $2, leveled_up_at = now() WHERE department = $1',
          [input.department, level],
        );
      }

      return { totalXp, level, leveledUp: level > previousLevel };
    });
  }

  async list(): Promise<DepartmentLevel[]> {
    return mapRows<DepartmentLevel>(
      await this.db.query(
        'SELECT department, level, total_xp, leveled_up_at FROM department_levels ORDER BY level DESC, total_xp DESC',
      ),
    );
  }

  async recentXp(department: Department, limit = 20): Promise<
    Array<{ amount: number; evidence: string; createdAt: string }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT amount, evidence, created_at FROM department_xp
         WHERE department = $1 ORDER BY created_at DESC LIMIT $2`,
        [department, limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Đo hiệu quả kiến thức — §124                                                */
/* -------------------------------------------------------------------------- */

export class KnowledgeMetricRepository {
  constructor(private readonly db: Database) {}

  /**
   * Mỗi lần đo là một hàng mới, không ghi đè. §124 hỏi "before → after", và
   * câu hỏi đó chỉ trả lời được khi còn giữ các lần đo trước.
   */
  async record(input: {
    itemId: Uuid;
    department: string;
    metric: string;
    valueBefore: number | null;
    valueAfter: number | null;
    sampleSize: number;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_metrics (item_id, department, metric, value_before, value_after, sample_size)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        input.itemId,
        input.department,
        input.metric,
        input.valueBefore,
        input.valueAfter,
        input.sampleSize,
      ],
    );
  }

  async listForItem(itemId: Uuid): Promise<
    Array<{
      department: string;
      metric: string;
      valueBefore: number | null;
      valueAfter: number | null;
      sampleSize: number;
      measuredAt: string;
    }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT department, metric, value_before, value_after, sample_size, measured_at
         FROM knowledge_metrics WHERE item_id = $1 ORDER BY measured_at DESC`,
        [itemId],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Phiên bản hồ sơ agent — §114, §115                                          */
/* -------------------------------------------------------------------------- */

export interface AgentProfileVersion {
  id: Uuid;
  agentRole: AgentRole;
  version: number;
  systemPrompt: string;
  knowledgeIds: Uuid[];
  activatedAt: string | null;
  rolledBackAt: string | null;
  createdAt: string;
}

/**
 * §114 — "Mỗi Agent phải có version. Version thay đổi khi ... knowledge mới
 * được activate."
 *
 * Bảng này là câu trả lời cho "hôm đó agent chạy bằng đúng cái gì". Không có
 * nó thì sau một tháng không ai dựng lại được: prompt đã đổi, kiến thức đã gắn
 * thêm, và bản ghi run chỉ còn kết quả chứ không còn nguyên nhân.
 */
export class AgentProfileRepository {
  constructor(private readonly db: Database) {}

  async createVersion(input: {
    agentRole: AgentRole;
    systemPrompt: string;
    knowledgeIds: Uuid[];
    approvalId?: Uuid | null;
  }): Promise<AgentProfileVersion> {
    return this.db.transaction(async (client) => {
      const next = await client.query<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM agent_profile_versions WHERE agent_role = $1',
        [input.agentRole],
      );
      const version = Number(next.rows[0]!.version);

      // Phiên bản mới là phiên bản đang dùng; bản cũ giữ nguyên để quay lui được.
      const rows = await client.query(
        `INSERT INTO agent_profile_versions
           (agent_role, version, system_prompt, knowledge_ids, approval_id, activated_at)
         VALUES ($1,$2,$3,$4,$5,now())
         RETURNING id, agent_role, version, system_prompt, knowledge_ids, activated_at,
                   rolled_back_at, created_at`,
        [
          input.agentRole,
          version,
          input.systemPrompt,
          input.knowledgeIds,
          input.approvalId ?? null,
        ],
      );
      return mapRow<AgentProfileVersion>(rows.rows[0]!);
    });
  }

  async listVersions(agentRole: AgentRole, limit = 20): Promise<AgentProfileVersion[]> {
    return mapRows<AgentProfileVersion>(
      await this.db.query(
        `SELECT id, agent_role, version, system_prompt, knowledge_ids, activated_at,
                rolled_back_at, created_at
         FROM agent_profile_versions WHERE agent_role = $1
         ORDER BY version DESC LIMIT $2`,
        [agentRole, limit],
      ),
    );
  }

  async current(agentRole: AgentRole): Promise<AgentProfileVersion | null> {
    return mapMaybe<AgentProfileVersion>(
      await this.db.one(
        `SELECT id, agent_role, version, system_prompt, knowledge_ids, activated_at,
                rolled_back_at, created_at
         FROM agent_profile_versions
         WHERE agent_role = $1 AND rolled_back_at IS NULL
         ORDER BY version DESC LIMIT 1`,
        [agentRole],
      ),
    );
  }

  /**
   * §115 — quay lui: đánh dấu mọi phiên bản sau mốc là đã bị lùi, và trả về
   * danh sách kiến thức của phiên bản đích để caller gắn lại đúng như cũ.
   *
   * Không xoá gì. Lịch sử phải nguyên vẹn để §149.30 truy được.
   */
  async rollbackTo(agentRole: AgentRole, version: number): Promise<AgentProfileVersion | null> {
    const target = await this.db.one<{ knowledge_ids: string[] }>(
      'SELECT knowledge_ids FROM agent_profile_versions WHERE agent_role = $1 AND version = $2',
      [agentRole, version],
    );
    if (!target) return null;

    await this.db.query(
      `UPDATE agent_profile_versions SET rolled_back_at = now()
       WHERE agent_role = $1 AND version > $2 AND rolled_back_at IS NULL`,
      [agentRole, version],
    );
    return this.current(agentRole);
  }
}

/* -------------------------------------------------------------------------- */
/* Nhật ký kiến thức — §149.29                                                 */
/* -------------------------------------------------------------------------- */

export class KnowledgeAuditRepository {
  constructor(private readonly db: Database) {}

  async record(input: {
    actor: string;
    action: string;
    itemId?: Uuid | null;
    department?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_audit_logs (actor, action, item_id, department, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.actor,
        input.action,
        input.itemId ?? null,
        input.department ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async listForItem(itemId: Uuid, limit = 100): Promise<
    Array<{ actor: string; action: string; metadata: Record<string, unknown>; createdAt: string }>
  > {
    return mapRows(
      await this.db.query(
        `SELECT actor, action, metadata, created_at FROM knowledge_audit_logs
         WHERE item_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [itemId, limit],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Gom nhóm                                                                    */
/* -------------------------------------------------------------------------- */

export interface KnowledgeRepositories {
  knowledgeSources: KnowledgeSourceRepository;
  knowledgeCandidates: KnowledgeCandidateRepository;
  knowledgeItems: KnowledgeItemRepository;
  knowledgeReviews: KnowledgeReviewRepository;
  githubRepos: GithubRepoRepository;
  technologyRadar: TechnologyRadarRepository;
  skills: SkillRepository;
  knowledgeMetrics: KnowledgeMetricRepository;
  departmentLevels: DepartmentLevelRepository;
  agentProfiles: AgentProfileRepository;
  knowledgeAudit: KnowledgeAuditRepository;
}

export function createKnowledgeRepositories(db: Database): KnowledgeRepositories {
  return {
    knowledgeSources: new KnowledgeSourceRepository(db),
    knowledgeCandidates: new KnowledgeCandidateRepository(db),
    knowledgeItems: new KnowledgeItemRepository(db),
    knowledgeReviews: new KnowledgeReviewRepository(db),
    githubRepos: new GithubRepoRepository(db),
    technologyRadar: new TechnologyRadarRepository(db),
    skills: new SkillRepository(db),
    knowledgeMetrics: new KnowledgeMetricRepository(db),
    departmentLevels: new DepartmentLevelRepository(db),
    agentProfiles: new AgentProfileRepository(db),
    knowledgeAudit: new KnowledgeAuditRepository(db),
  };
}
