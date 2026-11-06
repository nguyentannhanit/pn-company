/**
 * P&N — Repository cho API Center (§44–§56, §69, §81, §85).
 *
 * Quy tắc xuyên suốt file: không câu lệnh nào ở đây SELECT cột ciphertext ra
 * ngoài phạm vi `PostgresSecretStorage`. Cấu hình provider chỉ trả `key_preview`
 * (§88.3, §89).
 */

import type {
  AiProviderId,
  Environment,
  IntegrationConfig,
  IntegrationKind,
  IntegrationStatus,
  ModelRoute,
  ModelTier,
  ProviderConfig,
  RoutingMode,
} from '@pn/shared';
import type { EncryptedSecret, SecretStorage } from '@pn/secrets';

import type { Database } from '../pool.js';
import { mapMaybe, mapRow, mapRows } from './mapper.js';

/* -------------------------------------------------------------------------- */
/* Kho secret trên Postgres — §69                                              */
/* -------------------------------------------------------------------------- */

type StoredSecret = EncryptedSecret & { environment: string };

/**
 * Hiện thực `SecretStorage` bằng bảng `secrets`. Đây là nơi duy nhất trong hệ
 * thống được phép đọc/ghi cột ciphertext.
 */
export class PostgresSecretStorage implements SecretStorage {
  constructor(private readonly db: Database) {}

  async put(secret: StoredSecret): Promise<void> {
    await this.db.query(
      `INSERT INTO secrets (ref, ciphertext, iv, auth_tag, key_version, preview, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ref) DO UPDATE
         SET ciphertext  = EXCLUDED.ciphertext,
             iv          = EXCLUDED.iv,
             auth_tag    = EXCLUDED.auth_tag,
             key_version = EXCLUDED.key_version,
             preview     = EXCLUDED.preview,
             rotated_at  = now()`,
      [
        secret.ref,
        secret.ciphertext,
        secret.iv,
        secret.authTag,
        secret.keyVersion,
        secret.preview,
        secret.environment,
      ],
    );
  }

  async get(ref: string): Promise<StoredSecret | null> {
    const row = await this.db.one<{
      ref: string;
      ciphertext: string;
      iv: string;
      auth_tag: string;
      key_version: number;
      preview: string;
      environment: string;
    }>(
      'SELECT ref, ciphertext, iv, auth_tag, key_version, preview, environment FROM secrets WHERE ref = $1',
      [ref],
    );
    if (!row) return null;
    return {
      ref: row.ref,
      ciphertext: row.ciphertext,
      iv: row.iv,
      authTag: row.auth_tag,
      keyVersion: row.key_version,
      preview: row.preview,
      environment: row.environment,
    };
  }

  async delete(ref: string): Promise<void> {
    await this.db.query('DELETE FROM secrets WHERE ref = $1', [ref]);
  }

  /** Không trả ciphertext — chỉ metadata đủ để hiển thị và để rotation lặp qua. */
  async list(): Promise<Array<{ ref: string; preview: string; keyVersion: number; environment: string }>> {
    const rows = await this.db.query<{
      ref: string;
      preview: string;
      key_version: number;
      environment: string;
    }>('SELECT ref, preview, key_version, environment FROM secrets ORDER BY ref');
    return rows.map((row) => ({
      ref: row.ref,
      preview: row.preview,
      keyVersion: row.key_version,
      environment: row.environment,
    }));
  }

  async markUsed(ref: string): Promise<void> {
    await this.db.query('UPDATE secrets SET last_used_at = now() WHERE ref = $1', [ref]);
  }
}

/* -------------------------------------------------------------------------- */
/* Nhà cung cấp AI — §45, §47, §48                                             */
/* -------------------------------------------------------------------------- */

/** Danh sách cột an toàn để trả ra API: không có ciphertext, không có key thật. */
const PROVIDER_COLUMNS = `id, provider, display_name, is_enabled, status, key_preview,
  secret_ref, base_url, default_model, last_tested_at, last_error, environment,
  created_at, updated_at`;

