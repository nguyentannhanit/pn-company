/**
 * P&N — Nút loa bật/tắt tiếng hiệu ứng khi bấm, dùng ở mọi trang. Nhạc nền, giọng Khang và âm lượng chi
 * tiết vẫn chỉnh ở nút "Âm thanh" trong văn phòng; nút này chỉ là công tắc nhanh cho tiếng bấm.
 */

'use client';

import { useEffect, useState } from 'react';

import { officeAudio } from '@/lib/office-audio';

export function SoundToggle({ className = '', withLabel = false }: { className?: string; withLabel?: boolean }): React.JSX.Element {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(officeAudio.prefs.sfx);
    return officeAudio.subscribe(() => setOn(officeAudio.prefs.sfx));
  }, []);

  const title = on ? 'Tắt tiếng bấm' : 'Bật tiếng bấm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => officeAudio.update({ sfx: !on })}
      title={title}
      aria-label={title}
      className={`pn-press pn-focus flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full border border-line bg-fill-2 px-2.5 text-ink-300 hover:text-ink-100 ${className}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M11 5 6 9H3v6h3l5 4V5z" />
        {on ? (
          <>
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </>
        ) : (
          <path d="m16 9 5 6m0-6-5 6" />
        )}
      </svg>
      {withLabel && <span className="text-[12.5px] font-semibold">{on ? 'Tiếng bấm: bật' : 'Tiếng bấm: tắt'}</span>}
    </button>
  );
}
