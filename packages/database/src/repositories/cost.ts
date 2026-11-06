/**
 * P&N — Ghi và tổng hợp chi phí AI (§16, §54, §55, §77).
 *
 * `cost_usd` có thể NULL khi model chưa có giá. Mọi phép tổng hợp ở đây dùng
 * `SUM(cost_usd)` nên NULL bị bỏ qua thay vì bị coi là 0, và cột `unpriced_calls`
 * cho biết có bao nhiêu lần gọi chưa tính được tiền — dashboard phải hiển thị
 * con số đó thay vì im lặng báo thiếu.
 */

import type { AiProviderId, CostRecord, Uuid } from '@pn/shared';

import type { Database } from '../pool.js';
import { mapRow, mapRows } from './mapper.js';

export interface CostSummary {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  calls: number;
  /** Số lần gọi chưa có giá model, nên không cộng được vào tổng. */
  unpricedCalls: number;
}

export interface CostBreakdownRow extends CostSummary {
  key: string;
  label: string;
}

const SUMMARY_SELECT = `
  COALESCE(SUM(cost_usd), 0)::float8            AS cost_usd,
  COALESCE(SUM(input_tokens), 0)::int           AS input_tokens,
  COALESCE(SUM(output_tokens), 0)::int          AS output_tokens,
  COALESCE(SUM(cached_tokens), 0)::int          AS cached_tokens,
  COUNT(*)::int                                 AS calls,
  COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unpriced_calls`;

/**
 * Mốc "đếm lại chi phí" (nút Reset chi phí, cho giai đoạn thử
 * nghiệm): mọi con số trên dashboard, ngân sách và bản tin chỉ tính lượt gọi từ
 * mốc này. Lịch sử không bị xoá — tiền đã trả cho nhà cung cấp là thật.
 */
export const COST_COUNT_FROM_KEY = 'cost.countFrom';
const COUNT_FROM = `COALESCE((SELECT (value #>> '{}')::timestamptz FROM system_settings WHERE key = '${COST_COUNT_FROM_KEY}'), 'epoch'::timestamptz)`;

export class CostRepository {
  constructor(private readonly db: Database) {}

