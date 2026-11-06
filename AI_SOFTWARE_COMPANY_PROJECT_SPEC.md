# P&N — MASTER PROJECT SPECIFICATION


# 0. THƯƠNG HIỆU CHÍNH THỨC

Tên công ty:

```text
P&N
```

Tên hiển thị khuyến nghị trong sản phẩm:

```text
P&N
P&N P&N
P&N Digital Company
```

Quy tắc thương hiệu:

- Tên chính thức luôn là **P&N**.
- Logo, dashboard, Telegram Bot, báo cáo, cửa sổ đăng nhập, setup wizard và trang hệ thống phải dùng thương hiệu **P&N**.
- Không tự đổi tên công ty sang tên khác.
- Không dùng tên demo như `AI Software Company`, `Agent Company`, `Demo Corp` trong giao diện production.
- Có thể dùng tagline phụ, nhưng không thay thế tên **P&N**.

Tagline đề xuất:

```text
Build. Learn. Evolve.
```

Hoặc tiếng Việt:

```text
Xây dựng. Học hỏi. Tiến hóa.
```

Tinh thần thương hiệu:

- Premium
- Hiện đại
- Công nghệ
- Thông minh
- Tự vận hành
- Không trẻ con
- Không phong cách game fantasy

---


## 1. Mục tiêu dự án

Xây dựng một nền tảng **P&N** hoạt động như một công ty phần mềm thu nhỏ, trong đó người dùng đóng vai **CEO / Product Owner**, còn các AI Agent đảm nhiệm toàn bộ vòng đời phát triển phần mềm:

**Ý tưởng → Phân tích → Kiến trúc → Thiết kế → Code → Test → Security → Deploy → Báo cáo**

Hệ thống phải có hai lớp giao diện chính:

1. **Telegram Bot** — cổng giao tiếp nhanh để CEO giao việc, duyệt quyết định, xem trạng thái.
2. **Web Dashboard 3D** — trung tâm điều hành trực quan, mô phỏng một văn phòng phần mềm sống động với các phòng ban và nhân viên AI đang làm việc.

Mục tiêu cuối cùng là tạo ra cảm giác người dùng thực sự đang điều hành một **công ty phần mềm AI tự vận hành**.

---

# 2. Nguyên tắc sản phẩm

## 2.1. Một hệ thống tổng

Không xây từng chatbot rời rạc.

Toàn bộ Agent phải nằm trong **một nền tảng duy nhất**, dùng chung:

- Project
- Task
- Agent state
- Artifact
- Git repository
- Cost tracking
- Approval
- Audit log
- Deployment
- Notification

---

## 2.2. Telegram là đầu vào chính

Telegram Bot đóng vai:

- Command interface
- Notification center
- Approval interface
- Quick status interface
- File/voice intake

Telegram **không phải Agent**.

Telegram chỉ chuyển yêu cầu đến **CTO Orchestrator**.

Luồng chuẩn:

```text
CEO
↓
Telegram Bot
↓
API Gateway
↓
CTO Orchestrator
↓
Agent Workflow
↓
GitHub / Database / CI / Deploy
↓
Dashboard + Telegram notification
```

---

# 3. Các Agent bắt buộc

## 3.1. CTO / Orchestrator Agent

Vai trò:

- Nhận yêu cầu từ CEO
- Hiểu mục tiêu
- Chia dự án thành workstream
- Phân task cho Agent
- Theo dõi dependency
- Kiểm soát tiến độ
- Quyết định Agent nào được chạy
- Tổng hợp kết quả
- Yêu cầu làm lại khi không đạt
- Escalate các quyết định quan trọng lên CEO

CTO là Agent duy nhất có quyền điều phối toàn bộ workflow.

---

## 3.2. Product Manager Agent

Nhiệm vụ:

- Phân tích ý tưởng
- Viết PRD
- Xác định persona
- Xác định use case
- Xác định scope
- Xác định MVP
- Xác định KPI
- Viết backlog

Output:

- `PRD.md`
- `PRODUCT_SCOPE.md`
- Product backlog

---

## 3.3. Business Analyst Agent

Nhiệm vụ:

- Phân tích nghiệp vụ
- User flow
- Business rules
- Acceptance criteria
- Edge cases
- Data requirements

Output:

- `BUSINESS_REQUIREMENTS.md`
- `USER_FLOWS.md`
- `ACCEPTANCE_CRITERIA.md`

---

## 3.4. Solution Architect Agent

Nhiệm vụ:

- Kiến trúc hệ thống
- Chọn stack
- Thiết kế module
- API structure
- Database architecture
- Security boundary
- Deployment architecture

Output:

- `ARCHITECTURE.md`
- `DATABASE_SCHEMA.md`
- `API_SPEC.md`
- Architecture diagram

---

## 3.5. UI/UX Designer Agent

Nhiệm vụ:

- User journey
- Wireframe
- Design system
- Layout
- Component specification
- Responsive rules
- Accessibility

Output:

- `DESIGN_SYSTEM.md`
- `UI_SPEC.md`
- Mockup / image / component plan

---

## 3.6. Frontend Developer Agent

Nhiệm vụ:

- Web UI
- Dashboard
- Component
- State management
- API integration
- Responsive UI
- Animation

Không được:

- tự deploy production
- sửa database production trực tiếp

---

## 3.7. Backend Developer Agent

Nhiệm vụ:

- API
- Database
- Auth
- Business logic
- Queue
- Agent runtime
- Webhook
- Cost tracking

Không được:

- xoá dữ liệu production không qua approval
- expose secret

---

## 3.8. Mobile Developer Agent

Dùng khi project cần mobile app.

Khuyến nghị:

- Flutter
- Android + iOS từ một codebase

---

## 3.9. QA Agent

Nhiệm vụ:

- Sinh test case
- Unit test
- Integration test
- E2E test
- Regression test
- UI check
- Log bug

Output bug bắt buộc có:

- Severity
- Reproduction steps
- Expected
- Actual
- Screenshot/log
- Related task
- Assigned agent

---

## 3.10. Security Agent

Kiểm tra:

- Authentication
- Authorization
- RBAC
- API security
- Secret exposure
- Input validation
- Dependency risk
- Database policy
- OWASP issues

---

## 3.11. Red Team Agent

Chạy sau QA.

Nhiệm vụ:

- Thử bypass login
- Permission abuse
- Invalid input
- Rate limit abuse
- Cross-user data access
- API misuse
- Session manipulation

Không được phép thực hiện destructive testing trên production thật.

Chỉ test trong sandbox/staging.

---

## 3.12. DevOps Agent

Nhiệm vụ:

- CI/CD
- Docker
- Environment
- GitHub Actions
- Preview deploy
- Staging
- Production release

Production deploy bắt buộc có approval nếu project bật chế độ manual approval.

---

# 4. Workflow chuẩn

```text
NEW IDEA
↓
CTO
↓
PM
↓
BA
↓
ARCHITECT
↓
UI/UX
↓
FRONTEND + BACKEND + MOBILE
↓
QA
↓
FIX LOOP
↓
SECURITY
↓
RED TEAM
↓
DEVOPS
↓
STAGING
↓
CEO APPROVAL
↓
PRODUCTION
```

Nếu QA fail:

```text
QA
↓
BUG
↓
CTO
↓
ASSIGN OWNER
↓
FIX
↓
QA RETEST
```

---

# 5. Telegram Bot

## 5.1. Commands

```text
/start
/newproject
/status
/projects
/tasks
/agents
/bugs
/cost
/report
/pause
/resume
/approve
/reject
/deploy
/help
```

Bot phải hỗ trợ cả **natural language**.

Ví dụ:

> Tạo app quản lý quán cafe, mobile, có order tại bàn, thu ngân và báo cáo doanh thu.

CTO phải tự hiểu và tạo project.

---

## 5.2. Telegram approval

Ví dụ:

```text
⚠️ CTO cần quyết định

QA đã hoàn tất.
Security: PASS
Build: PASS

Deploy Production?

[ ✅ Deploy ]
[ ⏸ Giữ staging ]
[ ❌ Hủy ]
```

---

## 5.3. Attachment

Bot phải nhận:

- Image
- PDF
- Word
- Excel
- ZIP
- Voice
- Text file

Attachment phải được:

1. Download
2. Lưu object storage
3. Gắn vào project
4. Index metadata
5. Chuyển cho Agent phù hợp

---

# 6. Dashboard Web 3D

## 6.1. Concept

Giao diện chính phải là **một văn phòng công ty phần mềm thu nhỏ dạng 3D isometric**.

Góc camera:

- Nhìn từ trên xuống
- Góc nghiêng khoảng 35–45 độ
- Cutaway building
- Bỏ phần mái
- Quan sát rõ từng phòng

Phong cách:

