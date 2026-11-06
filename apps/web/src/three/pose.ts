/**
 * P&N — Tư thế nhân viên 3D: đặt góc từng khớp theo trạng thái việc (§8.1, §9).
 *
 * Tách khỏi `Employee.tsx` (React) vì hai lẽ: phần dò tư thế chạy một lần trên
 * bản sao riêng của mô hình, và `pose.test.ts` đo va chạm tay với bàn, màn hình,
 * tay vịn bằng chính mã này — chạy được ngoài trình duyệt.
 *
 * Ba điều đo được quyết định cách làm ở đây (tay từng xuyên màn hình):
 *  1. Tay đưa ra trước phải xoay sấp cẳng tay, không thì ngón út chúi xuyên phím.
 *  2. Ba mẫu người vai cao thấp khác nhau (khuỷu lệch 0.23 cùng góc), nên không
 *     ghi cứng góc: ghi CHỖ ĐẶT TAY rồi dò góc cho từng mẫu (`fitFor`).
 *  3. Ghế phải lùi SEAT_BACK (`layout.ts`) thì tay mới có chỗ trên bàn phím.
 */

import { Euler, Group, MathUtils, Quaternion, Vector3, type Bone, type Object3D, type SkinnedMesh } from 'three';

import { BONE, prepareHuman } from './human-model';
import { SEAT_BACK } from './layout';
import { FITS } from './pose-fits';

/**
 * Chiều cao trong cảnh. Chọn 3.2 sau khi đo: ngồi xuống đỉnh đầu ở ~2.40, nhô
 * trên mép màn hình (2.30) nên luôn thấy mặt; đứng lên chỉ hơi cao hơn tường
 * phòng (2.95) chứ không thành người khổng lồ.
 */
export const HEIGHT = 3.2;
/** Mặt ghế trong `fixtures.ts` (mặt ngồi 0.77 + nửa bề dày 0.09). */
export const SEAT_Y = 0.86;
/** Ngồi: đùi nằm ngang ra trước, cẳng chân gần thẳng xuống (góc từ phương thẳng đứng, dương là ra trước). */
const SIT_THIGH = 1.5;
const SIT_KNEE = 1.35;

/** Tư thế ngồi có tay đặt theo chỗ; `null` là giơ tay ăn mừng hoặc đang đứng. */
export type Mode = 'type' | 'review' | 'blocked' | 'meeting' | 'sleep' | 'idle';
const MODES: readonly Mode[] = ['type', 'review', 'blocked', 'meeting', 'sleep', 'idle'];

/**
 * Chỗ đặt tay của từng tư thế, [trái, phải]. Đo theo bàn làm việc (z 0 = giữa
 * bàn, bàn phím z 0.19–0.37, mặt phím cao 1.35, chuột z 0.28, mép bàn 0.625)
 * hoặc theo miệng (`face`). y, z là chỗ đốt gốc ngón trỏ; `drop` là đầu ngón
 * thấp hơn đốt ngón bao nhiêu; `palmDown` là xoay cẳng tay cho lòng bàn tay úp.
 */
interface Goal {
  y?: number;
  z?: number;
  face?: { dy: number; dz: number };
  drop?: number;
  palmDown?: boolean;
  /** Chỗ cẳng tay vắt qua mép bàn phải nằm trên mặt bàn (mẫu vai thấp gục ngủ thì cẳng tay dốc cắt mép). */
  elbowOnDesk?: boolean;
}
const onDesk = (y: number, z: number, drop: number): Goal => ({ y, z, drop, palmDown: true });
export const ARM_GOALS: Record<Mode, readonly [Goal, Goal]> = {
  // Gõ phím: hai tay trên bàn phím.
  type: [onDesk(1.52, 0.36, 0.08), onDesk(1.52, 0.36, 0.08)],
  // Rà soát: tay trái chống cằm, tay phải cầm chuột.
  review: [{ face: { dy: -0.16, dz: -0.06 } }, onDesk(1.5, 0.28, 0.06)],
  // Bị chặn: tay trái ôm trán, tay phải đặt hờ trên mặt bàn.
  blocked: [{ face: { dy: 0.2, dz: -0.1 } }, onDesk(1.48, 0.5, 0.04)],
  // Họp: tay trái giơ trước ngực như đang giải thích, tay phải đặt trên bàn.
  meeting: [{ y: 1.72, z: 0.36 }, onDesk(1.48, 0.5, 0.04)],
  // Gục ngủ: hai cẳng tay nằm trên bàn làm gối, đầu tựa lên.
  sleep: [
    { ...onDesk(1.47, 0.34, 0.02), elbowOnDesk: true },
    { ...onDesk(1.47, 0.34, 0.02), elbowOnDesk: true },
  ],
  // Rảnh: hai tay đặt hờ trên mặt bàn. Buông thõng thì xuyên tay vịn ghế; gác tay
  // vịn hay đặt lên đùi thì bàn tay to của mẫu người thò ra chạm mép bàn, gầm bàn.
  idle: [onDesk(1.48, 0.48, 0.04), onDesk(1.48, 0.48, 0.04)],
};

