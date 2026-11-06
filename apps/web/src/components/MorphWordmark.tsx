/**
 * P&N — Tên công ty biến hình ở trang đăng nhập.
 *
 * Tam giác, vuông, tròn lần lượt biến thành P, &, N (GSAP MorphSVG — miễn phí theo
 * giấy phép chuẩn của GSAP, lấy ý từ pen "MorphSVG: convertToPath" của GreenSock,
 * MIT), rồi hiện "DIGITAL COMPANY" và khẩu hiệu. Khung đăng nhập do Khang mở
 * (`LoginStage.tsx`), không chờ hiệu ứng này.
 *
 * Ba hình vẽ sẵn dưới dạng <path> chứ không dùng convertToPath: hàm đó thay phần tử
 * trong DOM, đụng với React. GSAP tải chậm hoặc lỗi thì chữ đứng ở hình ban đầu.
 * Không tắt theo "giảm chuyển động" của Windows: nhiều máy tắt hiệu ứng động mà người dùng vẫn
 * muốn thấy biến hình (cùng lý do văn phòng 3D).
 */

'use client';

import { useEffect, useId, useRef } from 'react';

import { BRAND } from '@/lib/brand';

import { LETTER_AND, LETTER_N, LETTER_P } from './morph-letters';

/** Ba hình ban đầu, đứng đúng chỗ ba chữ sẽ hiện (khung 760×400 như pen gốc). */
const SHAPES = [
  { d: 'M167 240L209.5 155L252 240Z', to: LETTER_P },
  { d: 'M332.5 155H417.5V240H332.5Z', to: LETTER_AND },
  { d: 'M547.3 155A42.5 42.5 0 1 1 547.3 240A42.5 42.5 0 1 1 547.3 155Z', to: LETTER_N },
] as const;

export function MorphWordmark(): React.JSX.Element {
  const id = useId().replace(/:/g, '');
  const shapes = useRef<Array<SVGPathElement | null>>([]);
  const text = useRef<HTMLDivElement>(null);

  // Chạy hiệu ứng một lần khi mở trang; rời trang thì trả mọi thứ về như cũ.
  useEffect(() => {
    let cancelled = false;
    let revert: (() => void) | null = null;
    void (async () => {
      const [{ gsap }, { MorphSVGPlugin }] = await Promise.all([import('gsap'), import('gsap/MorphSVGPlugin')]);
      if (cancelled) return;
      gsap.registerPlugin(MorphSVGPlugin);
      const [p, and, n] = shapes.current;
      const later = text.current ? Array.from(text.current.children) : [];
      // gsap.context gom mọi thay đổi để rời trang (hoặc React chạy hiệu ứng hai lần) trả về nguyên trạng.
      const context = gsap.context(() => {
        gsap.set(later, { opacity: 0, y: 8 });
        gsap
          .timeline({ delay: 1, defaults: { ease: 'power2.inOut', duration: 0.9 } })
          .to(p!, { morphSVG: SHAPES[0].to })
          .to(and!, { morphSVG: SHAPES[1].to }, '-=0.45')
          .to(n!, { morphSVG: SHAPES[2].to }, '-=0.45')
          .to(later, { opacity: 1, y: 0, duration: 0.6, stagger: 0.25, ease: 'power2.out' }, '-=0.2');
      });
      revert = () => context.revert();
    })();
    return () => {
      cancelled = true;
      revert?.();
    };
  }, []);

  return (
    <div className="pn-morph flex flex-col items-center" aria-label={BRAND.productName}>
      <svg viewBox="120 90 520 210" className="w-full max-w-[520px] overflow-visible" role="img" aria-label={BRAND.companyName}>
        <defs>
          <linearGradient id={`${id}g1`} x1="150" y1="290" x2="260" y2="110" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: 'var(--morph-start)' }} />
            <stop offset="0.55" style={{ stopColor: 'var(--morph-mid)' }} />
            <stop offset="1" style={{ stopColor: 'var(--morph-end)' }} />
          </linearGradient>
          <linearGradient id={`${id}g2`} x1="450" y1="115" x2="300" y2="280" gradientUnits="userSpaceOnUse">
            <stop offset="0" style={{ stopColor: 'var(--morph-start)' }} />
            <stop offset="0.5" style={{ stopColor: 'var(--morph-mid)' }} />
            <stop offset="1" style={{ stopColor: 'var(--morph-end)' }} />
          </linearGradient>
          <radialGradient id={`${id}g3`} cx="520" cy="250" r="160" gradientUnits="userSpaceOnUse">
            <stop offset="0.05" style={{ stopColor: 'var(--morph-start)' }} />
            <stop offset="0.45" style={{ stopColor: 'var(--morph-mid)' }} />
            <stop offset="1" style={{ stopColor: 'var(--morph-end)' }} />
          </radialGradient>
        </defs>
        {SHAPES.map((shape, index) => (
          <path
            key={index}
            ref={(element) => {
              shapes.current[index] = element;
            }}
            d={shape.d}
            fill={`url(#${id}g${index + 1})`}
          />
        ))}
      </svg>
      <div ref={text} className="-mt-1 flex flex-col items-center">
        <span className="pl-[0.42em] text-[13px] font-bold tracking-[0.42em] text-ink-300">DIGITAL COMPANY</span>
        <span className="pn-morph-tagline mt-1.5 font-mono text-[11.5px] uppercase tracking-[0.22em]">{BRAND.tagline}</span>
      </div>
    </div>
  );
}