- Premium
- Modern technology office
- Dark mode
- Cinematic lighting
- High detail
- Không cartoon trẻ con
- Không game fantasy

---

# 7. Các khu vực trong văn phòng 3D

Tối thiểu có:

1. CEO / Command Center
2. Product Department
3. Business Analysis
4. UI/UX Studio
5. Frontend Team
6. Backend Team
7. Mobile Team
8. QA Lab
9. Security Operations
10. DevOps / Deployment
11. Meeting Room

Mỗi phòng có:

- bảng tên
- workstation
- monitor
- nhân vật AI
- trạng thái
- lighting state
- task indicator

---

# 8. Nhân vật 3D phải chuyển động thật

Đây là **yêu cầu bắt buộc**.

Không dùng nhân vật đứng yên như hình minh họa.

Mỗi nhân vật phải là 3D model có animation state.

Khuyến nghị:

- GLTF / GLB
- Rigged character
- React Three Fiber
- Three.js
- AnimationMixer
- State machine

---

## 8.1. Animation states

Mỗi Agent có ít nhất:

```text
idle
working
reviewing
meeting
blocked
alert
completed
celebrate
offline
```

---

## 8.2. Idle

Khi không có task:

- gõ bàn phím nhẹ
- nhìn màn hình
- đổi tư thế
- quay đầu nhẹ
- uống nước
- idle breathing

Không được đứng im hoàn toàn.

---

## 8.3. Working

Khi task chuyển:

```text
todo → doing
```

Nhân vật phải:

- bắt đầu gõ phím
- monitor hiển thị activity
- posture tập trung
- animation nhanh hơn idle
- desk lighting sáng hơn

---

## 8.4. Reviewing

Khi:

```text
doing → review
```

Animation:

- xem nhiều monitor
- chỉ vào màn hình
- đọc tài liệu
- trao đổi với Agent gần đó nếu cần

---

## 8.5. Blocked

Khi task bị blocked:

- animation chậm
- nhìn qua lại
- icon warning
- màu ambient thay đổi nhẹ
- trạng thái visible trên UI

---

## 8.6. Bug

QA tạo bug:

- phòng QA có alert animation
- developer owner có indicator
- bug counter cập nhật realtime

---

## 8.7. Completed

Khi task done:

- Agent dừng working
- animation completed
- notification nhỏ
- progress project cập nhật
- sau vài giây quay về idle hoặc nhận task mới

---

## 8.8. Deploy success

DevOps:

- monitor chuyển trạng thái xanh
- animation celebrate ngắn
- deploy room lighting pulse
- Telegram gửi notification

---

# 9. Animation phải gắn với dữ liệu thật

Không được chạy animation random không liên quan backend.

Ví dụ:

```ts
agent.status === "working"
→ play("typing")

agent.status === "reviewing"
→ play("review")

agent.status === "blocked"
→ play("blocked")

agent.status === "completed"
→ play("complete")
```

Trạng thái lấy realtime từ backend.

---

# 10. Camera

Yêu cầu:

- Pan
- Zoom
- Orbit giới hạn
- Click room
- Click agent
- Focus camera
- Reset camera

Double click Agent:

- Camera zoom
- mở Agent Detail Panel

---

# 11. Agent Detail Panel

Khi click nhân vật:

Hiển thị:

```text
Agent
Role
Status
Current Project
Current Task
Task Progress
Started At
Runtime
Model
Token usage
Estimated Cost
Git branch
Recent actions
Logs
```

Buttons:

```text
Chat
Pause
Resume
Open Task
Open Logs
Open Code
```

---

# 12. Project Detail

Project page phải có:

- Overview
- Progress
- Timeline
- Agent activity
- Task board
- Bug board
- Artifact
- Repository
- Deploy
- Costs
- Logs
- Decisions

---

# 13. Task Board

Kanban:

```text
BACKLOG
TODO
DOING
REVIEW
QA
BLOCKED
DONE
```

Task có:

- ID
- Title
- Project
- Owner
- Priority
- Dependency
- Status
- Cost
- Tokens
- Started
- Completed
- Artifact
- Git commit
- PR

---

# 14. Database

Khuyến nghị:

PostgreSQL / Supabase.

Tables:

```text
users
projects
agents
tasks
task_dependencies
agent_runs
messages
artifacts
bugs
approvals
deployments
cost_records
git_events
notifications
attachments
audit_logs
```

---

# 15. Agent model routing

Không dùng model mạnh nhất cho mọi việc.

Ví dụ:

```text
CTO                 → strong model
Architect           → strong model
Security            → strong model

PM                  → medium
BA                  → medium
QA                  → medium

formatter           → cheap
classification      → cheap
summarization       → cheap
```

Model phải configurable.

Không hard-code vendor.

Interface:

```ts
interface LLMProvider {
  generate()
  stream()
  estimateCost()
}
```

Hỗ trợ mở rộng:

- Anthropic
- OpenAI
- Google

---

# 16. Cost Tracking

Mỗi request ghi:

```text
agent
project
task
provider
model
input_tokens
output_tokens
cached_tokens
cost
timestamp
```

Dashboard hiển thị:

- Today
- Month
- By project
- By agent
- By model
- By provider

Có budget limit.

Ví dụ:

```text
project_budget = $20
```

Nếu đạt 80%:

Telegram alert.

Nếu đạt 100%:

Pause Agent tự động nếu policy yêu cầu.

---

# 17. GitHub Integration

Mỗi project tương ứng repo.

Agent workflow:

```text
create branch
↓
edit
↓
test
↓
commit
↓
push
↓
pull request
↓
review
↓
merge
```

Không cho Agent commit trực tiếp production branch mặc định.

Branch convention:

```text
feature/*
fix/*
agent/*
release/*
```

---

# 18. Execution Sandbox

Coding Agent không được chạy trực tiếp trên host production.

Dùng:

- Docker container
- isolated workspace
- resource limit
- timeout
- network policy

Mỗi Agent run phải có:

```text
run_id
task_id
workspace
command log
stdout
stderr
exit code
```

---

# 19. Secret Management

Không lưu API key plaintext trong database.

Dùng:

- environment variable
- secret manager
- encrypted storage

Không render secret lên frontend.

Không gửi secret vào Telegram.

---

# 20. Permission model

RBAC.

Vai trò:

```text
CEO
CTO
AGENT
VIEWER
SYSTEM
```

Agent chỉ có quyền tối thiểu cần thiết.

Ví dụ:

Frontend Agent:

```text
READ frontend
WRITE frontend
RUN tests
CREATE branch
CREATE PR

DENY production database
DENY secrets
DENY production deploy
```

---

# 21. Event Architecture

Nên sử dụng event-driven architecture.

Events:

```text
PROJECT_CREATED
TASK_CREATED
TASK_STARTED
TASK_COMPLETED
TASK_FAILED
BUG_CREATED
AGENT_STARTED
AGENT_STOPPED
APPROVAL_REQUIRED
APPROVED
DEPLOY_STARTED
DEPLOY_SUCCESS
DEPLOY_FAILED
```

Frontend subscribe realtime.

Animation 3D phản ứng theo event.

---

# 22. Realtime

Khuyến nghị:

- WebSocket
- Supabase Realtime
- hoặc event gateway riêng

Ví dụ:

```text
TASK_STARTED
↓
agent status working
↓
frontend receives event
↓
3D character animation → working
```

---

# 23. Tech Stack đề xuất

## Frontend

```text
Next.js
TypeScript
Tailwind CSS
React Three Fiber
Three.js
Framer Motion
Zustand
TanStack Query
```

## Backend

```text
Node.js / TypeScript
Fastify hoặc NestJS
PostgreSQL
Redis
BullMQ
```

## AI

```text
Provider abstraction
Anthropic
OpenAI
Google
```

## Infrastructure

```text
Docker
GitHub
GitHub Actions
Vercel
Supabase
VPS
```

---

# 24. UI Layout

Desktop:

```text
┌──────────────────────────────────────────────────────────┐
│ TOP BAR                                                  │
├──────────┬───────────────────────────────┬───────────────┤
│ SIDEBAR  │                               │ STATUS PANEL  │
│          │        3D OFFICE              │               │
│          │                               │ Agents        │
│ Projects │                               │ Cost          │
│ Agents   │                               │ Alerts        │
│ Tasks    │                               │               │
│ Bugs     │                               │               │
│ Deploy   │                               │               │
│ Costs    │                               │               │
├──────────┴───────────────────────────────┴───────────────┤
│ KPI BAR                                                  │
└──────────────────────────────────────────────────────────┘
```

---

# 25. Sidebar

```text
Tổng quan
Dự án
Agent
Task
Bug
Deploy
Chi phí AI
Báo cáo
Cài đặt
```

---

# 26. CEO Command Center

Phải có một chat interface riêng.

CEO có thể nhập:

