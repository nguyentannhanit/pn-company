/**
 * P&N — Nút đổi giao diện sáng / tối.
 *
 * Lựa chọn lưu ở localStorage `pn.theme`; layout gốc đọc nó trước khi vẽ để
 * không nháy màu. Cảnh 3D ở Tổng quan luôn tối (`.pn-force-dark`) nên nút này
 * không đổi cảnh 3D; khung quanh nó và các tab khác đổi ngay khi bấm.
 */

'use client';

import { useEffect, useState } from 'react';

const KEY = 'pn.theme';

export function ThemeToggle({
  className = '',
  variant = 'switch',
}: {
  className?: string;
  /** `segmented`: hai nút "Sáng / Tối" cạnh nhau (ngăn "Thêm" trên điện thoại). */
  variant?: 'switch' | 'segmented';
}): React.JSX.Element {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.dataset['theme'] === 'dark');
  }, []);

  const apply = (next: boolean): void => {
    setDark(next);
    if (next) document.documentElement.dataset['theme'] = 'dark';
    else delete document.documentElement.dataset['theme'];
    try {
      window.localStorage.setItem(KEY, next ? 'dark' : 'light');
    } catch {
      /* không lưu được thì chỉ đổi trong phiên này */
    }
  };

  if (variant === 'segmented') {
    const seg = (on: boolean): string =>
      `pn-press flex h-[34px] items-center gap-1.5 rounded-[10px] px-3.5 text-[12.5px] font-semibold ${on ? 'bg-surface-1 text-ink-100 shadow-[var(--shadow-panel)]' : 'text-ink-500'}`;
    return (
      <div className={`flex rounded-[14px] bg-fill-2 p-1 ${className}`} role="group" aria-label="Giao diện">
        <button type="button" onClick={() => apply(false)} className={seg(!dark)} aria-pressed={!dark}>☀️ Sáng</button>
        <button type="button" onClick={() => apply(true)} className={seg(dark)} aria-pressed={dark}>🌙 Tối</button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => apply(!dark)}
      title={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
      aria-label={dark ? 'Chuyển sang giao diện sáng' : 'Chuyển sang giao diện tối'}
      className={`pn-press pn-focus flex h-8 w-[58px] shrink-0 items-center rounded-full border border-line bg-fill-2 px-1 ${className}`}
    >
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-1 text-[13px] shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-transform duration-300"
        style={{ transform: dark ? 'translateX(26px)' : 'translateX(0)' }}
      >
        {dark ? '🌙' : '☀️'}
      </span>
    </button>
  );
}