  /** §16 — mỗi request AI ghi đúng một bản ghi. */
  async record(input: {
    agentId?: Uuid | null;
    projectId?: Uuid | null;
    taskId?: Uuid | null;
    runId?: Uuid | null;
    provider: AiProviderId;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number | null;
    latencyMs?: number | null;
  }): Promise<CostRecord> {
    const rows = await this.db.query(
      `INSERT INTO cost_records (agent_id, project_id, task_id, run_id, provider, model,
                                 input_tokens, output_tokens, cached_tokens, cost_usd, latency_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.agentId ?? null,
        input.projectId ?? null,
        input.taskId ?? null,
        input.runId ?? null,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.cachedTokens,
        input.costUsd,
        input.latencyMs ?? null,
      ],
    );
    return mapRow<CostRecord>(rows[0]!);
  }

  /**
   * §54 — nhập giá muộn thì tính lại tiền cho những lượt gọi đã ghi null của
   * model đó (kể cả id snapshot có ngày). Trả về phần cộng thêm theo dự án để
   * cập nhật `projects.spent_usd`; không có bước này thì tiền đã tiêu trước lúc
   * nhập giá biến mất khỏi ngân sách mãi mãi.
   */
  async repriceUnpriced(
    modelId: string,
    pricing: { inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok?: number | null },
  ): Promise<Array<{ projectId: Uuid | null; costUsd: number; calls: number }>> {
    const rows = await this.db.query<{ project_id: string | null; cost_usd: string; calls: string }>(
      `WITH priced AS (
         UPDATE cost_records
            SET cost_usd = ROUND(((input_tokens * $2::numeric + output_tokens * $3::numeric
                                   + cached_tokens * $4::numeric) / 1000000)::numeric, 6)
          WHERE cost_usd IS NULL
            AND (model = $1 OR model ~ ('^' || $1 || '-[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
          RETURNING project_id, cost_usd)
       SELECT project_id, SUM(cost_usd)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM priced GROUP BY project_id`,
      [modelId, pricing.inputPerMtok, pricing.outputPerMtok, pricing.cachedInputPerMtok ?? pricing.inputPerMtok],
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      costUsd: Number(row.cost_usd),
      calls: Number(row.calls),
    }));
  }

  /**
   * Đếm lại chi phí từ bây giờ: đặt mốc và đưa số đã tiêu của mọi dự án về 0.
   * Lượt gọi cũ vẫn nằm trong cost_records, chỉ không được đếm nữa.
   */
  async resetCount(updatedBy: string): Promise<string> {
    const at = new Date().toISOString();
    await this.db.query(
      `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [COST_COUNT_FROM_KEY, JSON.stringify(at), updatedBy],
    );
    await this.db.query('UPDATE projects SET spent_usd = 0');
    return at;
  }

  /** Mốc đang đếm chi phí từ đó; `null` là đếm từ đầu. */
  async countFrom(): Promise<string | null> {
    const row = await this.db.one<{ value: string }>('SELECT value FROM system_settings WHERE key = $1', [COST_COUNT_FROM_KEY]);
    return row?.value ?? null;
  }

  /** Tổng chi phí trong hôm nay (§16 "Today"). */
  async today(): Promise<CostSummary> {
    const row = await this.db.one(
      `SELECT ${SUMMARY_SELECT} FROM cost_records WHERE created_at >= GREATEST(date_trunc('day', now()), ${COUNT_FROM})`,
    );
    return mapRow<CostSummary>(row!);
  }

  /** Tổng chi phí trong tháng hiện tại (§16 "Month"). */
  async thisMonth(): Promise<CostSummary> {
    const row = await this.db.one(
      `SELECT ${SUMMARY_SELECT} FROM cost_records WHERE created_at >= GREATEST(date_trunc('month', now()), ${COUNT_FROM})`,
    );
    return mapRow<CostSummary>(row!);
  }

  async forProject(projectId: Uuid): Promise<CostSummary> {
    const row = await this.db.one(`SELECT ${SUMMARY_SELECT} FROM cost_records WHERE project_id = $1 AND created_at >= ${COUNT_FROM}`, [
      projectId,
    ]);
    return mapRow<CostSummary>(row!);
  }

  /** §16 — bóc tách theo dự án / agent / model / provider cho dashboard. */
  async breakdown(
    dimension: 'project' | 'agent' | 'model' | 'provider',
    since?: Date,
  ): Promise<CostBreakdownRow[]> {
    // Mỗi chiều có cách lấy nhãn riêng; join để dashboard hiện tên chứ không hiện uuid.
    // Nhãn dự phòng viết thẳng trong SQL để thứ tự tham số không phụ thuộc `since`.
    const dimensions = {
      project: {
        key: 'c.project_id::text',
        label: "COALESCE(p.name, '(không thuộc dự án)')",
        join: 'LEFT JOIN projects p ON p.id = c.project_id',
      },
      agent: {
        key: 'c.agent_id::text',
        label: "COALESCE(a.display_name, '(không thuộc agent)')",
        join: 'LEFT JOIN agents a ON a.id = c.agent_id',
      },
      model: { key: 'c.model', label: 'c.model', join: '' },
      provider: { key: 'c.provider', label: 'c.provider', join: '' },
    } as const;

    const dim = dimensions[dimension];
    const rows = await this.db.query(
      `SELECT ${dim.key} AS key, ${dim.label} AS label, ${SUMMARY_SELECT}
       FROM cost_records c ${dim.join} WHERE c.created_at >= ${COUNT_FROM} ${since ? 'AND c.created_at >= $1' : ''}
       GROUP BY ${dim.key}, ${dim.label}
       ORDER BY cost_usd DESC`,
      since ? [since] : [],
    );
    return mapRows<CostBreakdownRow>(rows);
  }

  /** Chuỗi chi phí theo ngày, dùng vẽ biểu đồ xu hướng. */
  async daily(days = 30): Promise<Array<{ day: string; costUsd: number; calls: number }>> {
    const rows = await this.db.query<{ day: Date; cost_usd: number; calls: number }>(
      `SELECT date_trunc('day', created_at) AS day,
              COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
              COUNT(*)::int AS calls
       FROM cost_records
       WHERE created_at >= now() - ($1 || ' days')::interval AND created_at >= ${COUNT_FROM}
       GROUP BY 1 ORDER BY 1`,
      [days],
    );
    return rows.map((row) => ({
      day: row.day.toISOString().slice(0, 10),
      costUsd: row.cost_usd,
      calls: row.calls,
    }));
  }

  async listRecent(limit = 100): Promise<CostRecord[]> {
    return mapRows<CostRecord>(
      await this.db.query('SELECT * FROM cost_records ORDER BY created_at DESC LIMIT $1', [limit]),
    );
  }

  /**
   * Token và tiền theo vai trò từ mốc `since` — số liệu cho phân bổ model. Cố ý KHÔNG theo mốc "đếm lại chi
   * phí": phân tích cần biết vai trò nào thật sự ngốn token, không phải tiền tính vào hạn mức.
   */
  async byRole(since: Date): Promise<Array<{ role: string; calls: number; tokens: number; costUsd: number }>> {
    const rows = await this.db.query<{ role: string; calls: number; tokens: string; cost_usd: number }>(
      `SELECT a.role, COUNT(*)::int AS calls, COALESCE(SUM(c.input_tokens + c.output_tokens), 0)::bigint AS tokens,
              COALESCE(SUM(c.cost_usd), 0)::float8 AS cost_usd
       FROM cost_records c JOIN agents a ON a.id = c.agent_id
       WHERE c.created_at >= $1 GROUP BY a.role`,
      [since],
    );
    return rows.map((row) => ({ role: row.role, calls: row.calls, tokens: Number(row.tokens), costUsd: row.cost_usd }));
  }

  /**
   * Toàn cảnh chi phí tháng hiện tại cho trang Ngân sách: tổng cả tháng, theo ngày × hãng, theo hãng, theo vai
   * trò và phần không gắn nhân viên. Tính cả tháng (không theo mốc đếm lại) để CEO thấy tiền thật đã trả;
   * con số tính vào hạn mức lấy từ `BudgetRepository.globalStatus`.
   */
  async monthOverview(): Promise<{
    monthStart: string;
    costUsd: number;
    calls: number;
    daily: Array<{ day: string; provider: string; costUsd: number; calls: number }>;
    byProvider: Array<{ provider: string; costUsd: number; calls: number }>;
    byRole: Array<{ role: string; costUsd: number; calls: number }>;
    unassigned: { costUsd: number; calls: number };
  }> {
    const MONTH = "date_trunc('month', now())";
    const [total, daily, byProvider, byRole, unassigned] = await Promise.all([
      this.db.one<{ month_start: Date; cost_usd: number; calls: number }>(
        `SELECT ${MONTH} AS month_start, COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM cost_records WHERE created_at >= ${MONTH}`,
      ),
      this.db.query<{ day: string; provider: string; cost_usd: number; calls: number }>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, provider,
                COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM cost_records WHERE created_at >= ${MONTH} GROUP BY 1, 2 ORDER BY 1`,
      ),
      this.db.query<{ provider: string; cost_usd: number; calls: number }>(
        `SELECT provider, COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM cost_records WHERE created_at >= ${MONTH} GROUP BY provider ORDER BY 2 DESC`,
      ),
      this.db.query<{ role: string; cost_usd: number; calls: number }>(
        `SELECT a.role, COALESCE(SUM(c.cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM cost_records c JOIN agents a ON a.id = c.agent_id
         WHERE c.created_at >= ${MONTH} GROUP BY a.role ORDER BY 2 DESC`,
      ),
      this.db.one<{ cost_usd: number; calls: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
         FROM cost_records WHERE created_at >= ${MONTH} AND agent_id IS NULL`,
      ),
    ]);
    return {
      monthStart: total!.month_start.toISOString(),
      costUsd: total!.cost_usd,
      calls: total!.calls,
      daily: daily.map((row) => ({ day: row.day, provider: row.provider, costUsd: row.cost_usd, calls: row.calls })),
      byProvider: byProvider.map((row) => ({ provider: row.provider, costUsd: row.cost_usd, calls: row.calls })),
      byRole: byRole.map((row) => ({ role: row.role, costUsd: row.cost_usd, calls: row.calls })),
      unassigned: { costUsd: unassigned!.cost_usd, calls: unassigned!.calls },
    };
  }

  /** Tổng tiền thật đã tiêu của từng dự án từ trước tới nay (không theo mốc đếm lại). */
  async projectTotals(): Promise<Array<{ projectId: string; costUsd: number; calls: number }>> {
    const rows = await this.db.query<{ project_id: string; cost_usd: number; calls: number }>(
      `SELECT project_id, COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd, COUNT(*)::int AS calls
       FROM cost_records WHERE project_id IS NOT NULL GROUP BY project_id`,
    );
    return rows.map((row) => ({ projectId: row.project_id, costUsd: row.cost_usd, calls: row.calls }));
  }
}

/* -------------------------------------------------------------------------- */
/* Chính sách ngân sách — §54, §55                                             */
/* -------------------------------------------------------------------------- */

export interface BudgetStatus {
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  /** Đã vượt ngưỡng cảnh báo (mặc định 80%) — §54. */
  warned: boolean;
  /** Đã chạm hoặc vượt trần — §55. */
  exceeded: boolean;
  hardStop: boolean;
}

export class BudgetRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    scope: 'GLOBAL' | 'PROJECT' | 'AGENT' | 'RND';
    scopeId?: Uuid | null;
    limitUsd: number;
    period: 'DAY' | 'MONTH' | 'PROJECT';
    warnThreshold?: number;
    hardStop?: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO budget_policies (scope, scope_id, limit_usd, period, warn_threshold, hard_stop)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (scope, scope_id, period) DO UPDATE
         SET limit_usd = EXCLUDED.limit_usd,
             warn_threshold = EXCLUDED.warn_threshold,
             hard_stop = EXCLUDED.hard_stop`,
      [
        input.scope,
        input.scopeId ?? null,
        input.limitUsd,
        input.period,
        input.warnThreshold ?? 0.8,
        input.hardStop ?? true,
      ],
    );
  }

  async list(): Promise<
    Array<{
      id: Uuid;
      scope: string;
      scopeId: Uuid | null;
      limitUsd: number;
      period: string;
      warnThreshold: number;
      hardStop: boolean;
    }>
  > {
    return mapRows(await this.db.query('SELECT * FROM budget_policies ORDER BY scope, period'));
  }

  /**
   * §54, §55 — tính trạng thái ngân sách của một dự án. Chỉ dùng `cost_records`
   * làm nguồn chi tiêu để con số luôn khớp với dashboard.
   */
  async projectStatus(projectId: Uuid): Promise<BudgetStatus | null> {
    const row = await this.db.one<{
      limit_usd: string;
      warn_threshold: string;
      hard_stop: boolean;
      spent_usd: number;
    }>(
      `SELECT COALESCE(b.limit_usd, p.budget_usd) AS limit_usd,
              COALESCE(b.warn_threshold, 0.8)     AS warn_threshold,
              COALESCE(b.hard_stop, true)         AS hard_stop,
              COALESCE((SELECT SUM(cost_usd) FROM cost_records WHERE project_id = p.id AND created_at >= ${COUNT_FROM}), 0)::float8
                AS spent_usd
       FROM projects p
       LEFT JOIN budget_policies b
         ON b.scope = 'PROJECT' AND b.scope_id = p.id
       WHERE p.id = $1`,
      [projectId],
    );
    if (!row) return null;

    const limitUsd = Number(row.limit_usd);
    const warnThreshold = Number(row.warn_threshold);
    const spentUsd = row.spent_usd;
    const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;

    return {
      limitUsd,
      spentUsd,
      ratio,
      warned: ratio >= warnThreshold,
      exceeded: ratio >= 1,
      hardStop: row.hard_stop,
    };
  }

  /** Ngân sách toàn hệ thống theo kỳ, dùng cho chặn ở AI Gateway. */
  async globalStatus(period: 'DAY' | 'MONTH'): Promise<BudgetStatus | null> {
    const row = await this.db.one<{
      limit_usd: string;
      warn_threshold: string;
      hard_stop: boolean;
    }>(
      "SELECT limit_usd, warn_threshold, hard_stop FROM budget_policies WHERE scope = 'GLOBAL' AND period = $1",
      [period],
    );
    if (!row) return null;

    const bucket = period === 'DAY' ? 'day' : 'month';
    const spent = await this.db.one<{ spent: number }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent FROM cost_records
       WHERE created_at >= GREATEST(date_trunc('${bucket}', now()), ${COUNT_FROM})`,
    );

    const limitUsd = Number(row.limit_usd);
    const spentUsd = spent?.spent ?? 0;
    const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;

    return {
      limitUsd,
      spentUsd,
      ratio,
      warned: ratio >= Number(row.warn_threshold),
      exceeded: ratio >= 1,
      hardStop: row.hard_stop,
    };
  }
}
