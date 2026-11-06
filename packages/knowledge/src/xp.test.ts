/**
 * §111, §112 — "XP không được random" và "Không cho knowledge nhiều nhưng chất
 * lượng thấp làm level tăng giả".
 *
 * Hai câu đó là toàn bộ nội dung cần canh: XP phải có bằng chứng, và nạp tài
 * liệu phải rẻ hơn nhiều so với cải thiện đo được.
 */

import { describe, expect, it } from 'vitest';

import {
  LEVEL_THRESHOLDS,
  MAX_LEVEL,
  MissingEvidenceError,
  XP_TABLE,
  grantXp,
  levelForXp,
  levelProgress,
} from './xp.js';

describe('cộng XP (§112)', () => {
  it('không có bằng chứng thì không cộng được — XP không bằng chứng là XP bịa', () => {
    expect(() => grantXp('FRONTEND', 'task_completed', '')).toThrow(MissingEvidenceError);
    expect(() => grantXp('FRONTEND', 'task_completed', 'xong')).toThrow(MissingEvidenceError);
  });

  it('có bằng chứng thì cộng đúng số điểm của bảng', () => {
    const grant = grantXp('BACKEND', 'qa_passed_first_try', 'Task #42 qua QA ngay lần đầu.');

    expect(grant.amount).toBe(XP_TABLE.qa_passed_first_try);
    expect(grant.department).toBe('BACKEND');
    expect(grant.evidence).toContain('Task #42');
  });

  it('nạp tài liệu cho ít điểm hơn nhiều so với cải thiện đo được', () => {
    // Đây chính là chỗ §112 chặn việc nạp thật nhiều tài liệu để lên cấp.
    expect(XP_TABLE.knowledge_approved * 5).toBeLessThan(XP_TABLE.performance_improved);
  });

  it('mọi nguồn XP đều là sự kiện đã xảy ra, không có mục nào theo thời gian trôi', () => {
    for (const reason of Object.keys(XP_TABLE)) {
      expect(reason).not.toMatch(/time|hour|day|duration/i);
    }
  });

  it('giữ lại liên kết tới dự án và task để truy được nguồn gốc', () => {
    const grant = grantXp('QA_LAB', 'bug_fixed', 'Sửa lỗi đăng nhập trùng email.', {
      projectId: 'p1',
      taskId: 't1',
    });

    expect(grant.projectId).toBe('p1');
    expect(grant.taskId).toBe('t1');
  });
});

describe('cấp độ phòng ban (§111)', () => {
  it('bắt đầu ở cấp 1 khi chưa có XP nào', () => {
    expect(levelForXp(0)).toBe(1);
  });

  it('đúng cấp tại từng mốc', () => {
    LEVEL_THRESHOLDS.forEach((threshold, index) => {
      expect(levelForXp(threshold)).toBe(index + 1);
    });
  });

  it('chưa đủ mốc thì chưa lên cấp', () => {
    expect(levelForXp(LEVEL_THRESHOLDS[1]! - 1)).toBe(1);
  });

  it('khoảng cách giữa các cấp giãn dần — cấp cao phải thật sự có nghĩa', () => {
    for (let index = 2; index < LEVEL_THRESHOLDS.length; index += 1) {
      const truoc = LEVEL_THRESHOLDS[index - 1]! - LEVEL_THRESHOLDS[index - 2]!;
      const sau = LEVEL_THRESHOLDS[index]! - LEVEL_THRESHOLDS[index - 1]!;
      expect(sau).toBeGreaterThan(truoc);
    }
  });

  it('tiến độ nói rõ còn thiếu bao nhiêu XP để lên cấp', () => {
    const progress = levelProgress(150);

    expect(progress.level).toBe(2);
    expect(progress.xpToNext).toBe(LEVEL_THRESHOLDS[2]! - 150);
    expect(progress.ratio).toBeGreaterThan(0);
    expect(progress.ratio).toBeLessThan(1);
  });

  it('ở cấp cao nhất thì không còn mốc nào để chờ', () => {
    const progress = levelProgress(999_999);

    expect(progress.level).toBe(MAX_LEVEL);
    expect(progress.xpToNext).toBeNull();
    expect(progress.ratio).toBe(1);
  });
});