/** Góc cố định (vai = cánh tay đưa ra trước bao nhiêu, khuỷu = gập thêm), radian. */
const POSE = {
  pronate: 1.57,
  cheer: { s: 2.6, e: 0.45 },
  /** Vươn vai: hai tay duỗi thẳng qua đầu. */
  stretch: { s: 2.85, e: 0.12 },
} as const;

/**
 * Người rảnh sống theo nhịp 9 giây, lệch theo tên vai trò để cả phòng không cùng
 * nhịp. Hai nhịp xen kẽ: ngủ gật (0–1.8 ngáp + vươn vai, 2.5–8.2 đầu gục dần,
 * 8.2–9 giật mình ngẩng lên) và xoay ghế (xoay qua lại, ngó quanh, ngâm nga).
 * Rảnh quá `longMin` phút thì gục hẳn xuống bàn ngủ — nhìn là biết phòng nào bỏ
 * không lâu. Đây vẫn là trạng thái thật (§9): chỉ người đang rảnh mới làm vậy.
 */
export const IDLE = { period: 9, yawn: 1.8, longMin: 30 } as const;
export function idleCycle(t: number, role: string): { doze: boolean; c: number } {
  const x = t + role.length * 1.7;
  return { doze: Math.floor(x / IDLE.period) % 2 === 0, c: x % IDLE.period };
}
/** Đầu lúc ngủ gật: ngửa ra khi ngáp, gục dần, rồi bật lên. */
function dozeHead(c: number): number {
  if (c < IDLE.yawn) return -0.24 * Math.sin((c / IDLE.yawn) * Math.PI);
  if (c < 2.5) return 0;
  if (c < 8.2) return 0.4 * ((c - 2.5) / 5.7) ** 2;
  return 0;
}
/** Sếp rê chuột vào người đang rảnh: 0–0.3 giật mình ngửa đầu, 0.3–1.5 cúi đầu xin lỗi. */
/**
 * `hold`: bật dậy đáp sếp bao lâu sau khi rời chuột. `guilt`: bị sếp đánh thức thì ngồi tỉnh thêm 3 phút
 * mới dám gật lại — trước đây buông chuột là ngủ tức thì, trông sai so với đời thật.
 */
export const WAKE = { hold: 3, sorry: 2.4, guilt: 180 } as const;
function wakeHead(w: number): number {
  if (w < 0.3) return -0.2;
  if (w < 1.5) return 0.34 * Math.sin(((w - 0.3) / 1.2) * Math.PI);
  return 0;
}

/** Gục ngủ trên bàn: đáy đầu tựa lên cẳng tay (~1.52); trán không chúi quá z 0.05 (màn hình ở −0.27). */
const SLEEP = { headY: 1.52, minFore: 0.05 };

interface Reach {
  s: number;
  e: number;
  f: number;
}
/** Kết quả dò cho một mẫu người: góc tay từng tư thế và độ gục khi ngủ. */
export interface Fit {
  reach: Record<Mode, [Reach, Reach]>;
  slump: { a: number; n: number };
}

export interface PoseInput {
  state: string;
  seated: boolean;
  calm: boolean;
  /** Giây, từ đồng hồ của cảnh 3D. */
  clock: number;
  delta: number;
  /** Mili giây thật (Date.now), để so với `completedAt`. */
  now: number;
  completedAt: number;
  /** Đã rảnh bao nhiêu phút (từ lúc đổi trạng thái thật). */
  idleMinutes: number;
  /** Lúc sếp rê chuột vào (giây của cảnh) và thức tới lúc nào. */
  wake: { at: number; until: number } | null;
  /** Chỉ dùng lúc dò: ép một tư thế bất kể trạng thái. */
  force?: Mode;
}

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);

interface Limb {
  upper: Object3D | undefined;
  lower: Object3D | undefined;
}
interface Leg extends Limb {
  end: Object3D | undefined;
  foot: Object3D | undefined;
}

