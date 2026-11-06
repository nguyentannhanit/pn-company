/**
 * P&N — Vệt sáng lan ra từ chỗ chạm trên MỌI nút, liên kết, ô bấm được của bảng điều khiển ("nhiều nút
 * nhấn chưa có hiệu ứng, nhìn đơ đơ chưa chuyên nghiệp").
 *
 * Gắn một lần ở layout gốc, nghe `pointerdown` trên cả trang. Vệt sáng vẽ trong một lớp phủ cố định đặt đúng khung
 * của nút (bo góc theo nút), không chèn gì vào trong nút nên không làm xô lệch bố cục của bất kỳ trang nào. Màu
 * vệt lấy từ màu chữ của nút: nút tím chữ trắng thì vệt trắng, nút nhạt chữ tối thì vệt tối.
 */

'use client';

import { useEffect } from 'react';

const TARGET = 'button, [role="button"], a[href], summary, label.pn-press, select';

/** Màu chữ `rgb(r, g, b)` → cùng màu, độ mờ 28%. */
function rippleColor(color: string): string {
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) return 'rgb(255 255 255 / 28%)';
  const [r, g, b] = match[1]!.split(',').map((part) => part.trim());
  return `rgb(${r} ${g} ${b} / 28%)`;
}

export function PressRipple(): null {
  useEffect(() => {
    const onDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const target = (event.target as Element | null)?.closest<HTMLElement>(TARGET);
      if (!target || target.matches(':disabled, [aria-disabled="true"]') || target.closest('[data-no-ripple]')) return;
      const rect = target.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const style = getComputedStyle(target);

      const layer = document.createElement('span');
      layer.className = 'pn-ripple-layer';
      Object.assign(layer.style, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        borderRadius: style.borderRadius,
      });
      const size = Math.hypot(rect.width, rect.height) * 2;
      const dot = document.createElement('span');
      dot.className = 'pn-ripple';
      Object.assign(dot.style, {
        width: `${size}px`,
        height: `${size}px`,
        left: `${event.clientX - rect.left - size / 2}px`,
        top: `${event.clientY - rect.top - size / 2}px`,
        background: rippleColor(style.color),
      });
      layer.append(dot);
      document.body.append(layer);
      window.setTimeout(() => layer.remove(), 650);
    };
    document.addEventListener('pointerdown', onDown, { passive: true });
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);
  return null;
}
