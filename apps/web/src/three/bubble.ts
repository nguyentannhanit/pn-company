/**
 * P&N — Bong bóng trạng thái trên đầu nhân viên 3D.
 *
 * Thay vạch màu nhấp nhô trên đầu và cờ đỏ cạnh bàn: vạch màu chỉ nói "có gì
 * đó đang xảy ra", bong bóng nói luôn là việc gì, kẹt vì sao. Người rảnh thì
 * ngủ gật / ngâm nga / gục ngủ theo cùng nhịp với dáng người (`pose.ts`).
 *
 * Chữ trong bong bóng có tên việc do người dùng đặt, nên chỉ ghi bằng
 * `textContent`, không bao giờ qua `innerHTML`.
 */

import { IDLE, WAKE, idleCycle } from './pose';

export type SayKind = 'working' | 'reviewing' | 'meeting' | 'waiting' | 'blocked' | 'celebrate';
/** Câu nói của một người đang có việc (hoặc chờ việc). */
export interface Say {
  kind: SayKind;
  text: string;
  pct?: number;
}

const LABEL: Record<SayKind | 'wake' | 'ready' | 'got', string> = {
  working: 'Đang làm',
  reviewing: 'Đang rà soát',
  meeting: 'Đang họp',
  waiting: 'Đang chờ',
  blocked: 'Đang kẹt',
  celebrate: 'Vừa xong',
  wake: 'Dạ sếp!',
  ready: 'Sẵn sàng',
  got: 'Dạ, em nhận ạ!',
};

/** "Rảnh 45 phút", "Rảnh 3 giờ". */
export function idleText(minutes: number): string {
  const m = Math.floor(minutes);
  return 'Rảnh ' + (m >= 60 ? `${Math.round(m / 60)} giờ` : `${m} phút`);
}

export interface BubbleInput {
  state: string;
  role: string;
  say: Say | null;
  /** Tên hiển thị: rê chuột vào người đang có việc thì bong bóng ghi tên thay cho trạng thái. */
  name: string;
  hovered: boolean;
  idleMinutes: number;
  /** Cả phòng cùng gục ngủ: "rảnh bao lâu" ghi một lần trên nhãn phòng, bong bóng chỉ còn z z z. */
  roomAsleep: boolean;
  clock: number;
  calm: boolean;
  wake: { at: number; until: number } | null;
  /** Vừa được trao hồ sơ: lúc nhận (giây của cảnh) và tên việc. */
  received?: { at: number; text: string } | null;
}

/** Nội dung bong bóng: lớp CSS, dòng nhãn, dòng chữ, thanh % — hoặc null khi không cần bong bóng. */
export interface BubbleView {
  className: string;
  label?: string;
  text?: string;
  pct?: number;
  /** Chữ bay lên thay cho nhãn: z z z (ngủ) hoặc nốt nhạc (ngâm nga lúc xoay ghế). */
  float?: readonly string[];
}

const ZZZ = ['z', 'z', 'z'] as const;
const NOTES = ['♪', '♫', '♪'] as const;

export function bubbleView(input: BubbleInput): BubbleView | null {
  const { say, state } = input;
  if (state === 'offline') return null;
  // Được trao hồ sơ: đáp lại người đưa trước đã (kể cả đang dở việc khác), rồi ngồi
  // tỉnh báo đã nhận cho tới khi bắt tay làm.
  if (input.received) {
    if (input.clock - input.received.at < WAKE.sorry) return { className: 'say wake', label: LABEL.got, text: input.received.text };
    if (!say && state === 'idle') return { className: 'say ready', label: `${input.name} · Đã nhận việc`, text: input.received.text };
  }
  if (say) {
    return {
      className: `say ${say.kind}`,
      label: input.hovered ? input.name : LABEL[say.kind],
      text: say.text,
      ...(say.pct === undefined ? {} : { pct: say.pct }),
    };
  }
  if (state !== 'idle') return null;
  // Sếp rê chuột vào: bật dậy xin lỗi, giữ chuột thì báo sẵn sàng nhận việc.
  if (input.wake && input.wake.until > input.clock) {
    const deep = input.idleMinutes >= IDLE.longMin;
    return input.clock - input.wake.at < WAKE.sorry
      ? { className: 'say wake', label: LABEL.wake, text: deep ? 'Em xin lỗi sếp, em không ngủ nữa ạ' : 'Dạ em đây sếp!' }
      : { className: 'say ready', label: `${input.name} · ${LABEL.ready}`, text: 'Sếp giao việc cho em nhé' };
  }
  if (input.idleMinutes >= IDLE.longMin) {
    return input.roomAsleep
      ? { className: 'say sleep deep', float: ZZZ }
      : { className: 'say sleep deep', float: ZZZ, text: idleText(input.idleMinutes) };
  }
  if (input.calm) return { className: 'say sleep doze', float: ZZZ };
  const cycle = idleCycle(input.clock, input.role);
  if (!cycle.doze) return { className: 'say sleep hum', float: NOTES };
  if (cycle.c < IDLE.yawn) return { className: 'say sleep yawn', text: 'Oáp… chưa có việc' };
  return { className: 'say sleep doze', float: ZZZ };
}

/** Khoá so sánh: chỉ vẽ lại DOM khi nội dung đổi, không phải mỗi khung hình. */
export function bubbleKey(view: BubbleView | null): string {
  return view ? [view.className, view.label, view.text, view.pct, view.float?.join('')].join('|') : '';
}

/** Vẽ bong bóng vào `el` bằng textContent. */
export function paintBubble(el: HTMLElement, view: BubbleView | null): void {
  el.hidden = !view;
  el.replaceChildren();
  if (!view) return;
  el.className = view.className;
  if (view.float) {
    const row = document.createElement('div');
    row.className = 'zz';
    row.setAttribute('aria-hidden', 'true');
    for (const glyph of view.float) {
      const item = document.createElement('i');
      item.textContent = glyph;
      row.append(item);
    }
    el.append(row);
  }
  if (view.label) {
    const label = document.createElement('b');
    label.textContent = view.label;
    el.append(label);
  }
  if (view.text) {
    const text = document.createElement('span');
    text.textContent = view.text;
    el.append(text);
  }
  if (view.pct !== undefined) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, view.pct))}%`;
    bar.append(fill);
    el.append(bar);
  }
}
