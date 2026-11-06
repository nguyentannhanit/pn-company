-- P&N — Kết nối AI qua CLI đăng nhập gói thuê bao.
-- Ngoài ba hãng gọi bằng API key, công ty gọi được Claude Code CLI (gói Claude Pro/Max) và
-- Codex CLI (gói ChatGPT) — trừ vào hạn mức gói thay vì trả tiền theo token. Ràng buộc ở 0002
-- chỉ cho ba hãng API nên phải nới.
ALTER TABLE ai_providers DROP CONSTRAINT IF EXISTS ai_providers_provider_check;
ALTER TABLE ai_providers ADD CONSTRAINT ai_providers_provider_check CHECK (provider IN
  ('anthropic','openai','google','claude-code','codex'));
