-- =============================================================================
-- P&N — 0003 Knowledge & R&D
-- Spec §130 (danh sách bảng), §98–§129, §137–§143
--
-- Khai báo ngay ở Phase 0 để schema đầy đủ và ổn định; pipeline R&D đổ dữ liệu
-- vào các bảng này được xây ở Phase 4 (xem IMPLEMENTATION_PLAN.md).
-- =============================================================================

-- §120 — uy tín của nguồn.
CREATE TABLE knowledge_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           text        NOT NULL CHECK (kind IN
                   ('github','blog','docs','paper','registry','conference','other')),
  name           text        NOT NULL,
  url            text        NOT NULL,
  -- 0..100; dùng cho bộ lọc nhiều tầng (§133).
  trust_score    integer     NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  is_allowed     boolean     NOT NULL DEFAULT true,
  last_scanned_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url)
);

-- §106 — phát hiện thô, trước khi sàng lọc.
CREATE TABLE knowledge_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     uuid        REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  discovered_by text        NOT NULL,
  title         text        NOT NULL,
  url           text,
  summary       text        NOT NULL DEFAULT '',
  raw           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  stage         text        NOT NULL DEFAULT 'DISCOVERED' CHECK (stage IN
                  ('DISCOVERED','SCREENED','EVALUATED','PROMOTED','REJECTED')),
  reject_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_candidates_stage_idx ON knowledge_candidates(stage, created_at DESC);

-- §109 — gói kiến thức đã được duyệt.
CREATE TABLE knowledge_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id       uuid        REFERENCES knowledge_candidates(id) ON DELETE SET NULL,
  source_id          uuid        REFERENCES knowledge_sources(id)    ON DELETE SET NULL,
  title              text        NOT NULL,
  kind               text        NOT NULL CHECK (kind IN
                       ('pattern','library','tool','skill','guideline','benchmark','repo')),
  summary            text        NOT NULL DEFAULT '',
  body               text        NOT NULL DEFAULT '',
  license            text,
  -- §119 — cổng kiểm soát giấy phép.
  license_approved   boolean     NOT NULL DEFAULT false,
  status             text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN
                       ('DRAFT','PENDING_APPROVAL','ACTIVE','DEPRECATED','ROLLED_BACK','REJECTED')),
  active_version     integer     NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_items_status_idx ON knowledge_items(status);

-- §114, §115 — phiên bản và rollback.
CREATE TABLE knowledge_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  version     integer     NOT NULL,
  body        text        NOT NULL,
  changelog   text        NOT NULL DEFAULT '',
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version)
);

-- §110 — gắn kiến thức vào kho của phòng ban.
CREATE TABLE knowledge_departments (
  item_id     uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  department  text        NOT NULL,
  activated_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, department)
);

-- §142 — agent nào nạp kiến thức nào.
CREATE TABLE knowledge_agent_bindings (
  item_id    uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  agent_role text        NOT NULL,
  priority   integer     NOT NULL DEFAULT 100,
  is_active  boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, agent_role)
);

-- §117, §118 — rà soát bảo mật trước khi kích hoạt bất cứ thứ gì.
CREATE TABLE knowledge_reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  reviewer    text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('security','license','quality','duplication')),
  passed      boolean     NOT NULL,
  findings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- §108, §136 — CEO duyệt, nối với bảng approvals dùng chung.
CREATE TABLE knowledge_approvals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  approval_id uuid        NOT NULL REFERENCES approvals(id)       ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, approval_id)
);

-- §116 — kết quả chạy thử trong sandbox.
CREATE TABLE knowledge_evaluations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id      uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  run_id       uuid        REFERENCES agent_runs(id) ON DELETE SET NULL,
  score        numeric(5,2),
  passed       boolean     NOT NULL DEFAULT false,
  report       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- §124 — kiến thức đó có thật sự cải thiện hiệu năng không?
CREATE TABLE knowledge_metrics (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id        uuid        NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  department     text        NOT NULL,
  metric         text        NOT NULL,
  value_before   numeric(12,4),
  value_after    numeric(12,4),
  sample_size    integer     NOT NULL DEFAULT 0,
  measured_at    timestamptz NOT NULL DEFAULT now()
);

-- §103
CREATE TABLE technology_radar (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  category    text        NOT NULL,
  ring        text        NOT NULL CHECK (ring IN ('adopt','trial','assess','hold')),
  rationale   text        NOT NULL DEFAULT '',
  item_id     uuid        REFERENCES knowledge_items(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, category)
);

-- §101, §102
CREATE TABLE github_repositories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name        text        NOT NULL UNIQUE,
  url              text        NOT NULL,
  stars            integer     NOT NULL DEFAULT 0,
  forks            integer     NOT NULL DEFAULT 0,
  open_issues      integer     NOT NULL DEFAULT 0,
  last_commit_at   timestamptz,
  license          text,
  language         text,
  -- §102 điểm chất lượng tổng hợp, thang 0..100.
  score            numeric(5,2),
  score_breakdown  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  candidate_id     uuid        REFERENCES knowledge_candidates(id) ON DELETE SET NULL,
  scanned_at       timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- §104
CREATE TABLE skill_catalog (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL UNIQUE,
  description  text        NOT NULL DEFAULT '',
  item_id      uuid        REFERENCES knowledge_items(id) ON DELETE SET NULL,
  department   text,
  is_active    boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- §111, §112, §113
CREATE TABLE department_levels (
  department  text PRIMARY KEY,
  level       integer     NOT NULL DEFAULT 1,
  total_xp    integer     NOT NULL DEFAULT 0,
  leveled_up_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE department_xp (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department  text        NOT NULL,
  amount      integer     NOT NULL,
  -- §112 — XP phải đến từ bằng chứng thật, không phải từ đồng hồ đếm giờ.
  evidence    text        NOT NULL,
  project_id  uuid        REFERENCES projects(id) ON DELETE SET NULL,
  task_id     uuid        REFERENCES tasks(id)    ON DELETE SET NULL,
  item_id     uuid        REFERENCES knowledge_items(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX department_xp_dept_idx ON department_xp(department, created_at DESC);

-- §114
CREATE TABLE agent_profile_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_role    text        NOT NULL,
  version       integer     NOT NULL,
  system_prompt text        NOT NULL,
  knowledge_ids uuid[]      NOT NULL DEFAULT '{}',
  activated_at  timestamptz,
  rolled_back_at timestamptz,
  approval_id   uuid        REFERENCES approvals(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_role, version)
);

-- §149.29 — mọi thay đổi kiến thức đều kiểm toán và truy vết được.
CREATE TABLE knowledge_audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor      text        NOT NULL,
  action     text        NOT NULL,
  item_id    uuid        REFERENCES knowledge_items(id) ON DELETE SET NULL,
  department text,
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_audit_logs_item_idx ON knowledge_audit_logs(item_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_sources','knowledge_candidates','knowledge_items',
                           'technology_radar','github_repositories','skill_catalog',
                           'department_levels']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION pn_touch_updated_at()',
      t, t);
  END LOOP;
END $$;
