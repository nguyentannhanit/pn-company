/**
 * P&N — Trợ lý điều hành trên web (§5.1, §57).
 *
 * Cùng bộ não với bot Telegram: gọi `/assistant/ask`, câu hỏi thì trả lời bằng
 * số liệu thật, mô tả sản phẩm thì đề nghị tạo dự án và chỉ tạo khi CEO bấm.
 * Trước đây ô "P&N Copilot" ở góc trái chỉ là một khung chữ tĩnh. Nay
 * Khang (nhân viên lễ tân 3D) đứng ở đầu khung và đổi động tác theo việc đang làm.
 */

'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import { PRODUCT_TYPE_LABEL } from '@/lib/brand';
import { RECEPTIONIST, type AssistantMood } from '@/three/Reception';

// Three.js chỉ chạy ở trình duyệt; tải động để khung mở nhanh và không dựng ở server.
const ReceptionStage = dynamic(() => import('@/three/Reception').then((module) => module.ReceptionStage), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-surface-3" />,
});

type Reply =
  | { intent: 'answer'; text: string; costUsd?: number }
  | { intent: 'project'; goal: string; name: string; productType: string; costUsd?: number };

type Turn =
  | { kind: 'ceo'; text: string }
  | { kind: 'bot'; text: string }
  | { kind: 'proposal'; goal: string; name: string; productType: string; created?: { id: string; name: string } }
  | { kind: 'note'; text: string };

const QUICK = ['Hôm nay tiêu bao nhiêu?', 'Phòng nào đang làm việc?', 'Có phiếu nào chờ tôi?', 'Sản phẩm nào mở được rồi?'];

