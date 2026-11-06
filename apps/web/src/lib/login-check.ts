/**
 * P&N — Kiểm tra ô nhập ở trang đăng nhập trước khi gọi máy chủ.
 *
 * Tách khỏi trang để test được: mỗi lỗi trả kèm ô cần chỉ vào và câu Khang nói,
 * còn thông báo trong khung là câu ngắn đọc được cả khi không có nhân vật 3D.
 */

export type LoginField = 'name' | 'email' | 'password';

export interface LoginProblem {
  field: LoginField;
  /** Dòng lỗi trong khung đăng nhập. */
  message: string;
  /** Câu Khang nói trong bong bóng. */
  say: string;
}

/** Dạng email tối thiểu: có một @ và có dấu chấm ở phần tên miền. */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Mật khẩu ngắn nhất máy chủ nhận, cả khi đăng nhập lẫn tạo tài khoản (`loginSchema`
 * trong packages/shared). Ngắn hơn thì máy chủ trả câu tiếng Anh của Zod, nên chặn trước ở đây.
 */
export const MIN_PASSWORD = 8;

/** Lỗi đầu tiên theo thứ tự ô từ trên xuống; hợp lệ thì trả null. */
export function checkLoginInput(input: {
  email: string;
  password: string;
  displayName?: string;
  bootstrap: boolean;
}): LoginProblem | null {
  if (input.bootstrap && !input.displayName?.trim()) {
    return { field: 'name', message: 'Anh chưa nhập tên hiển thị.', say: 'Anh cho em biết tên hiển thị trước nhé!' };
  }
  const email = input.email.trim();
  if (!email) return { field: 'email', message: 'Anh chưa nhập email.', say: 'Anh ơi, còn thiếu email ở đây nè!' };
  if (!EMAIL.test(email)) {
    return { field: 'email', message: 'Email chưa đúng dạng, ví dụ ceo@pn.company.', say: 'Email này thiếu gì đó rồi anh, xem lại chỗ này nhé.' };
  }
  if (!input.password) return { field: 'password', message: 'Anh chưa nhập mật khẩu.', say: 'Còn mật khẩu nữa anh ơi!' };
  if (input.password.length < MIN_PASSWORD) {
    return input.bootstrap
      ? { field: 'password', message: `Mật khẩu cần tối thiểu ${MIN_PASSWORD} ký tự.`, say: `Mật khẩu ngắn quá anh ạ, cần ít nhất ${MIN_PASSWORD} ký tự.` }
      : { field: 'password', message: `Mật khẩu P&N dài ít nhất ${MIN_PASSWORD} ký tự.`, say: 'Mật khẩu này ngắn quá, chưa phải mật khẩu P&N đâu anh.' };
  }
  return null;
}

/**
 * Máy chủ từ chối vì sai email/mật khẩu (401), hay không gọi được máy chủ.
 * Hai trường hợp Khang phản ứng khác nhau: sai mật khẩu thì giật mình, mất kết
 * nối thì không — người dùng không làm gì sai.
 */
export function loginFailureKind(error: unknown): 'wrong' | 'offline' | 'other' {
  if (error instanceof Error && 'status' in error && (error as { status: unknown }).status === 401) return 'wrong';
  // fetch không tới được máy chủ thì ném TypeError ("Failed to fetch").
  if (error instanceof TypeError) return 'offline';
  return 'other';
}

/** Câu Khang nói sau lần sai mật khẩu thứ `fails`; từ lần 3 chỉ cách vào bằng Telegram. */
export function wrongPasswordLine(fails: number): string {
  if (fails >= 3) return 'Anh quên mật khẩu à? Nhắn /dashboard cho bot Telegram, em gửi link vào thẳng.';
  if (fails === 2) return 'Vẫn chưa đúng anh ạ. Anh xem có bật Caps Lock không?';
  return 'Ối, mật khẩu chưa đúng rồi anh. Thử lại nhé!';
}
