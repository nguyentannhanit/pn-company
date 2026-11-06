/**
 * P&N — Vòng đưa việc: một người cầm nhiều hồ sơ, đi một vòng qua các phòng nhận.
 *
 * Trước đây mỗi hồ sơ là một chuyến riêng: đứng dậy → sang phòng A → về bàn →
 * đứng dậy → sang phòng B… CEO: "mất thời gian nếu như logic thật ngoài đời".
 * Nay hồ sơ của cùng một người được gom thành một vòng: bàn mình → A → B → … → về
 * bàn. Thứ tự: việc gấp trước, cùng độ gấp thì theo bước quy trình,
 * cùng bước thì phòng gần nhất trước để đường đi ngắn.
 *
 * Tách khỏi `Courier.tsx` (phần vẽ) để tính đường và thời gian kiểm thử được mà
 * không cần dựng cảnh 3D.
 */

import type { Handoff } from '@/lib/store';

import {
  LOBBY_Z,
  STAIR,
  YARD_Y,
  deskToDoor,
  frontToRoom,
  routeBetween,
  routeLength,
  type Point,
  type Point3,
  type RoomSpec,
  type Seat,
} from './layout';

/** Tốc độ đi bộ, đơn vị cảnh trên giây. Ở tỷ lệ này ≈ 2 m/s — đi nhanh, không chạy. */
export const SPEED = 4.6;
/** Đứng dậy khỏi ghế trước khi bước đi. */
export const STAND_S = 0.6;
/** Đứng cạnh bàn người nhận, chìa hồ sơ ra; nửa đầu còn cầm, nửa sau đã trao. */
export const HAND_S = 1.4;
/** Chế độ giảm chuyển động: chỉ đứng ở bàn từng người nhận một lúc. */
export const CALM_S = 4.2;

/** Một điểm giao trên vòng: hồ sơ nào, trao ở đâu trên đường, quay mặt hướng nào. */
export interface TourStop {
  handoff: Handoff;
  /** Quãng đường (từ đầu vòng) tới chỗ đứng trao. */
  at: number;
  spot: Point3;
  faceYaw: number;
}

export interface Tour {
  /** Người rời chỗ (vai trò, hoặc vai trò lễ tân cho Khang). */
  who: string;
  path: Point3[];
  stops: TourStop[];
  length: number;
  /** Tổng thời gian cả vòng, giây. */
  duration: number;
}

/** Chỗ ngồi của người nhận / người gửi, như `Office.tsx` tính. */
export interface Place {
  room: RoomSpec;
  seat: Seat | null;
}

/** Góc quay quanh trục đứng, quy ước nhân vật nhìn −Z. */
export const yawOf = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

export function pathLength(path: readonly Point3[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const [ax, ay, az] = path[i - 1]!;
    const [bx, by, bz] = path[i]!;
    total += Math.hypot(bx - ax, by - ay, bz - az);
  }
  return total;
}

/** Nối các đoạn đường, bỏ điểm trùng (điểm cuối đoạn này là điểm đầu đoạn sau). */
export function join(...parts: Point3[][]): Point3[] {
  const all = parts.flat();
  return all.filter((point, index) => {
    const prev = all[index - 1];
    return !prev || Math.hypot(point[0] - prev[0], point[1] - prev[1], point[2] - prev[2]) > 0.05;
  });
}

const onFloor = (points: readonly Point[]): Point3[] => points.map(([x, z]): Point3 => [x, 0, z]);

/** Trong phòng nhận: cửa → lối đi cạnh bàn người nhận. Chưa có bàn thì đứng ngay sau cửa. */
function inside({ room, seat }: Place): Point3[] {
  return seat ? deskToDoor(room, seat).reverse().slice(0, -1) : onFloor([[room.x, room.z + room.depth / 2 - 0.4]]);
}

/** Chiếu nghỉ đầu cầu thang ngoài, nơi Khang lên tới sàn văn phòng. */
const LANDING = STAIR.topX - 0.6;
/** Khang từ quầy lễ tân dưới sân, dọc sân tới chân cầu thang, leo lên chiếu nghỉ. */
const LOBBY_TO_LANDING: Point3[] = [
  [0, YARD_Y, LOBBY_Z],
  [STAIR.bottomX + 0.8, YARD_Y, LOBBY_Z],
  [STAIR.bottomX + 0.8, YARD_Y, STAIR.z],
  [STAIR.bottomX, YARD_Y, STAIR.z],
  [STAIR.topX, 0, STAIR.z],
  [LANDING, 0, STAIR.z],
];

/** Đoạn đi giữa hai điểm giao liền nhau. Cùng phòng thì đi dọc hàng trước, không ra cửa rồi vào lại. */
function between(a: Place, b: Place): Point3[] {
  const out = inside(a).reverse();
  if (a.room === b.room && a.seat && b.seat) return join(out.slice(0, 2), inside(b).slice(2));
  return join(out, onFloor(routeBetween(a.room, b.room)), inside(b));
}