export function AssistantDrawer({
  open,
  onClose,
  initialQuestion,
}: {
  open: boolean;
  onClose: () => void;
  /** Câu điền sẵn vào ô hỏi (từ ô lệnh trên cùng); CEO tự bấm gửi. */
  initialQuestion?: string;
}): React.JSX.Element | null {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // Động tác của Khang: chờ → tra số liệu → trả lời / vẫy tay khi tạo xong dự án / lỗi.
  const [mood, setMood] = useState<AssistantMood>('idle');
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [turns, open]);

  useEffect(() => {
    if (open && initialQuestion) setText(initialQuestion);
  }, [open, initialQuestion]);

  useEffect(() => {
    if (!open) {
      setMood('idle');
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ask = async (question: string): Promise<void> => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setMood('thinking');
    setText('');
    setTurns((current) => [...current, { kind: 'ceo', text: trimmed }]);
    try {
      const reply = await api<Reply>('/assistant/ask', { method: 'POST', body: { question: trimmed } });
      setTurns((current) => [
        ...current,
        reply.intent === 'project'
          ? { kind: 'proposal', goal: reply.goal, name: reply.name, productType: reply.productType }
          : { kind: 'bot', text: reply.text },
      ]);
      setMood('answering');
    } catch (caught) {
      setTurns((current) => [...current, { kind: 'note', text: caught instanceof Error ? caught.message : 'Trợ lý không trả lời được.' }]);
      setMood('error');
    } finally {
      setBusy(false);
    }
  };

  const create = async (index: number, proposal: { goal: string; name: string; productType: string }): Promise<void> => {
    setBusy(true);
    setMood('thinking');
    try {
      const result = await api<{ project: { id: string; name: string } }>('/orchestrator/intake', {
        method: 'POST',
        // Chạy nền để không bị đường hầm cắt khi CTO lập kế hoạch lâu.
        body: { goal: proposal.goal, productType: proposal.productType, background: true },
      });
      setTurns((current) =>
        current.map((turn, i) => (i === index && turn.kind === 'proposal' ? { ...turn, created: result.project } : turn)),
      );
      setMood('done');
    } catch (caught) {
      setTurns((current) => [...current, { kind: 'note', text: caught instanceof Error ? caught.message : 'Không tạo được dự án.' }]);
      setMood('error');
    } finally {
      setBusy(false);
    }
  };

  // Gắn thẳng vào body: nằm trong khung Tổng quan thì luật CSS kính trong suốt
  // của trang đó (`.office-dashboard aside`, `.depth-panel`) đè lên, trợ lý bị nhìn xuyên.
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-label="Trợ lý P&N">
      <button aria-label="Đóng" onClick={onClose} className="flex-1 bg-black/45 backdrop-blur-[2px]" />
      <aside className="pn-slide-in depth-panel flex h-full w-full max-w-[420px] flex-col border-l border-line bg-surface-1">
        {/* Điện thoại: chừa vùng an toàn cho thanh trạng thái, nút đóng to 40px cho dễ chạm. */}
        <header className="flex items-center gap-3 border-b border-line px-4 pb-3.5 pt-[calc(env(safe-area-inset-top)+14px)]">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-brand-400/30 bg-brand-500/15 text-brand-300">✦</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink-100">
              {RECEPTIONIST.name} · {RECEPTIONIST.title}
            </p>
            <p className="text-[11px] text-ink-500">Trợ lý P&amp;N — hỏi gì về công ty cũng được. Cùng bộ não với bot Telegram.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Đóng (Esc)"
            aria-label="Đóng trợ lý"
            className="pn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-fill-1 text-base text-ink-300 hover:text-ink-100"
          >
            ✕
          </button>
        </header>

        {/* Khang sau quầy, động tác theo trạng thái; cao vừa đủ thấy nửa người, không lấn phần hội thoại. */}
        <div className="h-[150px] shrink-0 border-b border-line bg-[#1c3140]">
          <ReceptionStage mood={mood} />
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {turns.length === 0 && (
            <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-xs leading-relaxed text-ink-500">
              Ví dụ: <i>"hôm nay tiêu bao nhiêu?"</i>, <i>"phòng nào đang rảnh?"</i>, hoặc mô tả một sản phẩm muốn làm.
            </p>
          )}
          {turns.map((turn, index) => {
            if (turn.kind === 'ceo') {
              return (
                <div key={index} className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-md bg-[linear-gradient(180deg,#7a67ff,#5b48e6)] px-3.5 py-2.5 text-sm leading-relaxed text-white">{turn.text}</div>
                </div>
              );
            }
            if (turn.kind === 'note') return <p key={index} className="text-center text-xs text-state-alert">{turn.text}</p>;
            if (turn.kind === 'bot') {
              return (
                <div key={index} className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-bl-md border border-line bg-surface-1 px-3.5 py-2.5 text-sm leading-relaxed text-ink-100">
                  {turn.text}
                </div>
              );
            }
            return (
              <div key={index} className="max-w-[92%] rounded-2xl rounded-bl-md border border-brand-400/25 bg-surface-3 px-3.5 py-3 text-sm leading-relaxed text-ink-100">
                <p>
                  Tôi hiểu đây là việc mới: <b>{turn.name}</b> ({PRODUCT_TYPE_LABEL[turn.productType] ?? turn.productType}).
                </p>
                <p className="mt-1.5 text-xs italic text-ink-300">{turn.goal}</p>
                {turn.created ? (
                  <p className="mt-2.5 text-xs text-state-working">
                    Đã tạo dự án, CTO đang phân rã. <a href={`/projects/${turn.created.id}`} className="underline">Mở dự án →</a>
                  </p>
                ) : (
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" onClick={() => void create(index, turn)} loading={busy}>
                      Tạo dự án
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => setText(turn.goal)} disabled={busy}>
                      Sửa lại
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {busy && <p className="text-xs text-ink-500">Đang đọc số liệu…</p>}
          <div ref={bottom} />
        </div>

        <div className="border-t border-line p-3 pb-[calc(env(safe-area-inset-bottom)+12px)]">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => void ask(item)}
                disabled={busy}
                className="pn-press rounded-full border border-line bg-fill-1 px-2.5 py-1 text-[11px] text-ink-300 hover:border-line-strong hover:text-ink-100 disabled:opacity-50"
              >
                {item}
              </button>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void ask(text);
            }}
            className="flex items-end gap-2"
          >
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void ask(text);
                }
              }}
              rows={2}
              placeholder="Hỏi hoặc giao việc…"
              className="pn-focus min-h-[44px] flex-1 resize-none rounded-xl border border-line bg-surface-0 px-3 py-2.5 text-sm text-ink-100 outline-none placeholder:text-ink-500 focus:border-brand-400/60"
            />
            <Button type="submit" disabled={busy || !text.trim()} title="Gửi (Enter)">
              ↑
            </Button>
          </form>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
