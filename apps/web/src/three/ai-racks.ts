/**
 * P&N — Sơ đồ 3D "tủ máy" trên trang Cài đặt → Kết nối AI.
 *
 * Nhìn đẳng cự, nền sáng dễ đọc: trụ sở P&N bên trái, năm ô đỗ xếp dọc bên phải, mỗi ô một tủ máy của một
 * nguồn AI theo đúng thứ tự dùng (ô trên cùng nhận việc trước). Đường mạch in đi từ trụ sở → trục chung →
 * nhánh vào từng ô; đường tới hãng chính tô màu hãng. Chuyển động duy nhất khi đứng yên là một xung sáng
 * chậm trên đường đang dùng (tắt khi máy bật "giảm chuyển động" hoặc sơ đồ ra khỏi màn hình) — bản
 * trước "nhiều thứ chuyển động".
 *
 * Phần chữ (tên hãng, trạng thái) là HTML do React vẽ; module này chỉ đặt vị trí các phần tử có
 * `data-rack="<id>"` (và `data-rack="core"`) cạnh đúng tủ mỗi khung hình, để chữ luôn sắc nét, cỡ lớn.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from 'three';

export interface RackItem {
  id: string;
  color: string;
  /** Chữ in trên nóc tủ (C, G, A…). */
  mark: string;
  kind: 'plan' | 'api';
  /** Hãng chưa dùng được (chưa có key, đang tắt) vẽ thành tủ xám viền đứt. */
  usable: boolean;
}