/**
 * Xếp thứ tự giao: việc gấp trước; cùng độ gấp thì bước quy trình sớm trước (việc
 * ngoài quy trình xếp sau); cùng bước thì phòng gần chỗ đang đứng nhất trước.
 * `from` là phòng người gửi, `null` cho Khang đi từ sảnh lên.
 */
export function orderStops<T extends { handoff: Handoff; place: Place }>(stops: T[], from: RoomSpec | null): T[] {
  const bucket = (item: T): string => `${3 - item.handoff.priority}:${String(item.handoff.step ?? 999).padStart(3, '0')}`;
  const distance = (at: RoomSpec | null, to: RoomSpec): number =>
    at === to ? 0 : routeLength(at ? routeBetween(at, to) : frontToRoom(LANDING, to));

  const left = [...stops];
  const ordered: T[] = [];
  let here = from;
  while (left.length > 0) {
    const first = left.map(bucket).sort()[0]!;
    const candidates = left.filter((item) => bucket(item) === first);
    const next = candidates.reduce((best, item) =>
      distance(here, item.place.room) < distance(here, best.place.room) ? item : best,
    );
    ordered.push(next);
    left.splice(left.indexOf(next), 1);
    here = next.place.room;
  }
  return ordered;
}

/**
 * Dựng cả vòng: rời chỗ → lần lượt từng điểm giao → về chỗ. `from` là chỗ người
 * gửi, `null` là Khang ở quầy lễ tân. Điểm giao phải khác phòng người gửi (người
 * cùng phòng thì không cần đi đâu cả — bên gọi đã lọc).
 */
export function planTour(who: string, from: Place | null, stops: Array<{ handoff: Handoff; place: Place }>, calm = false): Tour {
  const ordered = orderStops(stops, from?.room ?? null);
  const first = ordered[0]!;

  let path: Point3[] = from
    ? join(from.seat ? deskToDoor(from.room, from.seat) : [], onFloor(routeBetween(from.room, first.place.room)), inside(first.place))
    : join(LOBBY_TO_LANDING, onFloor(frontToRoom(LANDING, first.place.room)), inside(first.place));

  const planned: TourStop[] = [];
  ordered.forEach((item, index) => {
    if (index > 0) path = join(path, between(ordered[index - 1]!.place, item.place));
    const spot = path.at(-1)!;
    const { room, seat } = item.place;
    planned.push({
      handoff: item.handoff,
      at: pathLength(path),
      spot,
      faceYaw: seat ? yawOf(room.x + seat.x - spot[0], 0) : yawOf(0, -1),
    });
  });

  const last = ordered.at(-1)!.place;
  path = from
    ? join(path, inside(last).reverse(), onFloor(routeBetween(last.room, from.room)), from.seat ? deskToDoor(from.room, from.seat).reverse() : [])
    : join(path, inside(last).reverse(), onFloor(frontToRoom(LANDING, last.room)).reverse(), [...LOBBY_TO_LANDING].reverse());

  const length = pathLength(path);
  const duration = calm ? CALM_S * planned.length : STAND_S + length / SPEED + HAND_S * planned.length;
  return { who, path, stops: planned, length, duration };
}

export type TourPhase = 'waiting' | 'standing' | 'going' | 'handing' | 'returning' | 'done';

/** Người đang ở đâu trên vòng lúc `t` giây kể từ khi đứng dậy. */
export interface TourMoment {
  phase: TourPhase;
  /** Quãng đường đã đi. */
  distance: number;
  /** Điểm giao đang tới / đang trao (khi về thì là số điểm giao). */
  stop: number;
  /** Đã đứng trao bao lâu ở điểm hiện tại, giây. */
  handing: number;
}

/** Tính theo đồng hồ thật nên khung hình chậm cũng không làm lệch đường. */
export function tourAt(tour: Tour, t: number, calm = false): TourMoment {
  if (t < 0) return { phase: 'waiting', distance: 0, stop: 0, handing: 0 };
  if (calm) {
    const stop = Math.floor(t / CALM_S);
    if (stop >= tour.stops.length) return { phase: 'done', distance: tour.length, stop: tour.stops.length, handing: 0 };
    return { phase: 'handing', distance: tour.stops[stop]!.at, stop, handing: t - stop * CALM_S };
  }
  if (t < STAND_S) return { phase: 'standing', distance: 0, stop: 0, handing: 0 };

  let clock = STAND_S;
  let from = 0;
  for (const [index, stop] of tour.stops.entries()) {
    const walk = (stop.at - from) / SPEED;
    if (t < clock + walk) return { phase: 'going', distance: from + (t - clock) * SPEED, stop: index, handing: 0 };
    clock += walk;
    if (t < clock + HAND_S) return { phase: 'handing', distance: stop.at, stop: index, handing: t - clock };
    clock += HAND_S;
    from = stop.at;
  }
  const back = (tour.length - from) / SPEED;
  if (t < clock + back) return { phase: 'returning', distance: from + (t - clock) * SPEED, stop: tour.stops.length, handing: 0 };
  return { phase: 'done', distance: tour.length, stop: tour.stops.length, handing: 0 };
}
