/**
 * P&N — Chuyển đổi giữa hàng dữ liệu Postgres và kiểu domain.
 *
 * Postgres dùng snake_case, domain dùng camelCase. Thay vì rải `row.created_at`
 * khắp nơi, mọi repository đều đi qua các hàm ở đây để một chỗ duy nhất chịu
 * trách nhiệm về hình dạng dữ liệu.
 */

/** Đổi một khoá snake_case sang camelCase. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());
}

/** Chuyển timestamptz và numeric của pg về kiểu JS mà domain mong đợi. */
function normalise(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  // pg trả numeric dưới dạng chuỗi để không mất độ chính xác; domain dùng number.
  if (typeof value === 'string' && /^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}

/** Đổi một hàng dữ liệu thô thành object camelCase. */
export function mapRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[camel(key)] = normalise(value);
  }
  return out as T;
}

export function mapRows<T>(rows: Array<Record<string, unknown>>): T[] {
  return rows.map((row) => mapRow<T>(row));
}

export function mapMaybe<T>(row: Record<string, unknown> | null | undefined): T | null {
  return row ? mapRow<T>(row) : null;
}

/**
 * Dựng mệnh đề `SET` cho câu UPDATE từ một object chỉ chứa các field cần đổi.
 * Trả về `null` khi không có gì để cập nhật, để caller khỏi chạy câu lệnh rỗng.
 */
export function buildUpdate(
  patch: Record<string, unknown>,
  startIndex = 1,
): { clause: string; values: unknown[] } | null {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return null;

  const columns = entries.map(([key], i) => `${snake(key)} = $${startIndex + i}`);
  return { clause: columns.join(', '), values: entries.map(([, value]) => value) };
}

/** Đổi camelCase sang snake_case cho tên cột. */
export function snake(key: string): string {
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}
