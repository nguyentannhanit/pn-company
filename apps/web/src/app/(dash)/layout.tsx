/**
 * P&N — Layout cho toàn bộ khu vực cần đăng nhập.
 *
 * Cửa chặn ở đây chỉ là tiện ích cho người dùng — quyền thật do API quyết định
 * (§20). Không màn hình nào tự cho mình quyền chỉ vì ẩn được nút bấm.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Shell } from '@/components/Shell';
import { getToken } from '@/lib/api';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace('/login');
      return;
    }
    setReady(true);
  }, [router]);

  if (!ready) {
    return (
      <main className="flex h-screen items-center justify-center text-sm text-ink-500">
        Đang kiểm tra phiên đăng nhập…
      </main>
    );
  }

  return <Shell>{children}</Shell>;
}
