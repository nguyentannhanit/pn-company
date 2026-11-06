/**
 * P&N — Chuyển cảnh vào công ty sau khi đăng nhập (bỏ thẻ "Chào mừng anh trở lại"; chọn "máy quay tiến
 * vào": Khang đi vào văn phòng, máy quay tiến theo, rồi giao diện công ty hiện dần).
 *
 * Gắn ở layout gốc nên không bị huỷ khi chuyển trang: cuối cú tiến của máy quay, màn hình chìm vào màu đêm của văn
 * phòng, trang trong hiện ra phía sau rồi lớp phủ tan dần. Không tắt theo `prefers-reduced-motion`: nhiều máy tắt hiệu
 * ứng Windows nhưng vẫn muốn thấy chuyển cảnh.
 */

'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

type Phase = 'idle' | 'covering' | 'covered' | 'revealing';

/** Chìm vào màu đêm (khớp CSS `pn-enter-cover`). */
const COVER_MS = 450;
/** Trang trong đã đổi địa chỉ thì chờ chừng này cho khung trang kịp vẽ rồi mới tan lớp phủ. */
const SETTLE_MS = 250;
/** Chuyển trang kẹt quá lâu thì vẫn tan lớp phủ, không che mất màn hình. */
const FAILSAFE_MS = 6000;
/** Tan lớp phủ dài 0,8 giây (CSS); quá mốc này mà chưa báo xong thì vẫn gỡ. */
const REVEAL_FAILSAFE_MS = 2500;

let trigger: ((go: () => void) => void) | null = null;

/** Phủ màn hình rồi gọi `go` (thường là chuyển trang); chưa gắn lớp phủ thì gọi thẳng. */
export function enterCompany(go: () => void): void {
  if (trigger) trigger(go);
  else go();
}

export function CompanyEntrance(): React.JSX.Element | null {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>('idle');
  const from = useRef<string | null>(null);
  const timers = useRef<number[]>([]);

  const later = (ms: number, fn: () => void): void => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  // Tan lớp phủ; gọi nhiều lần (địa chỉ đổi + mốc an toàn) chỉ chạy một lần. Gỡ khi hiệu ứng tan chạy xong
  // (onAnimationEnd) chứ không theo đồng hồ: văn phòng 3D dựng cảnh làm trình duyệt bận vài giây, hẹn giờ có thể hết
  // hạn trước khi lớp phủ kịp vẽ.
  const reveal = useRef(() => {});
  reveal.current = () => {
    if (phase !== 'covered') return;
    setPhase('revealing');
    later(REVEAL_FAILSAFE_MS, () => setPhase((now) => (now === 'revealing' ? 'idle' : now)));
  };

  // Đăng ký để trang đăng nhập gọi được qua `enterCompany`.
  useEffect(() => {
    trigger = (go) => {
      from.current = window.location.pathname;
      setPhase('covering');
      later(COVER_MS, () => {
        setPhase('covered');
        go();
        later(FAILSAFE_MS, () => reveal.current());
      });
    };
    const pending = timers.current;
    return () => {
      trigger = null;
      for (const id of pending) clearTimeout(id);
    };
  }, []);

  // Trang trong đã hiện thì tan lớp phủ — đợi thêm hai khung hình: trình duyệt còn bận dựng trang thì khung hình chưa
  // tới, lớp phủ đứng yên che chỗ đang dựng thay vì tan dở.
  useEffect(() => {
    if (phase !== 'covered' || pathname === from.current) return;
    let frame = 0;
    const id = window.setTimeout(() => {
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => reveal.current())));
    }, SETTLE_MS);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(frame);
    };
  }, [phase, pathname]);

  if (phase === 'idle') return null;
  return (
    <div
      className="pn-enter"
      data-phase={phase}
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.animationName === 'pn-enter-reveal') setPhase('idle');
      }}
    />
  );
}
