/**
 * P&N — Bộ mảnh giao diện dùng chung của mọi tab (§33).
 *
 * Trước đây mỗi tab tự vẽ nút, thẻ, tiêu đề riêng nên nhìn như mười một ứng
 * dụng khác nhau. Giờ mọi tab lấy từ đây: cùng nhịp chữ, cùng cách bấm (lún
 * nhẹ khi nhấn, nhấc nhẹ khi rê), cùng cách vào trang (trượt lên 6px). Chỉ
 * những thứ xuất hiện ở ba màn hình trở lên mới nằm ở đây.
 */

'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';

/* -------------------------------------------------------------------------- */
/* Tiêu đề trang                                                               */
/* -------------------------------------------------------------------------- */

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  action,
  hero,
  tabs,
}: {
  title: string;
  subtitle?: string;
  /** Nhãn nhỏ phía trên tiêu đề, ví dụ "Vận hành" — cho biết trang này thuộc nhóm nào. */
  eyebrow?: string;
  action?: React.ReactNode;
  /** Nội dung thêm trong đầu trang chuyển sắc trên điện thoại (ví dụ ô số liệu). */
  hero?: React.ReactNode;
  /**
   * Hàng thẻ con (Cài đặt): ghim CHUNG một khối với tiêu đề và nút, cuộn trang không trôi theo. Trước
   * đây hàng thẻ nằm ngoài khối ghim nên trượt lên chui dưới tiêu đề.
   */
  tabs?: React.ReactNode;
}): React.JSX.Element {
  // Chiều cao khối ghim ghi vào vùng cuộn (`--pn-pin-h`) để phần tử ghim bên dưới (cột phải trang Tài khoản…) biết
  // chừa đúng chỗ, dù tiêu đề cao thấp khác nhau theo cỡ màn hình.
  const desktopPin = useRef<HTMLElement>(null);
  const mobilePin = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!tabs) return;
    const scroller = (desktopPin.current ?? mobilePin.current)?.closest('main');
    if (!scroller) return;
    const measure = (): void => {
      const pinned = [desktopPin.current, mobilePin.current].find((el) => el && el.offsetParent !== null);
      scroller.style.setProperty('--pn-pin-h', `${pinned?.offsetHeight ?? 0}px`);
    };
    measure();
    const watch = new ResizeObserver(measure);
    for (const el of [desktopPin.current, mobilePin.current]) if (el) watch.observe(el);
    return () => watch.disconnect();
  }, [tabs]);

  return (
    <>
      {/* Điện thoại (Mẫu C): đầu trang chuyển sắc nối liền thanh trên,
          cuộn đi cùng nội dung; hàng nút nằm dưới, vuốt ngang được. */}
      <div className="sm:hidden">
        <header className="pn-hero pn-hero-card relative z-10 rounded-b-[28px] px-[18px] pb-5 pt-2 text-white">
          {eyebrow && <p className="text-[10.5px] font-bold uppercase tracking-[0.15em] text-white/70">{eyebrow}</p>}
          <h1 className="mt-0.5 text-[28px] font-extrabold leading-tight tracking-[-0.025em]">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[13px] text-white/85">{subtitle}</p>}
          {hero && <div className="mt-4">{hero}</div>}
        </header>
        {tabs ? null : action && <div className="pn-scroll-x flex items-center gap-2 overflow-x-auto px-4 pt-4">{action}</div>}
      </div>
      {/* Điện thoại có hàng thẻ: đầu chuyển sắc vẫn cuộn đi (để không chiếm nửa màn hình), từ ngay dưới nó nút và hàng
          thẻ ghim lại ở mép trên. */}
      {/* Mốc 0px: chỗ khối ghim bắt đầu dính — đổi thẻ con thì cuộn về đúng đây, hàng thẻ không xê dịch. */}
      {tabs && <div data-pn-pin-start aria-hidden="true" />}
      {tabs && (
        <div ref={mobilePin} className="sticky top-0 z-20 border-b border-line bg-surface-0/90 backdrop-blur-xl sm:hidden">
          {action && <div className="pn-scroll-x flex items-center gap-2 overflow-x-auto px-4 pt-3">{action}</div>}
          {tabs}
        </div>
      )}

      {/* Máy tính: thanh tiêu đề dính trên; có hàng thẻ thì hàng thẻ nằm trong cùng khối dính. */}
      <header ref={desktopPin} className={`sticky top-0 z-20 hidden bg-surface-0/85 backdrop-blur-xl sm:block ${tabs ? '' : 'border-b border-line'}`}>
        <div className={`flex items-center justify-between gap-4 px-5 py-3.5 ${tabs ? 'border-b border-line' : ''}`}>
          <div className="min-w-0">
            {eyebrow && <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">{eyebrow}</p>}
            <h1 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink-100">{title}</h1>
            {subtitle && <p className="mt-0.5 truncate text-xs text-ink-500">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </div>
        {tabs}
      </header>
    </>
  );
}

/**
 * Ô icon khối 3D (§33): chuyển sắc theo cặp màu, có vệt sáng và bóng màu. Dùng
 * cho icon trong ngăn "Thêm", ô số liệu, dải cảnh báo.
 */
export function Tile3D({
  tint,
  size = 44,
  radius,
  children,
  className = '',
}: {
  tint: [string, string];
  size?: number;
  radius?: number;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const style = { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.3), '--a': tint[0], '--b': tint[1] } as React.CSSProperties;
  return (
    <span className={`pn-3d shrink-0 ${className}`} style={style}>
      {children}
    </span>
  );
}

/** Ô số liệu nhỏ có icon 3D; `glass` khi nằm trên đầu trang chuyển sắc. */
export function StatTile({
  tint,
  icon,
  value,
  label,
  glass = false,
}: {
  tint: [string, string];
  icon: React.ReactNode;
  value: string;
  label: string;
  glass?: boolean;
}): React.JSX.Element {
  return (
    <div className={`min-w-0 rounded-2xl px-3 py-2.5 ${glass ? 'pn-glass' : 'depth-panel border border-line bg-surface-1'}`}>
      <Tile3D tint={tint} size={28} radius={9}>
        {icon}
      </Tile3D>
      <p className={`mt-2 truncate font-mono text-lg font-semibold tabular-nums tracking-[-0.02em] ${glass ? 'text-white' : 'text-ink-100'}`}>{value}</p>
      <p className={`truncate text-[11px] ${glass ? 'text-white/80' : 'text-ink-500'}`}>{label}</p>
    </div>
  );
}

/** Khối trong trang: nhãn nhỏ viết hoa, mô tả một dòng, và nội dung. */
export function Section({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={className}>
      <div className="mb-2.5 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-500">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Nút                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Tím `brand` cho hành động chính, `quiet` cho hành động phụ, `ghost` cho nút
 * trong bảng, `danger` cho việc không quay lại được. Vàng `produce` chỉ dành cho
 * tiền và cảnh báo, không bao giờ là nút.
 */
export function Button({
  children,
  onClick,
  href,
  type = 'button',
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  className = '',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  type?: 'button' | 'submit';
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  title?: string;
}): React.JSX.Element {
  const sizing = size === 'sm' ? 'h-8 px-3 text-xs' : 'h-[38px] px-4 text-sm';
  const look = {
    primary:
      'border-brand-300/30 bg-[linear-gradient(180deg,#7a67ff,#5b48e6)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_10px_26px_rgba(79,70,229,0.28)] hover:brightness-110',
    quiet:
      'border-line bg-fill-1 text-ink-100 hover:border-line-strong hover:bg-fill-2',
    ghost: 'border-transparent bg-transparent text-ink-300 hover:bg-fill-2 hover:text-ink-100',
    danger:
      'border-state-alert/40 bg-state-alert/10 text-state-alert hover:bg-state-alert/20',
  }[variant];

  const classes = `pn-press pn-focus inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border font-medium disabled:cursor-not-allowed disabled:opacity-45 ${sizing} ${look} ${className}`;

  if (href) {
    return (
      <Link href={href} className={classes} title={title}>
        {children}
      </Link>
    );
  }

  return (
    <button type={type} onClick={onClick} disabled={disabled || loading} className={classes} title={title}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

function Spinner(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[2px] border-current border-r-transparent opacity-70"
    />
  );
}

/** Chip lọc: bấm để bật/tắt; đang bật thì đổi sang tím. */
export function Chip({
  children,
  active = false,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`pn-press pn-focus inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium ${
        active
          ? 'border-brand-400/50 bg-brand-500/20 text-brand-300'
          : 'border-line bg-fill-1 text-ink-300 hover:border-line-strong hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Thẻ, ô số liệu, hàng danh sách                                              */
/* -------------------------------------------------------------------------- */

const CARD_TONE: Record<string, string> = {
  default: 'border-line bg-surface-1',
  brand: 'pn-card-brand',
  warn: 'pn-card-warn',
  alert: 'pn-card-alert',
  learn: 'pn-card-learn',
};

export function Card({
  children,
  className = '',
  tone = 'default',
  interactive = false,
}: {
  children: React.ReactNode;
  className?: string;
  tone?: 'default' | 'brand' | 'warn' | 'alert' | 'learn';
  /** Thẻ bấm được: nhấc nhẹ khi rê chuột. */
  interactive?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`depth-panel rounded-xl border p-4 ${CARD_TONE[tone]} ${interactive ? 'pn-lift cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'produce' | 'alert' | 'learn' | 'live';
}): React.JSX.Element {
  const color = {
    default: 'text-ink-100',
    produce: 'text-produce-400',
    alert: 'text-state-alert',
    learn: 'text-learn-400',
    live: 'text-state-working',
  }[tone];
  const stripe = {
    default: 'var(--tone-muted)',
    produce: 'var(--tone-amber)',
    alert: 'var(--tone-red)',
    learn: 'var(--tone-sky)',
    live: 'var(--tone-green)',
  }[tone];

  return (
    <Card className="relative overflow-hidden pl-5">
      <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded-r" style={{ background: stripe }} />
      <p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-500">{label}</p>
      <p className={`mt-1.5 font-mono text-[26px] leading-none tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-2 text-xs text-ink-500">{hint}</p>}
    </Card>
  );
}

/** Một hàng trong danh sách (task, bug, dự án…): cùng lề, cùng nhịp, cùng cách bấm. */
export function RowLink({
  href,
  leading,
  title,
  meta,
  trailing,
  stripe,
}: {
  href: string;
  leading?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  trailing?: React.ReactNode;
  /** Màu vạch bên trái nói lên trạng thái/mức độ; không có thì không vẽ. */
  stripe?: string;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="pn-press pn-focus depth-panel relative flex items-center gap-3 overflow-hidden rounded-xl border border-line bg-surface-1 px-3.5 py-3 transition-[border-color,background-color] hover:border-line-strong hover:bg-surface-3"
    >
      {stripe && <span className="absolute bottom-2.5 left-0 top-2.5 w-[3px] rounded-r" style={{ background: stripe }} />}
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink-100">{title}</span>
        {meta && <span className="mt-0.5 block truncate text-[11px] text-ink-500">{meta}</span>}
      </span>
      {trailing}
    </Link>
  );
}

/** Chỗ giữ khi đang tải: ba vệt sáng chạy, không hiện số 0 giả. */
export function Skeleton({ rows = 3, className = '' }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="pn-skeleton h-11 w-full" style={{ opacity: 1 - index * 0.18 }} />
      ))}
    </div>
  );
}

/** Trạng thái rỗng — luôn nói rõ bước tiếp theo, không chỉ nói "chưa có gì". */
export function Empty({
  message,
  hint,
  action,
}: {
  message: string;
  hint?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mx-5 my-6 rounded-2xl border border-dashed border-line px-5 py-14 text-center">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-fill-1 text-ink-500">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
        </svg>
      </span>
      <p className="text-sm text-ink-300">{message}</p>
      {hint && <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-ink-500">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Badge({
  children,
  color,
  dot = false,
  size = 'sm',
}: {
  children: React.ReactNode;
  color?: string;
  /** Chấm màu trước chữ — dùng cho trạng thái, không dùng cho nhãn thường. */
  dot?: boolean;
  /** `md`: viên thuốc lớn hơn cho đầu thẻ (trạng thái dự án). */
  size?: 'sm' | 'md';
}): React.JSX.Element {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${size === 'md' ? 'h-6 rounded-full px-2.5 text-[11.5px] font-semibold' : 'rounded-md px-1.5 py-0.5 text-[10px]'}`}
      style={
        color
          ? { background: `color-mix(in srgb, ${color} var(--tone-bg-mix), transparent)`, color, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)` }
          : { background: 'var(--fill-2)', color: 'var(--ink-2)' }
      }
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color ?? 'currentColor' }} />}
      {children}
    </span>
  );
}

export function ErrorNote({ error }: { error: string | null }): React.JSX.Element | null {
  if (!error) return null;
  return (
    <p role="alert" className="mx-5 mt-4 rounded-lg border border-state-alert/30 bg-state-alert/10 px-3 py-2 text-xs text-state-alert">
      {error}
    </p>
  );
}
