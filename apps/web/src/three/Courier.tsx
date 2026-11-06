/**
 * P&N — Người đưa việc giữa các phòng ban (§9).
 *
 * Đây là phần trả lời câu hỏi "công ty đang làm gì": khi CTO giao task cho
 * Backend, chính CTO đứng dậy khỏi bàn, cầm tập hồ sơ đi ra cửa, qua hành lang,
 * vào phòng Backend, trao tận bàn người nhận rồi đi về chỗ ngồi. Việc CEO giao
 * thẳng thì Khang ở quầy lễ tân mang lên theo cầu thang ngoài. Không có event
 * thì không có ai đi — mọi chuyển động ở đây đều bắt nguồn từ một lần chuyển
 * giao có thật trong `agent_runs`.
 *
 * Trước đây người đưa việc là một nhân viên lạ hiện ra ở cửa phòng rồi biến
 * mất ở cửa phòng kia; trông "như bụt hiện ra". Nay nhiều hồ sơ của cùng
 * một người được gom thành một vòng qua các phòng (`tour.ts`), và người nhận tỉnh
 * dậy đáp lại khi được trao.
 */

'use client';

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Group } from 'three';

import type { Handoff } from '@/lib/store';

import { Employee } from './Employee';
import { roomOf, type Point3, type RoomSpec, type Seat } from './layout';
import { RECEPTIONIST_ROLE, awayFromDesk, received } from './presence';
import { RECEPTIONIST } from './Reception';
import { HAND_S, STAND_S, planTour, tourAt, yawOf, type Place, type Tour, type TourPhase } from './tour';

/** Chờ chừng này sau hồ sơ đầu tiên rồi mới đứng dậy, để gom các hồ sơ đến cùng đợt vào một vòng. */
const GATHER_MS = 1200;

/** Màu tập việc theo loại chuyển giao: việc mới, lỗi trả về, kết quả bàn giao. */
const KIND: Record<Handoff['kind'], { color: string; icon: string }> = {
  task: { color: '#6b8faa', icon: '▤' },
  bug: { color: '#c77e66', icon: '!' },
  report: { color: '#649b86', icon: '✓' },
};

/** Bàn làm việc của một vai trò (phòng + chỗ ngồi), `null` nếu vai trò chưa có bàn. */
export type SeatOf = (role: string) => { spec: RoomSpec; seat: Seat } | null;

/* -------------------------------------------------------------------------- */
/* Đường đi vẽ trên sàn                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Vạch dẫn trên sàn nối bàn người gửi với bàn từng người nhận. Chỉ vẽ đoạn nằm
 * ngang; đoạn leo cầu thang của Khang không vẽ vạch.
 */
