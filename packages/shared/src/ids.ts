/**
 * P&N — Hàm tiện ích sinh định danh.
 *
 * §18 yêu cầu mỗi lần chạy agent có `run_id` ổn định; §21 yêu cầu mỗi event có
 * id riêng. Cả hai dùng UUID v4 (RFC 4122) từ module crypto của Node.
 */

import { randomUUID } from 'node:crypto';

import type { Uuid } from './domain.js';

export function newId(): Uuid {
  return randomUUID();
}

/** Dấu tổ hợp Unicode, bỏ sau khi chuẩn hoá NFD để slug hoá được tiếng Việt. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Slug an toàn cho URL và tên branch — dùng cho slug dự án và branch git (§17). */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[đ]/g, 'd')
    .replace(/[Đ]/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : 'project';
}

/** §17 — quy ước đặt tên branch: `feature/* fix/* agent/* release/*`. */
export type BranchKind = 'feature' | 'fix' | 'agent' | 'release';

export function branchName(kind: BranchKind, subject: string, suffix?: string): string {
  const base = `${kind}/${slugify(subject, 48)}`;
  return suffix ? `${base}-${slugify(suffix, 12)}` : base;
}
