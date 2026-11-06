# P&N — IMPLEMENTATION PLAN

> Tài liệu này được tạo theo yêu cầu **§40** của `AI_SOFTWARE_COMPANY_PROJECT_SPEC.md`.
> Foundation trước. Không code toàn hệ thống trong một commit. Không fake implementation.
> Không tự ý bỏ requirement — requirement quá lớn thì **giữ interface**, implement ở phase sau.

**Company:** P&N — *Build. Learn. Evolve.*

---

## 0. Nguyên tắc thi công

| Quy tắc | Áp dụng |
|---|---|
| Đọc toàn bộ spec trước khi code | Đã hoàn tất (150 mục / 4709 dòng) |
| Foundation trước feature | Phase 0 |
| Mỗi module: lint → typecheck → test | Bắt buộc trước khi đóng phase |
| Requirement quá lớn → giữ interface | Xem mục *Deferred* |
| Không hard-code secret / brand | `packages/shared/branding.ts`, `packages/secrets` |
| Không fake Test Connection | §89 |
| Mọi AI request đi qua backend AI Gateway | §89 |

---

## 1. Bản đồ Phase

| Phase | Tên | Spec refs | Trạng thái |
|---|---|---|---|
| 0 | Foundation & Repo Skeleton | §41, §23, §0, §14, §20, §21 | ✅ Hoàn tất |
| 1 | MVP — end-to-end một project | §35, §87, §88, §43 | ✅ Hoàn tất (2 mục hoãn sang Phase 2) |
| 2 | Full Agent Org + Realtime + 3D Office | §36, §3, §5–§13, §27 | ✅ Hoàn tất |
| 3 | Digital Product Company + Routing nâng cao | §37, §91–§97, §52–§56 | 🟢 Gần xong (thiếu lập lịch đa dự án) |
| 4 | Knowledge & R&D Department | §98–§146 | 🟢 Gần xong (thiếu knowledge graph) |
| 5 | Autonomous Company + Governance | §38, §147–§149 | 🟡 Đang làm |

---

## PHASE 0 — FOUNDATION & REPO SKELETON

**Mục tiêu:** monorepo typecheck sạch, brand tập trung, domain model, event contract, DB schema đầy đủ, LLM provider abstraction. Chưa có business logic.

### 0.1. Repo & toolchain
- [x] npm workspaces monorepo đúng cấu trúc §41
- [x] `tsconfig.base.json` strict + path alias `@pn/*`
- [x] ESLint + Prettier + Vitest
- [x] `.gitignore`, `.env.example` (không chứa secret thật)
- [x] Script gốc: `lint`, `typecheck`, `test`, `build`, `verify` (`dev` thêm khi có app ở Phase 1)

### 0.2. `packages/shared` — §0, §150
- [x] `branding.ts`: `company_name`, `company_short_name`, `company_tagline`, logo — **single source of truth**
- [x] Domain types: User, Project, Agent, Task, AgentRun, Artifact, Bug, Approval, Deployment, CostRecord, GitEvent, Notification, Attachment, AuditLog
- [x] Enum: AgentRole (§3), AgentState (§8.1), TaskStatus, ProjectType (§92), RBAC Role (§20)
- [x] Zod schema cho mọi DTO đi qua API
- [x] Secret redaction utility (phục vụ test §89)

### 0.3. `packages/events` — §21, §129
- [x] Event union đầy đủ (PROJECT_CREATED … DEPLOY_FAILED + knowledge events)
- [x] Envelope: `id, type, ts, actor, project_id, task_id, agent_id, payload`
- [x] `EventBus` interface + in-memory impl (dev)
- [ ] Redis pub/sub impl → Phase 1

### 0.4. `packages/database` — §14, §130
- [x] `0001_init.sql` — 16 bảng core §14
- [x] `0002_api_center.sql` — providers, provider_keys, model_routes, integrations, budgets
- [x] `0003_knowledge.sql` — bảng §130 (khai báo sớm, dùng ở Phase 4)
- [x] Index + FK + trigger `updated_at`
- [x] Migration runner (node-postgres)

