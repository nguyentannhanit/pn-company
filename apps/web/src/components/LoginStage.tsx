/**
 * P&N — Sân khấu trang đăng nhập: Khang 3D + khung đăng nhập.
 *
 * Bọc `three/login-greeter.ts` cho React. Khung vẽ 3D cố định phủ kín cả trang (CSS
 * `.pn-greet-canvas`), văn phòng P&N chạy ra sau cả logo và khung đăng nhập. Khung đăng nhập ẩn lúc đầu và do Khang
 * cho "chui ra khỏi cặp" (Khang ghi đè bằng style trực tiếp trên lớp bọc); ba
 * trường hợp hiện ngay không chờ: vào bằng link Telegram
 * (`skip`), máy không có WebGL, mô hình không tải được. Quá 10 giây mà Khang chưa
 * sẵn sàng (mô hình tải quá chậm), hay Khang sẵn sàng rồi mà 20 giây sau khung vẫn
 * chưa hiện, thì cũng hiện luôn — không bao giờ chặn việc đăng nhập.
 */

'use client';

import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';

import type { BubbleTone, Greeter } from '@/three/login-greeter';

/** Những gì trang đăng nhập được gọi; gọi trước khi Khang sẵn sàng thì xếp hàng chờ. */
export type GreeterControl = Pick<Greeter, 'say' | 'remind' | 'wrong' | 'leave'>;

const FAILSAFE_MS = 10_000;

export function LoginStage({
  skip,
  greeting,
  control,
  children,
}: {
  /** null: chưa biết (đang đọc địa chỉ trang); true: vào thẳng, không có Khang. */
  skip: boolean | null;
  greeting: string;
  control: MutableRefObject<GreeterControl | null>;
  children: React.ReactNode;
}): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(true);
  const [withScene, setWithScene] = useState(true);
  // Mốc an toàn đã cho khung hiện chưa — Khang hỏi để khỏi kéo khung ra khỏi cặp lần nữa.
  const shownEarly = useRef(false);
  // Câu chào đọc lúc khung bung ra, khi trang đã biết đang đăng nhập hay tạo tài khoản đầu tiên.
  const greetingNow = useRef(greeting);
  greetingNow.current = greeting;

  // Hàng chờ: lệnh tới trước khi Khang sẵn sàng thì giữ lại; không có Khang thì bỏ, riêng `leave` chạy tiếp ngay.
  const queue = useMemo(() => {
    let real: Greeter | null = null;
    let gone = false;
    const waiting: Array<(greeter: Greeter) => void> = [];
    const run = (fn: (greeter: Greeter) => void): void => {
      if (real) fn(real);
      else if (!gone) waiting.push(fn);
    };
    const api: GreeterControl = {
      say: (text: string, tone?: BubbleTone, ms?: number) => run((g) => g.say(text, tone, ms)),
      remind: (target, text) => run((g) => g.remind(target, text)),
      wrong: (text) => run((g) => g.wrong(text)),
      leave: (onDone) => (real ? real.leave(onDone) : onDone()),
    };
    return {
      api,
      attach(greeter: Greeter) {
        real = greeter;
        for (const fn of waiting.splice(0)) fn(greeter);
      },
      drop() {
        gone = true;
        real = null;
        waiting.length = 0;
      },
    };
  }, []);

  useEffect(() => {
    control.current = queue.api;
  }, [control, queue]);

  // Dựng Khang khi đã biết không phải vào thẳng từ Telegram; rời trang thì dọn cảnh.
  useEffect(() => {
    if (skip === null) return;
    const showNow = (): void => {
      queue.drop();
      setWithScene(false);
      setHidden(false);
    };
    if (skip) {
      showNow();
      return;
    }
    let cancelled = false;
    let greeter: Greeter | null = null;
    const showEarly = (): void => {
      shownEarly.current = true;
      setHidden(false);
    };
    let failsafe = setTimeout(showEarly, FAILSAFE_MS);
    void import('@/three/login-greeter')
      .then(({ createGreeter }) =>
        createGreeter({
          canvas: canvas.current!,
          stage: stage.current!,
          form: form.current!,
          bubble: bubble.current!,
          greeting: () => greetingNow.current,
          formShown: () => shownEarly.current,
        }),
      )
      .then((created) => {
        if (cancelled) return created.dispose();
        greeter = created;
        queue.attach(created);
        // Khang đã sẵn sàng và sẽ tự cho khung chui ra khỏi cặp (mất khoảng 8 giây kể cả đi bộ vào);
        // đồng hồ 10 giây kể từ lúc bắt đầu tải không còn hợp, thay bằng một mốc dài hơn chỉ để đề phòng.
        clearTimeout(failsafe);
        failsafe = setTimeout(showEarly, FAILSAFE_MS * 2);
      })
      .catch(() => {
        if (!cancelled) showNow();
      });
    return () => {
      cancelled = true;
      clearTimeout(failsafe);
      greeter?.dispose();
    };
  }, [skip, queue]);

  return (
    <div ref={stage} className="pn-greet-stage">
      <canvas ref={canvas} className="pn-greet-canvas" aria-hidden hidden={!withScene} />
      <div ref={bubble} className="pn-greet-bubble" role="status" aria-live="polite" />
      <div ref={form} className={`pn-greet-form${hidden ? ' pn-greet-hidden' : ''}`}>
        {children}
      </div>
    </div>
  );
}
