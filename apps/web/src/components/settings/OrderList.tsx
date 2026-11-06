/**
 * P&N — Danh sách "Thứ tự dùng hãng": kéo tay nắm (chuột lẫn cảm ứng), bấm ▲▼ hoặc phím mũi tên để xếp.
 * Thứ tự mới hiện ngay trên sơ đồ 3D nhưng chỉ ghi vào bảng định tuyến khi CEO bấm Lưu.
 */

'use client';

import { useRef, useState } from 'react';

import { Bar, Pill, PROVIDER_META, int, okTone, pct, seconds, shortModel, styles as s, TIER_ORDER, type ProviderId, type ProviderState, type Tier } from './kit';

const GRIP = (
  <svg viewBox="0 0 12 18" width="12" height="18" aria-hidden="true">
    <g fill="currentColor">
      <circle cx="3" cy="3" r="1.6" /><circle cx="9" cy="3" r="1.6" />
      <circle cx="3" cy="9" r="1.6" /><circle cx="9" cy="9" r="1.6" />
      <circle cx="3" cy="15" r="1.6" /><circle cx="9" cy="15" r="1.6" />
    </g>
  </svg>
);

export function OrderList({
  order,
  providers,
  selected,
  mix,
  totalCalls,
  onSelect,
  onChange,
}: {
  order: ProviderId[];
  providers: ProviderState[];
  selected: string;
  /** Số vai trò theo bậc đang chạy — để ghi "nếu nhận việc: 8 Opus · 14 Sonnet · 4 Haiku". */
  mix: Record<Tier, number>;
  totalCalls: number;
  onSelect: (id: ProviderId) => void;
  onChange: (order: ProviderId[]) => void;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: ProviderId; startY: number; dy: number } | null>(null);
  const byId = new Map(providers.map((p) => [p.provider, p]));
  const live = order.filter((id) => byId.get(id)?.usable);

  const move = (id: ProviderId, to: number): void => {
    const from = order.indexOf(id);
    if (from < 0 || to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
  };

  // Kéo thả: bắt con trỏ trên cả danh sách (phần tử cố định) để hàng đổi chỗ trong DOM không làm mất thao tác.
  const onPointerDown = (event: React.PointerEvent, id: ProviderId): void => {
    event.preventDefault();
    listRef.current?.setPointerCapture(event.pointerId);
    setDrag({ id, startY: event.clientY, dy: 0 });
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    if (!drag || !listRef.current) return;
    const rows = [...listRef.current.querySelectorAll<HTMLElement>('[data-row]')];
    const index = order.indexOf(drag.id);
    const row = rows[index];
    if (!row) return;
    const gap = parseFloat(getComputedStyle(listRef.current).rowGap) || 8;
    const rect = row.getBoundingClientRect();
    const mid = rect.top + rect.height / 2 + (event.clientY - drag.startY - drag.dy);
    const next = rows[index + 1];
    const prev = rows[index - 1];
    if (next && mid > next.getBoundingClientRect().top + next.offsetHeight / 2) {
      move(drag.id, index + 1);
      setDrag({ ...drag, startY: drag.startY + next.offsetHeight + gap, dy: event.clientY - drag.startY - next.offsetHeight - gap });
      return;
    }
    if (prev && mid < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
      move(drag.id, index - 1);
      setDrag({ ...drag, startY: drag.startY - prev.offsetHeight - gap, dy: event.clientY - drag.startY + prev.offsetHeight + gap });
      return;
    }
    setDrag({ ...drag, dy: event.clientY - drag.startY });
  };
  const endDrag = (): void => setDrag(null);

  return (
    <div ref={listRef} className={s.plist} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {order.map((id, index) => {
        const p = byId.get(id);
        if (!p) return null;
        const meta = PROVIDER_META[id];
        const rank = live.indexOf(id);
        const w = p.usage.window;
        const okRatio = w.calls ? w.ok / w.calls : 0;
        const dragging = drag?.id === id;
        const models = TIER_ORDER.filter((tier) => mix[tier] > 0).map((tier) => `${mix[tier]} ${shortModel(id, p.models[tier])}`);
        return (
          <div
            key={id}
            data-row
            className={`${s.prow} ${rank === 0 ? s.prowPrimary : ''} ${p.usable ? '' : s.prowDead} ${dragging ? s.prowDragging : ''} ${selected === id ? s.prowSel : ''}`}
            style={{ '--row-c': meta.color, ...(dragging ? { transform: `translateY(${drag.dy}px)` } : {}) } as React.CSSProperties}
          >
            <button
              type="button"
              className={s.grip}
              aria-label={`Kéo để đổi chỗ ${meta.name}. Dùng phím mũi tên lên xuống.`}
              onPointerDown={(event) => onPointerDown(event, id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                move(id, index + (event.key === 'ArrowUp' ? -1 : 1));
              }}
            >
              {GRIP}
            </button>
            <span className={`${s.rank} ${p.usable ? '' : s.rankDead}`} style={p.usable ? { background: meta.color } : undefined}>{index + 1}</span>
            <button type="button" className={s.pname} onClick={() => onSelect(id)}>
              <span className={`${s.swatch} ${s.swatchSm} ${p.usable ? '' : s.swatchDead}`} style={{ background: meta.color }}>{meta.mark}</span>
              <span>
                <b>{meta.long}</b>
                <small>{p.kind === 'plan' ? 'CLI · đăng nhập tài khoản · $0 mỗi lượt' : 'API · dán khoá · trả theo token'}</small>
              </span>
            </button>
            <div className={s.pstat}>
              {p.usable ? (
                <>
                  <Pill tone={rank === 0 ? 'brand' : 'good'}>{rank === 0 ? 'Hãng chính' : `Dự phòng ${rank}`}</Pill>
                  <span>Chạy được · TB {seconds(w.avgLatencyMs)}</span>
                </>
              ) : (
                <>
                  <Pill tone={p.status === 'ERROR' ? 'bad' : 'off'}>Bỏ qua</Pill>
                  <span>{p.status === 'ERROR' ? 'Kiểm tra lỗi' : p.kind === 'plan' ? (p.isEnabled ? 'Chưa đăng nhập được' : 'Chưa bật') : p.hasKey ? 'Đang tắt' : 'Chưa có key'}</span>
                </>
              )}
            </div>
            <div className={`${s.meter} ${s.pusage}`}>
              <div className={s.meterTop}>
                <span>{int(w.calls)} lượt 30 ngày</span>
                <b>{w.calls ? `${pct(okRatio)} thành công` : '—'}</b>
              </div>
              <Bar ratio={totalCalls ? w.calls / totalCalls : 0} tone={w.calls ? (okTone(okRatio) === 'good' ? 'brand' : okTone(okRatio)) : 'off'} />
            </div>
            <div className={s.pmodels}>
              {p.usable ? <><b>Nếu nhận việc:</b> {models.join(' · ')}</> : <span className={s.muted}>Không nhận việc tới khi dùng được</span>}
            </div>
            <div className={s.moves}>
              <button type="button" disabled={index === 0} onClick={() => move(id, index - 1)} aria-label={`Đưa ${meta.name} lên`}>▲</button>
              <button type="button" disabled={index === order.length - 1} onClick={() => move(id, index + 1)} aria-label={`Đưa ${meta.name} xuống`}>▼</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
