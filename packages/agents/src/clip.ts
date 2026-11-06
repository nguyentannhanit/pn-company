/**
 * P&N — Chữ mô tả dài quá thì cắt bớt, không vứt cả kết quả.
 *
 * Model (nhất là Claude qua gói, viết dài hơn API) hay vượt giới hạn độ dài ở một mục phụ — một dòng "rủi ro"
 * hơn 500 ký tự — và cả lượt làm việc bị coi là hỏng, task đứng BLOCKED chờ CEO bấm chạy lại (từng có phòng thiết kế
 * đứng hàng chục phút). Chỉ dùng cho chữ để người đọc; đường dẫn, code, lệnh vẫn chặn cứng
 * vì cắt ra là hỏng thật.
 */

import { z } from 'zod';

/** Chuỗi tối đa `max` ký tự: dài hơn thì cắt và thêm "…". `min` vẫn kiểm như cũ. */
export function clipped(max: number, min = 0): z.ZodType<string, z.ZodTypeDef, string> {
  const base = min > 0 ? z.string().min(min) : z.string();
  return base.transform((text) => (text.length > max ? `${text.slice(0, max - 1)}…` : text));
}