export class ProviderRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    provider: AiProviderId;
    displayName: string;
    isEnabled: boolean;
    environment: Environment;
    keyPreview?: string | null;
    secretRef?: string | null;
    baseUrl?: string | null;
    defaultModel?: string | null;
  }): Promise<ProviderConfig> {
    // Dán key MỚI thì xoá luôn kết quả kiểm tra của key cũ. Thiếu đoạn này thì
    // người dùng thay key hỏng bằng key đúng xong vẫn thấy nguyên câu lỗi cũ
    // trên màn hình, và tưởng là hệ thống chưa nhận key mới.
    const rows = await this.db.query(
      `INSERT INTO ai_providers (provider, display_name, is_enabled, environment,
                                 key_preview, secret_ref, base_url, default_model, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'NOT_CONFIGURED')
       ON CONFLICT (provider, environment) DO UPDATE
         SET display_name   = EXCLUDED.display_name,
             is_enabled     = EXCLUDED.is_enabled,
             key_preview    = COALESCE(EXCLUDED.key_preview, ai_providers.key_preview),
             secret_ref     = COALESCE(EXCLUDED.secret_ref, ai_providers.secret_ref),
             base_url       = EXCLUDED.base_url,
             default_model  = EXCLUDED.default_model,
             status         = CASE WHEN EXCLUDED.secret_ref IS NULL
                                   THEN ai_providers.status ELSE 'NOT_CONFIGURED' END,
             last_error     = CASE WHEN EXCLUDED.secret_ref IS NULL
                                   THEN ai_providers.last_error ELSE NULL END,
             last_tested_at = CASE WHEN EXCLUDED.secret_ref IS NULL
                                   THEN ai_providers.last_tested_at ELSE NULL END
       RETURNING ${PROVIDER_COLUMNS}`,
      [
        input.provider,
        input.displayName,
        input.isEnabled,
        input.environment,
        input.keyPreview ?? null,
        input.secretRef ?? null,
        input.baseUrl ?? null,
        input.defaultModel ?? null,
      ],
    );
    return mapRow<ProviderConfig>(rows[0]!);
  }

  /** §48 — ghi kết quả Test Connection thật; lỗi lưu ở dạng đã redact. */
  async recordTest(
    provider: AiProviderId,
    environment: Environment,
    result: { ok: boolean; error?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE ai_providers SET status = $3, last_tested_at = now(), last_error = $4
       WHERE provider = $1 AND environment = $2`,
      [provider, environment, result.ok ? 'CONNECTED' : 'ERROR', result.error ?? null],
    );
  }

  /**
   * Xoá key khỏi cấu hình (thêm vào rồi không gỡ ra được). Tắt luôn hãng và xoá kết quả
   * kiểm tra cũ; ciphertext trong kho secret do route xoá riêng. Trả null nếu hãng chưa từng cấu hình.
   */
  async clearKey(provider: AiProviderId, environment: Environment): Promise<ProviderConfig | null> {
    return mapMaybe<ProviderConfig>(
      await this.db.one(
        `UPDATE ai_providers SET secret_ref = NULL, key_preview = NULL, is_enabled = false,
                status = 'NOT_CONFIGURED', last_error = NULL, last_tested_at = NULL
         WHERE provider = $1 AND environment = $2
         RETURNING ${PROVIDER_COLUMNS}`,
        [provider, environment],
      ),
    );
  }

  async setEnabled(provider: AiProviderId, environment: Environment, isEnabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE ai_providers SET is_enabled = $3,
              status = CASE WHEN $3 THEN 'NOT_CONFIGURED' ELSE 'DISABLED' END
       WHERE provider = $1 AND environment = $2`,
      [provider, environment, isEnabled],
    );
  }

  async find(provider: AiProviderId, environment: Environment): Promise<ProviderConfig | null> {
    return mapMaybe<ProviderConfig>(
      await this.db.one(
        `SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE provider = $1 AND environment = $2`,
        [provider, environment],
      ),
    );
  }

  async list(environment: Environment): Promise<ProviderConfig[]> {
    return mapRows<ProviderConfig>(
      await this.db.query(
        `SELECT ${PROVIDER_COLUMNS} FROM ai_providers WHERE environment = $1 ORDER BY provider`,
        [environment],
      ),
    );
  }

  /** Các provider đã bật và đã có key — dùng lúc khởi động để nạp client. */
  async listReady(environment: Environment): Promise<ProviderConfig[]> {
    return mapRows<ProviderConfig>(
      await this.db.query(
        `SELECT ${PROVIDER_COLUMNS} FROM ai_providers
         WHERE environment = $1 AND is_enabled = true
           AND (secret_ref IS NOT NULL OR provider IN ('claude-code', 'codex'))
         ORDER BY provider`,
        [environment],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Danh mục model — §49, §54                                                   */
/* -------------------------------------------------------------------------- */

export interface StoredModel {
  id: string;
  provider: AiProviderId;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cachedInputPerMtok: number | null;
  pricingSource: 'seed' | 'operator' | 'discovered';
  pricingAsOf: string | null;
  isAvailable: boolean;
}

export class ModelRepository {
  constructor(private readonly db: Database) {}

  /**
   * §49 + §54 — ghi model phát hiện được, nhưng giữ nguyên giá nếu người vận
   * hành đã tự nhập (`pricing_source = 'operator'`).
   */
  async upsertMany(models: StoredModel[]): Promise<void> {
    if (models.length === 0) return;
    await this.db.transaction(async (client) => {
      for (const model of models) {
        await client.query(
          `INSERT INTO ai_models (id, provider, display_name, tier, context_window, max_output_tokens,
                                  input_per_mtok, output_per_mtok, cached_input_per_mtok,
                                  pricing_source, pricing_as_of, is_available, discovered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,now())
           ON CONFLICT (id) DO UPDATE SET
             display_name      = EXCLUDED.display_name,
             context_window    = EXCLUDED.context_window,
             max_output_tokens = EXCLUDED.max_output_tokens,
             is_available      = true,
             discovered_at     = now(),
             input_per_mtok = CASE WHEN ai_models.pricing_source = 'operator'
                                   THEN ai_models.input_per_mtok ELSE EXCLUDED.input_per_mtok END,
             output_per_mtok = CASE WHEN ai_models.pricing_source = 'operator'
                                    THEN ai_models.output_per_mtok ELSE EXCLUDED.output_per_mtok END,
             cached_input_per_mtok = CASE WHEN ai_models.pricing_source = 'operator'
                                          THEN ai_models.cached_input_per_mtok
                                          ELSE EXCLUDED.cached_input_per_mtok END,
             pricing_source = CASE WHEN ai_models.pricing_source = 'operator'
                                   THEN 'operator' ELSE EXCLUDED.pricing_source END`,
          [
            model.id,
            model.provider,
            model.displayName,
            model.tier,
            model.contextWindow,
            model.maxOutputTokens,
            model.inputPerMtok,
            model.outputPerMtok,
            model.cachedInputPerMtok,
            model.pricingSource,
            model.pricingAsOf,
          ],
        );
      }
    });
  }

  /** §54 — người vận hành nhập giá; từ đó discovery không ghi đè nữa. */
  async setPricing(
    modelId: string,
    pricing: { inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok?: number | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE ai_models SET input_per_mtok = $2, output_per_mtok = $3, cached_input_per_mtok = $4,
              pricing_source = 'operator', pricing_as_of = current_date
       WHERE id = $1`,
      [modelId, pricing.inputPerMtok, pricing.outputPerMtok, pricing.cachedInputPerMtok ?? null],
    );
  }

  async list(provider?: AiProviderId): Promise<StoredModel[]> {
    if (provider) {
      return mapRows<StoredModel>(
        await this.db.query('SELECT * FROM ai_models WHERE provider = $1 ORDER BY tier, id', [provider]),
      );
    }
    return mapRows<StoredModel>(
      await this.db.query('SELECT * FROM ai_models ORDER BY provider, tier, id'),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Định tuyến model — §50, §51, §53                                            */
/* -------------------------------------------------------------------------- */

const ROUTE_COLUMNS = `id, agent_role, mode, tier, provider, model, fallbacks,
  max_input_tokens, max_output_tokens, environment, created_at, updated_at`;

export class RouteRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    agentRole: ModelRoute['agentRole'];
    mode: RoutingMode;
    tier: ModelTier;
    provider: AiProviderId;
    model: string;
    fallbacks: Array<{ provider: AiProviderId; model: string }>;
    maxInputTokens?: number | null;
    maxOutputTokens?: number | null;
    environment: Environment;
  }): Promise<ModelRoute> {
    const rows = await this.db.query(
      `INSERT INTO model_routes (agent_role, mode, tier, provider, model, fallbacks,
                                 max_input_tokens, max_output_tokens, environment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (agent_role, environment) DO UPDATE
         SET mode = EXCLUDED.mode, tier = EXCLUDED.tier, provider = EXCLUDED.provider,
             model = EXCLUDED.model, fallbacks = EXCLUDED.fallbacks,
             max_input_tokens = EXCLUDED.max_input_tokens,
             max_output_tokens = EXCLUDED.max_output_tokens
       RETURNING ${ROUTE_COLUMNS}`,
      [
        input.agentRole,
        input.mode,
        input.tier,
        input.provider,
        input.model,
        JSON.stringify(input.fallbacks),
        input.maxInputTokens ?? null,
        input.maxOutputTokens ?? null,
        input.environment,
      ],
    );
    return mapRow<ModelRoute>(rows[0]!);
  }

  async list(environment: Environment): Promise<ModelRoute[]> {
    return mapRows<ModelRoute>(
      await this.db.query(
        `SELECT ${ROUTE_COLUMNS} FROM model_routes WHERE environment = $1 ORDER BY agent_role`,
        [environment],
      ),
    );
  }

  async find(agentRole: ModelRoute['agentRole'], environment: Environment): Promise<ModelRoute | null> {
    return mapMaybe<ModelRoute>(
      await this.db.one(
        `SELECT ${ROUTE_COLUMNS} FROM model_routes WHERE agent_role = $1 AND environment = $2`,
        [agentRole, environment],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tích hợp ngoài — §57–§67                                                    */
/* -------------------------------------------------------------------------- */

const INTEGRATION_COLUMNS = `id, kind, display_name, status, is_enabled, settings,
  secret_refs, last_tested_at, last_error, environment, created_at, updated_at`;

export class IntegrationRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: {
    kind: IntegrationKind;
    displayName: string;
    isEnabled: boolean;
    settings: Record<string, unknown>;
    secretRefs: string[];
    environment: Environment;
  }): Promise<IntegrationConfig> {
    const rows = await this.db.query(
      `INSERT INTO integrations (kind, display_name, is_enabled, settings, secret_refs, environment)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (kind, environment) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             is_enabled   = EXCLUDED.is_enabled,
             settings     = EXCLUDED.settings,
             secret_refs  = EXCLUDED.secret_refs
       RETURNING ${INTEGRATION_COLUMNS}`,
      [
        input.kind,
        input.displayName,
        input.isEnabled,
        JSON.stringify(input.settings),
        input.secretRefs,
        input.environment,
      ],
    );
    return mapRow<IntegrationConfig>(rows[0]!);
  }

  async recordTest(
    kind: IntegrationKind,
    environment: Environment,
    result: { ok: boolean; error?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE integrations SET status = $3, last_tested_at = now(), last_error = $4
       WHERE kind = $1 AND environment = $2`,
      [kind, environment, result.ok ? 'CONNECTED' : 'ERROR', result.error ?? null],
    );
  }

  async find(kind: IntegrationKind, environment: Environment): Promise<IntegrationConfig | null> {
    return mapMaybe<IntegrationConfig>(
      await this.db.one(
        `SELECT ${INTEGRATION_COLUMNS} FROM integrations WHERE kind = $1 AND environment = $2`,
        [kind, environment],
      ),
    );
  }

  async list(environment: Environment): Promise<IntegrationConfig[]> {
    return mapRows<IntegrationConfig>(
      await this.db.query(
        `SELECT ${INTEGRATION_COLUMNS} FROM integrations WHERE environment = $1 ORDER BY kind`,
        [environment],
      ),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Log gọi provider — §81                                                      */
/* -------------------------------------------------------------------------- */

export class ApiRequestLogRepository {
  constructor(private readonly db: Database) {}

  /** §82 — chỉ ghi metadata, không ghi nội dung prompt/response. */
  async record(input: {
    provider: string;
    model?: string | null;
    agentRole?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    statusCode?: number | null;
    ok: boolean;
    latencyMs?: number | null;
    errorKind?: string | null;
    errorText?: string | null;
    retryCount?: number;
    fellBackTo?: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO api_request_logs (provider, model, agent_role, project_id, task_id,
                                     status_code, ok, latency_ms, error_kind, error_text,
                                     retry_count, fell_back_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.provider,
        input.model ?? null,
        input.agentRole ?? null,
        input.projectId ?? null,
        input.taskId ?? null,
        input.statusCode ?? null,
        input.ok,
        input.latencyMs ?? null,
        input.errorKind ?? null,
        input.errorText ?? null,
        input.retryCount ?? 0,
        input.fellBackTo ?? null,
      ],
    );
  }

  /** §68, §77 — tỉ lệ lỗi và độ trễ theo provider trong N giờ gần nhất. */
  async health(hours = 24): Promise<
    Array<{ provider: string; calls: number; failures: number; p95LatencyMs: number | null }>
  > {
    const rows = await this.db.query<{
      provider: string;
      calls: number;
      failures: number;
      p95: number | null;
    }>(
      `SELECT provider,
              COUNT(*)::int                              AS calls,
              COUNT(*) FILTER (WHERE NOT ok)::int        AS failures,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
       FROM api_request_logs
       WHERE created_at >= now() - ($1 || ' hours')::interval
       GROUP BY provider`,
      [hours],
    );
    return rows.map((row) => ({
      provider: row.provider,
      calls: row.calls,
      failures: row.failures,
      p95LatencyMs: row.p95,
    }));
  }

  /** Lượt gọi, lượt thành công và độ trễ trung bình theo vai trò từ mốc `since` — số liệu cho phân bổ model. */
  async byRole(since: Date): Promise<Array<{ role: string; calls: number; ok: number; avgLatencyMs: number | null }>> {
    const rows = await this.db.query<{ role: string; calls: number; ok: number; avg: number | null }>(
      `SELECT agent_role AS role, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE ok)::int AS ok,
              AVG(latency_ms)::float8 AS avg
       FROM api_request_logs WHERE created_at >= $1 AND agent_role IS NOT NULL
       GROUP BY agent_role`,
      [since],
    );
    return rows.map((row) => ({ role: row.role, calls: row.calls, ok: row.ok, avgLatencyMs: row.avg === null ? null : Math.round(row.avg) }));
  }

  /** Như `byRole` nhưng theo hãng — thẻ chi tiết từng nguồn AI trên trang Cài đặt. */
  async byProvider(since: Date): Promise<Array<{ provider: string; calls: number; ok: number; avgLatencyMs: number | null }>> {
    const rows = await this.db.query<{ provider: string; calls: number; ok: number; avg: number | null }>(
      `SELECT provider, COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE ok)::int AS ok, AVG(latency_ms)::float8 AS avg
       FROM api_request_logs WHERE created_at >= $1 GROUP BY provider`,
      [since],
    );
    return rows.map((row) => ({ provider: row.provider, calls: row.calls, ok: row.ok, avgLatencyMs: row.avg === null ? null : Math.round(row.avg) }));
  }

  /** Lượt hỏng theo loại lỗi — để nói rõ lỗi do hãng (quá tải, giới hạn) hay do nội dung. */
  async errorKinds(since: Date): Promise<Array<{ kind: string; count: number }>> {
    const rows = await this.db.query<{ kind: string | null; count: number }>(
      `SELECT error_kind AS kind, COUNT(*)::int AS count
       FROM api_request_logs WHERE created_at >= $1 AND NOT ok GROUP BY error_kind ORDER BY 2 DESC`,
      [since],
    );
    return rows.map((row) => ({ kind: row.kind ?? 'unknown', count: row.count }));
  }
}

/* -------------------------------------------------------------------------- */
/* Cấu hình hệ thống — §73, §76, §85                                           */
/* -------------------------------------------------------------------------- */

export class SettingsRepository {
  constructor(private readonly db: Database) {}

  async get<T = unknown>(key: string): Promise<T | null> {
    const row = await this.db.one<{ value: T }>('SELECT value FROM system_settings WHERE key = $1', [key]);
    return row ? row.value : null;
  }

  async set(key: string, value: unknown, updatedBy?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), updatedBy ?? null],
    );
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.query<{ key: string; value: unknown }>(
      'SELECT key, value FROM system_settings',
    );
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }
}

/** Khoá cấu hình dùng chung, tránh mỗi nơi gõ một chuỗi khác nhau. */
export const SETTING_KEYS = {
  setupCompleted: 'setup.completed',
  routingMode: 'routing.mode',
  smartRouting: 'routing.smart',
  environment: 'system.environment',
} as const;

export interface ApiCenterRepositories {
  providers: ProviderRepository;
  models: ModelRepository;
  routes: RouteRepository;
  integrations: IntegrationRepository;
  requestLogs: ApiRequestLogRepository;
  settings: SettingsRepository;
  secretStorage: PostgresSecretStorage;
}

export function createApiCenterRepositories(db: Database): ApiCenterRepositories {
  return {
    providers: new ProviderRepository(db),
    models: new ModelRepository(db),
    routes: new RouteRepository(db),
    integrations: new IntegrationRepository(db),
    requestLogs: new ApiRequestLogRepository(db),
    settings: new SettingsRepository(db),
    secretStorage: new PostgresSecretStorage(db),
  };
}

export type { IntegrationStatus };
