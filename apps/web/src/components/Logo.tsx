/**
 * P&N — Dấu hiệu nhận diện thương hiệu (§150).
 *
 * Ưu tiên file logo thật ở `/brand/logo.png`; chưa có
 * file thì dựng dấu 3D "Quỹ đạo" (khối P·N kim loại chuyển
 * sắc, hai vành sáng quay quanh — `three/logo-orbit.ts`). Máy không có WebGL thì
 * rơi về dấu SVG vẽ tay để trang không bao giờ trống.
 */

'use client';

import { useEffect, useRef, useState } from 'react';

import { BRAND } from '@/lib/brand';
import type { LogoOrbit } from '@/three/logo-orbit';

/** Đường dẫn cố định để đổi logo không phải sửa module khác (§150.12). */
export const LOGO_IMAGE = '/brand/logo.png';

export function LogoMark({ size = 36, glass = false }: { size?: number; glass?: boolean }): React.JSX.Element {
  // Lúc build đã biết có file logo hay chưa; chưa có thì dựng dấu 3D ngay.
  const [missing, setMissing] = useState(process.env['NEXT_PUBLIC_HAS_LOGO'] !== '1');

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size }}
      title={BRAND.companyName}
    >
      {missing ? (
        <OrbitMark size={size} glass={glass} />
      ) : (
        <img
          src={LOGO_IMAGE}
          alt={`Logo ${BRAND.companyName}`}
          width={size}
          height={size}
          className="rounded-xl object-contain drop-shadow-[0_6px_14px_rgba(56,189,248,0.35)]"
          onError={() => setMissing(true)}
        />
      )}
    </span>
  );
}

/**
 * Dấu 3D: dựng vào canvas sau khi gắn vào trang; WebGL lỗi thì đổi sang dấu SVG.
 * Canvas vẽ trong suốt, to hơn ô 1,3 lần để vành ngoài không bị cắt ở mép.
 */
function OrbitMark({ size, glass }: { size: number; glass: boolean }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbit = useRef<LogoOrbit | null>(null);
  const [failed, setFailed] = useState(false);
  const px = Math.round(size * 1.3);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    void import('@/three/logo-orbit')
      .then(({ createLogoOrbit }) => {
        if (cancelled) return;
        orbit.current = createLogoOrbit(canvas, px);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      orbit.current?.dispose();
      orbit.current = null;
    };
  }, [px]);

  if (failed) return glass ? <GlassMark size={size} /> : <DrawnMark size={size} />;
  return (
    <canvas
      ref={canvasRef}
      width={px}
      height={px}
      role="img"
      aria-label={`Logo ${BRAND.companyName}`}
      className="pointer-events-auto shrink-0"
      style={{ width: px, height: px, margin: (size - px) / 2 }}
      onPointerEnter={() => orbit.current?.hover(true)}
      onPointerLeave={() => orbit.current?.hover(false)}
    />
  );
}

/** Dấu SVG dự phòng: P và N lồng nhau, gạch nối gợi hai vòng chạy (§146). */
function DrawnMark({ size }: { size: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" role="img" aria-label={`Logo ${BRAND.companyName}`}>
      <defs>
        <linearGradient id="pnMarkGradient" x1="3" y1="2" x2="29" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8" fill="url(#pnMarkGradient)" stroke="#7dd3fc" strokeWidth="0.8" />
      <path d="M9 23V9h4.6a3.7 3.7 0 0 1 0 7.4H9" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18.5 23V9l5 14V9" stroke="#e0f2fe" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Dấu trên nền chuyển sắc (đầu trang điện thoại): ô kính, nét trắng. */
function GlassMark({ size }: { size: number }): React.JSX.Element {
  return (
    <span className="pn-glass flex items-center justify-center rounded-xl" style={{ width: size, height: size }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 32 32" fill="none" role="img" aria-label={`Logo ${BRAND.companyName}`}>
        <path d="M9 23V9h4.6a3.7 3.7 0 0 1 0 7.4H9" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M18.5 23V9l5 14V9" stroke="#e0f2fe" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function Wordmark({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return (
    <span className="flex items-center gap-3">
      <LogoMark />
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className="text-[15px] font-semibold tracking-[0.03em] text-ink-100">{BRAND.companyName}</span>
          <span className="mt-1.5 text-[8px] uppercase tracking-[0.19em] text-ink-500">{BRAND.productName}</span>
        </span>
      )}
    </span>
  );
}
