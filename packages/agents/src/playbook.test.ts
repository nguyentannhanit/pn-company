/**
 * Sổ tay nghề: mọi vai trò theo quy chuẩn công ty; các vai trò làm ra sản
 * phẩm có quy trình và định nghĩa xong; mọi loại sản phẩm có danh sách điều phải
 * xác định. Thiếu các phần này là quay lại thời "vài dòng chung chung" — thời app
 * tắt/mở máy giao ra rỗng.
 */

import { describe, expect, it } from 'vitest';

import { PRODUCT_TYPES } from '@pn/shared';

import { AGENT_PROMPTS } from './prompts.js';
import { MUST_CLARIFY, PRODUCT_GUIDE } from './roles.js';

describe('sổ tay nghề', () => {
  it('mọi vai trò đọc tài liệu và Sổ quyết định trước khi làm, và biết CEO chỉ quyết chi phí + phát hành', () => {
    for (const [role, prompt] of Object.entries(AGENT_PROMPTS)) {
      expect(prompt, role).toContain('SỔ QUYẾT ĐỊNH');
      expect(prompt, role).toContain('CEO chỉ quyết chi phí phát sinh và phát hành chính thức');
    }
  });

  it('các vai trò làm ra sản phẩm có quy trình từng bước và định nghĩa xong', () => {
    for (const role of ['PRODUCT_MANAGER', 'BUSINESS_ANALYST', 'SOLUTION_ARCHITECT', 'UIUX_DESIGNER', 'BACKEND_DEVELOPER', 'FRONTEND_DEVELOPER'] as const) {
      expect(AGENT_PROMPTS[role], role).toContain('QUY TRÌNH');
      expect(AGENT_PROMPTS[role], role).toContain('ĐỊNH NGHĨA XONG');
    }
  });

  it('QA nghiệm thu theo từng tiêu chí trong tài liệu Yêu cầu và coi trang tạm là không đạt', () => {
    expect(AGENT_PROMPTS.QA).toContain('Cho–Khi–Thì');
    expect(AGENT_PROMPTS.QA).toContain('trang tạm là KHÔNG ĐẠT');
  });

  it('mọi loại sản phẩm có chuẩn kỹ thuật và danh sách điều phải xác định', () => {
    for (const type of PRODUCT_TYPES) {
      expect(PRODUCT_GUIDE[type], type).toBeTruthy();
      expect(MUST_CLARIFY[type]?.length ?? 0, type).toBeGreaterThanOrEqual(3);
    }
  });

  it('chuẩn desktop cấm trang dự phòng giả và bắt giao diện nằm trong gói', () => {
    expect(PRODUCT_GUIDE['DESKTOP_APPLICATION']).toContain('CẤM trang dự phòng giả');
    expect(PRODUCT_GUIDE['DESKTOP_APPLICATION']).toContain('src/ không có trong gói');
  });
});
