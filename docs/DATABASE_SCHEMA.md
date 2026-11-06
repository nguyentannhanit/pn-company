# P&N — DATABASE SCHEMA

> Spec refs: §14 (bảng core), §44–§56 + §69 (API Center), §130 (Knowledge & R&D).
> Nguồn chân lý là `packages/database/migrations/*.sql`. Tài liệu này là bản đồ.

PostgreSQL 15+ (Supabase tương thích). Mọi bảng dùng `uuid` sinh bởi `gen_random_uuid()`
(extension `pgcrypto`), timestamp là `timestamptz`, và các bảng có vòng đời đều
có trigger `pn_touch_updated_at`.

## Chạy migration

```bash
cp .env.example .env      # điền DATABASE_URL
npm run db:status         # xem migration nào pending / drifted
npm run db:migrate        # áp dụng
```

Migration đã áp dụng mà bị sửa file sẽ báo lỗi checksum — bắt buộc tạo migration
mới thay vì sửa file cũ.

---

## 0001_init.sql — 16 bảng core (§14)

| Bảng | Vai trò | Ghi chú thiết kế |
|---|---|---|
| `users` | CEO / CTO / VIEWER / SYSTEM | unique theo `lower(email)`; `telegram_chat_id` cho allow-list §58 |
| `projects` | Dự án | `product_type` §92, `budget_usd`/`spent_usd` §16, status có `PAUSED_BUDGET` §55 |
| `agents` | Nhân sự AI | **`state` là nguồn duy nhất của animation 3D** (§9); `profile_version` §114; `xp` §112 |
| `tasks` | Công việc | `fix_loop_count` giới hạn vòng lặp QA (§43.6) |
| `task_dependencies` | Phụ thuộc task | PK ghép, chặn self-dependency |
| `agent_runs` | Mỗi lần agent chạy | §18: `workspace`, `command_log`, `stdout`, `stderr`, `exit_code` |
| `messages` | Hội thoại agent | phân theo project / task / run |
| `artifacts` | Sản phẩm sinh ra | document, design, code, report, diagram, test_result |
| `bugs` | Lỗi QA/Security phát hiện | severity + status, gắn agent báo cáo và agent sửa |
| `approvals` | Cổng phê duyệt CEO | `context` là jsonb — **không được chứa secret** (§19) |
| `deployments` | Triển khai | CHECK: `PRODUCTION` phải có `approval_id` (§20, §38) |
| `cost_records` | Chi phí từng request | `cost_usd` **nullable** — model chưa có giá thì `NULL`, không phải 0 |
| `git_events` | Sự kiện Git | branch / commit / push / PR / merge / review (§17) |
| `notifications` | Thông báo | telegram / dashboard / email |
| `attachments` | File & voice từ Telegram | `storage_key` trỏ object storage (§65), `transcript` cho voice |
| `audit_logs` | Nhật ký kiểm toán | `metadata` đã qua redaction (§28, §71, §89) |

## 0002_api_center.sql — 8 bảng (§44–§56, §69, §81)

| Bảng | Vai trò | Ghi chú |
|---|---|---|
| `secrets` | Kho secret mã hoá | AES-256-GCM: `ciphertext`, `iv`, `auth_tag`, `key_version`; `preview` là chuỗi đã mask |
| `ai_providers` | Cấu hình Anthropic / OpenAI / Google | chỉ giữ `key_preview` + `secret_ref`; unique theo (provider, environment) |
| `ai_models` | Catalog + giá | `pricing_source` = seed / operator / discovered (§49, §54) |
| `model_routes` | Routing theo Agent | mode §51, `fallbacks` jsonb §53, unique theo (agent_role, environment) |
| `integrations` | Telegram / GitHub / DB / Deploy / Store / Storage / SMTP / Webhook | `settings` không chứa secret; secret nằm ở `secret_refs` |
| `budget_policies` | Ngân sách | scope GLOBAL/PROJECT/AGENT/RND, `warn_threshold`, `hard_stop` (§54, §55) |
| `api_request_logs` | Log gọi provider | **không lưu prompt/response** (§82); có `fell_back_to` cho §53 |
| `system_settings` | Setup wizard, environment, dev mode | key/value jsonb (§73, §76, §85) |

## 0003_knowledge.sql — 17 bảng (§130)

Khai báo sẵn ở Phase 0 để schema ổn định; pipeline R&D được xây ở Phase 4.

| Bảng | Spec | Vai trò |
|---|---|---|
| `knowledge_sources` | §120 | Nguồn + điểm tin cậy |
| `knowledge_candidates` | §106, §133 | Phát hiện thô, đi qua các stage lọc |
| `knowledge_items` | §109, §119 | Gói kiến thức đã duyệt; có cổng `license_approved` |
| `knowledge_versions` | §114, §115 | Phiên bản + rollback |
| `knowledge_departments` | §110 | Gắn kiến thức vào phòng ban |
| `knowledge_agent_bindings` | §142 | Agent nào nạp kiến thức nào |
| `knowledge_reviews` | §117, §118, §121 | Rà soát security / license / quality / duplication |
| `knowledge_approvals` | §108, §136 | Nối với bảng `approvals` chung |
| `knowledge_evaluations` | §116 | Kết quả chạy thử trong sandbox |
| `knowledge_metrics` | §124 | Đo hiệu năng trước/sau |
| `technology_radar` | §103 | adopt / trial / assess / hold |
| `github_repositories` | §101, §102 | Điểm chất lượng repo |
| `skill_catalog` | §104 | Skill phát hiện được |
| `department_levels` | §111, §113 | Level phòng ban |
| `department_xp` | §112 | XP kèm **bằng chứng thật**, không cộng theo thời gian |
| `agent_profile_versions` | §114 | Phiên bản prompt + tập kiến thức, gắn approval |
| `knowledge_audit_logs` | §149.30 | Truy vết mọi thay đổi kiến thức |

---

## Bất biến do DB tự bảo vệ

1. `deployments`: môi trường `PRODUCTION` không thể rời trạng thái `PENDING` nếu
   không có `approval_id` → không có deploy production ngoài governance (§38).
2. `cost_records.cost_usd` cho phép `NULL` → dashboard phân biệt được
   "chưa biết giá" với "miễn phí" (§16).
3. `model_routes` unique theo `(agent_role, environment)` → một agent không thể
   có hai route mâu thuẫn trong cùng môi trường.
4. `secrets` không có cột plaintext nào → không thể "tạm lưu thô cho nhanh" (§19).
5. `task_dependencies` chặn `task_id = depends_on_task_id`.
