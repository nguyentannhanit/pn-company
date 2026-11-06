/**
 * P&N — Ai đang rời chỗ để đi giao việc.
 *
 * Người đưa việc chính là người ngồi bàn (hoặc Khang ở quầy) đứng dậy đi, nên
 * trong lúc họ đi, chỗ ngồi phải trống — không thì một người thành hai. Tập này
 * đổi theo từng khung hình (người đi thêm/xoá tên), phòng ban và quầy lễ tân đọc
 * nó trong `useFrame` để ẩn/hiện người ngồi mà không phải dựng lại cả cảnh.
 */

export const awayFromDesk = new Set<string>();

/** Tên dùng cho Khang trong tập trên: việc CEO giao thẳng không có vai trò gửi. */
export const RECEPTIONIST_ROLE = 'RECEPTIONIST';

/**
 * Ai vừa được trao hồ sơ tận bàn: vai trò → lúc nhận (ms) và tên việc. Người đưa
 * việc ghi vào lúc chìa hồ sơ; người nhận đọc trong `useFrame` để tỉnh dậy đáp lại
 * và ngồi tỉnh chờ tới lúc bắt tay làm, không ngủ gật tiếp.
 */
export const received = new Map<string, { at: number; label: string }>();
