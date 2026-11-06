/**
 * P&N — Tay nhân viên 3D không được xuyên màn hình, bàn, tay vịn ghế.
 *
 * Từng có ảnh chụp màn hình cho thấy tay "gõ phím" xuyên màn hình ở mọi phòng. Test này đo
 * từng điểm trên da của ba mẫu người thật trong `public/models`, ở mọi tư thế
 * ngồi, trong đúng khung chỗ ngồi như `Room.tsx` dựng (bàn ở gốc, người lùi
 * SEAT_BACK, cả cụm quay nửa vòng).
 */

import { readFileSync } from 'node:fs';

import { Group, Vector3, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';

import { prepareHuman } from './human-model';
import { SEAT_BACK } from './layout';
import { HEIGHT, IDLE, Rig, fitFor, measureFit, type PoseInput } from './pose';
import { FITS } from './pose-fits';

const MODELS = ['nv-nam-thuong.glb', 'nv-nu-thuong.glb', 'nv-nam-hoodie.glb'];

async function load(file: string): Promise<Object3D> {
  const bytes = readFileSync(new URL(`../../public/models/${file}`, import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', (gltf) => resolve(gltf.scene), reject));
}

/** Dựng một người ngồi đúng như `Room.tsx`: chỗ ngồi quay nửa vòng, người lùi SEAT_BACK. */
function seat(scene: Object3D, url: string, role: string): { rig: Rig; seatGroup: Group; body: Object3D } {
  const { model, scale } = prepareHuman(scene, HEIGHT);
  const seatGroup = new Group();
  seatGroup.rotation.y = Math.PI;
  const root = new Group();
  root.position.z = SEAT_BACK;
  const inner = new Group();
  inner.scale.setScalar(scale);
  inner.rotation.y = Math.PI;
  inner.add(model);
  root.add(inner);
  seatGroup.add(root);
  seatGroup.updateMatrixWorld(true);
  // Dùng đúng bảng dò sẵn mà app dùng, để test đo chính thứ người xem thấy.
  return { rig: new Rig(root, model, role, fitFor(scene, url)), seatGroup, body: model };
}

interface Hits {
  screen: number;
  desk: number;
  armrest: number;
  lowestHand: number;
}

/** Đếm điểm da tay nằm trong màn hình, mặt bàn/bàn phím, tay vịn ghế (toạ độ bàn). */
function measure(body: Object3D, seatGroup: Group): Hits {
  seatGroup.updateMatrixWorld(true);
  const toSeat = seatGroup.matrixWorld.clone().invert();
  const hits: Hits = { screen: 0, desk: 0, armrest: 0, lowestHand: Infinity };
  const point = new Vector3();
  const E = 0.02; // chạm dưới 2 cm không nhìn thấy được
  body.traverse((node) => {
    const mesh = node as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.getAttribute('skinIndex');
    const weight = mesh.geometry.getAttribute('skinWeight');
    for (let v = 0; v < position.count; v++) {
      let strongest = 0;
      let most = -1;
      for (let k = 0; k < 4; k++) {
        if (weight.getComponent(v, k) > most) {
          most = weight.getComponent(v, k);
          strongest = index.getComponent(v, k);
        }
      }
      const name = mesh.skeleton.bones[strongest]?.name ?? '';
      if (!/Arm|Wrist|Thumb|Index|Middle|Ring|Pinky/.test(name)) continue;
      point.fromBufferAttribute(position, v);
      mesh.applyBoneTransform(v, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(toSeat);
      const { x, y, z } = point;
      // Màn hình: mặt kính z −0.266, cao 1.6–2.37, rộng 1.25.
      if (z < -0.22 && y > 1.55 && y < 2.4 && Math.abs(x) < 0.7) hits.screen++;
      // Mặt bàn 1.15–1.29 (tới mép 0.625), khung gầm 1.08–1.16, bàn phím tới 1.335.
      const inDesk =
        Math.abs(x) < 1.3 &&
        ((y > 1.15 + E && y < 1.29 && z < 0.625 - E) ||
          (y > 1.08 + E && y < 1.16 - E && z < 0.54 - E) ||
          (Math.abs(x) < 0.47 && y > 1.29 && y < 1.335 && z > 0.15 && z < 0.45));
      if (inDesk) hits.desk++;
      // Tay vịn ghế: x ±0.48, mặt trên 1.33.
      if (Math.abs(Math.abs(x) - 0.48) < 0.05 && y > 1.27 && y < 1.33 && z > SEAT_BACK - 0.22 && z < SEAT_BACK + 0.3) hits.armrest++;
      if (/Wrist|Thumb|Index|Middle|Ring|Pinky/.test(name)) hits.lowestHand = Math.min(hits.lowestHand, y);
    }
  });
  return hits;
}

/** Chạy tư thế đủ lâu cho các khớp tới đích. */
function settle(rig: Rig, input: Partial<PoseInput> & { state: string }, clock = 1): void {
  for (let k = 0; k < 30; k++) {
    rig.update({ seated: true, calm: false, delta: 0.3, now: 0, completedAt: 0, idleMinutes: 0, wake: null, ...input, clock: clock - 0.48 + k * 0.016 });
  }
}

describe('tay nhân viên 3D', async () => {
  const scenes = await Promise.all(MODELS.map(load));

  const cases: Array<{ name: string; role: string; input: Partial<PoseInput> & { state: string }; clock?: (role: string) => number; onDesk: boolean }> = [
    { name: 'gõ phím', role: 'FRONTEND_DEVELOPER', input: { state: 'working' }, onDesk: true },
    { name: 'rà soát (chống cằm, cầm chuột)', role: 'QA', input: { state: 'working' }, onDesk: true },
    { name: 'bị chặn', role: 'BACKEND_DEVELOPER', input: { state: 'blocked' }, onDesk: true },
    { name: 'họp', role: 'MOBILE_DEVELOPER', input: { state: 'meeting' }, onDesk: true },
    { name: 'rảnh', role: 'DEVOPS', input: { state: 'idle' }, onDesk: true },
    { name: 'gục ngủ khi rảnh lâu', role: 'RESEARCH', input: { state: 'idle', idleMinutes: IDLE.longMin + 5 }, onDesk: true },
    // Đúng lúc tay vươn cao nhất (giữa lúc ngáp) và lúc ghế xoay xa nhất.
    { name: 'vươn vai', role: 'SEO', input: { state: 'idle' }, clock: (role) => 180 + 0.9 - role.length * 1.7, onDesk: false },
    { name: 'xoay ghế', role: 'SEO', input: { state: 'idle' }, clock: (role) => 189 + 3.4 - role.length * 1.7, onDesk: true },
    { name: 'tỉnh dậy xin lỗi sếp', role: 'RESEARCH', input: { state: 'idle', idleMinutes: 90, wake: { at: 0.4, until: 9 } }, onDesk: true },
    { name: 'ăn mừng', role: 'DEVOPS', input: { state: 'celebrate' }, onDesk: false },
  ];

  it('bảng dò sẵn còn khớp với mô hình (đổi mô hình thì dò lại và dán bảng mới vào pose-fits.ts)', () => {
    for (const [m, file] of MODELS.entries()) {
      const fresh = measureFit(scenes[m]!);
      const table = FITS[`/models/${file}`];
      const round = (fit: typeof fresh): unknown => JSON.parse(JSON.stringify(fit, (_key, value: unknown) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value)));
      expect(table, `bảng mới cho ${file}: ${JSON.stringify(round(fresh))}`).toEqual(round(fresh));
    }
  }, 120_000);

  for (const [m, file] of MODELS.entries()) {
    for (const c of cases) {
      it(`${file}: ${c.name}`, () => {
        const { rig, seatGroup, body } = seat(scenes[m]!, `/models/${file}`, c.role);
        settle(rig, c.input, c.clock?.(c.role) ?? 1);
        const hits = measure(body, seatGroup);
        expect(hits.screen, 'ngón tay xuyên màn hình').toBe(0);
        // Chạm tới 1–2 cm ở vài điểm (đầu ngón chạm mép phím) không nhìn thấy; xuyên thật là hàng trăm điểm.
        expect(hits.desk, 'tay xuyên mặt bàn / bàn phím').toBeLessThanOrEqual(12);
        if (c.onDesk) expect(hits.lowestHand, 'bàn tay thấp hơn mặt phím').toBeGreaterThan(1.32);
        // Khuỷu tì lên tay vịn thì chạm; xuyên hẳn tay vịn là vài chục điểm trở lên.
        if (c.name !== 'xoay ghế') expect(hits.armrest, 'tay xuyên tay vịn ghế').toBeLessThanOrEqual(20);
      }, 120_000);
    }
  }
});
