/**
 * P&N — Khang ở trang đăng nhập (bản 4 "mềm mượt").
 *
 * Khang (lễ tân, cùng mô hình với quầy tiếp đón trong văn phòng 3D) xách cặp
 * bước vào, đặt cặp xuống, nắp bật mở và khung đăng nhập chui ra từ miệng cặp.
 * Sau đó Khang nhìn theo con trỏ chuột và con trỏ chữ khi gõ email, quay đi khi
 * nhập mật khẩu, chỉ tay vào ô còn thiếu, giật mình khi sai mật khẩu; đăng nhập
 * đúng thì khung chui ngược vào cặp, Khang xách cặp đi khỏi khung rồi thẻ
 * "Chào mừng" mới hiện một mình.
 *
 * three.js thuần (không React) để giữ nguyên cách dựng của bản mẫu đã duyệt;
 * `LoginStage.tsx` bọc lại. Lỗi WebGL hay không nạp được mô hình thì hàm tạo
 * ném lỗi, trang hiện khung đăng nhập ngay — Khang không bao giờ chặn việc vào.
 */

import { gsap } from 'gsap';
import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AnimationMixer,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  Clock,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Euler,
  Fog,
  GridHelper,
  Group,
  HemisphereLight,
  type LineBasicMaterial,
  LoopOnce,
  LoopRepeat,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PMREMGenerator,
  PointLight,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type Blending,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

import { BONE, prepareHuman } from './human-model';

export type BubbleTone = 'info' | 'warn' | 'bad' | 'good';

export interface Greeter {
  /** Nói một câu trong bong bóng; `ms = 0` giữ tới câu sau. */
  say(text: string, tone?: BubbleTone, ms?: number): void;
  /** Chỉ tay vào một ô và nhắc (thiếu email, sai dạng…). */
  remind(target: Element, text: string): void;
  /** Sai mật khẩu: giật mình, lắc đầu, khung rung. */
  wrong(text: string): void;
  /** Đăng nhập đúng: khung chui vào cặp, Khang xách cặp đi vào văn phòng, máy quay tiến theo; vào sâu thì gọi `onDone`. */
  leave(onDone: () => void): void;
  dispose(): void;
}

export interface GreeterParts {
  canvas: HTMLCanvasElement;
  /** Khung chứa cả cảnh và khung đăng nhập; cỡ khoảng trống phía trên khung đăng nhập (điện thoại) đo theo khung này. */
  stage: HTMLElement;
  /** Lớp bọc khung đăng nhập — Khang cho nó chui ra khỏi cặp và chui ngược vào. */
  form: HTMLElement;
  bubble: HTMLElement;
  /** Câu chào khi khung vừa bung ra (đăng nhập hay tạo tài khoản CEO đầu tiên). */
  greeting: () => string;
  /** Khung đã hiện sẵn (mốc an toàn của LoginStage nổ trước khi Khang kịp mở cặp): bỏ đoạn khung chui ra, chỉ chào. */
  formShown: () => boolean;
}

const MODEL_URL = '/models/le-tan-nam.glb';
const HEIGHT = 1.8;
/** Tốc độ đi, khớp sải chân của động tác Walk (đo 1,28 u/s) để bàn chân không trượt. */
const WALK = 1.35;
/**
 * Tốc độ chạy vào, khớp sải chân của động tác Run (đo thực tế: bàn chân chạm đất lùi 2,94–3,15 u/s sau khi thu
 * model về cao 1,8; cùng cách đo cho Walk ra 1,32–1,36). Đi bộ vào mất thời gian nên chạy vào cho nhanh.
 */
const RUN = 3.05;
/** Còn cách chỗ đứng chừng này thì hãm từ chạy sang đi để dừng tự nhiên, không phanh gấp. */
const BRAKE = 1.1;
/** Ngồi yên chừng này thì Khang hỏi han. */
const IDLE_NUDGE_MS = 12_000;
const DUST = 70;
const WORLD_UP = new Vector3(0, 1, 0);

/** Điện thoại: Khang đứng sẵn phía trên khung, bỏ đoạn đi bộ. Cùng mốc với CSS `.pn-greet-stage`. */
const isNarrow = (): boolean => window.matchMedia('(max-width: 767px)').matches;
/** Trang đăng nhập luôn tone đêm — không theo nút sáng/tối của app. Bảng màu sáng vẫn giữ trong các hàm tô màu. */
const isDark = (): boolean => true;
const damp = (from: number, to: number, rate: number, dt: number): number => from + (to - from) * (1 - Math.exp(-rate * dt));

type Phase = 'walk' | 'arrive' | 'drop' | 'wave' | 'idle' | 'leaving' | 'pickup' | 'exit';

/** Ảnh vẽ bằng canvas 2D (bóng mềm, vòng sáng, quầng sáng) — mềm hơn nhiều so với bóng đổ cứng của đèn. */
function paint(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const texture = new CanvasTexture(c);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
const radial = (g: CanvasRenderingContext2D, s: number, stops: Array<[number, string]>): void => {
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [at, color] of stops) r.addColorStop(at, color);
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
};

/**
 * Làm mềm mô hình: bản gốc low-poly tách rời đỉnh ở mọi cạnh nên mỗi mặt phẳng một màu (trông như
 * giấy gấp). Gộp các đỉnh trùng nhau rồi tính lại pháp tuyến → sáng tối chuyển mượt qua các cạnh.
 */
function soften(root: Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const geometry = node.geometry.clone();
    geometry.deleteAttribute('normal');
    const merged = mergeVertices(geometry, 1e-4);
    merged.computeVertexNormals();
    node.geometry = merged;
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      const standard = material as MeshStandardMaterial;
      standard.roughness = 0.62;
      standard.envMapIntensity = 0.55;
    }
  });
}

