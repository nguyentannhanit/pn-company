/**
 * Chữ mô tả dài quá phải được cắt bớt chứ không làm hỏng cả lượt làm việc. Đường dẫn và lệnh vẫn phải bị chặn cứng.
 */

import { describe, expect, it } from 'vitest';

import { clipped } from './clip.js';
import { planningSchema, planSchema } from './roles.js';

const long = (n: number): string => 'rủi ro '.repeat(Math.ceil(n / 7)).slice(0, n);

describe('Cắt chữ mô tả dài quá', () => {
  it('cắt đúng độ dài, thêm dấu …, giữ nguyên chuỗi ngắn', () => {
    const schema = clipped(10);
    expect(schema.parse('ngắn')).toBe('ngắn');
    const cut = schema.parse('a'.repeat(25));
    expect(cut).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('vẫn kiểm độ dài tối thiểu', () => {
    expect(() => clipped(100, 5).parse('ab')).toThrow();
  });

  it('bản kế hoạch có một rủi ro 800 ký tự vẫn nhận được, rủi ro bị cắt còn 500', () => {
    const result = planSchema.parse({
      summary: 'Kế hoạch',
      tasks: [{ title: 'Đặc tả sản phẩm', description: 'Viết đặc tả', assignedRole: 'PRODUCT_MANAGER' }],
      risks: [long(800), 'rủi ro ngắn'],
    });
    expect(result.risks[0]).toHaveLength(500);
    expect(result.risks[1]).toBe('rủi ro ngắn');
  });

  it('tài liệu phòng thiết kế có tóm tắt quá dài vẫn nhận được', () => {
    const result = planningSchema.parse({ summary: long(6000), document: 'x'.repeat(400), risks: [long(900)] });
    expect(result.summary.length).toBe(4000);
    expect(result.risks[0]!.length).toBe(500);
  });
});
