/**
 * P&N — Sơ đồ 2D dạng cây nối dây, thay lưới thẻ phòng ban cũ.
 *
 * Gốc là CEO → Phòng điều hành → dây chuyền sản xuất theo đúng quy trình (sản phẩm → phân tích → thiết kế → các đội
 * dựng → kiểm thử → an ninh → vận hành), nhánh phụ Nghiên cứu. Chuyển động đều từ dữ liệu thật (§9):
 *   - dây đi vào phòng có người đang làm: dòng chấm chạy liên tục;
 *   - mỗi lần một việc thật được chuyển giao (sự kiện TASK_CREATED, BUG_CREATED… có phòng giao → phòng nhận): một chấm
 *     sáng chạy dọc dây từ phòng giao tới phòng nhận.
 * Không có việc thì sơ đồ đứng yên. Máy tính: cây nằm ngang; màn hẹp (điện thoại): cây nằm dọc, cuộn được.
 * Hiệu ứng KHÔNG chặn theo `prefers-reduced-motion`.
 */

'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { AgentRow } from '@/lib/api';
import { STATE_COLOR, STATE_LABEL } from '@/lib/brand';
import { useRealtime, type Handoff } from '@/lib/store';
import { roomName, roomOf } from '@/three/layout';

type NodeId = 'CEO' | string;

/**
 * Vị trí trên cây. Nằm ngang: `col` là tầng theo quy trình, `row` là hàng (1,5 = xương sống — dây chuyền chính đi
 * thẳng một hàng, nhánh phụ tách lên/xuống). Nằm dọc: mỗi mục trong VERTICAL là một hàng, tối đa hai nút.
 */
const HORIZONTAL: Array<{ id: NodeId; col: number; row: number }> = [
  { id: 'CEO', col: 0, row: 1.5 },
  { id: 'COMMAND_CENTER', col: 1, row: 1.5 },
  { id: 'KNOWLEDGE_RND', col: 2, row: 0.15 },
  { id: 'PRODUCT', col: 2, row: 1.5 },
  { id: 'BUSINESS_ANALYSIS', col: 3, row: 1.5 },
  { id: 'UIUX_STUDIO', col: 4, row: 1.5 },
  { id: 'FRONTEND', col: 5, row: 0 },
  { id: 'BACKEND', col: 5, row: 1 },
  { id: 'MOBILE', col: 5, row: 2 },
  { id: 'WEB_DEVELOPMENT', col: 5, row: 3 },
  { id: 'QA_LAB', col: 6, row: 1.5 },
  { id: 'SECURITY_OPS', col: 7, row: 1.5 },
  { id: 'DEVOPS', col: 8, row: 1.5 },
];
/** Hàng hai nút: nhánh phụ đặt hai bên để dây chính luồn qua khe giữa, không cắt ngang ô nào. */
const VERTICAL: NodeId[][] = [
  ['CEO'],
  ['COMMAND_CENTER'],
  ['KNOWLEDGE_RND'],
  ['PRODUCT'],
  ['BUSINESS_ANALYSIS'],
  ['UIUX_STUDIO'],
  ['FRONTEND', 'BACKEND'],
  ['MOBILE', 'WEB_DEVELOPMENT'],
  ['QA_LAB'],
  ['SECURITY_OPS'],
  ['DEVOPS'],
];

/** Dây nối: [từ, tới, nhánh phụ?]. Nhánh phụ (Nghiên cứu) vẽ nét đứt — không nằm trên dây chuyền dự án. */
const EDGES: Array<[NodeId, NodeId, boolean?]> = [
  ['CEO', 'COMMAND_CENTER'],
  ['COMMAND_CENTER', 'PRODUCT'],
  ['COMMAND_CENTER', 'KNOWLEDGE_RND', true],
  ['PRODUCT', 'BUSINESS_ANALYSIS'],
  ['BUSINESS_ANALYSIS', 'UIUX_STUDIO'],
  ['UIUX_STUDIO', 'FRONTEND'],
  ['UIUX_STUDIO', 'BACKEND'],
  ['UIUX_STUDIO', 'MOBILE'],
  ['UIUX_STUDIO', 'WEB_DEVELOPMENT'],
  ['FRONTEND', 'QA_LAB'],
  ['BACKEND', 'QA_LAB'],
  ['MOBILE', 'QA_LAB'],
  ['WEB_DEVELOPMENT', 'QA_LAB'],
  ['QA_LAB', 'SECURITY_OPS'],
  ['SECURITY_OPS', 'DEVOPS'],
];

const ACTIVE = ['working', 'reviewing', 'meeting'];
const STUCK = ['blocked', 'alert'];
/** Kích thước nút (đơn vị logic; cả khối được co theo bề rộng khung). */
const W = 146;
const H = 96;
/** Chừa chỗ cho các nút nổi của văn phòng (thẻ "Văn phòng P&N", nút chuyển 3D) phía trên. */
const TOP = 118;
const PULSE_MS = 1500;
/** Chuyển giao cũ hơn chừng này thì không chạy nữa (mở sơ đồ ra không phát lại cả lô cũ). */
const PULSE_FRESH_MS = 8000;

