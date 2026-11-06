/**
 * P&N — Tín hiệu "mở phòng trong văn phòng 3D" từ cột phải sang cảnh 3D.
 *
 * Cột phải nằm trong Shell (có mặt ở mọi trang), còn cảnh 3D chỉ có ở trang
 * Tổng quan. Đang ở Tổng quan thì một sự kiện trình duyệt là đủ; đang ở trang
 * khác thì cột phải chuyển trang, và cảnh 3D vừa dựng xong tự lấy phòng đang chờ.
 */

const EVENT = 'pn:office-room';

/** Phòng được bấm trước khi cảnh 3D kịp dựng (bấm từ trang khác). */
let pending: string | null = null;

/** Gọi từ cột phải: lướt camera tới phòng và mở thẻ phòng. */
export function openRoomIn3D(department: string): void {
  pending = department;
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: department }));
}

/**
 * Cảnh 3D đăng ký khi dựng: nhận ngay phòng đang chờ (nếu có) rồi nghe các lần
 * bấm sau. Nhận xong là xoá chờ, để lần mở Tổng quan sau không tự bay tới nữa.
 */
export function onOpenRoom(handler: (department: string) => void): () => void {
  if (pending) {
    handler(pending);
    pending = null;
  }
  const listener = (event: Event): void => {
    pending = null;
    handler((event as CustomEvent<string>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