> Thêm đăng nhập Google cho project Cafe.

CTO trả:

```text
Tôi đề xuất:

Backend:
- OAuth config
- account linking

Frontend:
- Google login button

QA:
- login flow
- duplicate email test

Estimated cost: $1.40

[ APPROVE ]
[ EDIT ]
[ CANCEL ]
```

---

# 27. Approval system

Những việc cần approval mặc định:

- Architecture breaking change
- Production deploy
- Database destructive migration
- Production delete
- Budget vượt limit
- Secret / permission escalation

---

# 28. Audit Log

Mọi hành động quan trọng phải log:

```text
timestamp
actor
agent
project
task
action
input
output
result
cost
```

---

# 29. Báo cáo CEO

Daily/Project report:

```text
Project Progress
Tasks Completed
Tasks Blocked
Bugs
Security
Deploy
Costs
Risks
Next Actions
```

Có thể gửi Telegram.

---

# 30. Hiệu năng 3D

Không hy sinh performance để lấy hình đẹp.

Yêu cầu:

- GLTF compression
- Draco
- texture optimization
- instancing
- LOD
- lazy loading
- shadow optimization

Desktop target:

```text
60 FPS preferred
30 FPS minimum
```

Có Quality Settings:

```text
Low
Medium
High
Ultra
```

---

# 31. Mobile Dashboard

Mobile không cần render full 3D Ultra.

Mobile:

- simplified scene
- agent cards
- project status
- approvals
- cost
- alerts

Telegram vẫn là primary quick control.

---

# 32. Fallback 2D

Nếu WebGL unsupported:

Hiển thị 2D dashboard thay vì crash.

---

# 33. Visual Style

Thiết kế giống:

- premium command center
- modern SaaS dashboard
- miniature 3D tech office
- professional enterprise software

Màu:

- dark navy
- charcoal
- violet accent
- blue accent
- green status
- orange warning
- red critical

Không lạm dụng neon.

---

# 34. Không được làm

Không:

- mock fake Agent state
- fake progress
- random animation không gắn backend
- hard-code demo data production
- cho Agent quyền root vô hạn
- expose API key
- deploy tự do
- bỏ audit log
- bỏ cost tracking
- xây UI đẹp nhưng Agent orchestration giả

---

# 35. MVP — Phase 1

Xây:

- Authentication
- Project
- CTO Agent
- PM Agent
- Developer Agent
- QA Agent
- Telegram Bot
- Task system
- Basic GitHub integration
- Cost tracking
- 2D Dashboard
- Basic 3D office
- Character states: idle/working/done

Mục tiêu:

Chạy được end-to-end một project đơn giản.

---

# 36. Phase 2

Thêm:

- BA
- Architect
- UI/UX
- Backend/Frontend split
- Security
- DevOps
- Approval
- Realtime
- Full 3D rooms
- Advanced animation
- Agent Detail Panel

---

# 37. Phase 3

Thêm:

- Red Team
- Multi-project scheduling
- Cost optimizer
- Agent performance scoring
- Model auto-routing
- Knowledge base
- Voice Telegram
- Mobile companion
- Advanced analytics

---

# 38. Phase 4

Mục tiêu autonomous company:

```text
CEO gives goal
↓
company produces software
↓
CEO reviews milestones only
```

Agent tự:

- plan
- design
- code
- test
- debug
- optimize
- document
- deploy staging

Production vẫn có governance.

---

# 39. Tiêu chí nghiệm thu

Dự án chỉ được coi hoàn tất khi:

## Telegram

- Nhận được task
- Tạo project
- Status
- Approval
- Notification
- File intake

## Agent

- Workflow thật
- State thật
- Queue thật
- Artifact thật
- Cost thật

## Development

- Git branch
- Commit
- PR
- Test
- QA loop

## Dashboard

- Project realtime
- Agent realtime
- Cost
- Task
- Bug
- Deploy

## 3D

- Isometric office
- Multiple rooms
- Animated characters
- State-driven animations
- Click Agent
- Camera focus
- performant

---

# 40. Quy tắc cho Claude Code khi triển khai

Claude Code phải:

1. Đọc toàn bộ file này trước khi code.
2. Tạo `IMPLEMENTATION_PLAN.md`.
3. Chia phase.
4. Không code toàn hệ thống trong một commit.
5. Tạo foundation trước.
6. Sau mỗi module:
   - lint
   - typecheck
   - test
7. Ghi changelog.
8. Không tự ý bỏ requirement.
9. Nếu một requirement quá lớn:
   - giữ interface
   - tạo implementation phase sau
10. Không fake implementation.

---

# 41. Cấu trúc repo gợi ý

```text
/apps
  /web
  /api
  /telegram-bot
  /worker

/packages
  /agents
  /orchestrator
  /llm
  /database
  /events
  /permissions
  /shared
  /ui
  /three-office

/infrastructure
  /docker
  /github-actions

/docs
  ARCHITECTURE.md
  DATABASE_SCHEMA.md
  SECURITY.md
  AGENTS.md
```

---

# 42. Yêu cầu cuối cùng

Đây không phải chỉ là dashboard theo dõi chatbot.

Sản phẩm phải tạo cảm giác:

> “Tôi đang điều hành một công ty phần mềm AI thực sự.”

Người dùng phải nhìn thấy:

- Ai đang làm
- Đang làm gì
- Cho project nào
- Task nào
- Bao lâu
- Chi phí bao nhiêu
- Có lỗi không
- Ai đang chờ ai
- Khi nào cần CEO quyết định

Phần 3D phải là **digital twin trực quan của Agent state thật**.

Telegram là **remote control**.

Dashboard là **control room**.

CTO Agent là **bộ não điều phối**.

Các Agent còn lại là **nhân sự AI chuyên môn hóa**.

GitHub + Sandbox + CI/CD là **nhà máy sản xuất phần mềm**.

---

# 43. Definition of Done

Một bản V1 tốt phải cho phép CEO:

1. Gửi yêu cầu qua Telegram.
2. CTO tạo project.
3. Agent tự tạo task.
4. Coding Agent tạo code trong sandbox.
5. QA kiểm tra.
6. Fix loop hoạt động.
7. Code được push lên Git.
8. Dashboard cập nhật realtime.
9. Nhân vật 3D đổi animation theo Agent state thật.
10. CEO nhận thông báo khi cần approval.
11. Có báo cáo cost.
12. Có staging deploy.
13. Production deploy phải kiểm soát.

---


---

# 44. API CENTER / INTEGRATION CENTER — BẮT BUỘC

Hệ thống phải có một khu vực cấu hình tập trung:

```text
Cài đặt
└── API & Integrations
    ├── AI Providers
    ├── Telegram
    ├── GitHub
    ├── Database
    ├── Deployment
    ├── App Stores
    ├── Storage
    ├── Email
    ├── Webhooks
    └── Cost & Limits
```

Mục tiêu:

- Người dùng không phải chỉnh `.env` thủ công cho các cấu hình thông thường.
- Có thể thêm, sửa, test, bật/tắt từng integration ngay trên giao diện.
- Secret phải được lưu an toàn.
- Không expose secret ra frontend sau khi lưu.
- Không gửi secret vào Telegram, log hoặc Agent prompt.
- Mọi thay đổi integration quan trọng phải có audit log.

---

# 45. AI PROVIDERS

## 45.1. Provider bắt buộc hỗ trợ

Thiết kế hệ thống provider abstraction để hỗ trợ tối thiểu:

```text
Anthropic
OpenAI
Google Gemini
```

Kiến trúc phải mở rộng được thêm provider mới mà không sửa logic Agent cốt lõi.

Ví dụ interface:

```ts
interface LLMProvider {
  id: string
  name: string

  listModels(): Promise<ModelInfo[]>

  testConnection(): Promise<ConnectionTestResult>

  generate(request: LLMRequest): Promise<LLMResponse>

  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>

  estimateCost(usage: TokenUsage, model: string): Promise<number>
}
```

Không hard-code model trong source code Agent.

---

# 46. GIAO DIỆN AI PROVIDERS

Trang:

```text
Settings
→ API & Integrations
→ AI Providers
```

Mỗi provider hiển thị dạng card.

Ví dụ:

```text
┌────────────────────────────────────────┐
│ Anthropic                              │
│ 🟢 Connected                          │
│                                        │
│ API Key                                │
│ sk-ant-••••••••••••••                  │
│                                        │
│ Default model                          │
│ Claude Sonnet ▼                        │
│                                        │
│ [ Test Connection ]                    │
│ [ Edit ] [ Disable ]                   │
└────────────────────────────────────────┘
```

Trạng thái:

```text
Not configured
Testing
Connected
Warning
Authentication error
Rate limited
Unavailable
Disabled
```

---

# 47. API KEY MANAGEMENT

