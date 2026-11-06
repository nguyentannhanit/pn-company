-- P&N — Dòng sản phẩm phần mềm desktop (.exe).
-- CEO yêu cầu công ty làm được cả phần mềm máy tính, không chỉ web; ràng buộc
-- product_type ở 0001 chỉ cho bốn loại web/mobile nên phải nới.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_product_type_check;
ALTER TABLE projects ADD CONSTRAINT projects_product_type_check CHECK (product_type IN
  ('CORPORATE_WEBSITE','WEB_APPLICATION','MOBILE_APPLICATION','LANDING_PAGE','DESKTOP_APPLICATION'));
