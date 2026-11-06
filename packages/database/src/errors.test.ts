/** §19 — thông báo lỗi phải rõ ràng nhưng không được lộ mật khẩu. */

import { describe, expect, it } from 'vitest';

import { describeDatabaseError, errorCode, safeTarget } from './errors.js';

const DSN = 'postgresql://postgres:sieu-bi-mat-123@localhost:5432/pn_company';

describe('describeDatabaseError', () => {
  it('đọc được mã lỗi nằm trong AggregateError của Node', () => {
    // Node thử cả IPv6 lẫn IPv4 rồi gộp lại; AggregateError có message RỖNG.
    const nested = Object.assign(new Error('connect ECONNREFUSED ::1:5432'), {
      code: 'ECONNREFUSED',
    });
    const aggregate = new AggregateError([nested]);

    expect(aggregate.message).toBe('');
    expect(errorCode(aggregate)).toBe('ECONNREFUSED');
    expect(describeDatabaseError(aggregate)).toContain('ECONNREFUSED');
  });

  it('kèm gợi ý xử lý cho lỗi thường gặp', () => {
    const refused = new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]);
    expect(describeDatabaseError(refused)).toContain('services.msc');

    const badPassword = Object.assign(new Error('auth failed'), { code: '28P01' });
    expect(describeDatabaseError(badPassword)).toContain('mã hoá URL');

    const noDatabase = Object.assign(new Error('missing'), { code: '3D000' });
    expect(describeDatabaseError(noDatabase)).toContain('createdb');
  });

  it('không bao giờ để mật khẩu lọt vào thông báo (§19)', () => {
    const error = Object.assign(new Error('auth failed'), { code: '28P01' });
    const message = describeDatabaseError(error, DSN);

    expect(message).not.toContain('sieu-bi-mat-123');
    expect(message).not.toContain('postgres:');
    expect(message).toContain('localhost:5432/pn_company');
  });

  it('vẫn nói được điều gì đó khi lỗi không có mã', () => {
    expect(describeDatabaseError(new Error('hỏng bất thường'))).toContain('hỏng bất thường');
    expect(describeDatabaseError(null)).toContain('không rõ nguyên nhân');
  });
});

describe('safeTarget', () => {
  it('chỉ giữ host, cổng và tên database', () => {
    expect(safeTarget(DSN)).toBe('localhost:5432/pn_company');
  });

  it('chuỗi hỏng thì báo rõ thay vì ném lỗi', () => {
    expect(safeTarget('không-phải-url')).toContain('không đọc được');
  });
});
