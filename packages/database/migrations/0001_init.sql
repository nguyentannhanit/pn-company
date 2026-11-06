-- =============================================================================
-- P&N — 0001 schema lõi
-- Spec §14 (danh sách bảng), §12, §13, §16, §17, §18, §20, §27, §28
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Giữ updated_at luôn đúng mà không phụ thuộc tầng ứng dụng.
CREATE OR REPLACE FUNCTION pn_touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- -----------------------------------------------------------------------------
-- users — người dùng, §14, §20
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text        NOT NULL,
  password_hash    text        NOT NULL,
  display_name     text        NOT NULL,
  role             text        NOT NULL CHECK (role IN ('CEO','CTO','AGENT','VIEWER','SYSTEM')),
  telegram_chat_id text,
  is_active        boolean     NOT NULL DEFAULT true,
  last_login_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- Duy nhất không phân biệt hoa thường mà không cần extension citext.
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- -----------------------------------------------------------------------------
-- projects — dự án, §12, §92
-- -----------------------------------------------------------------------------
CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  slug           text        NOT NULL UNIQUE,
  description    text        NOT NULL DEFAULT '',
  product_type   text        NOT NULL CHECK (product_type IN
                   ('CORPORATE_WEBSITE','WEB_APPLICATION','MOBILE_APPLICATION','LANDING_PAGE')),
  status         text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                   ('DRAFT','PLANNING','IN_PROGRESS','BLOCKED','REVIEW','DEPLOYING',
                    'COMPLETED','ARCHIVED','PAUSED_BUDGET')),
  owner_id       uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  repo_full_name text,
  default_branch text        NOT NULL DEFAULT 'main',
  budget_usd     numeric(12,4) NOT NULL DEFAULT 20,
  spent_usd      numeric(12,6) NOT NULL DEFAULT 0,
  started_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_status_idx ON projects(status);
CREATE INDEX projects_owner_idx  ON projects(owner_id);

-- -----------------------------------------------------------------------------
-- agents — nhân sự AI, §3, §8, §9
-- -----------------------------------------------------------------------------
CREATE TABLE agents (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role               text        NOT NULL,
  display_name       text        NOT NULL,
  department         text        NOT NULL,
  -- §9: cột này CHÍNH LÀ nguồn chân lý cho animation 3D.
  state              text        NOT NULL DEFAULT 'idle' CHECK (state IN
                       ('idle','working','reviewing','meeting','blocked','alert',
                        'completed','celebrate','offline')),
  current_task_id    uuid,
  current_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  is_enabled         boolean     NOT NULL DEFAULT true,
  profile_version    integer     NOT NULL DEFAULT 1,
  xp                 integer     NOT NULL DEFAULT 0,
  state_changed_at   timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role)
);
CREATE INDEX agents_state_idx ON agents(state);

-- -----------------------------------------------------------------------------
-- tasks — công việc, §13
-- -----------------------------------------------------------------------------
CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title             text        NOT NULL,
  description       text        NOT NULL DEFAULT '',
  status            text        NOT NULL DEFAULT 'BACKLOG' CHECK (status IN
                      ('BACKLOG','TODO','IN_PROGRESS','REVIEW','BLOCKED','DONE','CANCELLED')),
  priority          text        NOT NULL DEFAULT 'MEDIUM' CHECK (priority IN
                      ('LOW','MEDIUM','HIGH','CRITICAL')),
  assigned_role     text,
  assigned_agent_id uuid        REFERENCES agents(id) ON DELETE SET NULL,
  parent_task_id    uuid        REFERENCES tasks(id) ON DELETE SET NULL,
  estimate_minutes  integer,
  started_at        timestamptz,
  completed_at      timestamptz,
  -- §43.6 — vòng sửa lỗi QA có giới hạn.
  fix_loop_count    integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_project_idx ON tasks(project_id);
CREATE INDEX tasks_status_idx  ON tasks(project_id, status);
CREATE INDEX tasks_agent_idx   ON tasks(assigned_agent_id);

ALTER TABLE agents
  ADD CONSTRAINT agents_current_task_fk
  FOREIGN KEY (current_task_id) REFERENCES tasks(id) ON DELETE SET NULL;

