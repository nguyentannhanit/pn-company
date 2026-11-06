/**
 * P&N — Diễn giải lỗi kết nối PostgreSQL thành câu người đọc hiểu.
 *
 * Lý do file này tồn tại: Node dùng happy-eyeballs khi kết nối, nên lỗi trả về
 * là `AggregateError` với `message` RỖNG — người dùng chỉ thấy một dòng trắng.
 * Mã lỗi thật nằm ở `code`. Đây là lỗi đầu tiên mà bất kỳ ai cũng gặp khi chưa
 * bật PostgreSQL, nên nó phải nói rõ cần làm gì.
 */

interface CodedError {
  code?: string;
  message?: string;
  errors?: unknown[];
}

/** Gợi ý xử lý theo mã lỗi, tra từ tài liệu PostgreSQL và Node. */
const HINTS: Record<string, string> = {
  ECONNREFUSED:
    'PostgreSQL không nhận kết nối. Kiểm tra dịch vụ đã chạy chưa ' +
    '(Windows: mở services.msc, tìm postgresql-x64-17, bấm Start).',
  ENOTFOUND: 'Không phân giải được tên máy chủ trong DATABASE_URL. Kiểm tra lại phần host.',
  ETIMEDOUT: 'Kết nối quá hạn. Nếu dùng dịch vụ đám mây, kiểm tra mạng và cấu hình SSL.',
  '28P01': 'Sai mật khẩu. Nếu mật khẩu có ký tự đặc biệt (@ # / :) thì phải mã hoá URL.',
  '28000': 'User không có quyền đăng nhập.',
  '3D000': 'Database chưa tồn tại. Tạo bằng: createdb -U postgres -h localhost pn_company',
  '42P01': 'Bảng chưa tồn tại. Chạy: npm run db:migrate',
  '53300': 'PostgreSQL đã hết slot kết nối.',
};

/** Lấy mã lỗi, kể cả khi nó nằm trong một `AggregateError`. */
export function errorCode(error: unknown): string | null {
  const coded = error as CodedError | null;
  if (!coded) return null;
  if (coded.code) return coded.code;

  for (const nested of coded.errors ?? []) {
    const code = (nested as CodedError | null)?.code;
    if (code) return code;
  }
  return null;
}

/**
 * Câu mô tả đầy đủ: chuyện gì xảy ra, ở đâu, và cần làm gì tiếp.
 * `connectionString` được rút gọn để mật khẩu không lọt vào log (§19).
 */
export function describeDatabaseError(error: unknown, connectionString?: string): string {
  const coded = error as CodedError | null;
  const code = errorCode(error);

  // AggregateError gộp nhiều lần thử (IPv6 rồi IPv4); lấy message của các con.
  const nestedMessages = (coded?.errors ?? [])
    .map((nested) => (nested as CodedError | null)?.message)
    .filter((message): message is string => Boolean(message));

  const base =
    coded?.message ||
    nestedMessages[0] ||
    (code ? `lỗi ${code}` : 'không rõ nguyên nhân');

  const parts = [base];
  if (connectionString) parts.push(`(máy chủ: ${safeTarget(connectionString)})`);
  if (code && HINTS[code]) parts.push(`\n→ ${HINTS[code]}`);

  return parts.join(' ');
}

/** Chỉ giữ host:port/database — bỏ user và mật khẩu khỏi mọi thông báo. */
export function safeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || '5432'}${url.pathname}`;
  } catch {
    return 'không đọc được DATABASE_URL';
  }
}