interface Box { x: number; y: number }

/** Vị trí từng nút. Ngang: mỗi tầng một cột. Dọc: mỗi tầng một hàng, tối đa hai nút một hàng cho vừa điện thoại. */
function layout(vertical: boolean): { boxes: Map<NodeId, Box>; width: number; height: number } {
  const boxes = new Map<NodeId, Box>();
  if (!vertical) {
    const colGap = 156;
    const rowGap = 108;
    for (const node of HORIZONTAL) boxes.set(node.id, { x: 16 + node.col * colGap, y: 16 + node.row * rowGap });
    return { boxes, width: 16 * 2 + 8 * colGap + W, height: 16 * 2 + 3 * rowGap + H };
  }
  // Hai cột sát nhau, khe giữa đúng chỗ dây chính đi qua.
  const colGap = W + 18;
  const rowGap = 128;
  VERTICAL.forEach((row, index) => {
    const left = 16 + ((2 - row.length) * colGap) / 2;
    row.forEach((id, j) => boxes.set(id, { x: left + j * colGap, y: 16 + index * rowGap }));
  });
  return { boxes, width: 16 * 2 + colGap + W, height: 16 * 2 + (VERTICAL.length - 1) * rowGap + H };
}

/** Đường cong nối hai nút theo chiều cây. */
function wire(a: Box, b: Box, vertical: boolean): string {
  if (vertical) {
    const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H, b.x + W / 2, b.y];
    const bend = Math.max(24, (y2 - y1) / 2);
    return `M${x1},${y1} C${x1},${y1 + bend} ${x2},${y2 - bend} ${x2},${y2}`;
  }
  const [x1, y1, x2, y2] = [a.x + W, a.y + H / 2, b.x, b.y + H / 2];
  const bend = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}

/** Chuyển giao giữa hai phòng không kề nhau (QA trả lỗi về đội dựng…): cung nối thẳng tâm hai nút. */
function arc(a: Box, b: Box): string {
  const [x1, y1, x2, y2] = [a.x + W / 2, a.y + H / 2, b.x + W / 2, b.y + H / 2];
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2 - Math.max(40, Math.abs(x2 - x1) / 4);
  return `M${x1},${y1} Q${mx},${my} ${x2},${y2}`;
}

