/**
 * P&N — Người đang đăng nhập và quyền của họ (nhiều tài khoản, chín khu quyền).
 *
 * Chỉ để giao diện ẩn nút/thẻ mà người này không bấm được — quyền thật vẫn do API quyết định.
 * Nhiều thành phần cùng hỏi một lúc (khung, thanh cài đặt, trang) nên dùng chung một lần gọi, gắn theo token:
 * đổi người đăng nhập là hỏi lại.
 */

'use client';

import { useEffect, useState } from 'react';

import { api, getToken } from '@/lib/api';

export type AccessArea = 'projects' | 'approvals' | 'agents' | 'code' | 'deploy' | 'ai' | 'budget' | 'accounts' | 'audit';

export interface Me {
  user: { id: string; email: string; displayName: string; role: string; telegramChatId: string | null };
  access: Record<AccessArea, number> | null;
  capabilities: string[];
}

let cached: { token: string | null; promise: Promise<Me> } | null = null;

/** Hỏi `/auth/me` một lần cho mỗi token; lỗi thì lần sau hỏi lại. */
export function loadMe(): Promise<Me> {
  const token = getToken();
  if (!cached || cached.token !== token) {
    const promise = api<Me>('/auth/me');
    cached = { token, promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
  }
  return cached.promise;
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let alive = true;
    loadMe().then((value) => alive && setMe(value), () => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return me;
}

/** Chưa biết (đang tải) thì coi như được — tránh nút nhấp nháy biến mất rồi hiện lại với CEO. */
export const allowed = (me: Me | null, capability: string): boolean => !me || me.capabilities.includes(capability);