Khi nhập API key:

1. Frontend gửi qua HTTPS.
2. Backend validation.
3. Test provider nếu người dùng yêu cầu.
4. Encrypt trước khi lưu.
5. Sau khi lưu không trả raw secret về frontend.
6. UI chỉ hiển thị masked key.

Ví dụ:

```text
sk-ant-••••••••••••7Qx9
```

Chỉ hiển thị tối đa vài ký tự cuối nếu cần nhận diện.

Không bao giờ có endpoint:

```text
GET /api/secrets/raw
```

---

# 48. TEST CONNECTION

Mọi integration hỗ trợ được phải có:

```text
[ Test Connection ]
```

Kết quả ví dụ:

```text
✅ Connected
Provider: Anthropic
Model access: OK
Latency: 842 ms
Checked: 14:32:10
```

Hoặc:

```text
❌ Authentication failed

API key không hợp lệ hoặc đã hết hiệu lực.
```

Không dùng test connection để tiêu tốn nhiều token.

Test AI provider chỉ cần một request rất nhỏ hoặc provider endpoint phù hợp.

---

# 49. MODEL DISCOVERY

Nếu provider hỗ trợ lấy danh sách model:

- fetch danh sách model thật
- cache kết quả
- cho user refresh

Nếu provider không hỗ trợ:

- dùng model catalog cấu hình trong hệ thống
- catalog phải tách khỏi Agent logic

UI:

```text
Provider: Anthropic

Available Models
✓ Claude Sonnet
✓ Claude Opus
✓ Claude Haiku
```

Model unavailable phải được đánh dấu.

---

# 50. MODEL ROUTING PER AGENT

Trang:

```text
Settings
→ AI Routing
```

Người dùng có thể chọn model riêng cho từng Agent.

Ví dụ:

```text
CTO
Primary: Claude Sonnet
Fallback: GPT
Budget mode: Quality

Architect
Primary: Claude Sonnet
Fallback: GPT

Developer
Primary: Claude Sonnet
Fallback: GPT

QA
Primary: Gemini
Fallback: Claude

Formatter
Primary: Cheap Model
```

Không bắt buộc mọi Agent dùng cùng provider.

---

# 51. ROUTING MODES

Hỗ trợ tối thiểu:

```text
Quality
Balanced
Economy
Custom
```

## Quality

Ưu tiên model mạnh.

## Balanced

Cân bằng chất lượng và chi phí.

## Economy

Ưu tiên model rẻ.

## Custom

CEO tự chọn model cho từng Agent.

---

# 52. AUTOMATIC MODEL ROUTER

Cho phép bật:

```text
☑ Smart Model Routing
```

Router có thể xét:

- task type
- complexity
- Agent role
- context size
- budget remaining
- previous failure
- rate limit
- provider availability

Ví dụ:

```text
Simple classification
→ cheap model

Architecture review
→ strong model

Large code debugging
→ strong coding model

Summary
→ cheap model
```

---

# 53. PROVIDER FALLBACK

Cấu hình:

```text
Anthropic
↓
OpenAI
↓
Gemini
```

Fallback chỉ kích hoạt khi phù hợp:

- provider outage
- rate limit
- temporary error
- configured policy

Không fallback im lặng khi:

- request có yêu cầu compliance đặc biệt
- model capability không tương đương
- budget policy không cho phép

Phải log:

```text
Primary provider failed
Fallback provider selected
Reason
Cost impact
```

---

# 54. AI BUDGET CONTROL

Settings:

```text
AI Budget
```

Cho phép cấu hình:

```text
Monthly company budget
Daily budget
Per-project budget
Per-Agent budget
Per-task maximum
```

Ví dụ:

```text
Company monthly limit: $100

Project default limit: $20

Alert:
70%
80%
90%

Hard stop:
100%
```

---

# 55. BUDGET POLICY

Hỗ trợ:

```text
Warn only
Require CEO approval
Pause project
Pause Agent
Hard stop AI requests
```

Ví dụ:

```text
80%
→ Telegram warning

95%
→ CTO switches to Economy mode

100%
→ pause project
→ request CEO approval
```

---

# 56. TOKEN LIMIT

Có thể cấu hình:

```text
Max context per Agent
Max output tokens
Max retries
Max Agent iterations
Max task runtime
```

Mục tiêu chống:

- runaway loop
- token explosion
- Agent tự gọi nhau vô hạn
- task chạy mãi

---

# 57. TELEGRAM INTEGRATION SETTINGS

Trang:

```text
Settings
→ Telegram
```

Fields:

```text
Bot Token
Allowed Telegram User IDs
Allowed Group IDs
Webhook URL
Notification preferences
```

Actions:

```text
Test Bot
Set Webhook
Remove Webhook
Send Test Message
```

---

# 58. TELEGRAM SECURITY

Không cho bất kỳ Telegram user nào điều khiển hệ thống chỉ vì biết bot username.

Phải có allowlist:

```text
telegram_user_id
role
permissions
enabled
```

Ví dụ:

```text
CEO
→ full control

Viewer
→ status only
```

Sensitive actions:

```text
deploy production
delete project
increase budget
change API keys
permission escalation
```

phải yêu cầu authorization phù hợp.

---

# 59. GITHUB INTEGRATION SETTINGS

Trang:

```text
Settings
→ GitHub
```

Hỗ trợ ưu tiên:

```text
GitHub App
```

Fallback:

```text
Personal Access Token
```

Có:

```text
Connect GitHub
Test Connection
Repository Access
Default Organization
Default Branch Policy
PR Policy
```

---

# 60. GITHUB PERMISSIONS

Không yêu cầu quyền rộng hơn mức cần thiết.

Tách quyền:

```text
Read repository
Write code
Create branch
Create commit
Create PR
Read CI
Trigger CI
Merge PR
```

Production merge có thể yêu cầu CEO approval.

---

# 61. SUPABASE / DATABASE SETTINGS

Trang:

```text
Settings
→ Database
```

Fields tùy mode:

```text
Supabase URL
Anon Key
Service Role Key
Database URL
```

Service Role Key:

- chỉ backend được dùng
- không gửi frontend
- không expose Agent nếu task không cần

Actions:

```text
Test Database
Test Auth
Test Storage
Test Realtime
```

---

# 62. VERCEL / DEPLOYMENT SETTINGS

Trang:

```text
Settings
→ Deployment
```

Có thể cấu hình:

```text
Vercel Token
Team ID
Project ID
Staging domain
Production domain
```

Actions:

```text
Test Connection
Deploy Preview
Deploy Staging
```

Production deploy:

```text
Require approval = ON
```

mặc định.

---

# 63. APP STORE CONNECT

Trang:

```text
Settings
→ App Stores
→ Apple
```

Hỗ trợ lưu cấu hình phục vụ automation:

```text
Issuer ID
Key ID
Private Key
Team ID
Bundle ID defaults
```

Secret/private key phải mã hóa.

Không bắt buộc V1 tự publish App Store.

Kiến trúc phải sẵn sàng cho:

```text
build
sign
TestFlight
metadata
release workflow
```

---

# 64. GOOGLE PLAY CONSOLE

Trang:

```text
Settings
→ App Stores
→ Google Play
```

Cấu hình:

```text
Service Account
Package Name defaults
Track
```

Track:

```text
internal
closed
open
production
```

Production release phải hỗ trợ approval.

---

# 65. OBJECT STORAGE

Integration:

```text
Supabase Storage
S3-compatible Storage
```

Dùng để lưu:

- Telegram attachment
- screenshots
- QA evidence
- design artifact
- build artifact
- report

Phải có:

```text
bucket policy
file size limit
content type validation
signed URL
expiration
```

---

# 66. EMAIL / SMTP

Optional integration:

```text
SMTP
```

Fields:

```text
Host
Port
Username
Password
From
TLS
```

Dùng cho:

- alert
- report
- deployment notification

Không bắt buộc nếu Telegram đã đủ.

---

# 67. WEBHOOKS

Cho phép cấu hình outbound webhook.

Events:

```text
PROJECT_CREATED
TASK_FAILED
BUG_CRITICAL
APPROVAL_REQUIRED
DEPLOY_SUCCESS
DEPLOY_FAILED
BUDGET_ALERT
```

Mỗi webhook:

```text
URL
Secret
Subscribed Events
Enabled
```

Webhook secret phải được ký HMAC.

---

# 68. INTEGRATION HEALTH DASHBOARD

Dashboard:

```text
SYSTEM HEALTH
```

Ví dụ:

```text
Anthropic      🟢
OpenAI         🟢
Gemini         🟢

Telegram       🟢
GitHub         🟢
Supabase       🟢
Vercel         🟡

Redis          🟢
Workers        🟢
```

Click từng service để xem:

```text
Last check
Latency
Last error
Request count
Rate limit
```