export function OrgFlow2D({ agents, onSelect }: { agents: AgentRow[]; onSelect: (role: string) => void }): React.JSX.Element {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const handoffs = useRealtime((state) => state.handoffs);
  const clearHandoff = useRealtime((state) => state.clearHandoff);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const measure = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const vertical = size.w > 0 && size.w < 760;
  const { boxes, width, height } = useMemo(() => layout(vertical), [vertical]);
  // Co (hoặc phóng tối đa 1,2 lần) cho vừa bề rộng khung — không cuộn ngang; thiếu chiều cao thì cuộn dọc.
  const scale = size.w ? Math.min(1.2, (size.w - 24) / width) : 1;

  const byDepartment = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    for (const agent of agents) map.set(agent.department, [...(map.get(agent.department) ?? []), agent]);
    return map;
  }, [agents]);
  const departmentOf = useMemo(() => new Map(agents.map((agent) => [agent.role, agent.department])), [agents]);
  const tone = (id: NodeId): 'live' | 'stuck' | 'idle' => {
    const list = byDepartment.get(id) ?? [];
    if (list.some((agent) => STUCK.includes(agent.state))) return 'stuck';
    return list.some((agent) => ACTIVE.includes(agent.state)) ? 'live' : 'idle';
  };

  // Chuyển giao mới → chấm sáng chạy từ phòng giao tới phòng nhận; chạy xong thì bỏ khỏi hàng (3D không phát lại).
  const pulses = handoffs
    .filter((handoff) => Date.now() - handoff.startedAt < PULSE_FRESH_MS)
    .map((handoff) => {
      const from = handoff.fromRole ? departmentOf.get(handoff.fromRole) : 'CEO';
      const to = departmentOf.get(handoff.toRole);
      const a = from ? boxes.get(from) : undefined;
      const b = to ? boxes.get(to) : undefined;
      if (!a || !b || from === to) return null;
      const direct = EDGES.find(([x, y]) => x === from && y === to);
      return { handoff, d: direct ? wire(a, b, vertical) : arc(a, b) };
    })
    .filter((pulse): pulse is { handoff: Handoff; d: string } => pulse !== null);

  const working = agents.filter((agent) => ACTIVE.includes(agent.state)).length;

  return (
    <div ref={frame} className="flex h-full flex-col overflow-y-auto overflow-x-hidden bg-surface-0" style={{ paddingTop: TOP }}>
      <div className="relative mx-auto shrink-0" style={{ width: width * scale, height: height * scale }}>
        <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `scale(${scale})` }}>
          <svg className="absolute inset-0" width={width} height={height} aria-hidden>
            {EDGES.map(([from, to, side]) => {
              const a = boxes.get(from);
              const b = boxes.get(to);
              if (!a || !b) return null;
              const state = tone(to);
              const d = wire(a, b, vertical);
              return (
                <g key={`${from}-${to}`}>
                  <path d={d} className={`pn-wire${side ? ' is-side' : ''}${state === 'stuck' ? ' is-stuck' : ''}`} />
                  {state === 'live' && <path d={d} className="pn-wire-flow" />}
                </g>
              );
            })}
            {pulses.map(({ handoff, d }) => (
              <Pulse key={handoff.id} d={d} label={handoff.label} onDone={() => clearHandoff(handoff.id)} />
            ))}
          </svg>
          {[...boxes.keys()].map((id) => {
            const box = boxes.get(id)!;
            return id === 'CEO' ? (
              <div key={id} className="pn-org-node is-ceo" style={{ left: box.x, top: box.y, width: W, height: H }}>
                <span className="pn-org-en">OWNER</span>
                <b className="pn-org-vi">CEO</b>
                <span className="pn-org-meta">Giao việc, duyệt chi phí và phát hành</span>
              </div>
            ) : (
              <DepartmentNode key={id} id={id} box={box} agents={byDepartment.get(id) ?? []} state={tone(id)} onSelect={onSelect} />
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 px-5 pb-24 pt-4 text-[11px] text-ink-500">
        <b className="font-semibold text-ink-300">{working > 0 ? `${working} người đang làm` : 'Không ai đang làm — sơ đồ đứng yên'}</b>
        <span className="flex items-center gap-1.5"><i className="pn-flow-key" /> dây vào phòng đang làm việc</span>
        <span className="flex items-center gap-1.5"><i className="pn-flow-dot" /> việc vừa được chuyển giao</span>
        <span className="flex items-center gap-1.5"><i className="pn-flow-side" /> nhánh hỗ trợ, ngoài dây chuyền dự án</span>
      </div>
    </div>
  );
}

/** Một phòng trên cây: số phòng, tên song ngữ (5a), và mỗi nhân viên một chấm bấm được. */
function DepartmentNode({ id, box, agents, state, onSelect }: {
  id: string;
  box: Box;
  agents: AgentRow[];
  state: 'live' | 'stuck' | 'idle';
  onSelect: (role: string) => void;
}): React.JSX.Element {
  const room = roomOf(id);
  const busy = agents.filter((agent) => ACTIVE.includes(agent.state)).length;
  return (
    <div
      className={`pn-org-node is-${state}`}
      style={{ left: box.x, top: box.y, width: W, height: H, ['--accent' as string]: room?.accent ?? '#8b9aa3' }}
    >
      <span className="pn-org-num">{room?.number}</span>
      <span className="pn-org-en">{room?.labelEn ?? id}</span>
      <b className="pn-org-vi">{room ? roomName(room) : id}</b>
      <span className="pn-org-meta">
        {agents.length === 0 ? 'Chưa có người' : busy > 0 ? `${busy}/${agents.length} đang làm` : `${agents.length} người · rảnh`}
      </span>
      <span className="pn-org-people">
        {agents.map((agent) => (
          <button
            key={agent.role}
            type="button"
            onClick={() => onSelect(agent.role)}
            title={`${agent.displayName} — ${STATE_LABEL[agent.state] ?? agent.state}`}
            aria-label={`${agent.displayName}, ${STATE_LABEL[agent.state] ?? agent.state}`}
            className={ACTIVE.includes(agent.state) ? 'is-busy' : ''}
            style={{ background: STATE_COLOR[agent.state] ?? '#7c8899' }}
          />
        ))}
      </span>
    </div>
  );
}

/** Chấm sáng chạy dọc dây một lần (đo đường bằng getPointAtLength — chạy được mọi trình duyệt, không cần SMIL). */
function Pulse({ d, label, onDone }: { d: string; label: string; onDone: () => void }): React.JSX.Element {
  const path = useRef<SVGPathElement>(null);
  const dot = useRef<SVGGElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const line = path.current;
    const mark = dot.current;
    if (!line || !mark) return;
    const length = line.getTotalLength();
    const start = performance.now();
    let frameId = 0;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / PULSE_MS);
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const point = line.getPointAtLength(eased * length);
      mark.setAttribute('transform', `translate(${point.x} ${point.y})`);
      if (t < 1) frameId = requestAnimationFrame(step);
      else window.setTimeout(() => done.current(), 400);
    };
    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [d]);

  return (
    <g>
      <path ref={path} d={d} fill="none" stroke="none" />
      <g ref={dot} className="pn-pulse-dot">
        <title>{label}</title>
        <circle r="11" className="pn-pulse-halo" />
        <circle r="5" className="pn-pulse-core" />
      </g>
    </g>
  );
}
