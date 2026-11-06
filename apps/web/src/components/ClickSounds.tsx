/**
 * P&N — Tiếng bấm cho MỌI trang của công ty ("hiệu ứng nhiều hơn, to hơn, rõ hơn, áp dụng cho toàn bộ
 * click của công ty chứ không riêng Tổng quan 3D").
 *
 * Gắn một lần ở layout gốc cạnh `PressRipple` (vệt sáng khi bấm) — cùng cách nghe `pointerdown` trên cả trang, nên
 * không phải sửa từng nút. Mỗi loại thao tác một tiếng: chuyển trang, đổi thẻ, nút xác nhận, nút nguy hiểm, công tắc,
 * đóng bảng; rê chuột qua menu bên trái có tiếng tích nhỏ; lưu/tạo/xoá xong (sự kiện `pn:api-result` từ `lib/api`)
 * kêu "ting" hoặc tiếng lỗi. Nút nào muốn tiếng riêng thì gắn `data-sound="confirm|danger|…"`.
 */

'use client';

import { useEffect } from 'react';

import { officeAudio, type OfficeSfx } from '@/lib/office-audio';

const TARGET =
  'button, [role="button"], [role="switch"], [role="tab"], a[href], summary, label.pn-press, select, input[type="checkbox"], input[type="radio"]';
const SOUNDS = new Set<OfficeSfx>(['click', 'nav', 'tab', 'confirm', 'danger', 'toggle', 'close', 'open', 'focus', 'success']);
/** Chữ trên nút cho biết thao tác khó đảo ngược. */
const DANGER_TEXT = /^(xoá|xóa|khoá|khóa|dừng|huỷ|hủy|gỡ|đăng xuất)/i;
const CONFIRM_TEXT = /^(\+|lưu|tạo|giao việc|duyệt|bắt đầu|tiếp tục|chạy tiếp|chạy lại|gửi|đặt mật khẩu|vào phòng|kiểm tra|nghe thử)/i;
/** Thao tác ghi tự động (không do người bấm) — không kêu "ting". */
const SILENT_API = ['/voice/'];

/** Chọn tiếng cho phần tử vừa bấm. */
function soundFor(target: HTMLElement): OfficeSfx {
  const forced = target.closest<HTMLElement>('[data-sound]')?.dataset['sound'] as OfficeSfx | undefined;
  if (forced && SOUNDS.has(forced)) return forced;
  if (target.closest('[data-room]')) return 'focus';
  const role = target.getAttribute('role');
  if (role === 'switch' || target.matches('input[type="checkbox"], input[type="radio"]')) return 'toggle';
  if (role === 'tab' || target.closest('[role="tablist"], nav[aria-label="Mục cài đặt"]')) return 'tab';
  const label = `${target.getAttribute('aria-label') ?? ''} ${target.textContent ?? ''}`.trim();
  if (/^(đóng|✕|×)/i.test(label) || target.getAttribute('aria-label') === 'Đóng') return 'close';
  const className = typeof target.className === 'string' ? target.className : '';
  const text = (target.textContent ?? '').trim();
  if (/danger|Danger/.test(className) || DANGER_TEXT.test(text)) return 'danger';
  if (target.matches('a[href]')) return 'nav';
  if (/primary|Primary|office-primary/.test(className) || CONFIRM_TEXT.test(text)) return 'confirm';
  return 'click';
}

export function ClickSounds(): null {
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      // Cú chạm đầu tiên ở bất kỳ đâu mở khoá âm thanh của trình duyệt.
      officeAudio.arm();
      const target = (event.target as Element | null)?.closest<HTMLElement>(TARGET);
      if (!target || target.matches(':disabled, [aria-disabled="true"]') || target.closest('[data-no-sound]')) return;
      officeAudio.play(soundFor(target));
    };

    // Rê chuột (chuột thật, không phải chạm) qua mục menu bên trái / thanh thẻ: tích nhỏ, tối đa 1 lần mỗi 90ms.
    let lastHover = 0;
    let lastItem: Element | null = null;
    const onOver = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      const item = (event.target as Element | null)?.closest('nav a[href], [role="tab"]');
      if (!item || item === lastItem) return;
      lastItem = item;
      const now = performance.now();
      if (now - lastHover < 90) return;
      lastHover = now;
      officeAudio.play('hover');
    };
    const onOut = (event: PointerEvent): void => {
      if (lastItem && !lastItem.contains(event.relatedTarget as Node | null)) lastItem = null;
    };

    const onResult = (event: Event): void => {
      const { path, ok, status } = (event as CustomEvent<{ path: string; ok: boolean; status: number }>).detail;
      if (SILENT_API.some((prefix) => path.startsWith(prefix))) return;
      if (ok) officeAudio.play('success');
      else if (status !== 401) officeAudio.play('error');
    };

    document.addEventListener('pointerdown', onDown, { passive: true, capture: true });
    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    window.addEventListener('pn:api-result', onResult);
    return () => {
      document.removeEventListener('pointerdown', onDown, { capture: true });
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      window.removeEventListener('pn:api-result', onResult);
    };
  }, []);
  return null;
}
