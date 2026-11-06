/**
 * P&N — Đăng ký service worker và tìm địa chỉ API cho bản chạy ngoài máy.
 *
 * Dashboard công khai chạy qua đường hầm còn API là một đường hầm khác; địa chỉ
 * có thể đổi. Ba nguồn, theo thứ tự: `?api=` trên đường dẫn (bấm link từ bot),
 * rồi `/api-config` do chính web trả lời (app cài trên điện thoại có ngăn lưu
 * trữ riêng nên không thấy gì trình duyệt đã nhớ), cuối cùng là địa chỉ gắn lúc
 * build. Trên localhost không hỏi gì cả: máy công ty gọi thẳng API của nó.
 */

'use client';

import { useEffect } from 'react';

import { rememberApiUrl } from '@/lib/api';

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

export function PwaSetup(): null {
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('api');
    if (requested && rememberApiUrl(requested)) {
      const url = new URL(window.location.href);
      url.searchParams.delete('api');
      window.history.replaceState(null, '', url.toString());
      window.location.reload();
      return;
    }

    if (!LOCAL_HOSTS.includes(window.location.hostname)) {
      fetch('/api-config', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((config: { apiUrl?: string | null } | null) => {
          if (config?.apiUrl && rememberApiUrl(config.apiUrl)) window.location.reload();
        })
        .catch(() => {
          /* không hỏi được thì dùng địa chỉ đang có */
        });
    }

    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      // Một số trình duyệt nhúng không cho đăng ký service worker; không cài được thì thôi.
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);
  return null;
}
