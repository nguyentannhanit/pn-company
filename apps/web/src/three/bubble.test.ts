/**
 * P&N — Bong bóng trạng thái nói đúng việc, và người rảnh ngủ gật đúng nhịp với dáng người.
 */

import { describe, expect, it } from 'vitest';

import { bubbleView, idleText, type BubbleInput } from './bubble';
import { IDLE, idleCycle } from './pose';

const base: BubbleInput = {
  state: 'idle',
  role: 'DEVOPS',
  say: null,
  name: 'Kỹ sư vận hành',
  hovered: false,
  idleMinutes: 5,
  roomAsleep: false,
  clock: 0,
  calm: false,
  wake: null,
};

/** Tìm một thời điểm trong nhịp rảnh thoả điều kiện. */
function clockWhere(test: (cycle: ReturnType<typeof idleCycle>) => boolean): number {
  for (let t = 0; t < 40; t += 0.1) if (test(idleCycle(t, base.role))) return t;
  throw new Error('không có thời điểm nào');
}

describe('bong bóng trạng thái', () => {
  it('người có việc: nhãn trạng thái và việc đang làm; rê chuột thì hiện tên', () => {
    const say = { kind: 'working' as const, text: 'Dựng trang Đăng nhập' };
    expect(bubbleView({ ...base, state: 'working', say })).toMatchObject({ className: 'say working', label: 'Đang làm', text: 'Dựng trang Đăng nhập' });
    expect(bubbleView({ ...base, state: 'working', say, hovered: true })?.label).toBe('Kỹ sư vận hành');
  });

  it('kẹt: bong bóng nói lý do', () => {
    const view = bubbleView({ ...base, state: 'blocked', say: { kind: 'blocked', text: 'Hết lượt gọi model trong phút này' } });
    expect(view).toMatchObject({ className: 'say blocked', label: 'Đang kẹt', text: 'Hết lượt gọi model trong phút này' });
  });

  it('ngoại tuyến thì không có bong bóng', () => {
    expect(bubbleView({ ...base, state: 'offline' })).toBeNull();
  });

  it('rảnh: ngáp, ngủ gật, ngâm nga theo đúng nhịp của dáng người', () => {
    expect(bubbleView({ ...base, clock: clockWhere((c) => c.doze && c.c < IDLE.yawn) })?.text).toBe('Oáp… chưa có việc');
    expect(bubbleView({ ...base, clock: clockWhere((c) => c.doze && c.c > 3) })?.className).toBe('say sleep doze');
    expect(bubbleView({ ...base, clock: clockWhere((c) => !c.doze) })?.float).toEqual(['♪', '♫', '♪']);
  });

  it('rảnh lâu thì gục ngủ, ghi rảnh bao lâu — trừ khi cả phòng cùng ngủ (nhãn phòng ghi rồi)', () => {
    expect(bubbleView({ ...base, idleMinutes: 45 })).toMatchObject({ className: 'say sleep deep', text: 'Rảnh 45 phút' });
    expect(bubbleView({ ...base, idleMinutes: 180, roomAsleep: true })?.text).toBeUndefined();
    expect(idleText(180)).toBe('Rảnh 3 giờ');
  });

  it('sếp rê chuột vào: xin lỗi trước, rồi báo sẵn sàng', () => {
    const wake = { at: 10, until: 13 };
    expect(bubbleView({ ...base, idleMinutes: 90, wake, clock: 10.5 })).toMatchObject({ className: 'say wake', text: 'Em xin lỗi sếp, em không ngủ nữa ạ' });
    expect(bubbleView({ ...base, wake, clock: 10.5 })?.text).toBe('Dạ em đây sếp!');
    expect(bubbleView({ ...base, wake, clock: 12.9 })).toMatchObject({ className: 'say ready', text: 'Sếp giao việc cho em nhé' });
    // Hết giờ thức thì ngủ lại.
    expect(bubbleView({ ...base, idleMinutes: 90, wake, clock: 14 })?.className).toBe('say sleep deep');
  });

  it('được trao hồ sơ: đáp "Dạ, em nhận ạ!" rồi ngồi tỉnh báo đã nhận, không ngủ gật', () => {
    const received = { at: 10, text: 'Dựng API đăng nhập' };
    expect(bubbleView({ ...base, idleMinutes: 90, received, clock: 10.5 })).toMatchObject({ className: 'say wake', label: 'Dạ, em nhận ạ!', text: 'Dựng API đăng nhập' });
    expect(bubbleView({ ...base, idleMinutes: 90, received, clock: 40 })).toMatchObject({ className: 'say ready', label: 'Kỹ sư vận hành · Đã nhận việc' });
    // Đã vào việc: đáp xong thì bong bóng nói việc đang làm như thường.
    const say = { kind: 'working' as const, text: 'Dựng API đăng nhập' };
    expect(bubbleView({ ...base, state: 'working', say, received, clock: 10.5 })?.className).toBe('say wake');
    expect(bubbleView({ ...base, state: 'working', say, received, clock: 40 })?.className).toBe('say working');
  });
});