### 0.5. `packages/llm` — §15, §45, §51–§53
- [x] `interface LLMProvider { generate, stream, estimateCost, listModels, testConnection }`
- [x] Adapter Anthropic / OpenAI / Google qua registry (không hard-code vendor tại call site)
- [x] Model catalog + pricing → `estimateCost()`
- [x] `ModelRouter`: routing per-agent + mode Quality / Balanced / Economy / Custom (§51)
- [x] Fallback chain + circuit breaker (§53, §80) — đã implement đầy đủ, không chỉ interface

### 0.6. `packages/permissions` — §20, §83
- [x] Ma trận RBAC CEO / CTO / AGENT / VIEWER / SYSTEM
- [x] Agent capability grant theo least-privilege + `assertCan()`

### 0.7. Docs
- [x] `docs/ARCHITECTURE.md`, `docs/DATABASE_SCHEMA.md`, `docs/SECURITY.md`, `docs/AGENTS.md`

**DoD Phase 0 — ✅ ĐẠT** (2026-08-27): `typecheck` pass · `lint` 0 warning · `test` 52/52 pass · `npm audit` 0 vulnerabilities · chưa app nào chứa business logic · brand khai báo đúng một nơi.

---

## PHASE 1 — MVP (§35 + §87)

**Mục tiêu §35:** chạy end-to-end một project đơn giản: Telegram → CTO → task → code → QA → GitHub → dashboard.

### 1.1. `packages/secrets` + kho trên Postgres — §19, §69, §88
- [x] Encrypted store AES-256-GCM, master key từ env, `ref` làm AAD
- [x] `PostgresSecretStorage` — nơi duy nhất chạm cột ciphertext
- [x] API không bao giờ trả raw key (chỉ masked `sk-…abcd`)
- [x] Integration test: redaction ở API response, ở audit, và ở lỗi provider (§89)

### 1.2. `apps/api` (Fastify) — §90
- [x] Auth scrypt + JWT, RBAC middleware theo `@pn/permissions`
- [x] REST: projects, tasks, agents, agent_runs, bugs, approvals, deployments, cost, audit
- [x] **AI Gateway** `/ai/generate` — mọi LLM call đi qua đây, kiểm ngân sách trước khi tiêu, ghi `cost_records`
- [x] API Center: providers CRUD, Test Connection thật, model discovery, routing, budget
- [x] WebSocket gateway phát event (§22), có snapshot lúc kết nối
- [x] Audit log tự động cho mọi request thay đổi dữ liệu (§28, §71)
- [x] Setup wizard status (§73), System Health (§74)
- [x] Cửa nội bộ cho bot/worker, bảo vệ bằng `PN_SERVICE_SECRET`

### 1.3. `packages/orchestrator` + `packages/agents` — §3, §4
- [x] Agent runtime: prompt theo vai trò, output JSON có schema, một vòng tự sửa
- [x] CTO Orchestrator (§3.1), PM (§3.2), Developer backend/frontend (§3.6/3.7), QA (§3.9)
- [x] QA chốt chặn bằng bằng chứng: test đỏ hoặc chưa có test thì không thể "đạt"
- [x] Fix loop: QA fail → Bug → Dev sửa → QA kiểm lại, tối đa 3 vòng rồi escalate CEO
- [x] Hàng đợi tuần tự theo dự án (in-process — máy build không có Redis)
- [ ] `apps/worker` chạy tiến trình riêng bằng BullMQ → Phase 2 khi có Redis

### 1.4. Sandbox — §18
- [x] Workspace cô lập, chặn path traversal, timeout cứng giết cả cây tiến trình
- [x] Allow-list lệnh và allow-list biến môi trường (§88.18)
- [x] Ghi `command log` / `stdout` / `stderr` / `exit code` vào bản ghi run
- [x] Khai báo trung thực phần chưa cưỡng chế được: RAM/CPU và chính sách mạng
- [ ] Docker driver (cô lập thật ở mức kernel) → Phase 2

### 1.5. GitHub — §17, §59, §60
- [x] Octokit-free client: create branch → commit nhiều file → push → mở PR
- [x] Chặn cứng commit trực tiếp vào branch được bảo vệ
- [x] Branch convention `feature/* fix/* agent/* release/*`
- [x] Ghi `git_events` cho mọi thao tác

