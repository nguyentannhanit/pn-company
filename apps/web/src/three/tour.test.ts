/**
 * P&N — Vòng đưa việc: gom nhiều hồ sơ thành một vòng, đúng thứ tự đã định.
 */

import { describe, expect, it } from 'vitest';

import type { Handoff } from '@/lib/store';

import { deskSeats, deskToDoor, door, roomOf, type RoomSpec } from './layout';
import { CALM_S, HAND_S, STAND_S, planTour, tourAt, type Place } from './tour';

/** Chỗ ngồi đầu tiên của một phòng, như văn phòng 3D xếp. */
function place(department: string, index = 0, count = 2): Place {
  const room = roomOf(department)!;
  return { room, seat: deskSeats(room, count)[index] ?? null };
}

function handoff(toRole: string, extra: Partial<Handoff> = {}): Handoff {
  return { id: toRole, fromRole: 'CTO_ORCHESTRATOR', toRole, kind: 'task', label: toRole, startedAt: 0, priority: 1, step: null, ...extra };
}

const near = (a: readonly number[], b: readonly number[]): boolean => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!) < 0.05;
const passesDoor = (path: readonly (readonly number[])[], room: RoomSpec): boolean =>
  path.some((point) => near(point, [door(room)[0], 0, door(room)[1]]));

const cto = place('COMMAND_CENTER');

describe('vòng đưa việc', () => {
  it('việc gấp đưa trước, rồi theo bước quy trình, việc ngoài quy trình sau cùng', () => {
    const tour = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('QA', { step: 5 }), place: place('QA_LAB') },
      { handoff: handoff('FREE', { step: null }), place: place('DEVOPS') },
      { handoff: handoff('BE', { step: 4 }), place: place('BACKEND') },
      { handoff: handoff('URGENT', { step: 6, priority: 3 }), place: place('SECURITY_OPS') },
    ]);
    expect(tour.stops.map((stop) => stop.handoff.toRole)).toEqual(['URGENT', 'BE', 'QA', 'FREE']);
  });

  it('cùng độ gấp, cùng bước thì phòng gần trước — không đi lòng vòng', () => {
    const tour = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('FAR'), place: place('WEB_DEVELOPMENT') },
      { handoff: handoff('NEAR'), place: place('PRODUCT') },
    ]);
    expect(tour.stops.map((stop) => stop.handoff.toRole)).toEqual(['NEAR', 'FAR']);
  });

  it('đi một mạch qua các phòng, không quay về bàn giữa chừng, xong mới về chỗ', () => {
    const tour = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('BE'), place: place('BACKEND') },
      { handoff: handoff('FE'), place: place('FRONTEND') },
    ]);
    const desk = deskToDoor(cto.room, cto.seat!)[0]!;
    const [first, second] = tour.stops;
    expect(near(tour.path[0]!, desk)).toBe(true);
    expect(near(tour.path.at(-1)!, desk)).toBe(true);
    // Giữa hai điểm giao không đi qua cửa phòng điều hành — không ghé về.
    const middle = tour.path.filter((_, index) => {
      const upTo = tour.path.slice(0, index + 1);
      const at = upTo.reduce((sum, point, i) => (i === 0 ? 0 : sum + Math.hypot(point[0] - upTo[i - 1]![0], point[1] - upTo[i - 1]![1], point[2] - upTo[i - 1]![2])), 0);
      return at > first!.at + 0.01 && at < second!.at - 0.01;
    });
    expect(middle.length).toBeGreaterThan(0);
    expect(passesDoor(middle, cto.room)).toBe(false);
  });

  it('hai người nhận cùng phòng thì đưa liền một lượt, không ra cửa rồi vào lại', () => {
    const qa = roomOf('QA_LAB')!;
    const tour = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('A'), place: place('QA_LAB', 0, 4) },
      { handoff: handoff('B'), place: place('QA_LAB', 1, 4) },
    ]);
    const [first, second] = tour.stops;
    const start = tour.path.findIndex((point) => near(point, first!.spot));
    const end = tour.path.findIndex((point) => near(point, second!.spot));
    expect(passesDoor(tour.path.slice(start, end + 1), qa)).toBe(false);
  });

  it('dòng thời gian: đứng dậy → đi → trao từng người → về; giảm chuyển động thì đứng lần lượt từng bàn', () => {
    const tour = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('BE'), place: place('BACKEND') },
      { handoff: handoff('FE'), place: place('FRONTEND') },
    ]);
    expect(tourAt(tour, 0.1).phase).toBe('standing');
    const firstHand = STAND_S + tour.stops[0]!.at / 4.6 + 0.1;
    expect(tourAt(tour, firstHand)).toMatchObject({ phase: 'handing', stop: 0 });
    expect(tourAt(tour, firstHand + HAND_S)).toMatchObject({ phase: 'going', stop: 1 });
    expect(tourAt(tour, tour.duration - 0.1).phase).toBe('returning');
    expect(tourAt(tour, tour.duration + 0.1).phase).toBe('done');

    const calm = planTour('CTO_ORCHESTRATOR', cto, [
      { handoff: handoff('BE'), place: place('BACKEND') },
      { handoff: handoff('FE'), place: place('FRONTEND') },
    ], true);
    expect(calm.duration).toBe(2 * CALM_S);
    expect(tourAt(calm, CALM_S + 0.1, true)).toMatchObject({ phase: 'handing', stop: 1 });
  });

  it('Khang mang việc CEO giao: từ quầy lễ tân lên cầu thang, giao xong xuống lại quầy', () => {
    const tour = planTour('RECEPTIONIST', null, [{ handoff: handoff('PM', { fromRole: null }), place: place('PRODUCT') }]);
    expect(tour.path[0]![1]).toBeLessThan(0);
    expect(tour.path.at(-1)).toEqual(tour.path[0]);
  });
});
