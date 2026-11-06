/**
 * P&N — Tín hiệu "mở trợ lý" giữa cảnh 3D, ô lệnh và khung hỏi đáp.
 *
 * Khung nằm trong Shell, còn nút bấm nằm sâu trong cảnh 3D của trang Tổng quan
 * hoặc trong ô lệnh trên cùng; một sự kiện trình duyệt đủ nối hai bên mà không
 * phải xâu prop qua bốn lớp. Có thể kèm câu hỏi điền sẵn (chưa gửi).
 */

const EVENT = 'pn:assistant';

/** Gọi từ bất kỳ đâu trên trang (nhân viên lễ tân 3D, ô lệnh…). */
export function openAssistant(question?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(EVENT, { detail: question }));
}

/** Shell đăng ký một lần; trả về hàm gỡ. */
export function onOpenAssistant(handler: (question?: string) => void): () => void {
  const listener = (event: Event): void => handler((event as CustomEvent<string | undefined>).detail);
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
