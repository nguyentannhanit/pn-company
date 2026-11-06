/**
 * P&N — Thanh thẻ của bốn trang Cài đặt (§86).
 *
 * Sidebar chính chỉ có một mục "Cài đặt"; các mục con nằm ở đây. Mỗi thẻ kèm một con số nhìn là biết tình
 * trạng mà chưa cần mở: nguồn AI dùng được, tích hợp đã nối, phần trăm hạn mức tháng, tổng bản ghi nhật ký.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { api } from '@/lib/api';
import { allowed, useMe } from '@/lib/me';

interface Summary {
  ai: { usable: number; total: number };
  integrations: { connected: number; total: number };
  budget: { ratio: number; warned: boolean; exceeded: boolean } | null;
  audit: { total: number };
}

/** `need`: quyền tối thiểu để mở thẻ — thiếu thì ẩn thẻ, khỏi bấm vào rồi mới thấy lỗi không có quyền. */
const ITEMS = [
  { href: '/settings', label: 'Kết nối AI', need: 'settings:read' },
  { href: '/settings/integrations', label: 'Tích hợp', need: 'settings:read' },
  { href: '/settings/budget', label: 'Ngân sách', need: 'budget:read' },
  { href: '/settings/audit', label: 'Nhật ký kiểm toán', need: 'audit:read' },
  { href: '/settings/accounts', label: 'Tài khoản & quyền', need: 'users:read' },
];

/** Màu con số: xanh là ổn, vàng là cần để ý (chạm ngưỡng cảnh báo, chưa có nguồn AI), đỏ là đã chạm trần. */
const TONE = {
  good: 'bg-[color-mix(in_srgb,var(--tone-green)_12%,transparent)] text-[var(--tone-green)]',
  warn: 'bg-[color-mix(in_srgb,var(--tone-amber)_14%,transparent)] text-[var(--tone-amber)]',
  bad: 'bg-[color-mix(in_srgb,var(--tone-red)_12%,transparent)] text-[var(--tone-red)]',
  plain: 'bg-fill-2 text-ink-300',
};

export function SettingsNav(): React.JSX.Element {
  const pathname = usePathname();
  const [summary, setSummary] = useState<Summary | null>(null);
  const me = useMe();
  const navRef = useRef<HTMLElement>(null);

  // Điện thoại: hàng thẻ dài hơn màn hình. Thẻ đang mở mà bị khuất thì cuộn vừa đủ cho nó lọt vào; đang thấy rồi thì
  // để nguyên — bấm một thẻ không được làm cả hàng trượt đi.
  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !active) return;
    const left = active.offsetLeft - 16;
    const right = active.offsetLeft + active.offsetWidth + 16 - nav.clientWidth;
    if (nav.scrollLeft > left) nav.scrollTo({ left, behavior: 'smooth' });
    else if (nav.scrollLeft < right) nav.scrollTo({ left: right, behavior: 'smooth' });
  }, [pathname, summary, me]);

  // Số đếm chỉ để tham khảo: tải hỏng thì thanh thẻ vẫn dùng được, chỉ không có con số.
  useEffect(() => {
    api<Summary>('/api-center/settings-summary').then(setSummary, () => undefined);
  }, [pathname]);

  const count = (href: string): { text: string; tone: keyof typeof TONE } | null => {
    if (!summary) return null;
    if (href === '/settings') return { text: `${summary.ai.usable}/${summary.ai.total}`, tone: summary.ai.usable > 0 ? 'good' : 'warn' };
    if (href === '/settings/integrations') return { text: `${summary.integrations.connected}/${summary.integrations.total}`, tone: 'plain' };
    if (href === '/settings/budget') {
      if (!summary.budget) return null;
      return { text: `${Math.round(summary.budget.ratio * 100)}%`, tone: summary.budget.exceeded ? 'bad' : summary.budget.warned ? 'warn' : 'good' };
    }
    if (href === '/settings/audit') return { text: new Intl.NumberFormat('vi-VN').format(summary.audit.total), tone: 'plain' };
    return null;
  };

  return (
    <nav ref={navRef} className="pn-scroll-x flex gap-1 overflow-x-auto border-b border-line px-5" aria-label="Mục cài đặt">
      {ITEMS.filter((item) => allowed(me, item.need)).map((item) => {
        const active = pathname === item.href;
        const badge = count(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            // Khung Cài đặt tự lo vị trí cuộn dọc (giữ hàng thẻ đứng yên); để Next tự cuộn thì trang giật.
            scroll={false}
            aria-current={active ? 'page' : undefined}
            className={`pn-focus -mb-px flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-3 text-[15px] font-semibold transition-colors ${
              active ? 'border-[var(--brand-text)] text-brand-300' : 'border-transparent text-ink-500 hover:text-ink-100'
            }`}
          >
            {item.label}
            {badge && <span className={`rounded-full px-2 py-1 text-[12px] font-semibold leading-none tabular-nums ${TONE[badge.tone]}`}>{badge.text}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
