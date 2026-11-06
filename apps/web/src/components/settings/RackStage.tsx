/**
 * P&N — Khung sơ đồ 3D tủ máy trên trang Kết nối AI: canvas three.js + nhãn HTML cạnh từng tủ + chú thích.
 * React lo nội dung nhãn; `three/ai-racks.ts` lo vẽ cảnh và đặt vị trí nhãn mỗi khung hình.
 */

'use client';

import { useEffect, useRef, useState } from 'react';

import type { RackScene } from '@/three/ai-racks';

import { PROVIDER_META, seconds, styles as s, type ProviderState } from './kit';

export function RackStage({
  providers,
  selected,
  onSelect,
  modeLabel,
}: {
  /** Nguồn AI theo đúng thứ tự dùng. */
  providers: ProviderState[];
  selected: string;
  onSelect: (id: string) => void;
  /** Dòng phụ dưới nhãn trụ sở, ví dụ "Tự động · Cân bằng". */
  modeLabel: string;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RackScene | null>(null);
  const selectRef = useRef(onSelect);
  const [hover, setHover] = useState<string | null>(null);
  // Tăng lên khi cảnh dựng xong để các effect bên dưới đẩy dữ liệu vào cảnh lần đầu.
  const [ready, setReady] = useState(0);
  selectRef.current = onSelect;

  // Dựng cảnh một lần; three.js nạp động để trang không chờ gói 3D khi chưa cần.
  useEffect(() => {
    let disposed = false;
    void import('@/three/ai-racks').then(({ createRackScene }) => {
      if (disposed || !canvasRef.current || !stageRef.current || !labelsRef.current) return;
      sceneRef.current = createRackScene({
        canvas: canvasRef.current,
        stage: stageRef.current,
        labels: labelsRef.current,
        compactClass: s.compact!,
        onSelect: (id) => selectRef.current(id),
        onHover: setHover,
      });
      setReady((value) => value + 1);
    });
    return () => {
      disposed = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  const key = providers.map((p) => `${p.provider}:${p.usable ? 1 : 0}`).join(',');
  useEffect(() => {
    sceneRef.current?.setItems(
      providers.map((p) => ({ id: p.provider, color: PROVIDER_META[p.provider].color, mark: PROVIDER_META[p.provider].mark, kind: p.kind, usable: p.usable })),
    );
    sceneRef.current?.refit();
    // Chỉ đẩy lại vào cảnh khi thứ tự hoặc trạng thái dùng được đổi (khoá `key`), không phải mỗi lần tải số liệu.
  }, [key, ready]);
  useEffect(() => sceneRef.current?.setSelected(selected), [selected, ready]);
  useEffect(() => sceneRef.current?.setHover(hover), [hover, ready]);

  const live = providers.filter((p) => p.usable);
  const primary = live[0];
  return (
    <div ref={stageRef} className={`${s.card} ${s.stage}`}>
      <canvas ref={canvasRef} aria-label="Sơ đồ 3D: trụ sở P&N nối tới các tủ máy nguồn AI theo thứ tự dùng" />
      <div ref={labelsRef} className={s.labels}>
        <div data-rack="core" className={`${s.node} ${s.nodeCore}`}>
          <span className={s.nodeN} style={{ background: '#5b48e6' }}>P</span>
          <span>
            <b>Trụ sở P&amp;N</b>
            <span className={s.nodeSt}>26 nhân viên gọi AI</span>
            <span className={s.nodeRole}>{modeLabel}</span>
          </span>
        </div>
        {providers.map((p, index) => {
          const meta = PROVIDER_META[p.provider];
          const rank = live.indexOf(p);
          const role = !p.usable ? (p.hasKey || p.kind === 'plan' ? 'Bỏ qua · chưa dùng được' : 'Bỏ qua · chưa có key') : rank === 0 ? 'Hãng chính' : `Dự phòng ${rank}`;
          return (
            <button
              key={p.provider}
              type="button"
              data-rack={p.provider}
              className={`${s.node} ${p.usable ? '' : s.nodeSkip} ${selected === p.provider ? s.nodeSel : ''}`}
              onClick={() => onSelect(p.provider)}
              onPointerEnter={() => setHover(p.provider)}
              onPointerLeave={() => setHover(null)}
              aria-label={`Ô ${index + 1}: ${meta.long}, ${role}`}
            >
              <span className={`${s.nodeN} ${p.usable ? '' : s.nodeNDead}`} style={p.usable ? { background: meta.color } : undefined}>{index + 1}</span>
              <span>
                <b>
                  <span className={s.full}>{meta.name}</span>
                  <span className={s.nick}>{meta.nick}</span>
                </b>
                <span className={s.nodeSt}>
                  <i className={`${s.dot} ${p.usable ? '' : s.dotOff}`} />
                  {role}
                  {p.usable && p.usage.window.avgLatencyMs !== null ? ` · ${seconds(p.usage.window.avgLatencyMs)}` : ''}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div className={s.stageHead}>
        <h2>Sơ đồ kết nối</h2>
        <p>Tủ trên cùng nhận việc trước. Bấm vào tủ để xem chi tiết.</p>
      </div>
      <div className={s.legend} aria-hidden="true">
        <span><i style={{ borderColor: primary ? PROVIDER_META[primary.provider].color : undefined }} />Đường đang dùng</span>
        <span><i className={s.dash} />Dự phòng</span>
        <span><i className={s.skip} />Bỏ qua</span>
      </div>
    </div>
  );
}
