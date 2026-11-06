# P&N — ARCHITECTURE

> Spec refs: §2, §21, §22, §41, §90. Cập nhật khi kiến trúc thay đổi.

## 1. Bức tranh tổng thể (§90)

```text
                    CEO
                     │
               TELEGRAM BOT              ← remote control (§2.2)
                     │
                     ▼
                API GATEWAY  (apps/api)
                     │
              CTO ORCHESTRATOR           ← bộ não điều phối (§3.1)
                     │
       ┌─────────────┼─────────────┐
       │             │             │
      PM           DEV            QA     ← nhân sự AI chuyên môn hoá (§3)
       │             │             │
       └─────────────┼─────────────┘
                     │
                 AI GATEWAY               ← mọi LLM call đi qua đây (§89)
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
   Anthropic       OpenAI        Gemini
                     │
            INTEGRATION CENTER            ← §44
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
     GitHub      Supabase        Vercel
                                    │
                        App Store / Play
```

Dashboard 3D là **digital twin** của agent state thật (§9). Telegram là **remote
control**. GitHub + Sandbox + CI/CD là **software factory**.

## 2. Nguyên tắc bất di bất dịch

| # | Nguyên tắc | Spec | Enforce ở |
|---|---|---|---|
| 1 | Một nền tảng duy nhất, không chatbot rời rạc | §2.1 | monorepo + DB dùng chung |
| 2 | Telegram không phải Agent, chỉ chuyển tiếp | §2.2 | `apps/telegram-bot` không gọi LLM |
| 3 | Mọi AI request qua backend gateway | §89 | `apps/api` `/ai/generate` |
| 4 | Không hard-code vendor | §15 | `packages/llm` `LLMProvider` |
| 5 | Agent least privilege | §20 | `packages/permissions` |
| 6 | Secret không bao giờ plaintext / không ra client | §19, §89 | `packages/secrets`, redaction |
| 7 | Animation 3D chỉ phản ánh state thật | §9 | `packages/events` là nguồn duy nhất |
| 8 | Production deploy luôn có governance | §20, §38 | `approvals` + DB constraint |
| 9 | Brand khai báo một nơi | §150.10 | `packages/shared/branding.ts` |

## 3. Cấu trúc repo (§41)

```text
/apps
  /web            Next.js dashboard + 3D office
  /api            Fastify: REST, AI Gateway, WebSocket, API Center
  /telegram-bot   Command / approval / attachment intake
  /worker         BullMQ: chạy agent run trong sandbox

/packages
  /shared         branding, domain types, enums, zod schema, redaction
  /events         event contract + event bus (in-memory / Redis)
  /database       SQL migrations + pool + migration runner
  /llm            LLMProvider, catalog, cost, router, fallback, circuit breaker
  /permissions    RBAC + agent capability grants
  /secrets        AES-256-GCM secret store + rotation
  /sandbox        SandboxDriver contract (local → Phase 1, docker → Phase 2)
  /agents         Agent runtime contract + state machine
  /orchestrator   Workflow definition + fix loop + Orchestrator contract
  /ui             Design system dùng chung (Phase 1)
  /three-office   R3F scene, nhân vật, animation (Phase 1–2)

/infrastructure   docker, github-actions
/docs             ARCHITECTURE, DATABASE_SCHEMA, SECURITY, AGENTS
```

## 4. Luồng dữ liệu

### 4.1. Production loop (§4)

```text
CEO gửi yêu cầu (Telegram)
  → API Gateway xác thực chat_id (§58)
  → CTO Orchestrator: tạo project + phân rã task
  → Task queue (BullMQ)
  → Worker: mở sandbox theo run_id (§18)
  → Agent gọi AI Gateway → ModelRouter → Provider
  → Ghi cost_records (§16)
  → Agent commit / mở PR (§17)
  → QA test → fail thì fix loop (tối đa 3 vòng)
  → Security → DevOps → staging
  → CEO approval → production (§27)
```

### 4.2. Event → 3D (§21, §22, §9)

```text
Agent đổi state trong DB
  → EventBus.publish(AGENT_STATE_CHANGED)
  → WebSocket gateway
  → Zustand store ở web
  → Nhân vật 3D đổi animation
```

Không có timer, không có random. Nếu không có event thì không có animation.

## 5. Quyết định kỹ thuật đã chốt

| Quyết định | Lý do |
|---|---|
| npm workspaces thay vì pnpm | pnpm chưa có sẵn trên máy build; npm workspaces đủ dùng |
| TypeScript project references | typecheck tăng dần, ranh giới package rõ ràng |
| SQL thuần thay vì ORM | Schema trong §14/§130 rất cụ thể; migration là nguồn chân lý |
| Anthropic dùng SDK chính thức, OpenAI/Google dùng REST | SDK chính thức bắt buộc cho Claude; REST giữ lớp provider mỏng và dễ thay |
| `costUsd` có thể `null` | Model chưa có giá thì ghi `null`, không ghi 0 (§16, §89) |
| Script npm gọi thẳng `node ./node_modules/...` | Thư mục dự án chứa ký tự `&` làm hỏng shim `.bin` của Windows |

## 6. Ghi chú môi trường

Tên thư mục dự án chứa ký tự `&` (ví dụ `P&N App`). Trên Windows, `cmd.exe`
hiểu `&` là dấu phân tách lệnh nên mọi shim trong `node_modules/.bin` (`npx`,
`tsc`, `next`, …) đều lỗi. Đã xử lý bằng cách gọi trực tiếp entrypoint qua
`node`. Nếu sau này muốn dùng `npx` bình thường, nên đổi tên thư mục thành
`PN App` — thương hiệu hiển thị vẫn là **P&N** vì brand đọc từ
`packages/shared/branding.ts`, không phụ thuộc tên thư mục.
