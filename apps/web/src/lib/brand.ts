/**
 * P&N — Thương hiệu ở phía frontend (§150.10).
 *
 * Không hard-code chuỗi "P&N" rải rác trong component. Giá trị lấy từ subpath
 * `branding` của gói chung — đúng một nguồn chân lý cho cả backend lẫn frontend.
 * Dùng subpath thay vì import cả gói vì gói gốc có phần chỉ chạy được trên Node.
 */

'use client';

import { AGENT_PROFILES } from '@pn/shared';
import { branding as defaults } from '@pn/shared/branding';

export interface Brand {
  companyName: string;
  companyShortName: string;
  tagline: string;
  taglineVi: string;
  productName: string;
  welcomeHeadline: string;
}

export const BRAND: Brand = {
  companyName: defaults.companyName,
  companyShortName: defaults.companyShortName,
  tagline: defaults.companyTagline,
  taglineVi: defaults.companyTaglineVi,
  productName: defaults.productName,
  welcomeHeadline: defaults.welcomeHeadline,
};

/** Nhãn tiếng Việt cho từng trạng thái agent (§8.1). */
export const STATE_LABEL: Record<string, string> = {
  idle: 'rảnh',
  working: 'đang làm',
  reviewing: 'đang rà soát',
  meeting: 'đang họp',
  blocked: 'bị chặn',
  alert: 'có lỗi',
  completed: 'vừa xong',
  celebrate: 'ăn mừng',
  offline: 'ngoại tuyến',
};

/** Màu theo trạng thái, khớp token trong globals.css. */
export const STATE_COLOR: Record<string, string> = {
  idle: '#7c8899',
  working: '#4ade80',
  reviewing: '#60a5fa',
  meeting: '#c084fc',
  blocked: '#fb923c',
  alert: '#f87171',
  completed: '#34d399',
  celebrate: '#f0b429',
  offline: '#4b5563',
};

/**
 * Cùng bảng trạng thái nhưng bằng biến CSS: đậm trên nền sáng, sáng trên nền
 * tối. Dùng cho mọi chỗ HTML; STATE_COLOR (hex) chỉ dành cho vật liệu 3D.
 */
export const STATE_TONE: Record<string, string> = {
  idle: 'var(--tone-gray)',
  working: 'var(--tone-green)',
  reviewing: 'var(--tone-blue)',
  meeting: 'var(--tone-purple)',
  blocked: 'var(--tone-orange)',
  alert: 'var(--tone-red)',
  completed: 'var(--tone-teal)',
  celebrate: 'var(--tone-amber)',
  offline: 'var(--tone-dim)',
};

/**
 * Cặp màu khối 3D cho từng mục điều hướng trên điện thoại: mỗi mục một màu
 * cố định để nhận ra bằng mắt, không cần đọc chữ.
 */
export const NAV_TINT: Record<string, [string, string]> = {
  '/overview': ['#2dd4bf', '#2563eb'],
  '/command': ['#9a8cff', '#5b48e6'],
  '/projects': ['#8e7dff', '#4f3bd8'],
  '/agents': ['#34d399', '#059669'],
  '/tasks': ['#60a5fa', '#2563eb'],
  '/bugs': ['#fb7185', '#e11d48'],
  '/deploy': ['#2dd4bf', '#0d9488'],
  '/cost': ['#fbbf24', '#d97706'],
  '/approvals': ['#fb923c', '#ea580c'],
  '/reports': ['#38bdf8', '#0284c7'],
  '/knowledge': ['#a78bfa', '#7c3aed'],
  '/settings': ['#94a3b8', '#475569'],
};

/** Tên tiếng Việt của phòng ban (§7). */
export const DEPARTMENT_LABEL: Record<string, string> = {
  COMMAND_CENTER: 'Phòng điều hành',
  PRODUCT: 'Phòng sản phẩm',
  BUSINESS_ANALYSIS: 'Phòng phân tích',
  UIUX_STUDIO: 'Phòng thiết kế',
  FRONTEND: 'Phòng giao diện',
  BACKEND: 'Phòng máy chủ',
  MOBILE: 'Phòng di động',
  QA_LAB: 'Phòng kiểm thử',
  SECURITY_OPS: 'Phòng an ninh',
  DEVOPS: 'Phòng vận hành',
  MEETING_ROOM: 'Phòng họp',
  WEB_DEVELOPMENT: 'Phòng web',
  KNOWLEDGE_RND: 'Phòng nghiên cứu',
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  BACKLOG: 'Chờ xếp',
  TODO: 'Chờ làm',
  IN_PROGRESS: 'Đang làm',
  REVIEW: 'Đang duyệt',
  BLOCKED: 'Bị chặn',
  DONE: 'Xong',
  CANCELLED: 'Đã bỏ',
  PAUSED: 'Tạm dừng',
};

export const PROJECT_STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Nháp',
  PLANNING: 'Đang lập kế hoạch',
  IN_PROGRESS: 'Đang chạy',
  BLOCKED: 'Bị chặn',
  REVIEW: 'Đang duyệt',
  DEPLOYING: 'Đang triển khai',
  COMPLETED: 'Hoàn tất',
  ARCHIVED: 'Lưu trữ',
  PAUSED_BUDGET: 'Dừng vì ngân sách',
  PAUSED: 'Tạm dừng',
  CANCELLED: 'Đã dừng hẳn',
};

export const PRODUCT_TYPE_LABEL: Record<string, string> = {
  CORPORATE_WEBSITE: 'Website công ty',
  WEB_APPLICATION: 'Ứng dụng web',
  MOBILE_APPLICATION: 'Ứng dụng di động',
  LANDING_PAGE: 'Trang đích',
  DESKTOP_APPLICATION: 'Phần mềm máy tính (.exe)',
};

/** Chức danh tiếng Việt từ mã vai trò (FRONTEND_DEVELOPER → Lập trình giao diện). */
export function roleLabel(role: string): string {
  return (AGENT_PROFILES as Record<string, { displayName: string }>)[role]?.displayName ?? role;
}

export function money(value: number, digits = 2): string {
  return `$${value.toFixed(digits)}`;
}