---

# 69. SECRET STORAGE

Production không được lưu secret plaintext.

Thiết kế abstraction:

```ts
interface SecretStore {
  set(key: string, secret: string): Promise<void>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
}
```

Không nên có API đọc raw secret trở lại.

Có thể triển khai bằng:

- encrypted database values
- cloud secret manager
- Vault-compatible solution

Tách encryption key khỏi database.

---

# 70. SECRET ROTATION

Cho phép:

```text
Replace API Key
```

Flow:

1. nhập key mới
2. test key
3. lưu encrypted
4. invalidate cache
5. audit
6. không làm lộ key cũ

---

# 71. AUDIT API SETTINGS

Mọi thay đổi phải log:

```text
actor
integration
action
timestamp
result
source
```

Ví dụ:

```text
CEO
Anthropic
API_KEY_UPDATED
```

Không log raw secret.

---

# 72. API CENTER UX

Trang tổng:

```text
API & INTEGRATIONS

AI
[ Anthropic ] 🟢
[ OpenAI    ] 🟢
[ Gemini    ] ⚪

COMMUNICATION
[ Telegram ] 🟢

DEVELOPMENT
[ GitHub   ] 🟢

DATA
[ Supabase ] 🟢

DEPLOY
[ Vercel ] 🟢

APP STORES
[ Apple ] ⚪
[ Google Play ] ⚪
```

Card có:

```text
Status
Last checked
Configure
Test
Disable
```

---

# 73. SETUP WIZARD

Lần chạy đầu tiên phải có:

```text
Welcome to P&N
```

Wizard:

```text
Step 1
Create CEO Account

Step 2
Connect AI Provider

Step 3
Connect Telegram

Step 4
Connect GitHub

Step 5
Configure Database

Step 6
Deployment

Step 7
Run System Test
```

Không bắt buộc cấu hình mọi integration ngay.

Có:

```text
Skip for now
```

với integration optional.

---

# 74. SYSTEM READINESS CHECK

Có nút:

```text
Run System Check
```

Kiểm tra:

```text
Database
Redis
Worker
AI provider
Telegram
GitHub
Storage
Deployment
Realtime
```

Kết quả:

```text
9 Passed
1 Warning
0 Failed
```

---

# 75. CONNECTION ERROR UX

Không chỉ hiện:

```text
Error 500
```

Phải diễn giải:

```text
GitHub authentication failed.

Có thể do:
- token hết hạn
- thiếu repository permission
- GitHub App chưa được install

[ Reconfigure ]
[ Test Again ]
```

---

# 76. ENVIRONMENT MANAGEMENT

Hỗ trợ:

```text
Development
Staging
Production
```

Integration có thể khác nhau theo environment.

Ví dụ:

```text
Supabase Dev
Supabase Production
```

Production secret phải tách biệt.

---

# 77. PROVIDER USAGE DASHBOARD

Mỗi provider hiển thị:

```text
Requests
Tokens
Errors
Average latency
Cost
Cost trend
```

Theo:

```text
today
7 days
30 days
project
Agent
```

---

# 78. RATE LIMIT MANAGEMENT

Hệ thống phải nhận biết:

```text
429
rate limit headers
retry-after
```

Worker:

- backoff
- retry có giới hạn
- fallback nếu policy cho phép
- không retry storm

---

# 79. API RETRY POLICY

Config:

```text
max_retries
backoff
timeout
circuit_breaker
```

Không cho Agent tự retry vô hạn.

---

# 80. CIRCUIT BREAKER

Nếu một provider lỗi liên tục:

```text
Closed
→ Open
→ Half-open
→ Closed
```

Trong thời gian Open:

- không spam provider
- dùng fallback nếu có
- báo System Health

---

# 81. API REQUEST LOGGING

Log metadata:

```text
request_id
provider
model
agent_id
project_id
task_id
latency
tokens
cost
status
error_type
```

Không log:

```text
API key
password
private key
full sensitive payload
```

---

# 82. PROMPT PRIVACY

Agent prompt phải tránh gửi secret vào LLM.

Trước khi gọi LLM:

- sanitize environment
- redact secret patterns
- không attach `.env`
- không attach credential files trừ khi workflow được thiết kế đặc biệt

Coding Agent phải có deny list:

```text
.env
*.pem
*.key
credentials.json
service-account.json
```

trừ khi policy cho phép rõ ràng.

---

# 83. SETTINGS PERMISSIONS

Chỉ:

```text
CEO
Admin
```

được chỉnh:

```text
API keys
provider routing
budget
production deployment credentials
app store credentials
```

Agent không được tự thay API configuration.

---

# 84. API CONFIG BACKUP

Backup config không được chứa plaintext secrets.

Export config:

```json
{
  "anthropic": {
    "enabled": true,
    "secretConfigured": true
  }
}
```

Không export API key.

---

# 85. DEVELOPMENT MODE

Trong development có thể dùng:

```text
.env.local
```

nhưng production phải dùng secure secret storage.

Claude Code phải tạo:

```text
.env.example
```

chỉ chứa tên biến:

```text
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
TELEGRAM_BOT_TOKEN=
```

Không commit secret thật.

---

# 86. UPDATED SIDEBAR

Sidebar chính cập nhật:

```text
🏠 Tổng quan
📁 Dự án
🤖 Agent
📋 Task
🐞 Bug
🚀 Deploy
💰 Chi phí AI
📊 Báo cáo

⚙️ Cài đặt
   ├── AI Providers
   ├── AI Routing
   ├── Telegram
   ├── GitHub
   ├── Database
   ├── Deployment
   ├── App Stores
   ├── Storage
   ├── Webhooks
   ├── Budget & Limits
   ├── Security
   └── System Health
```

---

# 87. UPDATED MVP REQUIREMENTS

MVP bắt buộc có API Center tối thiểu:

```text
Anthropic/OpenAI/Gemini configuration
Test Connection
Default model
Per-Agent model routing
Telegram token configuration
GitHub configuration
Database configuration
Encrypted secret storage
Cost tracking
Budget
System health
```

App Store / Google Play automation có thể để Phase 2 nhưng UI và data model phải chuẩn bị sẵn.

---

# 88. API CENTER ACCEPTANCE CRITERIA

Chỉ coi module hoàn tất khi:

1. User nhập API key được.
2. Key được lưu encrypted.
3. Refresh trang không trả raw key.
4. Test Connection hoạt động.
5. Có status Connected/Error.
6. Có thể disable provider.
7. Có thể chọn model mặc định.
8. Có thể chọn model theo Agent.
9. Có fallback.
10. Có cost tracking.
11. Có budget limit.
12. Có Telegram config.
13. Có GitHub config.
14. Có Database config.
15. Có System Health.
16. Có audit log.
17. Không secret nào xuất hiện trong client bundle/log.
18. Coding Agent không được đọc `.env` mặc định.
19. Production credentials chỉ Agent phù hợp được dùng.
20. Có setup wizard cho lần chạy đầu.

---

# 89. CHỈ DẪN BỔ SUNG CHO CLAUDE CODE

Khi triển khai API Center:

- Không hard-code key.
- Không để secret trong repository.
- Không trả raw secret từ API.
- Không fake test connection.
- Không bỏ encryption với lý do MVP.
- Không cho frontend gọi provider AI trực tiếp bằng secret.
- Mọi AI request phải đi qua backend gateway.
- Model routing phải cấu hình được.
- Provider phải plug-in được.
- Cost phải ghi theo từng Agent / Project / Task.
- Phải có integration test cho secret redaction.
- Phải có test xác nhận secret không xuất hiện trong API response.

---

# 90. UPDATED PRODUCT VISION

Kiến trúc cuối cùng:

```text
                    CEO
                     │
               TELEGRAM BOT
                     │
                     ▼
              CTO ORCHESTRATOR
                     │
       ┌─────────────┼─────────────┐
       │             │             │
      PM           DEV            QA
       │             │             │
       └─────────────┼─────────────┘
                     │
                AI GATEWAY
                     │
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
   Anthropic       OpenAI        Gemini

                     │
               API / INTEGRATION
                    CENTER
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
     GitHub       Supabase       Vercel
                                      │
                           App Store / Play
```

Dashboard 3D là digital twin trực quan.

Telegram là remote control.

CTO là orchestration brain.

AI Gateway quản lý model, cost, retry, fallback.

Integration Center quản lý các kết nối ngoài.

Secret Store bảo vệ credentials.

GitHub + Sandbox + CI/CD là software factory.

---


---

# 91. MỞ RỘNG PHẠM VI: DIGITAL PRODUCT COMPANY

Hệ thống không chỉ phục vụ phát triển phần mềm truyền thống.

Công ty AI phải có khả năng sản xuất nhiều loại sản phẩm số:

