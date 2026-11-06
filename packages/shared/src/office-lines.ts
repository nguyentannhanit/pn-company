/**
 * P&N — Các câu Khang đọc trong văn phòng ("đảm bảo nhân viên có giọng đọc hoàn hảo và đỡ bị im lặng").
 *
 * Một nguồn duy nhất cho hai nơi: trang văn phòng chọn câu để đọc, còn API đọc sẵn đúng từng câu này bằng Vbee một lần
 * (giọng Vbee gói của CEO mất 7–40 giây mỗi câu mới; câu đã đọc sẵn phát ngay, không tốn credit lần sau). Lệch một chữ
 * là lệch khoá đệm — nên cả hai phía phải dựng câu từ đây. Chỉ dùng câu cố định (không chèn tên việc, tên dự án) để
 * mọi câu đều đọc sẵn được.
 */

import type { Department } from './enums.js';

/** Tên phòng đọc thành tiếng. */
export const ROOM_SPOKEN: Record<Department, string> = {
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

export type OfficeEvent = 'started' | 'done' | 'blocked' | 'alert';

const TEMPLATE: Record<OfficeEvent, (room: string) => string> = {
  started: (room) => `${room} bắt đầu làm việc.`,
  done: (room) => `${room} vừa xong việc.`,
  blocked: (room) => `${room} đang kẹt, anh xem giúp.`,
  alert: (room) => `${room} báo có lỗi cần xử lý.`,
};

/** Câu cho một sự kiện của một phòng; phòng lạ (không có trong danh sách) thì null — không đọc mã kỹ thuật thành tiếng. */
export function officeLine(event: OfficeEvent, department: string): string | null {
  const room = ROOM_SPOKEN[department as Department];
  return room ? TEMPLATE[event](room) : null;
}

/** Câu chung, không gắn phòng nào. */
export const OFFICE_GENERAL_LINES = {
  greeting: 'Em nghe đây. Phòng nào bắt đầu, xong việc hay kẹt, em sẽ báo anh.',
  approval: 'Có việc mới cần anh duyệt.',
  preview: 'Chào anh, em là Khang của P&N. Phòng nào xong việc hay kẹt, em sẽ báo anh bằng giọng này.',
} as const;

/** Mọi câu văn phòng có thể đọc — API đọc sẵn danh sách này bằng Vbee. */
export function allOfficeLines(): string[] {
  const rooms = (Object.keys(ROOM_SPOKEN) as Department[]).filter((room) => room !== 'MEETING_ROOM');
  return [
    ...Object.values(OFFICE_GENERAL_LINES),
    ...rooms.flatMap((room) => (Object.keys(TEMPLATE) as OfficeEvent[]).map((event) => officeLine(event, room)!)),
  ];
}
