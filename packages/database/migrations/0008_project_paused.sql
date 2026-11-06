-- P&N — Nút "Dừng dự án": trạng thái PAUSED do CEO dừng tay, khác PAUSED_BUDGET (tự dừng vì ngân sách).
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN
  ('DRAFT','PLANNING','IN_PROGRESS','BLOCKED','REVIEW','DEPLOYING','COMPLETED','ARCHIVED','PAUSED_BUDGET','PAUSED'));