/** Cặp táp bo góc: thân da, nắp mở quanh bản lề sau, quai cong, khoá kim loại, luồng sáng bên trong. */
function makeBriefcase(glow: CanvasTexture): { group: Group; lid: Group; inner: Mesh; halo: Sprite; beam: PointLight } {
  const leather = new MeshStandardMaterial({ color: 0x6e3c20, roughness: 0.5, envMapIntensity: 0.45 });
  const dark = new MeshStandardMaterial({ color: 0x4a2916, roughness: 0.52, envMapIntensity: 0.45 });
  const metal = new MeshStandardMaterial({ color: 0xdcbc72, metalness: 0.85, roughness: 0.28 });
  const group = new Group();
  group.add(new Mesh(new RoundedBoxGeometry(0.46, 0.28, 0.12, 5, 0.035), leather));
  const lid = new Group();
  lid.position.set(0, 0.14, -0.062);
  group.add(lid);
  const top = new Mesh(new RoundedBoxGeometry(0.47, 0.05, 0.126, 5, 0.022), dark);
  top.position.set(0, 0.02, 0.062);
  lid.add(top);
  const curve = new CatmullRomCurve3([
    new Vector3(-0.07, 0, 0), new Vector3(-0.06, 0.05, 0), new Vector3(0, 0.07, 0), new Vector3(0.06, 0.05, 0), new Vector3(0.07, 0, 0),
  ]);
  const handle = new Mesh(new TubeGeometry(curve, 32, 0.011, 10), dark);
  handle.position.set(0, 0.04, 0.062);
  lid.add(handle);
  for (const x of [-0.07, 0.07]) {
    const foot = new Mesh(new RoundedBoxGeometry(0.03, 0.018, 0.03, 3, 0.006), metal);
    foot.position.set(x, 0.045, 0.062);
    lid.add(foot);
  }
  for (const x of [-0.13, 0.13]) {
    const clasp = new Mesh(new RoundedBoxGeometry(0.046, 0.036, 0.012, 3, 0.006), metal);
    clasp.position.set(x, 0.11, 0.062);
    group.add(clasp);
  }
  const inner = new Mesh(new PlaneGeometry(0.4, 0.09), new MeshBasicMaterial({ color: 0xbffcf2, transparent: true, opacity: 0 }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.set(0, 0.141, 0);
  group.add(inner);
  const halo = new Sprite(new SpriteMaterial({ map: glow, color: 0x5eead4, transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }));
  halo.position.set(0, 0.26, 0.02);
  halo.scale.set(0.9, 0.7, 1);
  group.add(halo);
  const beam = new PointLight(0x2dd4bf, 0, 1.6);
  beam.position.set(0, 0.35, 0.15);
  group.add(beam);
  group.scale.setScalar(1.15);
  return { group, lid, inner, halo, beam };
}

/** Màu nền trang (`--page` trong globals.css) — sương và sàn tan vào đúng màu này. */
const PAGE = { dark: 0x0a1827, light: 0xf3f6fa };

/**
 * Văn phòng P&N sau lưng Khang: hai hàng bàn (hàng xa mờ hơn), ghế, màn hình,
 * vách ngăn, đèn treo có vũng sáng, cây; sàn gương mờ nối chỗ Khang đứng với văn phòng, kẻ lưới mảnh.
 * Khung vẽ phủ cả trang nên văn phòng chạy ra sau cả logo và khung đăng nhập; chỉ tan dần theo chiều sâu bằng sương.
 */
interface Office {
  group: Group;
  mats: Record<'desk' | 'chair' | 'body' | 'plant' | 'pot' | 'partition', MeshStandardMaterial>;
  screens: Array<{ material: MeshBasicMaterial; seed: number; base: number }>;
  sitters: Array<{ head: Mesh; seed: number }>;
  walkers: Array<{ group: Group; dir: number; speed: number; folder: Mesh }>;
  lamps: Array<{ disc: MeshBasicMaterial; pool: MeshBasicMaterial; seed: number }>;
  mirror: Reflector;
  veil: MeshBasicMaterial;
  grid: LineBasicMaterial;
}

function buildOffice(glow: CanvasTexture): Office {
  const group = new Group();
  const navy = (color: number): MeshStandardMaterial => new MeshStandardMaterial({ color, roughness: 0.75, envMapIntensity: 0.4 });
  const mats = { desk: navy(0x15294a), chair: navy(0x10223d), body: navy(0x1e3860), plant: navy(0x17563f), pot: navy(0x2a3d59), partition: navy(0x12233f) };
  const screens: Office['screens'] = [];
  const sitters: Office['sitters'] = [];
  const walkers: Office['walkers'] = [];
  const lamps: Office['lamps'] = [];
  // Số giả cố định: mỗi lần mở trang văn phòng đều y hệt nhau.
  let seed = 11;
  const rnd = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const put = (mesh: Mesh, x: number, y: number, z: number): Mesh => {
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  };
  for (const row of [{ z: -5.4, n: 6, x0: -6.5, gap: 2.6 }, { z: -8.3, n: 8, x0: -9.5, gap: 2.7 }]) {
    for (let i = 0; i < row.n; i++) {
      const x = row.x0 + i * row.gap;
      const z = row.z;
      put(new Mesh(new BoxGeometry(1.7, 0.05, 0.75), mats.desk), x, 0.74, z);
      for (const lx of [-0.78, 0.78]) put(new Mesh(new BoxGeometry(0.04, 0.72, 0.7), mats.desk), x + lx, 0.36, z);
      put(new Mesh(new BoxGeometry(0.05, 0.16, 0.05), mats.chair), x, 0.84, z - 0.2);
      const screen = new MeshBasicMaterial({ color: 0x5eead4, transparent: true, opacity: 0.45 });
      put(new Mesh(new PlaneGeometry(0.9, 0.52), screen), x, 1.18, z - 0.22).rotation.x = -0.08;
      screens.push({ material: screen, seed: rnd(), base: 0.3 + rnd() * 0.25 });
      put(new Mesh(new BoxGeometry(0.5, 0.55, 0.06), mats.chair), x, 0.85, z + 0.62);
      put(new Mesh(new BoxGeometry(0.5, 0.06, 0.5), mats.chair), x, 0.5, z + 0.4);
      // Vài bàn để trống cho tự nhiên.
      if (rnd() < 0.75) {
        put(new Mesh(new CapsuleGeometry(0.17, 0.3, 4, 8), mats.body), x, 0.92, z + 0.38).rotation.x = 0.12;
        sitters.push({ head: put(new Mesh(new SphereGeometry(0.13, 10, 8), mats.body), x, 1.36, z + 0.33), seed: rnd() });
      }
    }
  }
  put(new Mesh(new BoxGeometry(22, 1.1, 0.06), mats.partition), 0, 0.55, -6.9);
  // Sáu đèn treo lệch trục giữa để không có dây đèn nào chạy ngay sau logo.
  for (let i = 0; i < 6; i++) {
    const x = -10 + i * 4;
    const z = -6.7;
    const disc = new MeshBasicMaterial({ color: 0xbffcf2, transparent: true, opacity: 0.8 });
    put(new Mesh(new CylinderGeometry(0.34, 0.34, 0.04, 20), disc), x, 2.9, z);
    put(new Mesh(new BoxGeometry(0.02, 2.4, 0.02), mats.chair), x, 4.1, z);
    const pool = new MeshBasicMaterial({ map: glow, color: 0x2dd4bf, transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending });
    put(new Mesh(new PlaneGeometry(2.6, 1.5), pool), x, 0.006, z + 0.3).rotation.x = -Math.PI / 2;
    lamps.push({ disc, pool, seed: rnd() });
  }
  for (const [x, z] of [[-10.6, -4.6], [10.9, -4.9], [0.6, -9.7]] as const) {
    put(new Mesh(new CylinderGeometry(0.2, 0.16, 0.35, 12), mats.pot), x, 0.17, z);
    put(new Mesh(new ConeGeometry(0.45, 0.75, 8), mats.plant), x, 0.7, z);
    put(new Mesh(new ConeGeometry(0.34, 0.6, 8), mats.plant), x, 1.15, z);
  }
  // Người ôm hồ sơ đi lại ở hành lang trước và hành lang giữa hai hàng.
  for (let i = 0; i < 3; i++) {
    const walker = new Group();
    const body = new Mesh(new CapsuleGeometry(0.17, 0.6, 4, 8), mats.body);
    body.position.y = 0.85;
    walker.add(body);
    const head = new Mesh(new SphereGeometry(0.14, 10, 8), mats.body);
    head.position.y = 1.45;
    walker.add(head);
    const folder = new Mesh(new BoxGeometry(0.22, 0.3, 0.03), new MeshBasicMaterial({ color: 0x9ff5ea }));
    folder.position.set(0.22, 0.9, 0.1);
    walker.add(folder);
    walker.position.set(-8 + i * 6, 0, i === 1 ? -4.3 : -6.9);
    group.add(walker);
    walkers.push({ group: walker, dir: i % 2 ? -1 : 1, speed: 0.5 + i * 0.15, folder });
  }
  // Sàn gương mờ; tấm phủ làm phản chiếu chỉ còn thấp thoáng; lưới kẻ ô mảnh trên cùng.
  const mirror = new Reflector(new PlaneGeometry(40, 40), { clipBias: 0.003, textureWidth: 1024, textureHeight: 1024, color: 0x7f8f99 });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = -0.002;
  group.add(mirror);
  const veil = new MeshBasicMaterial({ color: PAGE.dark, transparent: true, opacity: 0.8, depthWrite: false });
  put(new Mesh(new PlaneGeometry(40, 40), veil), 0, 0.001, 0).rotation.x = -Math.PI / 2;
  const gridHelper = new GridHelper(40, 40, 0x2dd4bf, 0x2dd4bf);
  const grid = gridHelper.material as LineBasicMaterial;
  grid.vertexColors = false;
  grid.transparent = true;
  grid.opacity = 0.12;
  grid.depthWrite = false;
  gridHelper.position.y = 0.002;
  group.add(gridHelper);
  return { group, mats, screens, sitters, walkers, lamps, mirror, veil, grid };
}

/** Màu văn phòng theo sáng/tối: tối là xanh đêm, sáng là xám xanh nhạt; cộng sáng chỉ dùng trên nền tối. */
function themeOffice(office: Office, dark: boolean): void {
  const add = dark ? AdditiveBlending : NormalBlending;
  const { mats } = office;
  mats.desk.color.setHex(dark ? 0x15294a : 0xc9d6e6);
  mats.chair.color.setHex(dark ? 0x10223d : 0xb9c8da);
  mats.body.color.setHex(dark ? 0x1e3860 : 0xb1c1d4);
  mats.plant.color.setHex(dark ? 0x17563f : 0x7fb59a);
  mats.pot.color.setHex(dark ? 0x2a3d59 : 0xc0cbd8);
  mats.partition.color.setHex(dark ? 0x12233f : 0xd3dde8);
  office.veil.color.setHex(dark ? PAGE.dark : 0xeef3f8);
  office.veil.opacity = dark ? 0.8 : 0.86;
  office.grid.color.setHex(dark ? 0x2dd4bf : 0x0f9d8b);
  office.grid.opacity = dark ? 0.12 : 0.16;
  for (const s of office.screens) {
    s.material.blending = add;
    s.material.needsUpdate = true;
  }
  for (const l of office.lamps) {
    l.pool.blending = add;
    l.pool.needsUpdate = true;
    l.disc.color.setHex(dark ? 0xbffcf2 : 0x5eead4);
  }
}

/** Văn phòng sống: màn hình thỉnh thoảng loé, người ngồi khẽ gật, đèn thở nhẹ, người ôm hồ sơ đi qua lại. */
function updateOffice(office: Office, dt: number, time: number, dark: boolean): void {
  for (const s of office.screens) s.material.opacity = (s.base + (Math.sin(time * 7 + s.seed * 40) > 0.93 ? 0.35 : 0)) * (dark ? 1 : 0.8);
  for (const p of office.sitters) p.head.position.y = 1.36 + Math.sin(time * 2.2 + p.seed * 9) * 0.015;
  for (const l of office.lamps) l.pool.opacity = (dark ? 0.22 : 0.14) * (1 + Math.sin(time * 1.3 + l.seed * 7) * 0.15);
  for (const w of office.walkers) {
    w.group.position.x += w.dir * w.speed * dt;
    if (w.group.position.x > 9) w.dir = -1;
    else if (w.group.position.x < -9) w.dir = 1;
    w.group.position.y = Math.abs(Math.sin(time * 5.5 + w.speed)) * 0.035;
    w.folder.position.x = 0.22 * w.dir;
  }
}

export async function createGreeter(parts: GreeterParts): Promise<Greeter> {
  const { canvas, stage, form, bubble, greeting, formShown } = parts;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  let gltf;
  try {
    gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  } catch (error) {
    renderer.dispose();
    throw error;
  }

  // ---------- Dựng cảnh ----------
  const scene = new Scene();
  // Ánh sáng môi trường mềm (phòng studio dựng sẵn của three): bề mặt có độ chuyển sáng tối mượt thay vì mảng phẳng.
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new PerspectiveCamera(32, 1, 0.1, 100);
  scene.add(new HemisphereLight(0xeaf6ff, 0x243442, 0.9));
  const key = new DirectionalLight(0xffffff, 1.7);
  key.position.set(-3, 5, 5);
  scene.add(key);
  const fill = new DirectionalLight(0xdce8ff, 0.5);
  fill.position.set(4, 2, 4);
  scene.add(fill);
  const rim = new DirectionalLight(0x2dd4bf, 1.3);
  rim.position.set(3, 3, -4);
  scene.add(rim);

  const blobTex = paint(128, (g, s) => radial(g, s, [[0, 'rgba(0,0,0,.55)'], [0.5, 'rgba(0,0,0,.22)'], [1, 'rgba(0,0,0,0)']]));
  const ringTex = paint(512, (g, s) => {
    g.strokeStyle = '#fff';
    g.shadowColor = '#fff';
    g.shadowBlur = 22;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2);
    g.stroke();
    g.shadowBlur = 0;
    g.lineWidth = 2.5;
    g.stroke();
  });
  const glowTex = paint(128, (g, s) => radial(g, s, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.45)'], [1, 'rgba(255,255,255,0)']]));
  const flat = (texture: CanvasTexture, w: number, h: number, blending: Blending = NormalBlending): Mesh<PlaneGeometry, MeshBasicMaterial> => {
    const mesh = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, blending }));
    mesh.rotation.x = -Math.PI / 2;
    scene.add(mesh);
    return mesh;
  };
  // Vòng sáng dưới chân và bóng mềm của người, của cặp: nhân vật đứng trên "sân khấu", không lơ lửng.
  const ring = flat(ringTex, 3, 3, AdditiveBlending);
  ring.position.y = 0.003;
  const khangShadow = flat(blobTex, 1.1, 0.7);
  khangShadow.position.y = 0.004;
  const bagShadow = flat(blobTex, 0.8, 0.45);
  bagShadow.position.y = 0.005;
  const office = buildOffice(glowTex);
  scene.add(office.group);
  // Sương cùng màu nền trang: văn phòng cách 5–9 m mờ dần rồi tan hẳn vào nền, không lộ mép.
  const fog = new Fog(PAGE.dark, 6, 14);
  scene.fog = fog;

  const bag = makeBriefcase(glowTex);
  scene.add(bag.group);

  // Bụi sáng bay lên từ miệng cặp khi nắp mở.
  const dustPos = new Float32Array(DUST * 3);
  const dustSeed = Float32Array.from({ length: DUST }, () => Math.random());
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new BufferAttribute(dustPos, 3));
  const dustMaterial = new PointsMaterial({ size: 0.03, transparent: true, opacity: 0, depthWrite: false, map: glowTex });
  scene.add(new Points(dustGeo, dustMaterial));

  // Tô màu cảnh một lần theo tone đêm.
  const applyTheme = (): void => {
    const dark = isDark();
    ring.material.color.setHex(dark ? 0x2dd4bf : 0x0fa996);
    ring.material.opacity = dark ? 0.55 : 0.6;
    // Cộng sáng chỉ đẹp trên nền tối; nền sáng thì hạt cộng sáng biến mất.
    ring.material.blending = dark ? AdditiveBlending : NormalBlending;
    khangShadow.material.opacity = dark ? 0.9 : 0.45;
    dustMaterial.color.setHex(dark ? 0x9ff5ea : 0x0fb5a0);
    dustMaterial.blending = dark ? AdditiveBlending : NormalBlending;
    ring.material.needsUpdate = true;
    dustMaterial.needsUpdate = true;
    fog.color.setHex(dark ? PAGE.dark : PAGE.light);
    themeOffice(office, dark);
  };
  applyTheme();

  // ---------- Nhân vật ----------
  const prepared = prepareHuman(gltf.scene, HEIGHT);
  const model = prepared.model;
  soften(model);
  model.scale.setScalar(prepared.scale);
  scene.add(model);
  const mixer = new AnimationMixer(model);
  const actions = new Map<string, AnimationAction>();
  for (const clip of gltf.animations) actions.set(clip.name.replace('CharacterArmature|', ''), mixer.clipAction(clip));
  const bone = (name: string): Object3D => {
    const found = model.getObjectByName(name);
    if (!found) throw new Error(`Mô hình thiếu xương ${name}`);
    return found;
  };
  const head = bone(BONE.head);
  const hand = bone('WristR');
  // Tay trái chỉ vào khung (khung nằm bên trái của Khang, tức bên phải màn hình).
  const upperArm = bone(BONE.upperArm('L'));
  const lowerArm = bone(BONE.lowerArm('L'));
  const wrist = bone('WristL');
  // Dáng gốc của đầu và tay trái. Vài động tác (đặt cặp, giật mình) không có rãnh cho đầu/tay: mixer không ghi
  // đè, nên phần xoay cộng thêm mỗi khung hình sẽ dồn lại thành xoay vòng. Mỗi khung trả về dáng gốc trước rồi mới cộng.
  const rest: Array<[Object3D, Quaternion]> = [head, upperArm, lowerArm].map((b) => [b, b.quaternion.clone()]);

  /** Chuyển động tác với thời gian hoà trộn dài để các cú đổi dáng không bị giật. */
  const play = (name: string, { once = false, fade = 0.4, timeScale = 1 } = {}): void => {
    const next = actions.get(name);
    if (!next) return;
    next.reset();
    next.timeScale = timeScale;
    next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    next.clampWhenFinished = once;
    // Tắt dần MỌI động tác đang có mặt — kể cả động tác chạy một lần đã dừng ở khung cuối (isRunning() = false
    // nhưng vẫn giữ nguyên sức nặng). Bỏ sót nó thì dáng cúi nhặt cặp trộn vào dáng đi → chân lê, bàn chân lệch.
    for (const action of actions.values()) if (action !== next && action.isScheduled() && action.enabled) action.fadeOut(fade);
    next.fadeIn(fade).play();
  };

  const state = {
    phase: 'walk' as Phase,
    t0: performance.now(),
    speed: WALK,
    /** Đang chạy vào (màn hình rộng); tới gần chỗ đứng thì chuyển sang đi. */
    running: false,
    /** Cặp: đang trong tay, tự do trên sàn, hay đang hoà từ sàn lên tay lúc nhặt. */
    bagMode: 'hand' as 'hand' | 'free' | 'blend',
    /** Đã rút tay về sau khi thả cặp. */
    armBack: false,
    carry: 1,
    restPos: new Vector3(),
    restQ: new Quaternion(),
    focus: null as string | null,
    /** Khang đang chăm chú vào cặp / vào thẻ đang chui ra (ưu tiên trên mọi hướng nhìn khác). */
    look: null as 'bag' | 'card' | null,
    cursor: null as { x: number; y: number } | null,
    caret: null as { x: number; y: number } | null,
    shake: 0,
    nod: 0,
    lookAround: false,
    idleAt: performance.now(),
    point: false,
    pointTarget: new Vector3(),
    welcomed: false,
    /** Tiến độ máy quay tiến vào văn phòng sau khi đăng nhập (0 → 1). */
    push: 0,
  };
  const layout = { standX: -0.3, walkFrom: -4.2, face: 0.35 };
  // Hướng máy quay nhìn (fit đặt), và điểm đầu–cuối của cú tiến vào văn phòng.
  const camLook = new Vector3();
  const camFrom = new Vector3();
  const lookFrom = new Vector3();
  /** Máy quay dừng sau lưng Khang, giữa lối đi, trước hàng bàn đầu (z −5,4). */
  const CAM_TO = new Vector3(0, 1.5, -1.3);
  const LOOK_TO = new Vector3(0, 1.1, -8);
  /** Lối đi giữa hai dãy bàn: Khang đi về điểm này. */
  const AISLE = new Vector3(0, 0, -4.6);
  const headingTo = new Vector3();
  const lookNow = new Vector3();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void): void => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  // Động tác một lần (giật mình) xong thì về đứng yên.
  mixer.addEventListener('finished', () => {
    if (state.phase === 'wave' || state.phase === 'idle') {
      state.phase = 'idle';
      play('Idle', { fade: 0.5 });
    }
  });

  // ---------- Toạ độ màn hình ↔ cảnh ----------
  const ray = new Raycaster();
  const toCanvas = (point: Vector3): { x: number; y: number } => {
    const p = point.clone().project(camera);
    return { x: ((p.x + 1) / 2) * canvas.clientWidth, y: ((1 - p.y) / 2) * canvas.clientHeight };
  };
  const toClient = (point: Vector3): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    const p = toCanvas(point);
    return { x: r.left + p.x, y: r.top + p.y };
  };
  /** Điểm trên mặt phẳng z = `depth` nằm dưới một điểm màn hình (toạ độ trình duyệt). */
  const toWorld = (clientX: number, clientY: number, depth: number): Vector3 => {
    const rect = canvas.getBoundingClientRect();
    ray.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1)), camera);
    return ray.ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -depth), new Vector3()) ?? new Vector3();
  };

  /**
   * Đặt máy quay theo khung đăng nhập. Máy tính: Khang cao đúng bằng phần thân khung — đầu ngang mép trên khung,
   * chân ngang dòng "Máy chủ" — và đứng cách mép trái khung một quãng tỉ lệ với cỡ Khang (đủ chỗ đặt cặp).
   */
  const fit = (): void => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const narrow = isNarrow();
    const formRect = form.getBoundingClientRect();
    // Chân: phần thân chính của khung (tối đa 392px — cỡ khung khi chỉ có ô nhập) hạ thêm 72px, không theo danh
    // sách "Thiết lập hệ thống" dài bên dưới; không để chân tụt quá đáy màn hình. Hạ 72px để bong bóng
    // trên đầu Khang không che dòng "DIGITAL COMPANY". Điện thoại: ngay trên mép trên khung.
    const LOWER = 72;
    const target = narrow ? formRect.top - 16 : Math.min(formRect.top + Math.min(formRect.height, 392) - 24 + LOWER, window.innerHeight - 48);
    // Cỡ Khang trên màn hình → lùi/tiến máy quay cho vừa. Máy tính: ≈ cao phần thân khung (đầu thấp hơn mép trên khung
    // đúng LOWER). Điện thoại: vừa khoảng trống phía trên khung, chừa ~90px trên đầu cho bong bóng.
    const khangPx = narrow
      ? Math.max(130, formRect.top - stage.getBoundingClientRect().top - 16 - 90)
      : Math.max(260, target - formRect.top - 8 - LOWER);
    const halfFov = Math.tan(MathUtils.degToRad(16));
    const distance = MathUtils.clamp((HEIGHT * h) / (2 * halfFov * khangPx) + 0.2, narrow ? 5 : 5.5, narrow ? 20 : 11);
    const base: { pos: [number, number, number]; look: [number, number, number] } = narrow
      ? { pos: [0, 1.15, distance], look: [0, 1.05, 0] }
      : { pos: [0, 1.55, distance], look: [0, 0.95, 0] };
    camera.position.set(...base.pos);
    camera.lookAt(...base.look);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    // Khung vẽ phủ cả trang: nâng/hạ máy quay cho tới khi điểm sàn dưới chân rơi đúng chỗ, màn hình cao thấp gì cũng đúng.
    const feet = toClient(new Vector3(0, 0, 0.2));
    const perPx = (2 * (base.pos[2] - 0.2) * halfFov) / h;
    const dy = (target - feet.y) * perPx;
    camera.position.y += dy;
    camLook.set(base.look[0], base.look[1] + dy, base.look[2]);
    camera.lookAt(camLook);
    camera.updateMatrixWorld();
    const rect = canvas.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (narrow) {
      layout.standX = -0.3;
      layout.walkFrom = layout.standX;
    } else {
      // Khang (và chiếc cặp bên phải Khang) cách mép trái khung ~0,55 lần chiều cao Khang.
      layout.standX = toWorld(formRect.left - khangPx * 0.55, midY, 0.2).x;
      layout.walkFrom = toWorld(rect.left - 80, midY, 0.2).x;
    }
    ring.position.x = layout.standX + 0.25;
    // Sương tính từ máy quay: đi theo khoảng cách để văn phòng mờ đúng như mẫu duyệt (máy quay 7 m → sương 6–14 m).
    fog.near = base.pos[2] - 1;
    fog.far = base.pos[2] + 7;
    // Điện thoại bỏ gương (vẽ cảnh hai lần nặng máy); sàn mờ và lưới vẫn còn.
    office.mirror.visible = !narrow;
  };
  fit();
  const onResize = (): void => {
    // Đang tiến vào văn phòng thì máy quay do cú tiến điều khiển; khung đăng nhập co lại lúc chui vào cặp cũng gọi tới đây.
    if (state.phase === 'exit') return;
    fit();
    // Đã đứng yên thì dời ngay Khang và cặp theo khung mới.
    if (state.phase === 'idle' || state.phase === 'wave') {
      model.position.x = layout.standX;
      bag.group.position.x = layout.standX + 0.62;
    }
  };
  window.addEventListener('resize', onResize);
  // Khung đổi chiều cao (danh sách thiết lập hiện ra sau khi tải trạng thái) thì canh lại chỗ Khang đứng.
  const formWatch = new ResizeObserver(onResize);
  formWatch.observe(form);
  // Trang dài/ngắn đi (khung vẽ phủ cả trang) thì cũng canh lại.
  formWatch.observe(canvas);

  // ---------- Bong bóng lời thoại ----------
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  const bub = { x: 0, y: 0, placed: false };
  const say = (text: string, tone: BubbleTone = 'info', ms = 2200): void => {
    bubble.textContent = text;
    bubble.dataset['tone'] = tone;
    bubble.dataset['on'] = 'true';
    clearTimeout(bubbleTimer);
    if (ms) bubbleTimer = setTimeout(() => delete bubble.dataset['on'], ms);
  };

  // ---------- Kịch bản vào: đi → tới nơi → đặt cặp → mở nắp → khung chui ra → vẫy chào ----------
  model.position.set(layout.walkFrom, 0, 0.2);
  model.rotation.y = Math.PI / 2;
  if (isNarrow()) {
    state.phase = 'arrive';
    play('Idle', { fade: 0.01 });
  } else {
    state.running = true;
    state.speed = RUN;
    play('Run', { fade: 0.01 });
  }

  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  let emergeTl: gsap.core.Timeline | null = null;

  // Thả cặp từ đỉnh tay: rơi nhanh dần như có trọng lực, ngang thì chậm dần; chạm sàn lún nhẹ rồi nảy về dáng.
  const releaseBag = (): void => {
    state.bagMode = 'free';
    const from = bag.group.position.clone();
    const fromQ = bag.group.quaternion.clone();
    const to = new Vector3(model.position.x + 0.62, 0.161, 0.55);
    const toQ = new Quaternion().setFromEuler(new Euler(0, 0.35, 0));
    const p = { t: 0 };
    gsap.to(p, {
      t: 1, duration: 0.45, ease: 'none',
      onUpdate: () => {
        const flat = 1 - (1 - p.t) ** 2;
        const fall = p.t * p.t;
        bag.group.position.set(from.x + (to.x - from.x) * flat, from.y + (to.y - from.y) * fall, from.z + (to.z - from.z) * flat);
        bag.group.quaternion.slerpQuaternions(fromQ, toQ, flat);
      },
      onComplete: () => {
        gsap.fromTo(bag.group.scale, { x: 1.15 * 1.05, y: 1.15 * 0.9, z: 1.15 * 1.05 }, { x: 1.15, y: 1.15, z: 1.15, duration: 0.6, ease: 'elastic.out(1, 0.45)' });
        openBag();
      },
    });
  };
  const openBag = (): void => {
    gsap.timeline({ delay: 0.1 })
      .to(bag.lid.rotation, { x: -1.95, duration: 0.75, ease: 'back.out(1.5)' }, 0)
      .to(bag.inner.material, { opacity: 1, duration: 0.4 }, 0.1)
      .to(bag.halo.material, { opacity: 0.9, duration: 0.6, ease: 'power2.out' }, 0.15)
      .to(bag.beam, { intensity: 2.2, duration: 0.6 }, 0.15)
      .to(dustMaterial, { opacity: 0.9, duration: 0.8 }, 0.2)
      .add(emergeForm, 0.45);
  };

  /*
   * Khung đăng nhập chui ra khỏi cặp thật sự:
   * A) một tấm thẻ cỡ bằng miệng cặp trồi lên — phần còn nằm dưới miệng cặp bị cắt (clip-path), như đang được rút ra;
   * B) ra hết thì bay theo đường cong tới chỗ của nó, lớn dần, nghiêng nhẹ rồi đứng yên. Ngược lại khi đăng nhập xong.
   */
  interface Emerge { f: DOMRect; c: { x: number; y: number }; mouth: { x: number; y: number }; s0: number; hidden: number; out: number }
  interface Card { cx: number; cy: number; s: number; r: number; clip: boolean }
  let E: Emerge | null = null;
  const measure = (): Emerge => {
    gsap.set(form, { clearProps: 'transform' });
    form.style.clipPath = '';
    const f = form.getBoundingClientRect();
    const top = new Vector3(bag.group.position.x, bag.group.position.y + 0.165, bag.group.position.z);
    const mouth = toClient(top);
    const a = toClient(top.clone().add(new Vector3(-0.26, 0, 0)));
    const b = toClient(top.clone().add(new Vector3(0.26, 0, 0)));
    const s0 = Math.min(0.4, Math.max(0.1, (Math.hypot(b.x - a.x, b.y - a.y) * 1.05) / f.width));
    return { f, c: { x: f.left + f.width / 2, y: f.top + f.height / 2 }, mouth, s0, hidden: mouth.y + (f.height * s0) / 2 + 6, out: mouth.y - (f.height * s0) / 2 - 10 };
  };
  const applyCard = (p: Card): void => {
    if (!E) return;
    gsap.set(form, { x: p.cx - E.c.x, y: p.cy - E.c.y, scale: p.s, rotation: p.r, transformOrigin: '50% 50%' });
    const cut = p.clip ? Math.max(0, (p.cy + (E.f.height * p.s) / 2 - E.mouth.y) / p.s) : 0;
    form.style.clipPath = cut > 0 ? `inset(0 0 ${cut}px 0)` : '';
  };
  /** Khung đã ở đúng chỗ: Khang vẫy chào, cặp dịu ánh sáng, bắt đầu tiếp khách. */
  const settle = (): void => {
    state.look = null;
    state.phase = 'idle';
    startWave(1.8);
    say(greeting(), 'good', 2600);
    gsap.to(dustMaterial, { opacity: 0.35, duration: 1.5 });
    gsap.to(bag.halo.material, { opacity: 0.45, duration: 1.5 });
    state.idleAt = performance.now();
    resolveReady();
  };
  const emergeForm = (): void => {
    if (formShown()) return settle();
    E = measure();
    const p: Card = { cx: E.mouth.x, cy: E.hidden, s: E.s0, r: 0, clip: true };
    gsap.set(form, { autoAlpha: 1 });
    form.classList.add('is-emerging');
    applyCard(p);
    state.look = 'bag';
    emergeTl = gsap.timeline({
      onUpdate: () => applyCard(p),
      onComplete: () => {
        emergeTl = null;
        gsap.set(form, { clearProps: 'transform' });
        form.style.clipPath = '';
        form.classList.remove('is-emerging');
        settle();
      },
    })
      .to(p, { cy: E.out, duration: 0.7, ease: 'power2.out' })
      .add(() => {
        p.clip = false;
        state.look = 'card';
      })
      .to(p, { cx: E.c.x, duration: 0.95, ease: 'power3.inOut' }, '>-0.05')
      .to(p, { cy: E.c.y, duration: 0.95, ease: 'power3.out' }, '<')
      .to(p, { s: 1, duration: 0.95, ease: 'power3.inOut' }, '<')
      .to(p, { keyframes: { r: [0, -6, 1.5, 0] }, duration: 0.95, ease: 'power1.inOut' }, '<');
  };
  const sinkForm = (): gsap.core.Timeline => {
    emergeTl?.kill();
    emergeTl = null;
    E = measure();
    const p: Card = { cx: E.c.x, cy: E.c.y, s: 1, r: 0, clip: false };
    form.classList.add('is-emerging');
    return gsap.timeline({
      onUpdate: () => applyCard(p),
      onComplete: () => {
        gsap.set(form, { autoAlpha: 0 });
        form.classList.remove('is-emerging');
      },
    })
      .to(p, { cx: E.mouth.x, duration: 0.8, ease: 'power3.inOut' })
      .to(p, { cy: E.out, duration: 0.8, ease: 'power3.in' }, '<')
      .to(p, { s: E.s0, duration: 0.8, ease: 'power3.inOut' }, '<')
      .to(p, { r: 6, duration: 0.8, ease: 'power2.inOut' }, '<')
      .add(() => {
        p.clip = true;
      })
      .to(p, { cy: E.hidden, r: 0, duration: 0.5, ease: 'power2.in' });
  };

  // ---------- Đầu nhìn theo, tay chỉ ----------
  const parentQ = new Quaternion();
  const look = { yaw: 0, pitch: 0 };
  const headAt = new Vector3();
  /** Góc quay đầu (so với hướng người đang đứng) để nhìn thẳng vào một điểm; giới hạn trong tầm cổ người thật. */
  const anglesTo = (point: Vector3): [number, number] => {
    head.getWorldPosition(headAt);
    const d = point.clone().sub(headAt);
    let yaw = Math.atan2(d.x, d.z) - model.rotation.y;
    yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    const pitch = Math.atan2(-d.y, Math.hypot(d.x, d.z));
    return [MathUtils.clamp(yaw, -1.15, 1.15), MathUtils.clamp(pitch, -0.45, 0.55)];
  };
  /** Đầu quay theo trục của cả người (không theo trục riêng của xương đầu). */
  const aimHead = (dt: number, time: number): void => {
    let yaw = 0;
    let pitch = 0;
    const calm = state.phase === 'idle' || state.phase === 'wave';
    if (state.look === 'bag') {
      yaw = 0.35;
      pitch = 0.45;
    } else if (state.look === 'card') {
      yaw = 0.7;
      pitch = 0.05;
    } else if (calm) {
      // Nhìn đúng vào điểm trên màn hình: ô đang chỉ, con trỏ chữ khi gõ, hoặc con trỏ chuột. Mật khẩu thì quay đi.
      if (state.point) [yaw, pitch] = anglesTo(state.pointTarget);
      else if (state.focus === 'password') {
        yaw = -1.05;
        pitch = 0.18;
      } else if ((state.focus === 'email' || state.focus === 'name') && state.caret) [yaw, pitch] = anglesTo(toWorld(state.caret.x, state.caret.y, 0.9));
      else if (state.lookAround) {
        yaw = Math.sin(time * 1.3) * 0.65;
        pitch = -0.05;
      } else if (state.cursor) [yaw, pitch] = anglesTo(toWorld(state.cursor.x, state.cursor.y, 1.2));
    }
    // Lắc đầu khi sai mật khẩu: dao động nhanh, tắt dần.
    if (state.shake > 0) {
      yaw += Math.sin(time * 13) * 0.3 * state.shake;
      state.shake = Math.max(0, state.shake - dt * 0.8);
    }
    // Gật nhẹ theo mỗi phím gõ.
    if (state.nod > 0) {
      pitch += Math.sin((1 - state.nod) * Math.PI) * 0.15;
      state.nod = Math.max(0, state.nod - dt * 3.5);
    }
    look.yaw = damp(look.yaw, yaw, 5, dt);
    look.pitch = damp(look.pitch, pitch, 5, dt);
    const right = new Vector3(1, 0, 0).applyQuaternion(model.quaternion);
    const world = new Quaternion().setFromAxisAngle(WORLD_UP, look.yaw).multiply(new Quaternion().setFromAxisAngle(right, look.pitch));
    head.parent?.getWorldQuaternion(parentQ);
    head.quaternion.premultiply(parentQ.clone().invert().multiply(world).multiply(parentQ));
  };

  const va = new Vector3();
  const vb = new Vector3();
  const pointAmount = { w: 0 };
  /** Xoay một đoạn tay cho xương con trỏ về điểm đích, pha theo `w` (0 = tư thế động tác, 1 = chỉ hẳn). */
  const bendToward = (segment: Object3D, child: Object3D, target: Vector3, w: number): void => {
    segment.getWorldPosition(va);
    child.getWorldPosition(vb);
    const delta = new Quaternion().setFromUnitVectors(vb.sub(va).normalize(), target.clone().sub(va).normalize());
    const partial = new Quaternion().slerp(delta, w);
    segment.parent?.getWorldQuaternion(parentQ);
    segment.quaternion.premultiply(parentQ.clone().invert().multiply(partial).multiply(parentQ));
    segment.updateMatrixWorld(true);
  };
  const aimArm = (dt: number): void => {
    pointAmount.w = damp(pointAmount.w, state.point ? 1 : 0, 6, dt);
    if (pointAmount.w < 0.01) return;
    // smoothstep: vào và ra đều mềm.
    const w = pointAmount.w * pointAmount.w * (3 - 2 * pointAmount.w);
    bendToward(upperArm, lowerArm, state.pointTarget, w);
    bendToward(lowerArm, wrist, state.pointTarget, w);
  };

  // Vẫy tay dựng thủ tục thay cho clip Wave gốc (clip đó có 4 khung hình nhảy giật ở khuỷu tay):
  // cánh tay trái giơ chếch lên, cẳng tay quạt qua lại, vào và ra đều mềm, trên nền dáng đứng Idle.
  const wave = { t: -1, dur: 1.8 };
  const startWave = (dur: number): void => {
    wave.t = 0;
    wave.dur = dur;
  };
  const smooth = (a: number, b: number, x: number): number => {
    const k = MathUtils.clamp((x - a) / (b - a), 0, 1);
    return k * k * (3 - 2 * k);
  };
  const aimWave = (dt: number): void => {
    if (wave.t < 0) return;
    wave.t += dt;
    if (wave.t > wave.dur) {
      wave.t = -1;
      return;
    }
    const env = smooth(0, 0.45, wave.t) * (1 - smooth(wave.dur - 0.6, wave.dur, wave.t));
    if (env < 0.001 || state.point) return;
    const right = new Vector3(1, 0, 0).applyQuaternion(model.quaternion);
    const forward = new Vector3(0, 0, 1).applyQuaternion(model.quaternion);
    const shoulder = upperArm.getWorldPosition(new Vector3());
    bendToward(upperArm, lowerArm, shoulder.addScaledVector(right, 0.32).addScaledVector(WORLD_UP, 0.34).addScaledVector(forward, 0.12), env);
    const elbow = lowerArm.getWorldPosition(new Vector3());
    const swing = Math.sin(wave.t * Math.PI * 2 * 1.6) * 0.2;
    bendToward(lowerArm, wrist, elbow.addScaledVector(WORLD_UP, 0.3).addScaledVector(right, swing).addScaledVector(forward, 0.08), env);
  };

  let pointTimer: ReturnType<typeof setTimeout> | undefined;
  const pointAt = (target: Element, ms: number): void => {
    const box = target.getBoundingClientRect();
    // Điện thoại: khung nằm ngay dưới chân — chỉ thẳng xuống trông như tay buông, chỉ về máy quay thì tay bị
    // co ngắn lại. Nên chỉ chéo xuống, sang phải, ra trước: nhìn rõ là đang chỉ về phía khung bên dưới.
    if (isNarrow()) state.pointTarget.set(model.position.x + 1.1, 0.7, 1.4);
    else state.pointTarget.copy(toWorld(box.left + box.width * 0.15, box.top + box.height / 2, 0.9));
    state.point = true;
    clearTimeout(pointTimer);
    pointTimer = setTimeout(() => (state.point = false), ms);
  };

  // Máy quay đã tiến sâu vào văn phòng thì báo trang đăng nhập chuyển vào trong.
  let onLeft: (() => void) | null = null;

  // ---------- Vòng vẽ ----------
  const clock = new Clock();
  const carryTurn = new Quaternion().setFromAxisAngle(WORLD_UP, Math.PI / 2);
  const carryQ = new Quaternion();
  const handPos = new Vector3();
  const headPos = new Vector3();
  let frameId = 0;
  const frame = (): void => {
    frameId = requestAnimationFrame(frame);
    // Chặn bước thời gian: máy chậm vẫn đi đúng nhịp, chỉ bỏ qua lần treo dài (đổi tab…).
    const dt = Math.min(clock.getDelta(), 0.5);
    const now = performance.now();
    const time = now / 1000;
    const t = (now - state.t0) / 1000;
    const walk = actions.get('Walk');
    switch (state.phase) {
      case 'walk': {
        // Chạy vào, còn ~1 m thì hãm sang đi, chậm dần khi gần tới chỗ đứng; nhịp chân theo đúng tốc độ để không
        // trượt. Vừa đi vừa xoay người về tư thế đón trong quãng cuối, tới nơi là cúi đặt cặp ngay — không đứng chờ.
        const dist = layout.standX - model.position.x;
        if (state.running && dist < BRAKE) {
          state.running = false;
          play('Walk', { fade: 0.35 });
        }
        const target = state.running ? RUN : WALK * MathUtils.clamp(dist / 0.8, 0.3, 1);
        state.speed = damp(state.speed, target, 6, dt);
        const v = state.speed;
        model.position.x = Math.min(layout.standX, model.position.x + v * dt);
        const run = actions.get('Run');
        if (state.running && run) run.timeScale = v / RUN;
        else if (walk) walk.timeScale = MathUtils.clamp(v / WALK, 0.3, 1.6);
        if (dist < 0.9) model.rotation.y = damp(model.rotation.y, layout.face, 4, dt);
        if (dist < 0.01) {
          state.phase = 'drop';
          state.t0 = now;
          play('Interact', { once: true, fade: 0.3 });
        }
        break;
      }
      case 'arrive':
        // Điện thoại: đứng sẵn, chỉ xoay người rồi đặt cặp.
        model.rotation.y = damp(model.rotation.y, layout.face, 4, dt);
        if (t > 0.45) {
          state.phase = 'drop';
          state.t0 = now;
          play('Interact', { once: true, fade: 0.3 });
        }
        break;
      case 'drop':
        model.rotation.y = damp(model.rotation.y, layout.face, 4, dt);
        // Động tác Interact là vươn tay ra trước: tay lên cao nhất ở 0,45 s rồi giữ. Thả cặp ngay đỉnh tay
        // (0,35 s) và rút tay về sớm (0,65 s) — không để tay treo lơ lửng chờ.
        if (state.bagMode === 'hand' && t > 0.35) releaseBag();
        if (t > 0.65 && !state.armBack) {
          state.armBack = true;
          play('Idle', { fade: 0.4 });
        }
        break;
      case 'wave':
      case 'idle': {
        // Đang chỉ tay thì xoay hẳn người về phía khung; xong thì về tư thế đón.
        model.rotation.y = damp(model.rotation.y, state.point ? 0.85 : layout.face, 3.5, dt);
        if (now - state.idleAt > IDLE_NUDGE_MS && !state.lookAround && !state.focus && !state.point && !bubble.dataset['on']) {
          state.lookAround = true;
          say('Anh cần em giúp gì không ạ?', 'info', 3000);
          later(3400, () => {
            state.lookAround = false;
            state.idleAt = performance.now();
          });
        }
        break;
      }
      case 'exit': {
        // Quay lưng về phía lối đi giữa hai dãy bàn rồi đi vào văn phòng ("máy quay tiến vào"); chưa quay
        // hẳn thì chưa bước (tránh trượt ngang). Nhịp bước theo tốc độ trượt trên sàn để chân không trượt.
        headingTo.subVectors(AISLE, model.position);
        const heading = headingTo.z < -0.3 || Math.abs(headingTo.x) > 0.3 ? Math.atan2(headingTo.x, headingTo.z) : Math.PI;
        model.rotation.y = damp(model.rotation.y, heading, 5, dt);
        const aligned = MathUtils.clamp(1 - Math.abs(heading - model.rotation.y) / 0.9, 0, 1);
        state.speed = damp(state.speed, WALK * 1.15 * aligned, 2.5, dt);
        model.position.x += Math.sin(model.rotation.y) * state.speed * dt;
        model.position.z += Math.cos(model.rotation.y) * state.speed * dt;
        if (walk) walk.timeScale = Math.max(0.6, state.speed / WALK);
        // Máy quay trượt theo sau lưng Khang vào giữa lối đi; gần tới nơi thì báo trang chuyển vào trong.
        camera.position.lerpVectors(camFrom, CAM_TO, state.push);
        camera.lookAt(lookNow.lerpVectors(lookFrom, LOOK_TO, state.push));
        if (state.push > 0.6 && !state.welcomed) {
          state.welcomed = true;
          onLeft?.();
        }
        break;
      }
      case 'leaving':
      case 'pickup':
        break;
    }
    for (const [b, q] of rest) b.quaternion.copy(q);
    mixer.update(dt);
    aimHead(dt, time);
    aimArm(dt);
    aimWave(dt);
    // Cặp: trong tay thì treo dưới cổ tay phải; lúc nhặt lên thì hoà dần từ sàn vào tay.
    if (state.bagMode !== 'free') {
      hand.getWorldPosition(handPos);
      handPos.y -= 0.2;
      carryQ.copy(model.quaternion).multiply(carryTurn);
      if (state.bagMode === 'hand') {
        bag.group.position.copy(handPos);
        bag.group.quaternion.copy(carryQ);
      } else {
        bag.group.position.lerpVectors(state.restPos, handPos, state.carry);
        bag.group.quaternion.slerpQuaternions(state.restQ, carryQ, state.carry);
      }
    }
    khangShadow.position.set(model.position.x, 0.004, model.position.z);
    bagShadow.position.set(bag.group.position.x, 0.005, bag.group.position.z + 0.02);
    bagShadow.material.opacity = (isDark() ? 0.9 : 0.45) * MathUtils.clamp(1 - (bag.group.position.y - 0.161) * 2.2, 0, 1);
    if (dustMaterial.opacity > 0.01) {
      const base = bag.group.position;
      for (let i = 0; i < DUST; i++) {
        const seed = dustSeed[i] ?? 0;
        const life = (time * 0.3 + seed) % 1;
        const angle = seed * 40 + time * 1.1;
        dustPos[i * 3] = base.x + Math.cos(angle) * 0.12 * (0.4 + life);
        dustPos[i * 3 + 1] = base.y + 0.15 + life * 1.1;
        dustPos[i * 3 + 2] = base.z + Math.sin(angle) * 0.08 * (0.4 + life);
      }
      dustGeo.attributes['position']!.needsUpdate = true;
    }
    if (bag.halo.material.opacity > 0.01) {
      const pulse = 1 + Math.sin(time * 2.4) * 0.06;
      bag.halo.scale.set(0.9 * pulse, 0.7 * pulse, 1);
      if (bag.beam.intensity > 0.1) bag.beam.intensity = 1.9 + Math.sin(time * 2.4) * 0.3;
    }
    // Bong bóng: bám theo đầu nhưng trôi mềm, không rung theo từng khung hình; không tràn ra ngoài khung.
    if (bubble.dataset['on']) {
      head.getWorldPosition(headPos);
      headPos.y += 0.42;
      const s = toCanvas(headPos);
      const canvasBox = canvas.getBoundingClientRect();
      // Bong bóng định vị theo phần tử cha có định vị gần nhất (trang <main>, vì sân khấu không định vị).
      const stageBox = (bubble.offsetParent ?? stage).getBoundingClientRect();
      const tx = Math.max(8, Math.min(canvasBox.left - stageBox.left + s.x - 14, stageBox.width - bubble.offsetWidth - 8));
      const ty = canvasBox.top - stageBox.top + s.y - bubble.offsetHeight - 14;
      if (!bub.placed) {
        bub.x = tx;
        bub.y = ty;
        bub.placed = true;
      }
      bub.x = damp(bub.x, tx, 10, dt);
      bub.y = damp(bub.y, ty, 10, dt);
      bubble.style.translate = `${bub.x}px ${bub.y}px`;
    } else bub.placed = false;
    updateOffice(office, dt, time, isDark());
    renderer.render(scene, camera);
  };
  frame();

  // ---------- Theo dõi người dùng trong khung đăng nhập ----------
  const greetOf = (target: EventTarget | null): string | null =>
    target instanceof Element ? (target.closest<HTMLElement>('[data-greet]')?.dataset['greet'] ?? null) : null;
  const touch = (): void => void (state.idleAt = performance.now());
  const onPointerMove = (event: PointerEvent): void => {
    touch();
    state.cursor = { x: event.clientX, y: event.clientY };
  };
  /** Vị trí con trỏ chữ trong ô nhập (toạ độ trình duyệt): đo bề rộng phần chữ đứng trước con trỏ. */
  const measure2d = document.createElement('canvas').getContext('2d');
  const caretOf = (input: HTMLInputElement): { x: number; y: number } | null => {
    if (!measure2d) return null;
    const cs = getComputedStyle(input);
    measure2d.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // Ô kiểu email không cho đọc vị trí con trỏ (trả null) — khi đó coi như con trỏ ở cuối chữ.
    const at = input.selectionEnd ?? input.value.length;
    const r = input.getBoundingClientRect();
    const x = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft) + measure2d.measureText(input.value.slice(0, at)).width - input.scrollLeft;
    return { x: Math.min(x, r.right - 10), y: r.top + r.height / 2 };
  };
  const isTextField = (kind: string | null): kind is 'email' | 'name' => kind === 'email' || kind === 'name';
  const trackCaret = (event: Event): void => {
    if (isTextField(greetOf(event.target)) && event.target instanceof HTMLInputElement) state.caret = caretOf(event.target);
  };
  const onFocusIn = (event: FocusEvent): void => {
    touch();
    const kind = greetOf(event.target);
    if (kind !== 'email' && kind !== 'password' && kind !== 'name') return;
    state.focus = kind;
    trackCaret(event);
    // Đang nhắc lỗi thì không chen câu chào ô.
    if (state.point) return;
    if (kind === 'email' && !(event.target as HTMLInputElement).value) say('Em xem anh gõ email nhé.', 'info', 1800);
    if (kind === 'password') say('Em quay đi, anh cứ nhập mật khẩu.', 'info', 2400);
  };
  const onFocusOut = (): void => {
    state.focus = null;
    state.caret = null;
  };
  const onInput = (event: Event): void => {
    if (isTextField(greetOf(event.target))) state.nod = 1;
    trackCaret(event);
  };
  // Caps Lock đang bật lúc gõ mật khẩu: nhắc ngay, trước khi bấm đăng nhập.
  const onKeyUp = (event: KeyboardEvent): void => {
    if (greetOf(event.target) === 'password' && event.getModifierState?.('CapsLock')) say('Anh ơi, Caps Lock đang bật đó!', 'warn', 2400);
    trackCaret(event);
  };
  const onClick = (event: MouseEvent): void => {
    // Bấm "Hiện" mật khẩu: Khang vẫn quay đi, không nhìn trộm.
    if (greetOf(event.target) === 'eye') say('Em nhắm mắt rồi nhé, không nhìn đâu!', 'info', 2200);
    trackCaret(event);
  };
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('keydown', touch);
  window.addEventListener('pointerdown', touch);
  form.addEventListener('focusin', onFocusIn);
  form.addEventListener('focusout', onFocusOut);
  form.addEventListener('input', onInput);
  form.addEventListener('keyup', onKeyUp);
  form.addEventListener('click', onClick);

  const shakeForm = (): void => {
    gsap.fromTo(form, { x: 0 }, { keyframes: { x: [0, -10, 8, -6, 4, -2, 0], easeEach: 'sine.inOut' }, duration: 0.55 });
  };

  return {
    say,
    remind(target, text) {
      void ready.then(() => {
        pointAt(target, 3200);
        say(text, 'warn', 3200);
      });
    },
    wrong(text) {
      void ready.then(() => {
        shakeForm();
        play('HitRecieve', { once: true, fade: 0.2, timeScale: 0.85 });
        state.shake = 1;
        say(text, 'bad', text.includes('/dashboard') ? 5000 : 3000);
      });
    },
    leave(onDone) {
      onLeft = onDone;
      state.phase = 'leaving';
      state.focus = null;
      state.point = false;
      state.welcomed = false;
      say('Chào mừng anh! Em dẫn anh vào nhé.', 'good', 1800);
      startWave(1.5);
      // Khung chui ngược vào cặp → đóng nắp → nhặt cặp → quay lưng đi vào văn phòng, máy quay tiến theo → vào trong.
      gsap.timeline()
        .add(sinkForm(), 0.35)
        .add(() => {
          state.look = 'bag';
        }, 0.35)
        .to(bag.lid.rotation, { x: 0, duration: 0.4, ease: 'power2.in' }, '>-0.05')
        .to([bag.inner.material, bag.halo.material, dustMaterial], { opacity: 0, duration: 0.35 }, '<')
        .to(bag.beam, { intensity: 0, duration: 0.35 }, '<')
        .add(() => {
          state.phase = 'pickup';
          play('Interact', { once: true, fade: 0.3 });
        }, '>-0.1')
        .add(() => {
          state.restPos.copy(bag.group.position);
          state.restQ.copy(bag.group.quaternion);
          state.carry = 0;
          state.bagMode = 'blend';
        }, '>+0.35')
        .to(state, { carry: 1, duration: 0.35, ease: 'power2.inOut', onComplete: () => void (state.bagMode = 'hand') })
        .add(() => {
          state.look = null;
          state.phase = 'exit';
          state.speed = 0;
          play('Walk', { fade: 0.45 });
          camFrom.copy(camera.position);
          lookFrom.copy(camLook);
          state.push = 0;
        })
        .to(state, { push: 1, duration: 2.8, ease: 'power2.inOut' }, '>+0.25');
    },
    dispose() {
      cancelAnimationFrame(frameId);
      for (const id of timers) clearTimeout(id);
      clearTimeout(bubbleTimer);
      clearTimeout(pointTimer);
      window.removeEventListener('resize', onResize);
      formWatch.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', touch);
      window.removeEventListener('pointerdown', touch);
      form.removeEventListener('focusin', onFocusIn);
      form.removeEventListener('focusout', onFocusOut);
      form.removeEventListener('input', onInput);
      form.removeEventListener('keyup', onKeyUp);
      form.removeEventListener('click', onClick);
      emergeTl?.kill();
      gsap.killTweensOf([form, state, bag.group.position, bag.group.scale, bag.lid.rotation, bag.beam, bag.inner.material, bag.halo.material, dustMaterial]);
      mixer.stopAllAction();
      for (const texture of [blobTex, ringTex, glowTex]) texture.dispose();
      office.mirror.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
