-- =============================================================================
-- P&N — 0002 API Center / Trung tâm tích hợp
-- Spec §44–§56, §61–§67, §69, §70, §76, §81
-- =============================================================================

-- -----------------------------------------------------------------------------
-- secrets — §69: mã hoá khi lưu, không bao giờ để plaintext (§19).
-- Các cột ciphertext chỉ do packages/secrets ghi; không route API nào được
-- select chúng (§88.3, §89).
-- -----------------------------------------------------------------------------
CREATE TABLE secrets (
  ref            text        PRIMARY KEY,
  -- Các thành phần AES-256-GCM, mã hoá base64.
  ciphertext     text        NOT NULL,
  iv             text        NOT NULL,
  auth_tag       text        NOT NULL,
  -- Khoá chính nào đã mã hoá bản ghi này, để việc đổi khoá mã hoá lại được (§70).
  key_version    integer     NOT NULL DEFAULT 1,
  -- An toàn để hiển thị, ví dụ "sk-ant…4f2a".
  preview        text        NOT NULL DEFAULT '',
  environment    text        NOT NULL DEFAULT 'development'
                   CHECK (environment IN ('development','staging','production')),
  rotated_at     timestamptz,
  last_used_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- ai_providers — cấu hình nhà cung cấp AI, §45, §46, §47, §48
-- -----------------------------------------------------------------------------
CREATE TABLE ai_providers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text        NOT NULL CHECK (provider IN ('anthropic','openai','google')),
  display_name   text        NOT NULL,
  is_enabled     boolean     NOT NULL DEFAULT true,
  status         text        NOT NULL DEFAULT 'NOT_CONFIGURED'
                   CHECK (status IN ('NOT_CONFIGURED','CONNECTED','ERROR','DISABLED')),
  -- Chỉ là chuỗi đã mask; key thật nằm ở bảng `secrets` (§47, §88.3).
  key_preview    text,
  secret_ref     text        REFERENCES secrets(ref) ON DELETE SET NULL,
  base_url       text,
  default_model  text,
  last_tested_at timestamptz,
  last_error     text,
  environment    text        NOT NULL DEFAULT 'development'
                   CHECK (environment IN ('development','staging','production')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment)
);

-- -----------------------------------------------------------------------------
-- ai_models — §49 lấy danh sách model + §54 giá do người vận hành nhập
-- -----------------------------------------------------------------------------
CREATE TABLE ai_models (
  id                    text PRIMARY KEY,
  provider              text        NOT NULL,
  display_name          text        NOT NULL,
  tier                  text        NOT NULL CHECK (tier IN ('strong','medium','cheap')),
  context_window        integer     NOT NULL,
  max_output_tokens     integer     NOT NULL,
  input_per_mtok        numeric(10,4),
  output_per_mtok       numeric(10,4),
  cached_input_per_mtok numeric(10,4),
  pricing_source        text        NOT NULL DEFAULT 'seed'
                          CHECK (pricing_source IN ('seed','operator','discovered')),
  pricing_as_of         date,
  is_available          boolean     NOT NULL DEFAULT true,
  discovered_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- model_routes — định tuyến model, §50, §51, §53
-- -----------------------------------------------------------------------------
CREATE TABLE model_routes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_role        text        NOT NULL,
  mode              text        NOT NULL DEFAULT 'balanced'
                      CHECK (mode IN ('quality','balanced','economy','custom')),
  tier              text        NOT NULL CHECK (tier IN ('strong','medium','cheap')),
  provider          text        NOT NULL,
  model             text        NOT NULL,
  -- Mảng có thứ tự [{provider, model}, ...] — §53.
  fallbacks         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  max_input_tokens  integer,
  max_output_tokens integer,
  environment       text        NOT NULL DEFAULT 'development'
                      CHECK (environment IN ('development','staging','production')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_role, environment)
);

-- -----------------------------------------------------------------------------
-- integrations — các kết nối ngoài, §57–§67
-- -----------------------------------------------------------------------------
CREATE TABLE integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text        NOT NULL CHECK (kind IN
                   ('AI_PROVIDER','TELEGRAM','GITHUB','DATABASE','DEPLOYMENT',
                    'APP_STORE_CONNECT','GOOGLE_PLAY','OBJECT_STORAGE','SMTP','WEBHOOK')),
  display_name   text        NOT NULL,
  status         text        NOT NULL DEFAULT 'NOT_CONFIGURED'
                   CHECK (status IN ('NOT_CONFIGURED','CONNECTED','ERROR','DISABLED')),
  is_enabled     boolean     NOT NULL DEFAULT true,
  -- Chỉ chứa cấu hình không nhạy cảm (§19). Secret được tham chiếu, không nhúng.
  settings       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secret_refs    text[]      NOT NULL DEFAULT '{}',
  last_tested_at timestamptz,
  last_error     text,
  environment    text        NOT NULL DEFAULT 'development'
                   CHECK (environment IN ('development','staging','production')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, environment)
);

-- -----------------------------------------------------------------------------
-- budget_policies — chính sách ngân sách, §54, §55, §132
-- -----------------------------------------------------------------------------
CREATE TABLE budget_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope          text        NOT NULL CHECK (scope IN ('GLOBAL','PROJECT','AGENT','RND')),
  scope_id       uuid,
  limit_usd      numeric(12,4) NOT NULL,
  period         text        NOT NULL CHECK (period IN ('DAY','MONTH','PROJECT')),
  warn_threshold numeric(3,2) NOT NULL DEFAULT 0.80,
  -- §55 — tự động tạm dừng agent khi dùng hết 100%.
  hard_stop      boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, period)
);

-- -----------------------------------------------------------------------------
-- api_request_logs — §81. Mặc định KHÔNG lưu nội dung prompt/response
-- (§82 quyền riêng tư prompt); chỉ lưu metadata và thông báo lỗi đã redact.
-- -----------------------------------------------------------------------------
CREATE TABLE api_request_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text        NOT NULL,
  model        text,
  agent_role   text,
  project_id   uuid REFERENCES projects(id) ON DELETE SET NULL,
  task_id      uuid REFERENCES tasks(id)    ON DELETE SET NULL,
  status_code  integer,
  ok           boolean     NOT NULL,
  latency_ms   integer,
  error_kind   text,
  error_text   text,
  retry_count  integer     NOT NULL DEFAULT 0,
  fell_back_to text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_logs_created_idx  ON api_request_logs(created_at DESC);
CREATE INDEX api_request_logs_provider_idx ON api_request_logs(provider, created_at DESC);

-- -----------------------------------------------------------------------------
-- system_settings — §73 trạng thái setup wizard, §76 môi trường, §85 chế độ dev
-- -----------------------------------------------------------------------------
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['secrets','ai_providers','ai_models','model_routes',
                           'integrations','budget_policies','system_settings']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pn_touch_updated_at()',
      t, t);
  END LOOP;
END $$;