### 1.6. `apps/telegram-bot` — §5, §57, §58
- [x] 16 lệnh §5.1 + hiểu ngôn ngữ tự nhiên (chuyển thẳng cho CTO)
- [x] Approval inline keyboard §5.2, bấm xong khoá luôn nút
- [x] Allowlist `chat_id`, rate limit, phiên theo đúng vai trò từng người (§58)
- [x] Thương hiệu P&N trong mọi phản hồi (§150.4)
- [x] Ghi nhận file đính kèm và nói rõ phần chưa xử lý
- [ ] Tải file về object storage và chuyển cho agent (§5.3, §65) → Phase 2

### 1.7. `apps/web` (Next.js) — §24, §25, §86
- [x] Login P&N (§150.2) + bước đầu Setup Wizard "Welcome to P&N" (§73)
- [x] Layout §24: Top bar / Sidebar / Content / Status panel / KPI bar
- [x] Trang: Tổng quan, Dự án, Chi tiết dự án, Agent, Task, Bug, Deploy, Chi phí, Cài đặt
- [x] Realtime WebSocket → trạng thái agent, dòng sự kiện, phê duyệt tại chỗ
- [x] Văn phòng 3D (R3F): 13 phòng ban, nhân vật đổi chuyển động theo 9 trạng thái thật (§8, §9)
- [x] Fallback 2D và nút chuyển đổi thủ công (§32)
- [x] Agent Detail Panel (§11): task đang làm, model đang dùng, quyền, lịch sử chạy

### 1.8. Cost & Budget — §16, §54, §55
- [x] Ghi cost mỗi request theo agent / project / task / model / provider
- [x] Dashboard: hôm nay / tháng / theo 4 chiều / biểu đồ 30 ngày
- [x] Model chưa có giá được đếm riêng, không gộp im lặng vào 0
- [x] Chặn trước khi tiêu khi chạm trần; dự án chuyển `PAUSED_BUDGET`
- [ ] Alert 80% đẩy chủ động qua Telegram → Phase 2 (event đã có, còn thiếu bộ gửi)

### Chưa đạt trong Phase 1 — nêu rõ thay vì bỏ qua
| Mục | Lý do | Sẽ làm ở |
|---|---|---|
| Staging deploy thật (§43.12) | Cần tích hợp Vercel (§62); hiện mới có bản ghi + cổng phê duyệt | Phase 2 |
| Worker tiến trình riêng | Máy build không có Redis; hàng đợi in-process cùng interface | Phase 2 |
| Docker sandbox | Máy build không có Docker | Phase 2 |
| Lưu file đính kèm | Cần object storage (§65) | Phase 2 |
| Telegram đẩy cảnh báo chủ động | Cần bộ gửi thông báo nền | Phase 2 |

**DoD Phase 1 — 11/13 mục §43 đạt** (thiếu staging deploy thật và thông báo chủ động).
**§88 API Center — 20/20 tiêu chí có hiện thực, 22 test tự động phủ.**

---

## PHASE 2 — FULL AGENT ORG + 3D OFFICE (§36)

### Đã xong
- [x] Đủ 13 phòng ban 3D (§7) trên mặt bằng có hành lang thật
- [x] Đủ 9 animation state (§8.1–8.8) gắn dữ liệu thật (§9), thêm tư thế đi bộ
- [x] Camera pan / zoom / orbit giới hạn / bấm chọn phòng và agent (§10)
- [x] **Chuyển giao công việc nhìn thấy được**: người đưa việc đi qua hành lang
      từ phòng gửi sang phòng nhận, chỉ chạy khi có event thật (§9)
- [x] Project Detail (§12) + Task Board bấm được để xem lý do task bị chặn (§13)
- [x] Hiệu năng 3D đo được, không đoán (§30): 46 FPS · 1631 lệnh vẽ
- [x] Bộ cài đặt cho máy Windows + bộ thử 33 chức năng trên hệ thống chạy thật