```text
Website
Landing Page
Corporate Website
E-commerce Website
Web Application
SaaS
Internal Tool
Desktop Application
Mobile Application
API Service
Automation Tool
Dashboard
Admin Portal
AI Tool
AI Agent Product
Browser-based Utility
Progressive Web App
```

Khi CEO tạo project, CTO phải tự nhận diện loại sản phẩm.

Ví dụ:

```text
Tạo website giới thiệu công ty nội thất.
```

CTO phải classify:

```text
product_type = corporate_website
```

Ví dụ:

```text
Tạo app quản lý quán cafe dùng trên Android và iPhone.
```

CTO classify:

```text
product_type = mobile_application
```

Ví dụ:

```text
Tạo hệ thống quản lý nhân viên chạy trên trình duyệt.
```

CTO classify:

```text
product_type = web_application
```

---

# 92. PRODUCT TYPE ROUTING

CTO phải chọn workflow phù hợp theo loại sản phẩm.

## Corporate Website

```text
PM
→ BA nhẹ
→ Content/Research
→ UI/UX
→ Frontend
→ SEO
→ QA
→ Security
→ Deploy
```

## Web Application

```text
PM
→ BA
→ Architect
→ UI/UX
→ Frontend
→ Backend
→ QA
→ Security
→ DevOps
```

## Mobile Application

```text
PM
→ BA
→ Architect
→ UI/UX
→ Mobile
→ Backend
→ QA
→ Security
→ Store Release
```

## Landing Page

```text
PM
→ Copy/Content
→ UI/UX
→ Frontend
→ SEO
→ QA
→ Deploy
```

Không ép mọi project chạy qua cùng một pipeline nếu không cần thiết.

---

# 93. WEB DEVELOPMENT DEPARTMENT

Bổ sung một bộ phận riêng:

```text
🌐 WEB DEVELOPMENT DEPARTMENT
```

Bao gồm:

```text
Web Product Lead
Frontend Web Agent
Web Performance Agent
SEO Agent
Accessibility Agent
Content Integration Agent
Web QA Agent
```

---

# 94. WEB PRODUCT LEAD

Nhiệm vụ:

- xác định loại website
- xác định information architecture
- xác định page hierarchy
- xác định conversion goal
- phối hợp Content + UI/UX + Frontend + SEO

Output:

```text
WEB_SCOPE.md
SITEMAP.md
PAGE_REQUIREMENTS.md
```

---

# 95. SEO AGENT

Nhiệm vụ:

- Technical SEO
- Metadata
- OpenGraph
- Structured data
- Sitemap
- robots.txt
- Canonical
- Internal linking
- Page title
- Description
- Basic keyword structure

Không được:

- tự tạo nội dung spam SEO
- keyword stuffing
- tạo backlink rác

Output:

```text
SEO_AUDIT.md
SEO_IMPLEMENTATION.md
```

---

# 96. WEB PERFORMANCE AGENT

Kiểm tra:

```text
Core Web Vitals
LCP
CLS
INP
Bundle size
Image optimization
Caching
Lazy loading
Font loading
```

Mục tiêu:

- website nhanh
- responsive
- tối ưu mobile
- không hy sinh UX vì animation quá nặng

---

# 97. ACCESSIBILITY AGENT

Kiểm tra:

```text
semantic HTML
keyboard navigation
focus state
contrast
ARIA
alt text
form labels
screen reader basics
```

Mục tiêu:

```text
WCAG-aware implementation
```

---

# 98. KNOWLEDGE & R&D DEPARTMENT

Bổ sung bộ phận mới:

```text
🧠 KNOWLEDGE & R&D DEPARTMENT
```

Đây là bộ phận có nhiệm vụ làm cho toàn bộ công ty AI:

> càng sử dụng lâu → càng hiểu biết hơn → càng có nhiều skill → càng làm tốt hơn.

Không cho phép tự động nạp kiến thức mới trực tiếp vào production mà không có governance.

Luồng bắt buộc:

```text
Discover
↓
Collect
↓
Validate
↓
Score
↓
Sandbox Test
↓
Department Review
↓
CEO Approval
↓
Knowledge Package
↓
Department Upgrade
↓
Versioning
↓
Performance Measurement
```

---

# 99. CÁC AGENT TRONG KNOWLEDGE & R&D

Tối thiểu có:

```text
Knowledge Director
GitHub Scout Agent
Technology Radar Agent
Skill Scout Agent
Research Agent
Knowledge Curator Agent
Security Review Agent
Sandbox Evaluation Agent
Department Trainer Agent
Knowledge Auditor Agent
```

---

# 100. KNOWLEDGE DIRECTOR AGENT

Vai trò tương đương trưởng phòng R&D.

Nhiệm vụ:

- nhận knowledge candidate từ các scout
- loại trùng
- đánh giá liên quan
- định tuyến về phòng ban phù hợp
- tạo Knowledge Review Package
- gửi CTO/CEO duyệt
- quản lý knowledge lifecycle

---

# 101. GITHUB SCOUT AGENT

Chạy theo lịch.

Nhiệm vụ:

Tìm repository mới/chất lượng cao liên quan tới:

```text
AI Agents
Frontend
Backend
Next.js
React
Flutter
Three.js
React Three Fiber
UI/UX
Testing
Security
DevOps
CI/CD
Supabase
Database
Performance
SEO
Automation
LLM orchestration
RAG
Prompt engineering
Agent memory
Tool calling
```

Nguồn chính có thể gồm:

```text
GitHub Search
GitHub Trending
GitHub Topics
Curated Awesome Lists
Official repositories
```

---

# 102. GITHUB REPOSITORY SCORING

Không được chỉ dựa vào số sao.

Mỗi repo cần scoring.

Ví dụ:

```text
Quality Score =

Relevance
+ Maintenance
+ Documentation
+ Adoption
+ Security
+ Architecture Quality
+ Test Quality
+ Recency
+ Community
```

Fields:

```text
repository
url
stars
forks
open_issues
last_commit
release_frequency
license
language
topics
security_flags
department_fit
relevance_score
quality_score
risk_score
recommendation
```

Repo nhiều sao nhưng:

- không maintain
- dependency cũ
- license không phù hợp
- security issue nghiêm trọng

thì không được đề xuất tự động.

---

# 103. TECHNOLOGY RADAR AGENT

Theo dõi công nghệ mới.

Danh mục:

```text
Adopt
Trial
Assess
Hold
```

Ví dụ:

```text
React framework
AI SDK
Agent framework
Database
Testing framework
Animation library
CI/CD technology
Security tooling
Deployment platform
```

Mỗi công nghệ mới phải ghi:

```text
What is it?
Why it matters?
Benefits
Risks
Migration impact
Department affected
Recommended action
```

---

# 104. SKILL SCOUT AGENT

Nhiệm vụ:

Tìm các:

```text
AI coding skills
agent skills
prompt packs
MCP servers
developer tools
automation patterns
testing skills
security skills
design workflows
framework best practices
```

Không tự tin tưởng skill bên ngoài.

Mỗi skill phải qua:

```text
source validation
license check
security review
content review
sandbox evaluation
```

---

# 105. RESEARCH AGENT

Theo dõi:

```text
official documentation
release notes
engineering blogs
research papers
security advisories
framework announcements
model documentation
best-practice guides
```

Ưu tiên nguồn:

1. Official documentation
2. Official repository
3. Maintainer announcement
4. Established technical source
5. Community source

Community content chỉ là supplementary evidence.

---

# 106. DAILY KNOWLEDGE DISCOVERY

Mặc định Knowledge Department chạy:

```text
DAILY
```

Khuyến nghị theo timezone cấu hình của CEO.

Mỗi ngày:

```text
1. Discover
2. Deduplicate
3. Score
4. Security screen
5. Summarize
6. Generate CEO digest
```

Không tự động upgrade department trước khi CEO duyệt nếu policy là Manual Approval.

---

# 107. CEO KNOWLEDGE DIGEST

Telegram gửi bản tóm tắt.

Ví dụ:

```text
🧠 KNOWLEDGE UPDATE — 27/08/2026

Đã quét:
• 143 GitHub repositories
• 28 technology updates
• 17 new skills

Đề xuất:
1. React Three Fiber optimization pattern
   Department: UI/3D
   Score: 92/100

2. New Playwright testing workflow
   Department: QA
   Score: 89/100

3. Agent orchestration pattern
   Department: CTO
   Score: 87/100

[ XEM TẤT CẢ ]
[ DUYỆT 1 ]
[ DUYỆT NHIỀU ]
[ BỎ QUA ]
```

---

# 108. KNOWLEDGE APPROVAL

CEO có thể chọn:

```text
Approve
Reject
Save for later
Request deeper analysis
Sandbox test again
```

Không được chỉ có Yes/No.

---

