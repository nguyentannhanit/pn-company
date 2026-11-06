# P&N — AGENTS

> Spec refs: §3 (bộ agent bắt buộc), §4 (workflow), §8 (animation state),
> §9 (state phải là dữ liệu thật), §15/§50 (model routing), §20 (quyền),
> §93–§97 (Web Dept), §99–§105 (Knowledge & R&D).

## 1. Bộ agent

### 1.1. Core delivery (§3)

| Role | Phòng ban | Tier mặc định (§15) | Quyền chính (§20) | Phase |
|---|---|---|---|---|
| `CTO_ORCHESTRATOR` | Command Center | strong | project/task write, assign, agent control, staging deploy | 1 |
| `PRODUCT_MANAGER` | Product | medium | task write + assign | 1 |
| `BUSINESS_ANALYST` | Business Analysis | medium | task write, docs | 2 |
| `SOLUTION_ARCHITECT` | Command Center | strong | docs, task write | 2 |
| `UIUX_DESIGNER` | UI/UX Studio | medium | docs | 2 |
| `FRONTEND_DEVELOPER` | Frontend | strong | `code:write:frontend`, tests, branch, PR | 1 |
| `BACKEND_DEVELOPER` | Backend | strong | `code:write:backend`, tests, branch, PR | 1 |
| `MOBILE_DEVELOPER` | Mobile | strong | `code:write:mobile`, tests, branch, PR | 2 |
| `QA` | QA Lab | medium | chạy test, tạo bug — **không viết code sản phẩm** | 1 |
| `SECURITY` | Security Ops | strong | đọc + tạo bug | 2 |
| `RED_TEAM` | Security Ops | strong | đọc + tạo bug | 3 |
| `DEVOPS` | DevOps | medium | infra code, preview/staging deploy — **không production** | 2 |

### 1.2. Web Development Department (§93–§97) — Phase 3

`WEB_PRODUCT_LEAD`, `SEO`, `WEB_PERFORMANCE`, `ACCESSIBILITY`.

### 1.3. Knowledge & R&D (§99–§105) — Phase 4

`KNOWLEDGE_DIRECTOR`, `GITHUB_SCOUT`, `TECHNOLOGY_RADAR`, `SKILL_SCOUT`,
`RESEARCH`, `KNOWLEDGE_CURATOR`, `KNOWLEDGE_SECURITY_REVIEW`,
`SANDBOX_EVALUATION`, `DEPARTMENT_TRAINER`, `KNOWLEDGE_AUDITOR`.

Các scout agent chỉ có quyền `knowledge:discover`. Việc **kích hoạt** kiến thức
không do agent nào thực hiện — nó cần CEO duyệt (§108) và do vai trò `SYSTEM`
thi hành (§147).

## 2. Workflow chuẩn (§4)

```text
NEW IDEA → CTO → PM → BA → ARCHITECT → UI/UX
        → FRONTEND + BACKEND + MOBILE (song song)
        → QA → [FIX LOOP] → SECURITY → RED TEAM → DEVOPS
        → STAGING → CEO APPROVAL → PRODUCTION
```

Định nghĩa bằng dữ liệu ở `packages/orchestrator`:
`STANDARD_WORKFLOW`, `MVP_WORKFLOW`, `workflowFor(productType)` (§92).

Stage có `requiresApproval: true`: `architecture` và `production`.

### Fix loop (§4, §43.6)

```text
QA fail → BUG → CTO → assign owner → FIX → QA retest
```

Giới hạn `MAX_FIX_LOOP_ITERATIONS = 3`. Quá số vòng thì **escalate lên CEO**,
không lặp vô hạn để tránh đốt ngân sách (§55).

## 3. Trạng thái agent và animation (§8.1, §9)

```text
idle · working · reviewing · meeting · blocked · alert · completed · celebrate · offline
```

`packages/agents` khai báo `ALLOWED_TRANSITIONS`. Máy trạng thái này bảo đảm
nhân vật 3D không thể `celebrate` nếu chưa thật sự có `DEPLOY_SUCCESS`, và không
thể nhảy thẳng từ `idle` sang `completed`.

Đường dữ liệu:

```text
agents.state (DB)  →  EventBus AGENT_STATE_CHANGED  →  WebSocket  →  3D animation
```

Không có nguồn nào khác được phép đổi animation (§9).

## 4. Model routing (§15, §50, §51, §52)

- Bảng mặc định: `DEFAULT_ROLE_TIERS` trong `packages/llm/router.ts`.
- Mode: `quality` / `balanced` / `economy` / `custom`. Mode `custom` luôn tôn
  trọng lựa chọn của CEO, không tự đổi.
- Smart routing (§52) có thể hạ tier cho việc cơ học (classification,
  summarization, formatting) và khi ngân sách gần cạn; nâng tier cho
  architecture review / debugging.
- Fallback (§53) chỉ chạy với lỗi retryable (rate limit, overload, timeout,
  network, 5xx). Lỗi `auth` hay `invalid_request` **không** fallback — đó là lỗi
  cấu hình, phải hiện ra ngay. Mỗi lần fallback đều được log.

## 5. Contract triển khai agent

```ts
interface Agent {
  readonly definition: AgentDefinition;   // role, department, systemPrompt, tools
  run(context: AgentContext): Promise<AgentOutcome>;
}
```

`AgentOutcome` cho phép agent đề xuất task mới, báo bug, và yêu cầu approval —
nhưng **không** cho phép agent tự phê duyệt hay tự đổi quyền của mình (§147).

`AgentContext.signal` cho phép worker huỷ run khi sandbox timeout (§18) hoặc khi
budget policy chạm ngưỡng (§55).

## 6. Nạp kiến thức (§142)

`AgentDefinition.systemPrompt` chỉ chứa *danh tính vai trò*. Kiến thức phòng ban
được nối vào lúc chạy từ `knowledge_agent_bindings`, kèm phiên bản
(`agent_profile_versions`) để có thể rollback (§115).
