# P&N — SECURITY

> Spec refs: §18, §19, §20, §28, §58, §60, §69–§72, §82, §83, §88, §89,
> §117–§120, §147.

## 1. Secret management (§19, §69, §70)

| Quy tắc | Trạng thái | Enforce ở |
|---|---|---|
| Không lưu API key plaintext trong DB | ✅ Phase 0 | `packages/secrets` — AES-256-GCM |
| Master key nằm ngoài DB | ✅ Phase 0 | `PN_MASTER_KEY` (env) |
| Ciphertext gắn với `ref` (không di chuyển được) | ✅ Phase 0 | AAD = ref |
| Rotation không mất secret cũ | ✅ Phase 0 | `SecretStore.rotate()` + `key_version` |
| API không trả raw key | ✅ Phase 0 | `providerResponseSchema` chỉ có `keyPreview` |
| Secret không xuất hiện trong log | ✅ Phase 0 | `redactDeep()` ở logger + audit |
| Secret không gửi vào Telegram | 🔨 Phase 1 | bot chỉ render field đã redact |
| Coding Agent không đọc `.env` mặc định | 🔨 Phase 1 | `SandboxSpec.env` là allow-list |

Master key sinh bằng:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Đổi master key mà không chạy `rotate()` sẽ làm mọi secret cũ không giải mã được —
`SecretDecryptionError` được ném ra rõ ràng, không im lặng trả rác.

## 2. Redaction (§89)

`packages/shared/redaction.ts` là lớp phòng thủ dùng chung:

- Khóa nhạy cảm (`*password*`, `*token*`, `*api_key*`, `authorization`, …) bị
  thay nguyên giá trị.
- Chuỗi có hình dạng credential (Anthropic / OpenAI / Google / GitHub /
  Telegram / JWT / private key / DB URL có mật khẩu) bị quét ở mọi độ sâu.
- `containsSecret()` dùng trong test để khẳng định response và log sạch.

15 test trong `redaction.test.ts` khoá hành vi này.

## 3. RBAC (§20, §83)

Vai trò: `CEO`, `CTO`, `AGENT`, `VIEWER`, `SYSTEM`.

Agent nhận allow-list tối thiểu theo vai trò, và có một danh sách **cấm tuyệt
đối** không allow-list nào ghi đè được:

```text
secrets:read
db:production:read
db:production:write
deploy:production
settings:write
budget:write
approval:decide
```

Ví dụ (§20): Frontend Agent được `code:write:frontend`, `tests:run`,
`git:create_branch`, `git:create_pr`; bị từ chối `code:write:backend`,
production DB, secret, production deploy.

## 4. Sandbox (§18)

Mỗi agent run chạy trong workspace cô lập với `run_id`, timeout, giới hạn RAM/CPU
và network policy mặc định là `allowlist`. Ghi lại `command log`, `stdout`,
`stderr`, `exit code`. Driver Docker (cô lập thật) là Phase 2; Phase 1 dùng
workdir cô lập + timeout cứng, cùng một interface.

Path traversal ra ngoài workspace ném `SandboxEscapeError`.

## 5. Git & deploy (§17, §60, §38)

- Agent không được commit thẳng vào branch production.
- Branch theo quy ước `feature/* fix/* agent/* release/*`.
- `deployments` có ràng buộc DB: deploy `PRODUCTION` bắt buộc tham chiếu
  `approval_id` (trừ khi còn ở trạng thái `PENDING`).

## 6. Telegram (§58)

- Allow-list `chat_id`; message từ chat lạ bị bỏ qua và ghi audit.
- Webhook secret token so sánh bằng `safeCompare()` (constant-time).
- Rate limit theo chat.
- Không bao giờ render secret hoặc `.env` vào tin nhắn.

## 7. Audit (§28, §71)

Mọi hành động ghi `audit_logs`: actor, action, target, metadata **đã redact**,
IP, environment. Audit của knowledge có bảng riêng `knowledge_audit_logs` để
truy vết được nguồn và phê duyệt của từng item (§149.30).

## 8. Prompt privacy (§82)

`api_request_logs` chỉ lưu metadata (provider, model, latency, status, lỗi đã
redact). Nội dung prompt/response **không** được lưu mặc định.

## 9. Knowledge ingestion (§117–§120, §147)

Áp dụng từ Phase 4, nhưng nguyên tắc đã cố định từ bây giờ:

- Không tự động chạy code ngoài chưa được tin cậy.
- Prompt injection defense trước khi đưa nội dung ngoài vào system prompt.
- License governance: item chưa `license_approved` không được kích hoạt.
- Không tự sửa policy, không tự cấp quyền, không tự nâng cấp agent production
  ngoài quy trình phê duyệt.

## 10. Báo cáo lỗ hổng

Phụ thuộc: `npm audit` phải ở mức **0 vulnerabilities** trước khi đóng mỗi phase.
