-- P&N — Nút tạm dừng / dừng hẳn ở mọi chỗ bấm chạy:
--   dự án CANCELLED = dừng hẳn (mã giữ nguyên, làm tiếp bằng "Làm lại dự án");
--   việc PAUSED = tạm dừng riêng một việc; bản dựng CANCELLED = dừng giữa lúc dựng.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN
  ('DRAFT','PLANNING','IN_PROGRESS','BLOCKED','REVIEW','DEPLOYING','COMPLETED','ARCHIVED','PAUSED_BUDGET','PAUSED','CANCELLED'));

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN
  ('BACKLOG','TODO','IN_PROGRESS','REVIEW','BLOCKED','DONE','CANCELLED','PAUSED'));

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_status_check;
ALTER TABLE deployments ADD CONSTRAINT deployments_status_check CHECK (status IN
  ('PENDING','AWAITING_APPROVAL','IN_PROGRESS','SUCCESS','FAILED','ROLLED_BACK','CANCELLED'));