/** Các khớp cần điều khiển, tìm theo tên một lần. */
function readParts(body: Object3D) {
  const bone = (name: string): Object3D | undefined => body.getObjectByName(name);
  const leg = (side: 'L' | 'R'): Leg => ({
    upper: bone(BONE.upperLeg(side)),
    lower: bone(BONE.lowerLeg(side)),
    end: bone(BONE.lowerLegEnd(side)),
    foot: bone(BONE.foot(side)),
  });
  return {
    hips: bone(BONE.hips),
    torso: bone(BONE.torso),
    head: bone(BONE.head),
    neck: bone('Neck'),
    spine: [bone('Abdomen'), bone('Chest')],
    arms: (['L', 'R'] as const).map((side): Limb => ({ upper: bone(BONE.upperArm(side)), lower: bone(BONE.lowerArm(side)) })),
    wrists: [bone('WristL'), bone('WristR')],
    legs: [leg('L'), leg('R')],
    mouth: body.getObjectByName('mouth'),
    knuckles: [bone('Index1L'), bone('Index1R')],
    tips: [bone('Index4L'), bone('Index4R')],
  };
}

const resting = () => ({ twistL: 0, twistR: 0, flexL: 0, flexR: 0, shoulderL: 0.1, shoulderR: 0.1, elbowL: 0.15, elbowR: 0.15, headX: 0, headY: 0, torsoX: 0, slumpA: 0, slumpN: 0, swivel: 0 });
const defaultFit = (): Fit => ({
  reach: Object.fromEntries(MODES.map((mode) => [mode, [{ s: 0.1, e: 0.15, f: 0 }, { s: 0.1, e: 0.15, f: 0 }]])) as Fit['reach'],
  slump: { a: 0.15, n: 0.6 },
});

/**
 * Khung xương một người và cách đặt góc từng khớp. `root` là nhóm chứa mô hình
 * (đã quay nửa vòng, nhìn về −Z); `update` đặt góc, hạ người xuống mặt ghế và
 * xoay `root` khi xoay ghế.
 */
export class Rig {
  private readonly rest = new Map<Object3D, Quaternion>();
  private readonly aim = new Map<Object3D, { direction: Vector3; frame: Quaternion }>();
  private readonly parts: ReturnType<typeof readParts>;
  private readonly phase: number;
  private readonly cur = resting();
  private readonly world = new Vector3();
  private readonly tmp = { euler: new Euler(), quat: new Quaternion(), target: new Vector3() };
  fit: Fit;

  constructor(
    readonly root: Object3D,
    body: Object3D,
    readonly role: string,
    fit?: Fit,
  ) {
    this.fit = fit ?? defaultFit();
    let sum = 0;
    for (let i = 0; i < role.length; i++) sum += role.charCodeAt(i);
    // Nhịp lệch nhau để cả phòng không gõ phím cùng một nhịp.
    this.phase = (sum % 100) / 12;
    const bone = (name: string): Object3D | undefined => body.getObjectByName(name);
    // Tư thế gốc của từng khớp; mọi cử động là xoay thêm từ đây.
    body.traverse((node) => {
      if ((node as Bone).isBone) this.rest.set(node, node.quaternion.clone());
    });
    // Hướng xương và góc quay của xương tay, chân trong khung cơ thể, đo ở tư thế gốc.
    body.updateMatrixWorld(true);
    const bodyInverse = body.getWorldQuaternion(new Quaternion()).invert();
    for (const side of ['L', 'R'] as const) {
      for (const node of [bone(BONE.upperLeg(side)), bone(BONE.lowerLeg(side)), bone(BONE.upperArm(side)), bone(BONE.lowerArm(side))]) {
        if (!node) continue;
        const frame = bodyInverse.clone().multiply(node.getWorldQuaternion(new Quaternion()));
        // Xương chạy dọc trục Y riêng của nó.
        this.aim.set(node, { direction: new Vector3(0, 1, 0).applyQuaternion(frame), frame });
      }
    }
    this.parts = readParts(body);
  }

  /** Về tư thế nghỉ, không mang góc từ lần dò trước sang. */
  reset(): void {
    Object.assign(this.cur, resting());
  }

  /** Đầu người trong toạ độ thế giới — để neo bong bóng. */
  headPosition(out: Vector3): Vector3 {
    return this.parts.head ? this.parts.head.getWorldPosition(out) : this.root.getWorldPosition(out);
  }