CREATE TABLE task_dependencies (
  task_id            uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

-- -----------------------------------------------------------------------------
-- agent_runs — mỗi lần agent chạy, §18
-- -----------------------------------------------------------------------------
CREATE TABLE agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id       uuid        REFERENCES tasks(id) ON DELETE SET NULL,
  project_id    uuid        REFERENCES projects(id) ON DELETE SET NULL,
  status        text        NOT NULL DEFAULT 'QUEUED' CHECK (status IN
                  ('QUEUED','RUNNING','SUCCEEDED','FAILED','TIMEOUT','CANCELLED')),
  workspace     text,
  command_log   text,
  stdout        text,
  stderr        text,
  exit_code     integer,
  started_at    timestamptz,
  finished_at   timestamptz,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_task_idx  ON agent_runs(task_id);
CREATE INDEX agent_runs_agent_idx ON agent_runs(agent_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- messages — hội thoại agent, §14
-- -----------------------------------------------------------------------------
CREATE TABLE messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES projects(id)   ON DELETE CASCADE,
  task_id    uuid REFERENCES tasks(id)      ON DELETE CASCADE,
  run_id     uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  author     text        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_task_idx ON messages(task_id, created_at);

-- -----------------------------------------------------------------------------
-- artifacts — sản phẩm sinh ra, §14
-- -----------------------------------------------------------------------------
CREATE TABLE artifacts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id    uuid        REFERENCES tasks(id)      ON DELETE SET NULL,
  run_id     uuid        REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind       text        NOT NULL CHECK (kind IN
               ('document','design','code','report','diagram','test_result')),
  title      text        NOT NULL,
  location   text        NOT NULL,
  mime_type  text,
  size_bytes bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX artifacts_project_idx ON artifacts(project_id);

-- -----------------------------------------------------------------------------
-- bugs — lỗi, §3.9, §8.6
-- -----------------------------------------------------------------------------
CREATE TABLE bugs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id                uuid        REFERENCES tasks(id) ON DELETE SET NULL,
  title                  text        NOT NULL,
  description            text        NOT NULL DEFAULT '',
  severity               text        NOT NULL DEFAULT 'MEDIUM' CHECK (severity IN
                           ('LOW','MEDIUM','HIGH','CRITICAL')),
  status                 text        NOT NULL DEFAULT 'OPEN' CHECK (status IN
                           ('OPEN','IN_PROGRESS','FIXED','VERIFIED','WONTFIX')),
  reported_by_agent_id   uuid        REFERENCES agents(id) ON DELETE SET NULL,
  assigned_agent_id      uuid        REFERENCES agents(id) ON DELETE SET NULL,
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bugs_project_status_idx ON bugs(project_id, status);

-- -----------------------------------------------------------------------------
-- approvals — phê duyệt của CEO, §27
-- -----------------------------------------------------------------------------
CREATE TABLE approvals (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                    text        NOT NULL CHECK (kind IN
                            ('PROJECT_PLAN','ARCHITECTURE','PRODUCTION_DEPLOY','BUDGET_INCREASE',
                             'SECRET_ACCESS','KNOWLEDGE_ITEM','DEPARTMENT_UPGRADE')),
  status                  text        NOT NULL DEFAULT 'PENDING' CHECK (status IN
                            ('PENDING','APPROVED','REJECTED','EXPIRED')),
  project_id              uuid        REFERENCES projects(id) ON DELETE CASCADE,
  task_id                 uuid        REFERENCES tasks(id)    ON DELETE CASCADE,
  title                   text        NOT NULL,
  summary                 text        NOT NULL,
  -- §19: context được hiển thị trong Telegram nên tuyệt đối không chứa secret.
  context                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested_by_agent_id   uuid        REFERENCES agents(id) ON DELETE SET NULL,
  decided_by_user_id      uuid        REFERENCES users(id)  ON DELETE SET NULL,
  decided_at              timestamptz,
  decision_note           text,
  expires_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_pending_idx ON approvals(status, created_at DESC);

-- -----------------------------------------------------------------------------
-- deployments — triển khai, §62
-- -----------------------------------------------------------------------------
CREATE TABLE deployments (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment            text        NOT NULL CHECK (environment IN ('PREVIEW','STAGING','PRODUCTION')),
  status                 text        NOT NULL DEFAULT 'PENDING' CHECK (status IN
                           ('PENDING','AWAITING_APPROVAL','IN_PROGRESS','SUCCESS','FAILED','ROLLED_BACK')),
  commit_sha             text,
  url                    text,
  triggered_by_agent_id  uuid        REFERENCES agents(id)    ON DELETE SET NULL,
  -- §20, §38: deploy production bắt buộc trỏ tới một phê duyệt đã được cấp.
  approval_id            uuid        REFERENCES approvals(id) ON DELETE SET NULL,
  started_at             timestamptz,
  finished_at            timestamptz,
  log_excerpt            text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployments_production_needs_approval
    CHECK (environment <> 'PRODUCTION' OR status = 'PENDING' OR approval_id IS NOT NULL)
);
CREATE INDEX deployments_project_idx ON deployments(project_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- cost_records — chi phí từng request, §16
-- -----------------------------------------------------------------------------
CREATE TABLE cost_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      uuid REFERENCES agents(id)     ON DELETE SET NULL,
  project_id    uuid REFERENCES projects(id)   ON DELETE SET NULL,
  task_id       uuid REFERENCES tasks(id)      ON DELETE SET NULL,
  run_id        uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  provider      text        NOT NULL,
  model         text        NOT NULL,
  input_tokens  integer     NOT NULL DEFAULT 0,
  output_tokens integer     NOT NULL DEFAULT 0,
  cached_tokens integer     NOT NULL DEFAULT 0,
  -- NULL nghĩa là "model chưa có giá" — không bao giờ âm thầm ghi 0 (§16, §54).
  cost_usd      numeric(12,6),
  latency_ms    integer,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cost_records_project_idx ON cost_records(project_id, created_at DESC);
CREATE INDEX cost_records_agent_idx   ON cost_records(agent_id, created_at DESC);
CREATE INDEX cost_records_created_idx ON cost_records(created_at DESC);

-- -----------------------------------------------------------------------------
-- git_events — sự kiện Git, §17
-- -----------------------------------------------------------------------------
CREATE TABLE git_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type                 text        NOT NULL CHECK (type IN
                         ('branch_created','commit','push','pull_request','merge','review')),
  branch               text,
  commit_sha           text,
  pull_request_number  integer,
  actor_agent_id       uuid        REFERENCES agents(id) ON DELETE SET NULL,
  summary              text        NOT NULL DEFAULT '',
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX git_events_project_idx ON git_events(project_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- notifications — thông báo, §14, §134
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel      text        NOT NULL CHECK (channel IN ('telegram','dashboard','email')),
  severity     text        NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title        text        NOT NULL,
  body         text        NOT NULL DEFAULT '',
  project_id   uuid        REFERENCES projects(id) ON DELETE CASCADE,
  read_at      timestamptz,
  delivered_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- attachments — tệp đính kèm, §5.3, §65
-- -----------------------------------------------------------------------------
CREATE TABLE attachments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid        REFERENCES projects(id) ON DELETE CASCADE,
  task_id             uuid        REFERENCES tasks(id)    ON DELETE CASCADE,
  uploaded_by_user_id uuid        REFERENCES users(id)    ON DELETE SET NULL,
  source              text        NOT NULL CHECK (source IN ('telegram','dashboard','agent')),
  file_name           text        NOT NULL,
  mime_type           text        NOT NULL,
  size_bytes          bigint      NOT NULL,
  storage_key         text        NOT NULL,
  transcript          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- audit_logs — nhật ký kiểm toán, §28, §71
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text        NOT NULL,
  action      text        NOT NULL,
  target_type text        NOT NULL,
  target_id   text,
  -- §89: ghi qua lớp redaction; tuyệt đối không được chứa credential.
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip_address  text,
  environment text        NOT NULL DEFAULT 'development'
                CHECK (environment IN ('development','staging','production')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_target_idx  ON audit_logs(target_type, target_id);

-- -----------------------------------------------------------------------------
-- trigger tự cập nhật updated_at
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','projects','agents','tasks','agent_runs','messages',
                           'artifacts','bugs','approvals','deployments','notifications','attachments']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pn_touch_updated_at()',
      t, t);
  END LOOP;
END $$;
