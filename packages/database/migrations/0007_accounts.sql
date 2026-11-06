-- P&N — Tài khoản & phân quyền cho nhiều người.
-- Năm vai trò người (thêm Quản lý dự án, Kế toán), quyền chỉnh riêng theo chín khu, lời mời bằng link dùng một lần,
-- mật khẩu tạm phải đổi, và số phiên để khoá / "đăng xuất mọi thiết bị" có hiệu lực ngay.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN
  ('CEO','CTO','PROJECT_MANAGER','ACCOUNTANT','AGENT','VIEWER','SYSTEM'));

-- Chỉnh riêng từng khu so với vai trò, dạng {"budget": 2, ...}; NULL = theo đúng vai trò.
ALTER TABLE users ADD COLUMN IF NOT EXISTS access jsonb;
-- Tăng lên là mọi token cũ của người này hết hiệu lực.
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
-- Chỉ lưu băm SHA-256 của mã mời; mã gốc chỉ hiện một lần cho CEO.
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_invite_token_idx ON users (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
-- Một chat Telegram chỉ gắn với một người.
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_chat_idx ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