  update(input: PoseInput): void {
    const { state, seated, calm, clock, delta, force } = input;
    const { parts, cur, tmp, rest, aim } = this;
    const reach = this.fit.reach;
    const t = calm ? this.phase : clock + this.phase;
    // Nguyên văn luật tư thế của nhân vật cũ (§8.1): ai rà soát, ai gõ phím, ai bị chặn.
    const reviewing = force ? force === 'review' : state === 'reviewing' || (state === 'working' && /QA|SECURITY|REVIEW|RED_TEAM/.test(this.role));
    const working = force ? force === 'type' : state === 'working' && !reviewing;
    const blocked = force ? force === 'blocked' : state === 'blocked' || state === 'alert';
    const meeting = force ? force === 'meeting' : state === 'meeting';
    const celebrating =
      !force &&
      (state === 'celebrate' || state === 'completed' || (state === 'idle' && input.completedAt > 0 && input.now - input.completedAt < 1800));
    // Mang hồ sơ sang phòng khác: chân bước như đi bộ, tay giữ tập giấy trước ngực.
    const carrying = !force && state === 'carrying';
    const walking = !force && (state === 'walking' || carrying);
    const offline = !force && state === 'offline';
    // Sếp rê chuột vào (hoặc chạm trên điện thoại): tỉnh hẳn, thôi ngủ gật/xoay ghế.
    const woke = !force && seated && state === 'idle' && !!input.wake && input.wake.until > clock;
    const w = input.wake ? clock - input.wake.at : 99;
    const sleeping = force ? force === 'sleep' : seated && state === 'idle' && !woke && !celebrating && input.idleMinutes >= IDLE.longMin;
    const mode: Mode | null = !seated
      ? null
      : working
        ? 'type'
        : reviewing
          ? 'review'
          : blocked
            ? 'blocked'
            : meeting
              ? 'meeting'
              : celebrating
                ? null
                : sleeping
                  ? 'sleep'
                  : 'idle';
    const blend = calm ? 1 : 1 - Math.exp(-delta * 10);
    // Rảnh mà chưa lâu: sống theo nhịp ngủ gật / xoay ghế. Tắt hiệu ứng động thì ngồi yên.
    const lively = mode === 'idle' && !force && !calm && !woke && !offline;
    const cyc = idleCycle(clock, this.role);
    const dozing = lively && cyc.doze;
    const swivelling = lively && !cyc.doze;
    // Vươn vai cùng lúc ngáp: 0 → 1 → 0 trong 1.8 giây đầu nhịp ngủ gật.
    const stretchW = dozing && cyc.c < IDLE.yawn ? Math.sin((cyc.c / IDLE.yawn) * Math.PI) : 0;

    let shoulderL = 0.1;
    let shoulderR = 0.1;
    let elbowL = 0.15;
    let elbowR = 0.15;
    if (mode) {
      const [l, r] = reach[mode];
      shoulderL = l.s;
      shoulderR = r.s;
      elbowL = l.e;
      elbowR = r.e;
      // Gõ phím: hai vai nhấp so le rất nhẹ. Họp: tay trái đưa lên đưa xuống như đang giải thích.
      if (working) {
        shoulderL += Math.sin(t * 11) * 0.03;
        shoulderR += Math.sin(t * 11 + Math.PI) * 0.03;
      }
      if (meeting && !force) shoulderL += Math.sin(t * 2.2) * 0.12;
      if (stretchW) {
        shoulderL = MathUtils.lerp(shoulderL, POSE.stretch.s, stretchW);
        shoulderR = MathUtils.lerp(shoulderR, POSE.stretch.s, stretchW);
        elbowL = MathUtils.lerp(elbowL, POSE.stretch.e, stretchW);
        elbowR = MathUtils.lerp(elbowR, POSE.stretch.e, stretchW);
      }
    }
    if (celebrating) {
      shoulderL = shoulderR = POSE.cheer.s;
      elbowL = elbowR = POSE.cheer.e;
    }
    if (walking) {
      shoulderL = 0.5 + Math.sin(t * 6.5) * 0.35;
      shoulderR = 0.5 - Math.sin(t * 6.5) * 0.35;
      elbowL = elbowR = 0.45;
    }
    if (carrying) {
      shoulderL = shoulderR = 0.55;
      elbowL = elbowR = 0.95;
    }
    // Trao hồ sơ: đứng, hai tay chìa ra trước.
    if (!force && state === 'handing') {
      shoulderL = shoulderR = 1.15;
      elbowL = elbowR = 0.35;
    }

    // Đầu và thân: gật/lắc quanh trục riêng của xương (trục này ở đầu và thân thì thẳng).
    const tilt = (bone: Object3D | undefined, tiltX: number, tiltY = 0): void => {
      const base = bone && rest.get(bone);
      if (!bone || !base) return;
      tmp.euler.set(tiltX, tiltY, 0);
      bone.quaternion.copy(base).multiply(tmp.quat.setFromEuler(tmp.euler));
    };
    // Đặt đoạn trên rồi đoạn dưới của tay/chân tới hướng đích trong khung cơ thể
    // (góc từ phương thẳng đứng xuống, dương là ra trước), giữ độ dạng sang ngang
    // như tư thế gốc. Không xoay quanh trục riêng của xương: trục đó nghiêng khác
    // nhau theo từng mẫu.
    const toward = (from: Vector3, angle: number, side = from.x): Quaternion =>
      new Quaternion().setFromUnitVectors(from, tmp.target.set(side, -Math.cos(angle), Math.sin(angle)).normalize());
    // `foldIn`: cẳng tay gập càng cao càng vào giữa người — tay chống cằm, ôm đầu chạm tới mặt.
    const poseLimb = (upperBone: Object3D | undefined, lowerBone: Object3D | undefined, upperAngle: number, lowerAngle: number, foldIn = false): void => {
      const upper = upperBone && aim.get(upperBone);
      const lower = lowerBone && aim.get(lowerBone);
      const upperRest = upperBone && rest.get(upperBone);
      const lowerRest = lowerBone && rest.get(lowerBone);
      if (!upperBone || !lowerBone || !upper || !lower || !upperRest || !lowerRest) return;
      const upperTurn = toward(upper.direction, upperAngle);
      const lowerTurn = toward(lower.direction, lowerAngle, foldIn ? lower.direction.x * Math.cos(lowerAngle) * 3 : lower.direction.x);
      // Xoay trong khung cơ thể quy về khung riêng: rest · F⁻¹ · D · F; đoạn dưới trừ phần xoay của đoạn trên.
      upperBone.quaternion.copy(upperRest).multiply(upper.frame.clone().invert().multiply(upperTurn).multiply(upper.frame));
      lowerBone.quaternion.copy(lowerRest).multiply(lower.frame.clone().invert().multiply(upperTurn.invert()).multiply(lowerTurn).multiply(lower.frame));
    };
    const lerp = MathUtils.lerp;
    cur.shoulderL = lerp(cur.shoulderL, shoulderL, blend);
    cur.shoulderR = lerp(cur.shoulderR, shoulderR, blend);
    cur.elbowL = lerp(cur.elbowL, elbowL, blend);
    cur.elbowR = lerp(cur.elbowR, elbowR, blend);
    poseLimb(parts.arms[0]?.upper, parts.arms[0]?.lower, cur.shoulderL, cur.shoulderL + cur.elbowL, true);
    poseLimb(parts.arms[1]?.upper, parts.arms[1]?.lower, cur.shoulderR, cur.shoulderR + cur.elbowR, true);

    // Xoay sấp cẳng tay cho lòng bàn tay úp xuống (phím, chuột, mặt bàn). Tư thế gốc tay buông, lòng bàn tay
    // úp vào đùi; giơ ra trước mà không xoay thì ngón cái lên trên, ngón út chúi xuống xuyên bàn phím.
    // Tay đưa lên mặt (chống cằm, ôm trán) và tay giơ lên khi họp thì giữ nguyên.
    const goals = mode ? ARM_GOALS[mode] : null;
    const down = (i: 0 | 1): number => (goals?.[i].palmDown ? POSE.pronate * (1 - stretchW) : 0);
    cur.twistL = lerp(cur.twistL, down(0), blend);
    cur.twistR = lerp(cur.twistR, -down(1), blend);
    const twist = (bone: Object3D | undefined, angle: number): void => {
      if (bone && angle) bone.quaternion.multiply(tmp.quat.setFromAxisAngle(AXIS_Y, angle));
    };
    twist(parts.arms[0]?.lower, cur.twistL);
    twist(parts.arms[1]?.lower, cur.twistR);
    // Gập cổ tay theo mức đã dò cho mẫu này.
    cur.flexL = lerp(cur.flexL, mode ? reach[mode][0].f * (1 - stretchW) : 0, blend);
    cur.flexR = lerp(cur.flexR, mode ? reach[mode][1].f * (1 - stretchW) : 0, blend);
    [cur.flexL, cur.flexR].forEach((flex, i) => {
      const wrist = parts.wrists[i];
      const base = wrist && rest.get(wrist);
      if (wrist && base) wrist.quaternion.copy(base).multiply(tmp.quat.setFromAxisAngle(AXIS_X, flex));
    });

    // Đầu: cúi khi gõ, gục khi bị chặn hoặc ngoại tuyến, ngủ gật theo nhịp chung với bong bóng; lúc giật
    // mình ngẩng lên hoặc tỉnh dậy thì đầu bật nhanh hơn lúc gục.
    const headBlend = (woke && w < 1.6) || (dozing && cyc.c >= 8.2) ? 1 - Math.exp(-delta * 18) : blend;
    const headX = offline ? 0.55 : blocked ? 0.3 : working ? 0.11 : reviewing ? 0.06 : woke ? (calm ? 0 : wakeHead(w)) : dozing ? dozeHead(cyc.c) : 0;
    cur.headX = lerp(cur.headX, headX, headBlend);
    // Đang chống cằm thì đầu chỉ lắc rất nhẹ, không thì cằm trượt khỏi tay.
    const headY = reviewing
      ? Math.sin(t * 0.7) * 0.05
      : working
        ? Math.sin(t * 1.5) * 0.025
        : blocked || sleeping || woke
          ? 0
          : dozing
            ? Math.sin(t * 0.3) * 0.04
            : swivelling
              ? Math.sin(t * 0.9) * 0.2
              : Math.sin(t * 0.4) * 0.12;
    cur.headY = lerp(cur.headY, headY, blend);
    // Xin lỗi sếp chỉ cúi đầu, không gập thân: thân cúi kéo hai tay đang đặt trên bàn ấn xuyên mặt bàn
    // (pose.test.ts bắt được — số đo chưa đúng lúc cúi).
    cur.torsoX = lerp(cur.torsoX, working ? 0.08 : blocked ? 0.12 : reviewing ? 0.1 : 0, blend);
    tilt(parts.head, cur.headX, cur.headY);
    tilt(parts.torso, cur.torsoX);

    // Gục ngủ: cúi dần cả sống lưng rồi cổ. Thiếp đi thì chậm, giật mình tỉnh thì nhanh.
    const slow = calm ? 1 : 1 - Math.exp(-delta * (woke ? 14 : 2.5));
    cur.slumpA = lerp(cur.slumpA, sleeping ? this.fit.slump.a : 0, slow);
    cur.slumpN = lerp(cur.slumpN, sleeping ? this.fit.slump.n : 0, slow);
    const bend = (bone: Object3D | undefined, angle: number, keep = false): void => {
      const base = bone && rest.get(bone);
      if (!bone || !base) return;
      if (!keep) bone.quaternion.copy(base);
      bone.quaternion.multiply(tmp.quat.setFromEuler(tmp.euler.set(angle, 0, 0)));
    };
    bend(parts.spine[0], cur.slumpA);
    bend(parts.spine[1], cur.slumpA);
    bend(parts.neck, cur.slumpN);
    bend(parts.torso, cur.slumpA, true);
    bend(parts.head, cur.slumpN, true);

    // Xoay ghế qua lại ±0.16 rad (~9°), êm vào êm ra theo nhịp; ghế đọc góc `root` để xoay theo.
    const swivel = swivelling ? 0.16 * Math.sin((2 * Math.PI * cyc.c) / 4.5) * Math.sin((Math.PI * cyc.c) / IDLE.period) : 0;
    cur.swivel = lerp(cur.swivel, swivel, blend);
    this.root.rotation.y = seated ? cur.swivel : 0;

    // Chân: ngồi thì giữ tư thế ngồi, đứng thì đu theo nhịp bước có gập gối.
    const step = walking ? Math.sin(t * 6.5) : 0;
    const poseLeg = (leg: Leg | undefined, thigh: number, knee: number): void => {
      if (leg) poseLimb(leg.upper, leg.lower, thigh, thigh - knee);
    };
    if (seated) {
      poseLeg(parts.legs[0], SIT_THIGH, SIT_KNEE);
      poseLeg(parts.legs[1], SIT_THIGH, SIT_KNEE);
    } else {
      // Hai chân so le; chân đang ở phía sau thì co gối — bước đi mới có nhịp.
      poseLeg(parts.legs[0], step * 0.55, Math.max(0, -step) * 0.6 + 0.05);
      poseLeg(parts.legs[1], -step * 0.55, Math.max(0, step) * 0.6 + 0.05);
    }

    const bob = woke && !calm && w < 0.35
      ? Math.sin((w / 0.35) * Math.PI) * 0.12
      : walking
        ? Math.abs(Math.sin(t * 6.5)) * 0.045
        : celebrating
          ? Math.abs(Math.sin(t * 4.5)) * 0.065
          : Math.sin(t * 1.6) * 0.009;
    const root = this.root;
    if (seated && parts.hips) {
      // Tính thẳng trong một khung hình: đặt gốc về 0, đo xương hông rồi hạ đúng xuống mặt ghế.
      root.position.y = 0;
      root.updateMatrixWorld(true);
      parts.hips.getWorldPosition(this.world);
      root.parent?.worldToLocal(this.world);
      root.position.y = SEAT_Y - this.world.y + bob;
    } else {
      root.position.y = bob;
    }
    // Ma trận phải đúng chỗ rồi mới đặt bàn chân: xương bàn chân nằm dưới `Root`
    // chứ không dưới cẳng chân, đặt sớm thì giày chạy sau một khung hình.
    root.updateMatrixWorld(true);
    for (const leg of parts.legs) {
      if (!leg.foot || !leg.end) continue;
      leg.end.getWorldPosition(this.world);
      leg.foot.parent?.worldToLocal(this.world);
      leg.foot.position.copy(this.world);
      const restFoot = rest.get(leg.foot);
      if (restFoot) leg.foot.quaternion.copy(restFoot);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Dò tư thế — chỉ chạy trên bản sao riêng, chưa gắn vào cảnh              */
  /* ---------------------------------------------------------------------- */

  /** Toạ độ một điểm trong khung chỗ ngồi (y tính cả độ hạ người xuống ghế). */
  private seatSpace(node: Object3D | undefined, out = new Vector3()): { y: number; z: number } {
    this.root.updateMatrixWorld(true);
    node?.getWorldPosition(out);
    this.root.worldToLocal(out);
    return { y: out.y + this.root.position.y, z: out.z };
  }

  private goalOf(goal: Goal): { y: number; z: number } {
    // Đích theo bàn đổi sang khung người (người ngồi lùi SEAT_BACK); đích theo mặt lấy miệng làm mốc.
    if (goal.face) {
      const mouth = this.seatSpace(this.parts.mouth);
      return { y: mouth.y + goal.face.dy, z: mouth.z + goal.face.dz };
    }
    return { y: goal.y ?? 1.5, z: (goal.z ?? 0.4) - SEAT_BACK };
  }

  private forced(mode: Mode): void {
    this.update({ state: '', seated: true, calm: true, clock: 0, delta: 0, now: 0, completedAt: 0, idleMinutes: 0, wake: null, force: mode });
  }

  /**
   * Dò góc vai/khuỷu đưa đốt ngón tới đích (thô trước, mịn sau), rồi dò độ gập
   * cổ tay để đầu ngón thấp hơn đốt ngón một chút như đặt lên phím, lên bàn.
   */
  private aimArm(mode: Mode, i: 0 | 1): void {
    const goal = ARM_GOALS[mode][i];
    const reach = this.fit.reach[mode];
    const elbow = this.parts.arms[i]?.lower;
    const wrist = this.parts.wrists[i];
    const cost = (s: number, L: number): number => {
      reach[i] = { s, e: L - s, f: 0 };
      this.forced(mode);
      const knuckle = this.seatSpace(this.parts.knuckles[i]);
      const target = this.goalOf(goal);
      let err = (knuckle.y - target.y) ** 2 + (knuckle.z - target.z) ** 2;
      if (goal.elbowOnDesk) {
        // Chỗ cẳng tay (khuỷu → cổ tay) vắt qua mép bàn z 0.625 phải cao hơn mặt bàn cộng bề dày cẳng tay.
        const e = this.seatSpace(elbow);
        const wr = this.seatSpace(wrist);
        const ez = e.z + SEAT_BACK;
        const wz = wr.z + SEAT_BACK;
        const EDGE = 0.625;
        const y = ez <= EDGE ? e.y : wz >= EDGE ? null : e.y + ((wr.y - e.y) * (ez - EDGE)) / (ez - wz);
        if (y !== null) err += 4 * Math.max(0, 1.4 - y) ** 2;
      }
      return err;
    };
    let best = { err: Infinity, s: 0.1, L: 0.25 };
    for (let s = -0.9; s <= 1.2; s += 0.1) {
      for (let L = 0.3; L <= 3.0; L += 0.1) {
        const err = cost(s, L);
        if (err < best.err) best = { err, s, L };
      }
    }
    const coarse = { ...best };
    for (let s = coarse.s - 0.1; s <= coarse.s + 0.1; s += 0.02) {
      for (let L = coarse.L - 0.1; L <= coarse.L + 0.1; L += 0.02) {
        const err = cost(s, L);
        if (err < best.err) best = { err, s, L };
      }
    }
    reach[i] = { s: best.s, e: best.L - best.s, f: 0 };
    if (goal.drop === undefined) return;
    const tip = this.parts.tips[i];
    let bestFlex = { err: Infinity, f: 0 };
    for (let f = -1.2; f <= 0.4; f += 0.05) {
      reach[i].f = f;
      this.forced(mode);
      const err = Math.abs(this.seatSpace(tip).y - (this.goalOf(goal).y - goal.drop));
      if (err < bestFlex.err) bestFlex = { err, f };
    }
    reach[i].f = bestFlex.f;
  }

  /**
   * Dò độ gục khi ngủ: đáy đầu tựa đúng tầm cẳng tay trên bàn, trán không chúi
   * tới màn hình, ngực không lấn mép bàn. Mẫu này gập ở cổ nhiều, mẫu kia gập ở
   * lưng nhiều nên cũng phải dò theo mẫu. Dùng toạ độ thế giới:
   * `root` chưa gắn vào cảnh nên thế giới chính là khung chỗ ngồi.
   */
  private aimSlump(body: Object3D): void {
    const groups: Array<{ mesh: SkinnedMesh; head: number[]; trunk: number[] }> = [];
    body.traverse((node) => {
      const mesh = node as SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const index = mesh.geometry.getAttribute('skinIndex');
      const weight = mesh.geometry.getAttribute('skinWeight');
      const head: number[] = [];
      const trunk: number[] = [];
      for (let v = 0; v < index.count; v += 2) {
        let strongest = 0;
        let most = -1;
        for (let k = 0; k < 4; k++) {
          const value = weight.getComponent(v, k);
          if (value > most) {
            most = value;
            strongest = index.getComponent(v, k);
          }
        }
        const name = mesh.skeleton.bones[strongest]?.name ?? '';
        if (name === 'Head') head.push(v);
        else if (/Chest|Torso|Abdomen/.test(name)) trunk.push(v);
      }
      groups.push({ mesh, head, trunk });
    });
    const point = new Vector3();
    let best = { err: Infinity, a: 0.15, n: 0.6 };
    for (let a = 0.05; a <= 0.31; a += 0.05) {
      for (let n = 0.2; n <= 1.01; n += 0.1) {
        this.fit.slump = { a, n };
        this.forced('sleep');
        this.root.updateMatrixWorld(true);
        let low = Infinity;
        let fore = Infinity;
        let hits = 0;
        for (const { mesh, head, trunk } of groups) {
          const position = mesh.geometry.getAttribute('position');
          for (const v of head) {
            point.fromBufferAttribute(position, v);
            mesh.applyBoneTransform(v, point).applyMatrix4(mesh.matrixWorld);
            low = Math.min(low, point.y);
            fore = Math.min(fore, point.z + SEAT_BACK);
          }
          for (const v of trunk) {
            point.fromBufferAttribute(position, v);
            mesh.applyBoneTransform(v, point).applyMatrix4(mesh.matrixWorld);
            if (point.y < 1.29 && point.y > 1.15 && point.z + SEAT_BACK < 0.625) hits++;
          }
        }
        const err = Math.abs(low - SLEEP.headY) + Math.max(0, SLEEP.minFore - fore) * 3 + hits * 0.01;
        if (err < best.err) best = { err, a, n };
      }
    }
    this.fit.slump = { a: best.a, n: best.n };
  }

  /** Dò đủ mọi tư thế cho khung xương này (gọi trên bản sao riêng, chưa gắn vào cảnh). */
  fitAll(body: Object3D): Fit {
    this.aimSlump(body);
    for (const mode of MODES) {
      this.aimArm(mode, 0);
      this.aimArm(mode, 1);
    }
    this.reset();
    return structuredClone(this.fit);
  }
}

/** Một bản dò cho mỗi mô hình: cùng mô hình thì cùng khung xương. */
const fits = new Map<Object3D, Fit>();

/**
 * Dò mọi tư thế trên một bản sao riêng của mô hình, chưa gắn vào cảnh — để
 * phòng, ghế, cỡ chỗ ngồi không lẫn vào số đo. Mất ~0.7 giây mỗi mẫu.
 */
export function measureFit(scene: Object3D): Fit {
  const { model, scale } = prepareHuman(scene, HEIGHT);
  const root = new Group();
  const inner = new Group();
  inner.scale.setScalar(scale);
  inner.rotation.y = Math.PI;
  inner.add(model);
  root.add(inner);
  return new Rig(root, model, 'FIT').fitAll(model);
}

/**
 * Góc tay và độ gục cho mô hình này: lấy bảng dò sẵn (`pose-fits.ts`) nếu có,
 * mô hình lạ thì dò một lần rồi giữ lại.
 */
export function fitFor(scene: Object3D, url?: string): Fit {
  const table = url ? FITS[url] : undefined;
  if (table) return table;
  let fit = fits.get(scene);
  if (!fit) {
    fit = measureFit(scene);
    fits.set(scene, fit);
  }
  return fit;
}
