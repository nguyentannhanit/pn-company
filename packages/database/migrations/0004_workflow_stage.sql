-- =============================================================================
-- P&N — 0004 Gắn task vào stage của workflow
-- Spec §4 (pipeline chuẩn), §27 (approval), §38 + §20 (cổng duyệt production),
--       §92 (workflow theo loại sản phẩm)
--
-- Trước migration này `workflowFor()` và `STANDARD_WORKFLOW` chỉ là dữ liệu:
-- engine chạy theo danh sách task CTO đề xuất nên không có khái niệm "stage",
-- và cờ `requiresApproval` của stage — kể cả stage production — không có chỗ
-- nào để cưỡng chế. Cột dưới đây là chỗ neo đó.
-- =============================================================================

-- NULL nghĩa là task nằm ngoài pipeline (task lập kế hoạch, task người tạo tay).
ALTER TABLE tasks ADD COLUMN stage_id text;

-- Truy vấn nóng nhất là "task nào của stage này trong dự án này" — dùng ở
-- advance() mỗi lần đẩy dự án tiến lên.
CREATE INDEX tasks_stage_idx ON tasks(project_id, stage_id);