### Còn lại
- [ ] **Nối `workflowFor()` vào engine (§4, §92)** — `workflow.ts` khai báo đủ
      pipeline chuẩn và routing theo loại sản phẩm, nhưng `engine.ts` không
      import nó: engine chạy theo task CTO đề xuất, không theo stage. Hệ quả
      phải sửa sớm: cờ `requiresApproval` trên stage — kể cả stage `production`
      — hiện không có tác dụng, tức là cổng duyệt production chưa tồn tại
      trên thực tế dù §20 và §38 bắt buộc có
- [ ] BA, Solution Architect, UI/UX, Mobile, Security, DevOps chạy thật (§3.3–3.12)
      — hiện mới có CTO, PM, Developer, QA; các vai trò khác đã có chỗ trong
      mặt bằng và bảng định tuyến nhưng nhận task thì báo "chưa triển khai"
- [ ] Approval system đầy đủ (§27), Agent Detail Panel mở rộng (§11)
- [ ] Nối các API đã xong vào web: cấu hình tích hợp (§57–§68), ngân sách
      (§54, §55), audit log (§28, §71), model discovery và sửa giá (§49)
      — bốn màn hình này backend đã đủ, chỉ thiếu giao diện
- [ ] Trang Báo cáo (§29) — sidebar §86 có mục này, web chưa có trang
- [ ] Docker sandbox driver thật (§18) — máy build chưa có Docker
- [ ] Visual style premium hoàn chỉnh (§33), mobile dashboard (§31)
- [ ] CEO Command Center (§26), báo cáo CEO định kỳ (§29)
- [ ] Worker tiến trình riêng bằng BullMQ (cần Redis)
- [ ] Telegram đẩy cảnh báo ngân sách chủ động

## PHASE 3 — DIGITAL PRODUCT COMPANY (§37, §91–97)
- [ ] Product type routing: Corporate Website / Web App / Mobile App / Landing Page (§92)
- [ ] Web Development Department (§93) + Web Product Lead (§94)
- [ ] SEO Agent (§95), Web Performance Agent (§96), Accessibility Agent (§97)
- [ ] Red Team Agent (§3.11), automatic model router (§52), provider fallback + circuit breaker (§53, §80)
- [ ] Multi-project scheduling, agent performance scoring, rate limit + retry policy (§78, §79)
- [ ] Website project acceptance (§144)

## PHASE 4 — KNOWLEDGE & R&D (§98–146)
- [ ] Knowledge Director, GitHub Scout, Technology Radar, Skill Scout, Research Agent (§99–105)
- [ ] Daily discovery pipeline (§106), CEO digest (§107), approval UI (§108, §136)
- [ ] Repo scoring (§102), source reputation (§120), multi-stage filter (§133)
- [ ] Sandbox knowledge evaluation (§116), prompt injection defense (§118), license governance (§119)
- [ ] Department KB (§110), level/XP (§111–113), agent profile versioning (§114), rollback (§115)
- [ ] Knowledge graph (§123), performance feedback (§124), knowledge dashboard (§125)
- [ ] 3D R&D room + animation + level-up visual (§126–128)
- [ ] R&D budget control (§132), scheduled jobs (§131)

## PHASE 5 — AUTONOMOUS + GOVERNANCE (§38, §147–149)
- [ ] Autonomous loop: plan → design → code → test → debug → optimize → document → deploy staging
- [ ] Production deploy luôn qua governance gate
- [ ] Không self-modify policy, không tự cấp quyền, không ingest untrusted code (§147)
- [ ] Full audit traceability cho mọi knowledge item (§149.30)

---

## 2. Deferred — giữ interface, implement sau

| Hạng mục | Interface tạo ở | Implement ở |
|---|---|---|
| Docker sandbox driver | Phase 1 (`SandboxDriver`) | Phase 2 |
| App Store Connect / Google Play | Phase 1 (UI + data model, §87) | Phase 3 |
| Voice Telegram | Phase 1 (attachment intake) | Phase 3 |
| Knowledge tables | Phase 0 (migration ✅) | Phase 4 |
| Mobile companion | — | Phase 3 |
