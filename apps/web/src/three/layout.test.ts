/**
 * P&N — Đường đi của người đưa việc phải bám hành lang.
 *
 * Nếu đường đi cắt xuyên qua phòng thì cảnh 3D sẽ có người đi xuyên tường, và
 * cái gọi là "chuyển giao trực quan" lập tức mất hết sức thuyết phục.
 */

import { describe, expect, it } from 'vitest';

import {
  DOOR_WIDTH,
  GAP,
  LANE_X,
  LANE_Z,
  ROOMS,
  SEAT_BACK,
  STAIR,
  deskSeats,
  deskToDoor,
  door,
  frontToRoom,
  personZ,
  roomOf,
  routeBetween,
  routeLength,
} from './layout';

const inside = (x: number, z: number): boolean =>
  ROOMS.some(
    (spec) =>
      Math.abs(x - spec.x) < spec.width / 2 - 0.05 && Math.abs(z - spec.z) < spec.depth / 2 - 0.05,
  );

/** Lấy mẫu dày trên đường đi để không bỏ sót đoạn cắt qua góc phòng. */
function samples(path: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let index = 1; index < path.length; index += 1) {
    const [ax, az] = path[index - 1]!;
    const [bx, bz] = path[index]!;
    const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.25));
    for (let step = 0; step <= steps; step += 1) {
      points.push([ax + ((bx - ax) * step) / steps, az + ((bz - az) * step) / steps]);
    }
  }
  return points;
}

describe('Mặt bằng', () => {
  it('hành lang đủ rộng cho một người đi qua', () => {
    expect(GAP).toBeGreaterThan(1.6);
  });

  it('mọi phòng bắt buộc ở §7 đều có mặt', () => {
    for (const department of [
      'COMMAND_CENTER',
      'PRODUCT',
      'BUSINESS_ANALYSIS',
      'UIUX_STUDIO',
      'FRONTEND',
      'BACKEND',
      'MOBILE',
      'QA_LAB',
      'SECURITY_OPS',
      'DEVOPS',
      'MEETING_ROOM',
    ]) {
      expect(roomOf(department), department).not.toBeNull();
    }
  });

  it('không có hai phòng nào chồng lên nhau', () => {
    for (const a of ROOMS) {
      for (const b of ROOMS) {
        if (a === b) continue;
        const overlapX = Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 0.01;
        const overlapZ = Math.abs(a.z - b.z) < (a.depth + b.depth) / 2 - 0.01;
        expect(overlapX && overlapZ, `${a.department} × ${b.department}`).toBe(false);
      }
    }
  });
});

describe('Ô cửa trên vách trước', () => {
  /**
   * Bất biến quan trọng nhất của file này: `Room.tsx` chừa một ô cửa rộng
   * `DOOR_WIDTH` ở GIỮA vách trước, và `door()` phải đặt điểm đi bộ vào trong ô
   * đó. Lệch nhau là người đưa việc đi xuyên kính — đúng thứ cả mặt bằng này
   * sinh ra để tránh.
   */
  it('điểm cửa nằm trong ô cửa, không nằm trên kính', () => {
    for (const spec of ROOMS) {
      const [x] = door(spec);
      expect(Math.abs(x - spec.x), spec.department).toBeLessThanOrEqual(DOOR_WIDTH / 2);
    }
  });

  it('mọi phòng đều đủ rộng để chừa ô cửa mà vẫn còn vách hai bên', () => {
    for (const spec of ROOMS) {
      expect(spec.width, spec.department).toBeGreaterThan(DOOR_WIDTH + 1);
    }
  });

  it('ô cửa đủ rộng cho người đi qua', () => {
    // Nhân vật rộng khoảng 0.6; cửa hẹp hơn thế thì nhìn như chui qua khe.
    expect(DOOR_WIDTH).toBeGreaterThan(1.2);
  });
});

describe('Đường đi giữa hai phòng', () => {
  it('mọi cặp phòng đều đi được và chỉ đi trong hành lang', () => {
    for (const from of ROOMS) {
      for (const to of ROOMS) {
        if (from === to) continue;
        const path = routeBetween(from, to);
        expect(routeLength(path)).toBeGreaterThan(0);

        for (const [x, z] of samples(path)) {
          // Chỉ được ở trong phòng tại hai đầu: đoạn ra cửa và đoạn vào cửa.
          if (!inside(x, z)) continue;
          const atEnds =
            (Math.abs(x - from.x) < 0.5 && Math.abs(z - from.z) < from.depth / 2 + 0.5) ||
            (Math.abs(x - to.x) < 0.5 && Math.abs(z - to.z) < to.depth / 2 + 0.5);
          expect(atEnds, `${from.department} → ${to.department} đi xuyên tường tại ${x},${z}`).toBe(
            true,
          );
        }
      }
    }
  });

  it('điểm đầu ở phòng gửi và điểm cuối ở phòng nhận', () => {
    const from = roomOf('QA_LAB')!;
    const to = roomOf('FRONTEND')!;
    const path = routeBetween(from, to);

    expect(path[0]![0]).toBeCloseTo(from.x, 5);
    expect(path.at(-1)![0]).toBeCloseTo(to.x, 5);
    // Các điểm giữa đều nằm trên một trục hành lang.
    for (const [x, z] of path.slice(1, -1)) {
      const onLane =
        LANE_X.some((lane) => Math.abs(lane - x) < 0.01) ||
        LANE_Z.some((lane) => Math.abs(lane - z) < 0.01);
      expect(onLane, `${x},${z} không nằm trên hành lang nào`).toBe(true);
    }
  });
});