function RouteLine({ path, stops, color }: { path: Point3[]; stops: Point3[]; color: string }): React.JSX.Element {
  const segments = useMemo(
    () =>
      path.slice(1).flatMap((point, index) => {
        const [ax, ay, az] = path[index]!;
        const [bx, by, bz] = point;
        if (Math.abs(ay - by) > 0.01) return [];
        return [
          {
            x: (ax + bx) / 2,
            y: ay,
            z: (az + bz) / 2,
            length: Math.hypot(bx - ax, bz - az),
            angle: Math.atan2(bz - az, bx - ax),
          },
        ];
      }),
    [path],
  );

  return (
    <group>
      {segments.map((segment, index) => (
        <mesh
          key={index}
          rotation={[-Math.PI / 2, 0, -segment.angle]}
          position={[segment.x, segment.y + 0.087, segment.z]}
        >
          <planeGeometry args={[segment.length, 0.13]} />
          <meshBasicMaterial color={color} transparent opacity={0.72} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}

      {/* Dấu đích đứng yên cạnh bàn từng người nhận còn chưa được trao. */}
      {stops.map((end, index) => (
        <mesh key={index} rotation={[-Math.PI / 2, 0, 0]} position={[end[0], end[1] + 0.088, end[2]]}>
          <ringGeometry args={[0.55, 0.78, 24]} />
          <meshBasicMaterial color={color} transparent opacity={0.72} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/* -------------------------------------------------------------------------- */
/* Một người đưa việc                                                          */
/* -------------------------------------------------------------------------- */

/** Đặt người ở vị trí đã đi được `distance` trên đường, quay theo hướng đi. */
function placeOn(path: Point3[], distance: number, group: Group): void {
  let remaining = distance;
  for (let i = 1; i < path.length; i += 1) {
    const [ax, ay, az] = path[i - 1]!;
    const [bx, by, bz] = path[i]!;
    const segment = Math.hypot(bx - ax, by - ay, bz - az);
    if (remaining > segment && i < path.length - 1) {
      remaining -= segment;
      continue;
    }
    const ratio = segment > 0 ? Math.min(1, Math.max(0, remaining) / segment) : 1;
    group.position.set(ax + (bx - ax) * ratio, ay + (by - ay) * ratio, az + (bz - az) * ratio);
    if (Math.hypot(bx - ax, bz - az) > 0.01) group.rotation.y = yawOf(bx - ax, bz - az);
    return;
  }
  const [x, y, z] = path[0]!;
  group.position.set(x, y, z);
}

/** Đoạn đường từ đầu vòng tới quãng `distance` — vạch dẫn chỉ vẽ phần đi giao, không vẽ đường về. */
function pathUntil(path: Point3[], distance: number): Point3[] {
  const out: Point3[] = [path[0]!];
  let walked = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    walked += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    out.push(b);
    if (walked >= distance - 0.01) break;
  }
  return out;
}

/**
 * Người đứng dậy, ôm tập hồ sơ đi một vòng qua bàn từng người nhận, trao từng
 * tập, rồi đi về chỗ. Tính theo đồng hồ thật từ `start` nên khung hình chậm cũng
 * không làm lệch đường.
 */
function Walker({
  tour,
  start,
  model,
  scale,
  onDone,
  calm,
}: {
  tour: Tour;
  start: number;
  model?: string;
  scale: number;
  onDone: () => void;
  calm: boolean;
}): React.JSX.Element {
  const group = useRef<Group>(null);
  const folder = useRef<Group>(null);
  const done = useRef(false);
  // Điểm giao đã báo cho người nhận, để mỗi người chỉ được báo một lần.
  const told = useRef(-1);
  const [moment, setMoment] = useState<{ phase: TourPhase; stop: number }>({ phase: 'waiting', stop: 0 });
  const deliverPath = useMemo(() => pathUntil(tour.path, tour.stops.at(-1)!.at), [tour]);

  // Rời cảnh (xong vòng, hoặc vòng được dựng lại vì thêm hồ sơ) thì trả người về ghế.
  useEffect(() => () => void awayFromDesk.delete(tour.who), [tour.who]);

  useFrame(() => {
    const g = group.current;
    if (!g || done.current) return;
    const now = tourAt(tour, (Date.now() - start) / 1000, calm);
    if (now.phase === 'done') {
      done.current = true;
      g.visible = false;
      awayFromDesk.delete(tour.who);
      onDone();
      return;
    }

    g.visible = now.phase !== 'waiting';
    if (now.phase === 'waiting') return;
    awayFromDesk.add(tour.who);

    if (now.phase === 'standing') {
      placeOn(tour.path, 0, g);
      // Người ngồi bàn quay mặt ra phía trước phòng (+Z).
      g.rotation.y = yawOf(0, 1);
    } else if (now.phase === 'handing') {
      const stop = tour.stops[now.stop]!;
      placeOn(tour.path, stop.at, g);
      g.rotation.y = stop.faceYaw;
      // Chìa hồ sơ ra là người nhận tỉnh dậy đáp lại (Employee đọc `received`).
      if (told.current < now.stop) {
        told.current = now.stop;
        received.set(stop.handoff.toRole, { at: Date.now(), label: stop.handoff.label });
      }
    } else {
      placeOn(tour.path, now.distance, g);
    }
    // Còn hồ sơ trên tay khi đang đi giao và nửa đầu lúc trao tập cuối; về thì tay không.
    if (folder.current) {
      const last = now.stop === tour.stops.length - 1;
      folder.current.visible =
        now.phase === 'going' || (now.phase === 'handing' && (!last || calm || now.handing < HAND_S / 2));
    }
    if (now.phase !== moment.phase || now.stop !== moment.stop) setMoment({ phase: now.phase, stop: now.stop });
  });

  const current = tour.stops[Math.min(moment.stop, tour.stops.length - 1)]!;
  const kind = KIND[current.handoff.kind];
  const left = tour.stops.length - moment.stop;
  const state =
    moment.phase === 'going' ? 'carrying' : moment.phase === 'returning' ? 'walking' : moment.phase === 'handing' ? 'handing' : 'idle';
  const delivering = moment.phase === 'going' || moment.phase === 'handing';

  return (
    <>
      {/* Vạch dẫn chỉ hiện khi người đang mang việc đi — vòng còn xếp hàng thì chưa vẽ. */}
      {delivering && (
        <RouteLine path={deliverPath} stops={tour.stops.slice(moment.stop).map((stop) => stop.spot)} color={kind.color} />
      )}
      <group ref={group} visible={false}>
      <group scale={scale}>
        {/* Dấu chân phân biệt người đang đi giao việc với người ngồi tại bàn. */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]}>
          <circleGeometry args={[0.62, 20]} />
          <meshBasicMaterial color={kind.color} transparent opacity={0.16} toneMapped={false} depthWrite={false} />
        </mesh>

        <Employee state={state} role={tour.who} model={model} seated={false} calm={calm} />

        {/* Tập hồ sơ ôm trước ngực, đúng tầm hai bàn tay — thứ đang được chuyển giao. */}
        <group ref={folder} position={[0, 2.02, -0.72]} rotation={[-1.05, 0, 0]}>
          <mesh>
            <boxGeometry args={[0.62, 0.8, 0.07]} />
            <meshStandardMaterial color={kind.color} roughness={0.7} />
          </mesh>
          <mesh position={[0, 0.02, 0.04]}>
            <boxGeometry args={[0.52, 0.66, 0.02]} />
            <meshStandardMaterial color="#f3efe4" roughness={0.9} />
          </mesh>
        </group>
      </group>

      {/* Nhãn nói rõ tập đang mang tới đâu, còn mấy tập sau; về tay không thì bỏ nhãn. */}
      {delivering && (
        <Html position={[0, 3.7 * scale, 0]} center zIndexRange={[9, 0]}>
          <div
            className="office-walker-label pointer-events-none flex max-w-[210px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-lg backdrop-blur"
            style={{ background: '#081420ee', borderColor: `${kind.color}66`, color: kind.color }}
          >
            <span className="font-bold leading-none">{kind.icon}</span>
            <span className="office-walker-text truncate text-white/85">{current.handoff.label}</span>
            {left > 1 && <span className="font-mono text-white/60">+{left - 1}</span>}
          </div>
        </Html>
      )}
      </group>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Tất cả chuyển giao đang diễn ra                                             */
/* -------------------------------------------------------------------------- */

/** Một vòng đã chốt giờ đứng dậy; còn nhận thêm hồ sơ cho tới lúc bước đi. */
interface Round {
  id: string;
  who: string;
  from: Place | null;
  stops: Array<{ handoff: Handoff; place: Place }>;
  start: number;
  tour: Tour;
}

/**
 * Gom chuyển giao thành vòng đi. Một người chỉ đi một vòng mỗi lúc: CTO chia sáu
 * việc cùng lúc thì ôm sáu tập đi MỘT vòng qua sáu phòng, không đi sáu chuyến và
 * không nhân bản thành sáu CTO. Hồ sơ mới đến khi người đó đã bước đi thì vào vòng
 * sau, bắt đầu khi vòng này về tới bàn.
 */
export function Couriers({
  handoffs,
  departmentOfRole,
  seatOf,
  onArrive,
  calm = false,
}: {
  handoffs: Handoff[];
  /** Vai trò thuộc phòng ban nào — lấy từ danh sách agent thật của máy chủ. */
  departmentOfRole: (role: string) => string | null;
  seatOf: SeatOf;
  onArrive: (id: string) => void;
  calm?: boolean;
}): React.JSX.Element {
  const rounds = useRef(new Map<string, Round>());
  const seen = useRef(new Set<string>());
  // Vòng mới nhất của từng người, và lúc họ về tới bàn.
  const latest = useRef(new Map<string, string>());
  const busyUntil = useRef(new Map<string, number>());
  const [finished, setFinished] = useState(0);

  const { list, unplaceable } = useMemo(() => {
    const unplaceable: string[] = [];
    for (const handoff of handoffs) {
      if (seen.current.has(handoff.id)) continue;
      seen.current.add(handoff.id);

      const room = roomOf(departmentOfRole(handoff.toRole));
      const fromRoom = handoff.fromRole === null ? null : roomOf(departmentOfRole(handoff.fromRole));
      // Không vẽ được (phòng chưa có trên mặt bằng, gửi và nhận cùng phòng) thì bỏ.
      if (!room || (handoff.fromRole !== null && (!fromRoom || fromRoom === room))) {
        unplaceable.push(handoff.id);
        continue;
      }
      const who = handoff.fromRole ?? RECEPTIONIST_ROLE;
      const stop = { handoff, place: { room, seat: seatOf(handoff.toRole)?.seat ?? null } };

      const open = rounds.current.get(latest.current.get(who) ?? '');
      if (open && Date.now() < open.start + STAND_S * 1000) {
        // Chưa bước đi: ôm thêm tập này vào vòng đang chuẩn bị.
        open.stops.push(stop);
        open.tour = planTour(who, open.from, open.stops, calm);
        busyUntil.current.set(who, open.start + open.tour.duration * 1000);
        continue;
      }
      const own = handoff.fromRole ? seatOf(handoff.fromRole) : null;
      const from = fromRoom ? { room: fromRoom, seat: own?.seat ?? null } : null;
      const start = Math.max(handoff.startedAt + GATHER_MS, busyUntil.current.get(who) ?? 0);
      const tour = planTour(who, from, [stop], calm);
      rounds.current.set(handoff.id, { id: handoff.id, who, from, stops: [stop], start, tour });
      latest.current.set(who, handoff.id);
      busyUntil.current.set(who, start + tour.duration * 1000);
    }
    return { list: [...rounds.current.values()], unplaceable };
    // `finished` đổi khi một vòng xong, để danh sách bỏ vòng đó ra.
  }, [handoffs, seatOf, departmentOfRole, calm, finished]);

  // Sự kiện không vẽ được thì xoá ngay, để hàng chờ không giữ rác.
  useEffect(() => {
    unplaceable.forEach((id) => onArrive(id));
  }, [unplaceable, onArrive]);

  return (
    <group>
      {list.map((round) => (
        <Walker
          // Thêm hồ sơ vào vòng chưa đi thì dựng lại người đi theo đường mới.
          key={`${round.id}:${round.stops.length}`}
          tour={round.tour}
          start={round.start}
          model={round.from ? undefined : RECEPTIONIST.model}
          scale={round.from ? (seatOf(round.who)?.seat.scale ?? 1) : 1}
          onDone={() => {
            rounds.current.delete(round.id);
            round.stops.forEach((stop) => onArrive(stop.handoff.id));
            setFinished((value) => value + 1);
          }}
          calm={calm}
        />
      ))}
    </group>
  );
}