export interface RackScene {
  /** Danh sách theo thứ tự dùng; phần tử thứ i đứng ở ô i. Hãng chính = hãng dùng được đầu tiên. */
  setItems(items: RackItem[]): void;
  setSelected(id: string | null): void;
  setHover(id: string | null): void;
  /** Gọi lại sau khi React đổi nội dung nhãn (độ rộng nhãn quyết định khung nhìn). */
  refit(): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Toạ độ đẳng cự                                                              */
/* -------------------------------------------------------------------------- */

/** (a, d) = (ngang, dọc) trên màn hình → toạ độ thế giới. Camera nhìn từ (1,1,1): x−z là ngang, x+z là dọc. */
const at = (a: number, d: number, y = 0): Vector3 => new Vector3((a + d) / 2, y, (d - a) / 2);
const SLOT_A = 8.2;
const BUS_A = 4.7;
const PAD = 1.5;
const slotD = (i: number): number => -6.4 + i * 4.8;
const CORE_D = slotD(2);
const CORE_PLINTH = 2.6;
const CORE_COLOR = '#5b48e6';

/** Bảng màu cảnh theo giao diện sáng/tối của bảng điều khiển. */
const PALETTE = {
  light: {
    minor: 'rgba(40,62,94,0.07)', major: 'rgba(40,62,94,0.14)', dot: 'rgba(70,54,184,0.30)', pad: 'rgba(40,62,94,0.20)',
    trace: '#b3bfd0', dead: '#d3dbe6', edge: '#1e3552', edgeOp: 0.42, shadow: 0.17, via: '#ffffff', viaRing: '#97a6ba',
    sideA: 0.93, sideB: 0.8, topMix: 0.2, topBase: '#ffffff', ghost: '#e3e8ef', ghostEdge: '#94a3b8', ghostLed: '#c3ccd8', glow: 0.14,
  },
  dark: {
    minor: 'rgba(200,220,255,0.06)', major: 'rgba(200,220,255,0.12)', dot: 'rgba(169,156,255,0.45)', pad: 'rgba(200,220,255,0.18)',
    trace: '#3a5474', dead: '#2a4260', edge: '#d8e4f0', edgeOp: 0.3, shadow: 0.4, via: '#0f2236', viaRing: '#5b7390',
    sideA: 0.72, sideB: 0.56, topMix: 0.42, topBase: '#132a45', ghost: '#2a4564', ghostEdge: '#6f87a5', ghostLed: '#3a5270', glow: 0.22,
  },
};
type Palette = (typeof PALETTE)['light'];

const isDark = (): boolean => document.documentElement.dataset['theme'] === 'dark';
const pal = (): Palette => (isDark() ? PALETTE.dark : PALETTE.light);

export function createRackScene(options: {
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  labels: HTMLElement;
  /** Lớp CSS gắn vào khung nhãn khi sân khấu hẹp (nhãn gọn một dòng). */
  compactClass: string;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}): RackScene {
  const { canvas, stage, labels } = options;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, -100, 100);
  camera.position.set(10, 10, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  const themed: Array<() => void> = [];
  const disposables: Array<{ dispose(): void }> = [];
  const keep = <T extends { dispose(): void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  /** Texture vẽ bằng canvas 2D; `paint` vẽ lại khi đổi giao diện. */
  function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, W: number, H: number) => void): { tex: CanvasTexture; paint: () => void } {
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    const tex = keep(new CanvasTexture(c));
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = maxAniso;
    const paint = (): void => {
      const g = c.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, c.width, c.height);
      draw(g, c.width, c.height);
      tex.needsUpdate = true;
    };
    paint();
    return { tex, paint };
  }
  const roundRect = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void => {
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  };

  /* ---------- Sàn lưới bản vẽ mờ dần ra rìa, có ô đỗ nét đứt ---------- */
  const FLOOR = { size: 34, px: 2048 };
  const floorCenter = at(3.6, 3.2);
  const floor = canvasTex(FLOOR.px, FLOOR.px, (g, P) => {
    const t = pal();
    const k = P / FLOOR.size;
    const toC = (v: Vector3): [number, number] => [(v.x - floorCenter.x + FLOOR.size / 2) * k, (v.z - floorCenter.z + FLOOR.size / 2) * k];
    const x0 = floorCenter.x - FLOOR.size / 2;
    const z0 = floorCenter.z - FLOOR.size / 2;
    for (let i = Math.ceil(x0); i <= x0 + FLOOR.size; i++) {
      g.strokeStyle = i % 4 === 0 ? t.major : t.minor;
      g.lineWidth = i % 4 === 0 ? 2 : 1.2;
      g.beginPath(); g.moveTo((i - x0) * k, 0); g.lineTo((i - x0) * k, P); g.stroke();
    }
    for (let i = Math.ceil(z0); i <= z0 + FLOOR.size; i++) {
      g.strokeStyle = i % 4 === 0 ? t.major : t.minor;
      g.lineWidth = i % 4 === 0 ? 2 : 1.2;
      g.beginPath(); g.moveTo(0, (i - z0) * k); g.lineTo(P, (i - z0) * k); g.stroke();
    }
    g.fillStyle = t.dot;
    for (let i = Math.ceil(x0 / 4) * 4; i <= x0 + FLOOR.size; i += 4) {
      for (let j = Math.ceil(z0 / 4) * 4; j <= z0 + FLOOR.size; j += 4) {
        g.beginPath(); g.arc((i - x0) * k, (j - z0) * k, 3.2, 0, Math.PI * 2); g.fill();
      }
    }
    for (let i = 0; i < 5; i++) {
      const [cx, cz] = toC(at(SLOT_A, slotD(i)));
      g.strokeStyle = t.pad; g.lineWidth = 2.5; g.setLineDash([10, 7]);
      g.strokeRect(cx - (PAD / 2 + 0.05) * k, cz - (PAD / 2 + 0.05) * k, (PAD + 0.1) * k, (PAD + 0.1) * k);
      g.setLineDash([]);
    }
    // Mờ dần theo elip trục ngang/dọc màn hình quanh vùng nội dung.
    const [ex, ez] = toC(at(3.9, 3.2));
    g.globalCompositeOperation = 'destination-in';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.translate(ex, ez); g.rotate(-Math.PI / 4); g.scale((12.5 / Math.SQRT2) * k, (15.5 / Math.SQRT2) * k);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, 'rgba(0,0,0,1)'); grad.addColorStop(0.62, 'rgba(0,0,0,1)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(-1, -1, 2, 2);
    g.globalCompositeOperation = 'source-over';
  });
  const floorMesh = new Mesh(keep(new PlaneGeometry(FLOOR.size, FLOOR.size)), keep(new MeshBasicMaterial({ map: floor.tex, transparent: true, depthWrite: false })));
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.copy(floorCenter);
  floorMesh.renderOrder = -2;
  scene.add(floorMesh);
  themed.push(floor.paint);

  /* ---------- Bóng mềm dưới khối ---------- */
  const shadowTex = canvasTex(128, 128, (g, W) => {
    const gr = g.createRadialGradient(W / 2, W / 2, 0, W / 2, W / 2, W / 2);
    gr.addColorStop(0, 'rgba(10,20,40,1)'); gr.addColorStop(0.55, 'rgba(10,20,40,0.45)'); gr.addColorStop(1, 'rgba(10,20,40,0)');
    g.fillStyle = gr; g.fillRect(0, 0, W, W);
  }).tex;
  const shadowMats: MeshBasicMaterial[] = [];
  function softShadow(size: number): Mesh {
    const m = keep(new MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: pal().shadow }));
    shadowMats.push(m);
    const s = new Mesh(keep(new PlaneGeometry(size, size)), m);
    s.rotation.x = -Math.PI / 2;
    s.position.set(0.3, 0.004, 0.05);
    s.renderOrder = -1;
    return s;
  }
  themed.push(() => shadowMats.forEach((m) => { m.opacity = pal().shadow; }));

  /** Mặt bên tủ: chia khoang, mỗi khoang một dãy khe tản nhiệt (xám nhân với màu mặt). */
  function sideTexture(w: number, h: number, units: number): CanvasTexture {
    return canvasTex(w * 180, h * 180, (g, W, H) => {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
      const uh = H / units;
      for (let u = 0; u < units; u++) {
        const y0 = u * uh;
        g.fillStyle = '#b9c1cc'; g.fillRect(0, y0, W, Math.max(2, uh * 0.05));
        g.fillStyle = '#dde2e9';
        const sw = W * 0.032, gap = W * 0.028;
        for (let x = W * 0.08; x < W * 0.56; x += sw + gap) roundRect(g, x, y0 + uh * 0.33, sw, uh * 0.42, sw / 2);
        g.fillStyle = '#ccd3dc'; roundRect(g, W * 0.62, y0 + uh * 0.36, W * 0.12, uh * 0.3, 3);
      }
    }).tex;
  }

  interface Rack { group: Group; h: number; w: number; paints: Array<() => void> }

  /** Một tủ máy: thân chia khoang + dải màu ở cạnh trước + đèn LED + chữ trên nóc. */
  function rack(spec: { w: number; units: number; uh: number; color: string; mark: string; ghost?: boolean; markSize?: number }): Rack {
    const { w, units, uh, color, mark } = spec;
    const ghost = spec.ghost ?? false;
    const h = units * uh;
    const group = new Group();
    const geo = keep(new BoxGeometry(w, h, w));
    const side = sideTexture(w, h, units);
    const top = canvasTex(w * 200, w * 200, (g, W) => {
      const t = pal();
      const base = new Color(ghost ? t.ghost : t.topBase).lerp(new Color(ghost ? t.ghost : color), ghost ? 0 : t.topMix);
      g.fillStyle = `#${base.getHexString()}`; g.fillRect(0, 0, W, W);
      g.strokeStyle = 'rgba(20,40,63,0.12)'; g.lineWidth = W * 0.02; g.strokeRect(W * 0.07, W * 0.07, W * 0.86, W * 0.86);
      if (!mark) return;
      g.save(); g.translate(W / 2, W / 2); g.rotate(-Math.PI / 4);
      g.globalAlpha = ghost ? 0.5 : 0.95;
      g.fillStyle = ghost ? '#8a99ad' : isDark() ? `#${new Color(color).lerp(new Color('#ffffff'), 0.25).getHexString()}` : color;
      g.font = `700 ${W * (spec.markSize ?? 0.55)}px "Be Vietnam Pro", "Segoe UI", sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(mark, 0, W * 0.03); g.restore();
    });
    const mats = [0, 1, 2, 3, 4, 5].map((i) => keep(new MeshBasicMaterial({ map: i === 2 ? top.tex : i === 3 ? null : side })));
    const body = new Mesh(geo, mats);
    body.position.y = h / 2;
    const edges = new LineSegments(
      keep(new EdgesGeometry(geo)),
      keep(ghost ? new LineDashedMaterial({ color: '#94a3b8', dashSize: 0.1, gapSize: 0.07, transparent: true }) : new LineBasicMaterial({ color: '#1e3552', transparent: true, opacity: 0.42 })),
    );
    edges.position.y = h / 2;
    if (ghost) edges.computeLineDistances();
    group.add(softShadow(w * 2.1), body, edges);
    // Dải màu dọc ở cạnh trước (góc +x +z) — dấu nhận diện của từng hãng.
    if (!ghost) {
      const strip = new Mesh(keep(new BoxGeometry(0.07, h * 0.84, 0.07)), keep(new MeshBasicMaterial({ color })));
      strip.position.set(w / 2, h / 2, w / 2);
      group.add(strip);
    }
    // Hai đèn LED mỗi khoang trên mặt trái: đèn trạng thái xanh + đèn màu hãng.
    const leds: Array<Mesh<BoxGeometry, MeshBasicMaterial>> = [];
    for (let u = 0; u < units; u++) {
      for (let j = 0; j < 2; j++) {
        const led = new Mesh(keep(new BoxGeometry(0.075, 0.075, 0.02)), keep(new MeshBasicMaterial({ color: '#22c55e' })));
        led.position.set(-w / 2 + w * (0.8 + j * 0.1), h - (u + 0.5) * uh, w / 2 + 0.011);
        led.userData['kind'] = j === 0 ? 'status' : 'brand';
        group.add(led);
        leds.push(led);
      }
    }
    const paint = (): void => {
      const t = pal();
      const base = new Color(t.topBase).lerp(new Color(color), t.topMix);
      const face = (k: number): Color => (ghost ? new Color(t.ghost) : base.clone()).multiplyScalar(k);
      // Thứ tự mặt BoxGeometry: +x, -x, +y, -y, +z, -z. Camera nhìn từ +x +y +z; +z là mặt trái, sáng hơn.
      mats[0]!.color.copy(face(t.sideB)); mats[1]!.color.copy(face(t.sideB));
      mats[4]!.color.copy(face(t.sideA)); mats[5]!.color.copy(face(t.sideA));
      mats[2]!.color.set('#ffffff'); mats[3]!.color.copy(face(t.sideB));
      const em = edges.material as LineBasicMaterial;
      em.color.set(ghost ? t.ghostEdge : t.edge);
      em.opacity = ghost ? 0.9 : t.edgeOp;
      leds.forEach((l) => l.material.color.set(ghost ? t.ghostLed : l.userData['kind'] === 'status' ? '#22c55e' : color));
      top.paint();
    };
    paint();
    return { group, h, w, paints: [paint] };
  }

  /* ---------- Trụ sở P&N ---------- */
  const core = new Group();
  const plinthMats = [0, 1, 2, 3, 4, 5].map(() => keep(new MeshBasicMaterial({ color: '#ffffff' })));
  const plinth = new Mesh(keep(new BoxGeometry(CORE_PLINTH, 0.2, CORE_PLINTH)), plinthMats);
  plinth.position.y = 0.1;
  const plinthEdges = new LineSegments(keep(new EdgesGeometry(plinth.geometry)), keep(new LineBasicMaterial({ color: '#1e3552', transparent: true, opacity: 0.3 })));
  plinthEdges.position.y = 0.1;
  const tower = rack({ w: 1.9, units: 4, uh: 0.32, color: CORE_COLOR, mark: 'P&N', markSize: 0.3 });
  tower.group.position.y = 0.2;
  const roof = rack({ w: 1.05, units: 1, uh: 0.34, color: CORE_COLOR, mark: '' });
  roof.group.position.y = 0.2 + tower.h;
  const mast = new Mesh(keep(new CylinderGeometry(0.035, 0.035, 0.8, 8)), keep(new MeshBasicMaterial({ color: CORE_COLOR })));
  mast.position.set(0.2, 0.2 + tower.h + 0.34 + 0.4, -0.2);
  const mastTip = new Mesh(keep(new SphereGeometry(0.09, 16, 12)), keep(new MeshBasicMaterial({ color: '#8b7dff' })));
  mastTip.position.set(0.2, 0.2 + tower.h + 0.34 + 0.82, -0.2);
  core.add(softShadow(CORE_PLINTH * 1.9), plinth, plinthEdges, tower.group, roof.group, mast, mastTip);
  core.position.copy(at(0, CORE_D));
  scene.add(core);
  themed.push(...tower.paints, ...roof.paints, () => {
    const t = pal();
    const base = new Color(t.topBase).lerp(new Color(CORE_COLOR), t.topMix * 0.6);
    plinthMats.forEach((m, i) => m.color.copy(i === 2 ? base : base.clone().multiplyScalar(i === 4 || i === 5 ? t.sideA : t.sideB)));
    (plinthEdges.material as LineBasicMaterial).color.set(t.edge);
  });

  /* ---------- Tủ máy từng nguồn AI (dựng lại khi hãng đổi trạng thái dùng được) ---------- */
  interface ProviderRack extends Rack { item: RackItem; pick: Mesh; pos: Vector3; target: Vector3; lift: number }
  const racks = new Map<string, ProviderRack>();
  let items: RackItem[] = [];

  function buildRack(item: RackItem, index: number): ProviderRack {
    const plan = item.kind === 'plan';
    const r = rack({ w: plan ? 1.3 : 1.1, units: plan ? 3 : 2, uh: plan ? 0.3 : 0.28, color: item.color, mark: item.mark, ghost: !item.usable });
    const pick = new Mesh(keep(new BoxGeometry(r.w + 0.3, r.h + 0.5, r.w + 0.3)), keep(new MeshBasicMaterial({ visible: false })));
    pick.position.y = r.h / 2;
    pick.userData['id'] = item.id;
    r.group.add(pick);
    scene.add(r.group);
    const target = at(SLOT_A, slotD(index));
    return { ...r, item, pick, pos: target.clone(), target, lift: 0 };
  }
  function removeRack(r: ProviderRack): void {
    scene.remove(r.group);
    const t = themed;
    for (const p of r.paints) {
      const i = t.indexOf(p);
      if (i >= 0) t.splice(i, 1);
    }
  }

  /* ---------- Vòng chọn dưới tủ đang xem ---------- */
  const ring = new Mesh(keep(new RingGeometry(1.08, 1.2, 4, 1)), keep(new MeshBasicMaterial({ color: CORE_COLOR, transparent: true, opacity: 0.85, depthWrite: false })));
  ring.rotation.x = -Math.PI / 2;
  ring.rotation.z = Math.PI / 4;
  ring.position.y = 0.006;
  ring.renderOrder = -1;
  ring.scale.setScalar(((PAD / 2 + 0.2) * Math.SQRT2) / 1.2);
  scene.add(ring);

  /* ---------- Đường mạch in ---------- */
  const traces = new Group();
  scene.add(traces);
  const clearTraces = (): void => {
    traces.traverse((o: Object3D) => {
      const m = o as Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as Material).dispose();
      }
    });
    traces.clear();
  };
  function ribbon(p0: Vector3, p1: Vector3, width: number, color: string, opts: { dash?: [number, number]; opacity?: number; y?: number; order?: number } = {}): Mesh[] {
    const out: Mesh[] = [];
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    if (len < 1e-4) return out;
    dir.normalize();
    const angle = Math.atan2(dir.x, dir.z);
    const piece = (a: number, b: number): void => {
      const mat = new MeshBasicMaterial({ color, transparent: opts.opacity !== undefined, opacity: opts.opacity ?? 1, depthWrite: false });
      const m = new Mesh(new BoxGeometry(width, 0.004, b - a), mat);
      const mid = p0.clone().add(dir.clone().multiplyScalar((a + b) / 2));
      m.position.set(mid.x, opts.y ?? 0.012, mid.z);
      m.rotation.y = angle;
      m.renderOrder = opts.order ?? 0;
      out.push(m);
    };
    if (opts.dash) for (let s = 0; s < len; s += opts.dash[0] + opts.dash[1]) piece(s, Math.min(len, s + opts.dash[0]));
    else piece(0, len);
    return out;
  }
  const disc = (p: Vector3, r: number, color: string, y = 0.016, order = 1): Mesh => {
    const m = new Mesh(new CylinderGeometry(r, r, 0.004, 24), new MeshBasicMaterial({ color, depthWrite: false }));
    m.position.set(p.x, y, p.z);
    m.renderOrder = order;
    return m;
  };
  const trunkStart = at(CORE_PLINTH, CORE_D);
  const busPoint = (i: number): Vector3 => at(BUS_A, slotD(i));
  const branchEnd = (i: number): Vector3 => at(SLOT_A - PAD - 0.05, slotD(i));
  let pulsePath: { pts: Vector3[]; lens: number[]; total: number } | null = null;

  function drawTraces(): void {
    clearTraces();
    const t = pal();
    const pIdx = items.findIndex((item) => item.usable);
    const add = (arr: Mesh[]): void => arr.forEach((m) => traces.add(m));
    add(ribbon(trunkStart, at(BUS_A, CORE_D), 0.1, t.trace));
    add(ribbon(busPoint(0), busPoint(4), 0.1, t.trace));
    traces.add(disc(at(BUS_A, CORE_D), 0.1, t.trace));
    items.forEach((item, i) => {
      if (i === pIdx) return;
      add(ribbon(busPoint(i), branchEnd(i), item.usable ? 0.08 : 0.06, item.usable ? item.color : t.dead, { dash: [0.22, 0.16], opacity: item.usable ? 0.75 : 1 }));
    });
    for (let i = 0; i < 5; i++) {
      traces.add(disc(busPoint(i), 0.15, t.viaRing, 0.018, 2));
      traces.add(disc(busPoint(i), 0.075, t.via, 0.02, 3));
    }
    traces.add(disc(trunkStart, 0.12, t.viaRing, 0.018, 2));
    const primary = items[pIdx];
    if (primary) {
      const pts = [trunkStart, at(BUS_A, CORE_D), busPoint(pIdx), branchEnd(pIdx)];
      for (let k = 0; k < pts.length - 1; k++) {
        add(ribbon(pts[k]!, pts[k + 1]!, 0.44, primary.color, { opacity: t.glow, y: 0.013, order: 1 }));
        add(ribbon(pts[k]!, pts[k + 1]!, 0.15, primary.color, { y: 0.015, order: 2 }));
      }
      pts.slice(1, -1).forEach((p) => traces.add(disc(p, 0.075, primary.color, 0.016, 2)));
      traces.add(disc(busPoint(pIdx), 0.17, primary.color, 0.019, 3));
      traces.add(disc(busPoint(pIdx), 0.08, '#ffffff', 0.021, 4));
      const lens = pts.slice(0, -1).map((p, k) => p.distanceTo(pts[k + 1]!));
      pulsePath = { pts, lens, total: lens.reduce((a, b) => a + b, 0) };
      pulseHalo.material.color.set(primary.color);
    } else {
      pulsePath = null;
    }
  }

  /* ---------- Xung sáng chậm trên đường đang dùng ---------- */
  const pulse = new Group();
  const pulseHalo = new Mesh(keep(new CylinderGeometry(0.34, 0.34, 0.004, 28)), keep(new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.35, depthWrite: false })));
  const pulseDot = new Mesh(keep(new CylinderGeometry(0.12, 0.12, 0.004, 20)), keep(new MeshBasicMaterial({ color: '#ffffff', depthWrite: false })));
  pulseHalo.renderOrder = 5; pulseDot.renderOrder = 6;
  pulseHalo.position.y = 0.024; pulseDot.position.y = 0.026;
  pulse.add(pulseHalo, pulseDot);
  scene.add(pulse);
  // Không tắt theo "giảm chuyển động" của hệ điều hành: nhiều máy Windows tắt hiệu ứng nên trên máy tính chỉ thấy cảnh
  // tĩnh, mất gói tin chạy như trên điện thoại. Xung chậm, một chấm, đủ nhẹ mắt.
  function placePulse(now: number): void {
    if (!pulsePath) {
      pulse.visible = false;
      return;
    }
    const cycle = 3.6, travel = 2.6;
    const tt = (now / 1000) % cycle;
    if (tt > travel) {
      pulse.visible = false;
      return;
    }
    pulse.visible = true;
    let d = (tt / travel) * pulsePath.total;
    for (let k = 0; k < pulsePath.lens.length; k++) {
      const len = pulsePath.lens[k]!;
      if (d <= len || k === pulsePath.lens.length - 1) {
        const p = pulsePath.pts[k]!.clone().lerp(pulsePath.pts[k + 1]!, Math.min(1, d / len));
        pulse.position.set(p.x, 0, p.z);
        break;
      }
      d -= len;
    }
  }

  /* ---------- Chọn tủ bằng chuột ---------- */
  let selected: string | null = null;
  let hover: string | null = null;
  const ray = new Raycaster();
  const pointer = new Vector2();
  const pickAt = (e: PointerEvent | MouseEvent): string | null => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(pointer, camera);
    const hit = ray.intersectObjects([...racks.values()].map((r) => r.pick))[0];
    return (hit?.object.userData['id'] as string | undefined) ?? null;
  };
  const onMove = (e: PointerEvent): void => {
    const id = pickAt(e);
    canvas.style.cursor = id ? 'pointer' : 'default';
    if (id !== hover) options.onHover(id);
  };
  const onLeave = (): void => options.onHover(null);
  const onClick = (e: MouseEvent): void => {
    const id = pickAt(e);
    if (id) options.onSelect(id);
  };
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('click', onClick);

  /* ---------- Khung nhìn: vừa khít nội dung, chừa chỗ nhãn phải, tiêu đề trên, chú thích dưới ---------- */
  function fit(): void {
    const w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const pts: Vector3[] = [];
    const box = (c: Vector3, half: number, y1: number): void => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, y1]) pts.push(c.clone().add(new Vector3(sx * half, y, sz * half)));
    };
    box(at(0, CORE_D), CORE_PLINTH / 2, 3.1);
    for (let i = 0; i < 5; i++) box(at(SLOT_A, slotD(i)), PAD / 2 + 0.1, 1.2);
    const inv = camera.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      p.applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    // Khoảng cách dọc giữa hai ô liền nhau trên màn hình (đơn vị camera).
    const slotGap = Math.abs(at(SLOT_A, slotD(1)).applyMatrix4(inv).y - at(SLOT_A, slotD(0)).applyMatrix4(inv).y);
    const narrow = w < 620;
    const topPx = narrow ? 84 : 78, bottomPx = narrow ? 74 : 48, pad = 20;
    const tags = (): HTMLElement[] => [...labels.querySelectorAll<HTMLElement>('[data-rack]:not([data-rack="core"])')];
    const measure = (): { upp: number; labelPx: number; fits: boolean } => {
      const labelPx = Math.max(0, ...tags().map((el) => el.offsetWidth)) + 26;
      const tallest = Math.max(0, ...tags().map((el) => el.offsetHeight));
      const upp = Math.max((maxX - minX) / Math.max(120, w - labelPx - pad * 2), (maxY - minY) / Math.max(120, h - topPx - bottomPx));
      return { upp, labelPx, fits: slotGap / upp >= tallest + 6 };
    };
    // Nhãn đầy đủ trước; năm nhãn không đủ chỗ xếp dọc thì dùng nhãn gọn một dòng.
    labels.classList.remove(options.compactClass);
    let fitted = measure();
    if (narrow || !fitted.fits) {
      labels.classList.add(options.compactClass);
      fitted = measure();
    }
    const { upp, labelPx } = fitted;
    const spare = Math.max(0, w - pad * 2 - labelPx - (maxX - minX) / upp);
    const left = minX - (pad + spare / 2) * upp;
    const midPx = (bottomPx + (h - topPx)) / 2;
    camera.left = left; camera.right = left + w * upp;
    camera.bottom = (minY + maxY) / 2 - midPx * upp; camera.top = camera.bottom + h * upp;
    camera.updateProjectionMatrix();
    kick();
  }
  const resizeObserver = new ResizeObserver(fit);
  resizeObserver.observe(stage);

  /* ---------- Vòng vẽ: liên tục chỉ khi có xung sáng và sơ đồ đang hiện; còn lại vẽ khi có thay đổi ---------- */
  let running = false;
  let visible = true;
  let frameId = 0;
  const intersection = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    kick();
  });
  intersection.observe(stage);
  const tmp = new Vector3();
  function kick(): void {
    if (!running) {
      running = true;
      frameId = requestAnimationFrame(frame);
    }
  }
  function frame(now: number): void {
    let moving = false;
    for (const [id, r] of racks) {
      r.pos.lerp(r.target, 0.16);
      if (r.pos.distanceTo(r.target) > 0.004) moving = true;
      else r.pos.copy(r.target);
      const want = hover === id ? 0.14 : 0;
      r.lift += (want - r.lift) * 0.25;
      if (Math.abs(want - r.lift) > 0.002) moving = true;
      r.group.position.set(r.pos.x, r.lift, r.pos.z);
    }
    const sel = selected ? racks.get(selected) : undefined;
    ring.visible = Boolean(sel);
    if (sel) ring.position.set(sel.pos.x, 0.006, sel.pos.z);
    placePulse(now);
    renderer.render(scene, camera);
    // Đặt nhãn HTML cạnh góc phải từng tủ; nhãn trụ sở nằm dưới khối, không tràn mép.
    const w = stage.clientWidth, h = stage.clientHeight;
    const place = (el: HTMLElement | null, v: Vector3, dx: number): void => {
      if (!el) return;
      v.project(camera);
      el.style.left = `${(v.x * 0.5 + 0.5) * w + dx}px`;
      el.style.top = `${(-v.y * 0.5 + 0.5) * h}px`;
    };
    for (const [id, r] of racks) place(labels.querySelector<HTMLElement>(`[data-rack="${id}"]`), tmp.copy(r.group.position).add(new Vector3(r.w / 2, r.h / 2, -r.w / 2)), 16);
    const coreTag = labels.querySelector<HTMLElement>('[data-rack="core"]');
    if (coreTag) {
      place(coreTag, tmp.copy(core.position).add(new Vector3(CORE_PLINTH / 2, 0, CORE_PLINTH / 2)), 0);
      const half = coreTag.offsetWidth / 2;
      coreTag.style.left = `${Math.min(w - half - 8, Math.max(half + 8, parseFloat(coreTag.style.left)))}px`;
    }
    const animate = visible && !document.hidden && pulsePath !== null;
    if (moving || animate) frameId = requestAnimationFrame(frame);
    else running = false;
  }
  const onVisibility = (): void => kick();
  document.addEventListener('visibilitychange', onVisibility);

  /* ---------- Đổi giao diện sáng/tối theo bảng điều khiển ---------- */
  const applyTheme = (): void => {
    themed.forEach((paint) => paint());
    drawTraces();
    kick();
  };
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  // Chữ trên nóc tủ dùng phông của trang: vẽ lại khi phông tải xong.
  void document.fonts?.ready.then(applyTheme);

  return {
    setItems(next) {
      items = next;
      next.forEach((item, index) => {
        const existing = racks.get(item.id);
        if (!existing || existing.item.usable !== item.usable || existing.item.color !== item.color) {
          if (existing) removeRack(existing);
          const built = buildRack(item, index);
          if (existing) built.pos.copy(existing.pos);
          themed.push(...built.paints);
          racks.set(item.id, built);
        }
        racks.get(item.id)!.item = item;
        racks.get(item.id)!.target.copy(at(SLOT_A, slotD(index)));
      });
      drawTraces();
      kick();
    },
    setSelected(id) {
      selected = id;
      kick();
    },
    setHover(id) {
      hover = id;
      kick();
    },
    refit: fit,
    dispose() {
      cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersection.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
      clearTraces();
      disposables.forEach((item) => item.dispose());
      renderer.dispose();
    },
  };
}