/**
 * Người đứng dậy đi giao việc đi từ ghế ra cửa theo lối cạnh bàn. Lối
 * đi mà cắt qua mặt bàn thì người đi xuyên bàn — kiểm mọi phòng, mọi số người.
 */
describe('đường từ bàn ra cửa', () => {
  // Mặt bàn trong fixtures.ts: 2.65 × 1.25, nhân theo cỡ của chỗ ngồi.
  const DESK_W = 2.65;
  const DESK_D = 1.25;

  it('không cắt qua bàn nào và không ra khỏi phòng trước khi tới cửa', () => {
    // Gom lỗi rồi kiểm một lần: gọi expect cho từng điểm lấy mẫu làm test chậm quá giờ.
    const problems: string[] = [];
    for (const spec of ROOMS) {
      // Phòng điều hành xếp bàn sát hai tường, mỗi hàng 2 bàn: chỉ chứa được 4
      // (5 người trở lên thì hàng thứ ba ra ngoài tường — giới hạn có từ trước,
      // hiện phòng này có 2 người).
      const most = spec.feature === 'command' ? 4 : 10;
      for (let count = 1; count <= most; count += 1) {
        const seats = deskSeats(spec, count);
        for (const seat of seats) {
          const path = deskToDoor(spec, seat);
          const end = path.at(-1)!;
          if (end[0] !== door(spec)[0] || end[2] !== door(spec)[1]) problems.push(`${spec.department}: không kết thúc ở cửa`);
          for (const [x, z] of samples(path.map(([px, , pz]) => [px, pz] as const))) {
            const lx = x - spec.x;
            const lz = z - spec.z;
            if (Math.abs(lx) > spec.width / 2 || Math.abs(lz) > spec.depth / 2) {
              problems.push(`${spec.department} ${count} người: ra ngoài phòng tại (${lx.toFixed(2)}, ${lz.toFixed(2)})`);
            }
            const hit = seats.some(
              (desk) => Math.abs(lx - desk.x) < (DESK_W / 2) * desk.scale && Math.abs(lz - desk.z) < (DESK_D / 2) * desk.scale,
            );
            if (hit) problems.push(`${spec.department} ${count} người: đi xuyên bàn tại (${lx.toFixed(2)}, ${lz.toFixed(2)})`);
          }
        }
      }
    }
    expect([...new Set(problems)].slice(0, 5)).toEqual([]);
  });

  it('chỗ ngồi nằm sau bàn, người đứng dậy bước sang lối đi chứ không đứng trên bàn', () => {
    for (const spec of ROOMS) {
      for (const seat of deskSeats(spec, 6)) {
        expect(personZ(seat)).toBeLessThan(seat.z - (DESK_D / 2) * seat.scale + 0.01);
        expect(Math.abs(seat.aisle - seat.x)).toBeGreaterThan((DESK_W / 2) * seat.scale);
      }
    }
  });

  /**
   * Ghế lùi xa bàn hơn (SEAT_BACK 0.98) để người 3D không lấn mép bàn.
   * Ở phòng xếp dày thì lưng ghế hàng sau dễ đâm vào bàn hàng trước.
   */
  it('lưng ghế hàng sau không đâm vào bàn hàng trước, không xuyên tường sau', () => {
    // Lưng ghế trong fixtures.ts: tâm lùi 0.34 sau ghế, dày 0.17.
    const CHAIR_BACK = 0.34 + 0.17 / 2;
    for (const spec of ROOMS) {
      const most = spec.feature === 'command' ? 4 : 10;
      for (let count = 1; count <= most; count += 1) {
        const seats = deskSeats(spec, count);
        for (const seat of seats) {
          const back = seat.z - (SEAT_BACK + CHAIR_BACK) * seat.scale;
          expect(back, `${spec.department} ${count} người: ghế xuyên tường sau`).toBeGreaterThan(-spec.depth / 2 + 0.2);
          for (const desk of seats) {
            if (desk === seat || desk.z >= seat.z || Math.abs(desk.x - seat.x) > (DESK_W / 2) * desk.scale) continue;
            expect(back, `${spec.department} ${count} người: ghế đâm bàn trước`).toBeGreaterThan(desk.z + (DESK_D / 2) * desk.scale);
          }
        }
      }
    }
  });

  it('Khang lên cầu thang rồi theo hành lang trước tới đúng cửa phòng', () => {
    for (const spec of ROOMS) {
      const path = frontToRoom(STAIR.topX - 0.6, spec);
      expect(path.at(-1)).toEqual(door(spec));
      for (const [x, z] of samples(path.slice(0, -1))) expect(inside(x, z)).toBe(false);
    }
  });
});
