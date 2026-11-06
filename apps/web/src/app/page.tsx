/**
 * P&N — Trang gốc: đưa người dùng tới đúng nơi tuỳ theo trạng thái hệ thống.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { getToken } from '@/lib/api';

export default function Home(): React.JSX.Element {
  const router = useRouter();

  useEffect(() => {
    router.replace(getToken() ? '/overview' : '/login');
  }, [router]);

  return (
    <main className="flex h-screen items-center justify-center text-sm text-ink-500">Đang mở…</main>
  );
}