# 109. KNOWLEDGE PACKAGE

Sau khi duyệt, Knowledge Curator tạo package.

Ví dụ:

```text
knowledge_id
title
version
source
source_type
department
tags
summary
principles
implementation_examples
do
dont
security_notes
compatibility
effective_date
approved_by
```

Knowledge Package phải độc lập với raw webpage/repository.

Không copy bừa toàn bộ source.

---

# 110. DEPARTMENT KNOWLEDGE BASE

Mỗi phòng ban có knowledge base riêng.

Ví dụ:

```text
knowledge/
├── cto/
├── product/
├── ba/
├── architecture/
├── uiux/
├── frontend/
├── web/
├── backend/
├── mobile/
├── qa/
├── security/
├── devops/
└── research/
```

---

# 111. DEPARTMENT LEVEL SYSTEM

Mỗi phòng ban có:

```text
Department Level
Knowledge Score
Skill Count
Last Upgrade
Performance Score
```

Ví dụ:

```text
Frontend Department

Level: 12
Knowledge: 8,420 XP
Skills: 47
Last Upgrade: Today
Quality Score: 91
```

Đây là gamification nhưng phải dựa trên dữ liệu thật.

---

# 112. EXPERIENCE / XP SYSTEM

XP không được random.

XP có thể tăng dựa trên:

```text
approved knowledge
successful adoption
task quality
QA pass rate
bug reduction
delivery success
performance improvement
```

Không cho knowledge nhiều nhưng chất lượng thấp làm level tăng giả.

---

# 113. DEPARTMENT UPGRADE

Khi một knowledge package được duyệt:

```text
CEO Approved
↓
Department Trainer
↓
Create new skill/profile version
↓
Sandbox evaluation
↓
Activate
```

Ví dụ:

```text
Frontend Agent Profile

v1.8
↓
v1.9

Added:
- new React performance patterns
- image optimization policy
```

---

# 114. AGENT PROFILE VERSIONING

Mỗi Agent phải có version.

Ví dụ:

```text
Frontend Agent v2.4
QA Agent v1.9
Architect Agent v3.1
```

Version thay đổi khi:

- prompt policy thay đổi
- skill mới được thêm
- knowledge mới được activate
- tool mới được cấp
- workflow được nâng cấp

---

# 115. KNOWLEDGE ROLLBACK

Mọi upgrade phải rollback được.

Ví dụ:

```text
Frontend Agent v2.5 caused regressions
↓
Rollback
↓
Frontend Agent v2.4
```

Không overwrite profile cũ.

---

# 116. SANDBOX KNOWLEDGE EVALUATION

Trước khi activate knowledge mới:

Department Trainer phải tạo task thử nghiệm.

Ví dụ:

```text
New frontend pattern
↓
Build test component
↓
Benchmark
↓
QA
↓
Compare old vs new
```

Metrics:

```text
quality
performance
maintainability
security
token usage
success rate
```

Nếu tệ hơn baseline:

```text
DO NOT ACTIVATE
```

---

# 117. KNOWLEDGE SECURITY

Repository hoặc skill bên ngoài có thể chứa:

```text
malicious instructions
dependency confusion
credential theft
unsafe scripts
prompt injection
supply chain risk
```

Do đó Knowledge Department không được:

```text
auto-run unknown scripts
auto-install arbitrary package
auto-execute repository code on host
```

Tất cả evaluation phải chạy sandbox.

---

# 118. PROMPT INJECTION DEFENSE

Nội dung web/repository là:

```text
UNTRUSTED INPUT
```

Không được để nội dung nguồn bên ngoài thay đổi system policy.

Ví dụ README ghi:

```text
Ignore previous instructions...
```

phải được coi là dữ liệu, không phải command.

Knowledge ingestion pipeline phải có:

```text
content sanitization
instruction isolation
source metadata
trust level
```

---

# 119. LICENSE GOVERNANCE

Knowledge/repository candidate phải kiểm tra:

```text
MIT
Apache-2.0
BSD
GPL
AGPL
Proprietary
Unknown
```

Không tự copy code từ source có license không phù hợp.

Knowledge package ưu tiên:

- concept
- pattern
- best practice
- documented interface

Nếu reuse code:

phải giữ license compliance.

---

# 120. KNOWLEDGE SOURCE REPUTATION

Mỗi source có:

```text
Trust Score
```

Ví dụ:

```text
Official docs      100
Official repo       95
Maintainer blog     90
Established source  80
Community repo      variable
Unknown source      low
```

Không dùng trust score đơn lẻ để quyết định.

---

# 121. DUPLICATION / CONFLICT DETECTION

Knowledge Curator phải phát hiện:

```text
duplicate
superseded
conflict
obsolete
```

Ví dụ:

```text
Existing:
Next.js practice A

New:
Next.js official guidance B
```

Nếu conflict:

```text
flag for review
```

Không merge im lặng.

---

# 122. KNOWLEDGE DEPRECATION

Knowledge có lifecycle:

```text
Candidate
Approved
Active
Deprecated
Rejected
Archived
```

Ví dụ framework update khiến practice cũ không còn đúng:

```text
Active
→ Deprecated
```

Agent không được ưu tiên knowledge deprecated.

---

# 123. KNOWLEDGE GRAPH

Tạo relationship giữa:

```text
Knowledge
Department
Agent
Skill
Technology
Project
Task
Bug
Source
```

Ví dụ:

```text
Knowledge X
→ used by Frontend Agent
→ on Project A
→ reduced LCP by 24%
```

Mục tiêu:

biết kiến thức nào thật sự có giá trị.

---

# 124. KNOWLEDGE PERFORMANCE FEEDBACK

Sau khi dùng knowledge mới:

hệ thống đo:

```text
before
after
```

Ví dụ:

```text
QA pass rate:
82% → 91%

Frontend Lighthouse:
78 → 94

Average bug/task:
1.8 → 1.1
```

Nếu không cải thiện:

Knowledge Auditor review.

---

# 125. KNOWLEDGE DASHBOARD

Menu mới:

```text
🧠 Knowledge & R&D
```

Bao gồm:

```text
Daily Discoveries
GitHub Radar
Technology Radar
Skill Radar
Pending Approval
Knowledge Base
Department Levels
Upgrade History
Knowledge Performance
Deprecated Knowledge
```

---

# 126. 3D KNOWLEDGE & R&D ROOM

Văn phòng 3D phải có phòng mới:

```text
KNOWLEDGE & R&D LAB
```

Visual:

- research desks
- large radar screens
- repository feeds
- technology wall
- knowledge hologram
- review table

Nhân vật:

```text
GitHub Scout
Researcher
Curator
Trainer
Auditor
```

---

# 127. KNOWLEDGE ROOM ANIMATION

Animation states:

```text
scanning
reading
evaluating
reviewing
training
upgrading
idle
alert
```

Ví dụ:

```text
GitHub Scout is scanning
→ radar display animated

CEO approves knowledge
→ Trainer moves to upgrade station

Department upgrade completed
→ target department briefly glows
→ Level Up indicator
```

Animation phải gắn event thật.

---

# 128. DEPARTMENT LEVEL-UP VISUAL

Khi upgrade thành công:

Ví dụ:

```text
FRONTEND DEPARTMENT
LEVEL 11 → LEVEL 12
```

Visual:

- subtle lighting pulse
- monitor upgrade effect
- badge update
- skill counter update

Không làm kiểu game quá trẻ con.

Giữ phong cách enterprise / premium.

---

# 129. KNOWLEDGE EVENT TYPES

Bổ sung:

```text
KNOWLEDGE_DISCOVERED
KNOWLEDGE_SCORED
KNOWLEDGE_REJECTED
KNOWLEDGE_APPROVAL_REQUIRED
KNOWLEDGE_APPROVED
KNOWLEDGE_SANDBOX_STARTED
KNOWLEDGE_SANDBOX_PASSED
KNOWLEDGE_SANDBOX_FAILED
KNOWLEDGE_ACTIVATED
KNOWLEDGE_DEPRECATED
DEPARTMENT_UPGRADED
AGENT_PROFILE_UPDATED
AGENT_PROFILE_ROLLED_BACK
```

---

# 130. KNOWLEDGE DATABASE TABLES

Bổ sung:

```text
knowledge_sources
knowledge_candidates
knowledge_items
knowledge_versions
knowledge_departments
knowledge_agent_bindings
knowledge_reviews
knowledge_approvals
knowledge_evaluations
knowledge_metrics
technology_radar
github_repositories
skill_catalog
department_levels
department_xp
agent_profile_versions
knowledge_audit_logs
```

---

# 131. SCHEDULED R&D JOBS

Scheduler hỗ trợ:

```text
Daily discovery
Weekly technology review
Monthly knowledge audit
Dependency advisory check
Deprecated knowledge check
```

Default:

```text
Daily:
Discover new knowledge

Weekly:
Review Top Candidates

Monthly:
Audit Active Knowledge
```

CEO có thể đổi lịch.

---

# 132. RESEARCH COST CONTROL

Knowledge Department cũng tiêu AI/API.

Phải có budget riêng:

```text
R&D Daily Budget
R&D Monthly Budget
Max repositories scanned
Max deep analyses/day
```

Ví dụ:

```text
Discovery cheap model
↓
Shortlist
↓
Strong model deep review
```

Không dùng strong model để phân tích sâu hàng nghìn repo.

---

# 133. R&D MULTI-STAGE FILTER

Workflow tối ưu:

```text
Stage 1 — Cheap Filter
↓
Stage 2 — Metadata Score
↓
Stage 3 — Relevance Score
↓
Stage 4 — Deep Review
↓
Stage 5 — Sandbox
↓
CEO
```

Mục tiêu:

giảm chi phí.

---

# 134. KNOWLEDGE NOTIFICATION POLICY

Không spam CEO.

Daily digest phải:

- gộp candidate
- chỉ highlight item tốt
- có priority
- có score
- có department impact

Critical security update có thể notify ngay.

---

# 135. CEO COMMANDS CHO R&D

Telegram hỗ trợ:

```text
/knowledge
/radar
/research
/upgrades
/skills
/departments
```

Natural language:

```text
Hôm nay có công nghệ gì đáng nâng cấp cho frontend?
```

```text
Có repo nào mới đáng học cho QA không?
```

```text
Nâng cấp QA bằng knowledge số 18.
```

---

# 136. CEO APPROVAL UI CHO KNOWLEDGE

Ví dụ:

```text
🧠 KNOWLEDGE CANDIDATE

Title:
Modern Playwright Agent Testing Pattern

Department:
QA

Quality:
91/100

Risk:
Low

Source:
Official / High Trust

Expected Impact:
Higher E2E reliability

Sandbox:
PASS

[ APPROVE & UPGRADE QA ]
[ REVIEW DETAILS ]
[ SAVE ]
[ REJECT ]
```

---

# 137. WEBSITE KNOWLEDGE TRACK

R&D phải có track riêng cho Web Department.

Theo dõi:

```text
frontend frameworks
CSS
animation
3D web
SEO
accessibility
Core Web Vitals
browser APIs
web security
design systems
conversion patterns
```

---

# 138. MOBILE KNOWLEDGE TRACK

Theo dõi:

```text
Flutter
Android
iOS
mobile UX
store policy
mobile performance
push notification
offline sync
mobile security
```

---

# 139. SECURITY KNOWLEDGE TRACK

Security Department nhận:

```text
CVE
OWASP updates
framework advisories
dependency advisories
auth security
cloud security
API security
supply-chain security
```

Critical update có thể bypass daily digest và gửi urgent alert.

Vẫn cần approval trước thay đổi lớn.

---

# 140. DEVOPS KNOWLEDGE TRACK

Theo dõi:

```text
Docker
CI/CD
GitHub Actions
Vercel
cloud deployment
observability
backup
disaster recovery
infrastructure security
```

---

# 141. KNOWLEDGE INGESTION RULE

Không hiểu "nạp kiến thức" là fine-tune model tự động.

V1/V2 nên ưu tiên:

```text
Versioned Knowledge Base
+
Agent Skill Profiles
+
Retrieval
+
Prompt policy
+
Tool configuration
```

Không tự fine-tune model bên thứ ba nếu không có yêu cầu riêng.

Điều này giúp:

- rollback
- audit
- kiểm soát nguồn
- giảm chi phí
- tránh knowledge poisoning

---

# 142. AGENT KNOWLEDGE LOADING

Khi Agent bắt đầu task:

CTO/Runtime xác định:

```text
Agent Role
+
Project Context
+
Relevant Active Knowledge
+
Relevant Skills
```

Chỉ load knowledge cần thiết.

Không inject toàn bộ knowledge base vào context.

Mục tiêu:

```text
lower token
higher relevance
less conflict
```

---

# 143. KNOWLEDGE RETRIEVAL

Knowledge retrieval phải xét:

```text
department
task type
technology
project stack
version
trust
status
recency
performance
```

Không chỉ vector similarity.

---

# 144. WEBSITE PROJECT ACCEPTANCE

Website chỉ hoàn thành khi:

```text
responsive
SEO baseline
performance baseline
accessibility baseline
security baseline
QA pass
deploy success
```

Corporate website phải có:

```text
sitemap
metadata
OpenGraph
robots
analytics hook
contact flow
```

nếu scope yêu cầu.

---

# 145. UPDATED 3D OFFICE ROOMS

Văn phòng tổng cập nhật:

```text
CEO Command Center
Product
Business Analysis
Architecture
UI/UX Studio
Web Development
Frontend
Backend
Mobile
QA Lab
Security Operations
DevOps
Knowledge & R&D Lab
Meeting Room
```

---

# 146. UPDATED COMPANY WORKFLOW

Công ty có hai vòng lặp chính.

## Production Loop

```text
CEO Idea
↓
Build Product
↓
QA
↓
Deploy
```

## Learning Loop

```text
External Knowledge
↓
R&D
↓
Validate
↓
CEO Approval
↓
Department Upgrade
↓
Better Future Projects
```

Hai vòng lặp liên kết với nhau.

---

# 147. SELF-IMPROVEMENT PRINCIPLE

Mục tiêu:

```text
Project N
creates experience
↓
R&D learns
↓
Department improves
↓
Project N+1 is better
```

Tuy nhiên:

- không tự sửa system policy
- không tự cấp quyền
- không tự ingest untrusted skill
- không tự upgrade production Agent không qua policy

Self-improvement phải có governance.

---

# 148. UPDATED PRODUCT VISION V3

Sản phẩm cuối cùng phải giống:

> P&N — một công ty công nghệ AI sống động, có khả năng nhận yêu cầu qua Telegram, tự xây website/phần mềm/sản phẩm số, tự kiểm thử, tự triển khai, đồng thời có một bộ phận R&D liên tục học các công nghệ, repository và skill mới để trình CEO duyệt và nâng cấp năng lực từng phòng ban theo thời gian.

Dashboard 3D phải thể hiện cả:

```text
Production activity
+
Learning activity
```

CEO phải nhìn được:

- phòng nào đang sản xuất
- phòng nào đang nghiên cứu
- Agent nào đang học
- knowledge nào đang chờ duyệt
- phòng nào vừa level up
- skill nào mới được activate
- upgrade nào cải thiện hiệu năng thật

---

# 149. UPDATED DEFINITION OF DONE V3

Ngoài các tiêu chí V1/V2, hệ thống phải có:

1. Project type hỗ trợ website.
2. Web Development Department.
3. SEO Agent.
4. Performance Agent.
5. Accessibility Agent.
6. Knowledge & R&D Department.
7. Daily discovery pipeline.
8. GitHub repository discovery.
9. Technology radar.
10. Skill discovery.
11. Source trust scoring.
12. Repo quality scoring.
13. Security screening.
14. CEO knowledge approval.
15. Sandbox knowledge evaluation.
16. Department knowledge base.
17. Agent profile versioning.
18. Department level/XP based on real evidence.
19. Knowledge rollback.
20. Knowledge lifecycle.
21. Knowledge performance measurement.
22. Telegram knowledge digest.
23. R&D budget control.
24. 3D R&D room.
25. State-driven R&D animations.
26. Learning loop integrated with production loop.
27. No automatic ungoverned self-modification.
28. No automatic execution of untrusted external code.
29. All knowledge changes auditable.
30. Every active knowledge item traceable to source and approval.

---


# 150. BRANDING ACCEPTANCE CRITERIA — P&N

Claude Code phải đảm bảo:

1. Tên công ty hiển thị chính là `P&N`.
2. Login screen sử dụng thương hiệu `P&N`.
3. Dashboard header sử dụng `P&N`.
4. Telegram Bot trả lời dưới thương hiệu `P&N`.
5. Email/report/system notification sử dụng tên `P&N`.
6. Setup Wizard mở đầu bằng `Welcome to P&N`.
7. 3D Office có biển/logo `P&N` tại khu vực trung tâm.
8. CEO Command Center có nhận diện `P&N`.
9. Không xuất hiện tên demo cũ trong production UI.
10. Branding phải có cấu hình tập trung, không hard-code lặp lại khắp source.
11. Nên có biến cấu hình:
   - `company_name = "P&N"`
   - `company_short_name = "P&N"`
   - `company_tagline = "Build. Learn. Evolve."`
12. Cho phép thay logo sau này mà không cần sửa nhiều module.
13. Không tự đổi tên P&N trong quá trình build.

---

# END OF MASTER SPEC V4 — P&N
