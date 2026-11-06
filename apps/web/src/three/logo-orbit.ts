/**
 * P&N — Dấu logo 3D "Quỹ đạo".
 *
 * Khối P và N đúc kim loại chuyển sắc (trắng ngọc → xanh ngọc → xanh dương), khoá
 * chung một thân chữ; hai vành sáng mảnh quay quanh ở hai góc nghiêng, mỗi vành
 * một hạt sáng chạy — công ty số đang vận hành. Rê chuột thì vành tăng tốc.
 *
 * Nét chữ lấy từ `components/morph-letters.ts` (cùng phông với tên công ty ở trang
 * đăng nhập) nên logo và chữ là một bộ. Nền trong suốt để đặt lên thanh bên, đầu
 * trang điện thoại hay bất cứ nền nào. Không hậu kỳ bloom (đắt với ô 36px): hạt sáng
 * là sprite cộng màu, chữ tự phát sáng nhẹ — đủ cảm giác toả sáng ở cỡ nhỏ.
 * Vẽ bằng three.js thuần; `components/Logo.tsx` bọc lại và lo phần dự phòng.
 */

import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Clock,
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  WebGLRenderer,
  type BufferGeometry,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

import { LETTER_N, LETTER_P } from '@/components/morph-letters';

export interface LogoOrbit {
  /** Rê chuột vào: vành quay nhanh; rời ra: chậm lại. */
  hover(on: boolean): void;
  dispose(): void;
}

const PALE = new Color('#e0fbf7');
const TEAL = new Color('#2dd4bf');
const BLUE = new Color('#3b82f6');

/** Dựng khối chữ từ đường nét SVG: đùn dày, vát mép, thu về đơn vị cảnh, lật trục y (SVG hướng xuống). */
function letterGeometry(path: string): BufferGeometry {
  const svg = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${path}"/></svg>`);
  const shapes = svg.paths.flatMap((item) => SVGLoader.createShapes(item));
  const geo = new ExtrudeGeometry(shapes, { depth: 42, bevelEnabled: true, bevelThickness: 4.5, bevelSize: 4.5, bevelSegments: 4, curveSegments: 10 });
  // Lật bằng phép quay thật chứ không scale âm: scale âm đảo mặt trước/sau làm chữ tối đen.
  geo.scale(0.01, 0.01, 0.01);
  geo.rotateX(Math.PI);
  geo.center();
  return geo;
}

/** Tô chuyển sắc theo trục x cho cả cụm chữ: mép trái trắng ngọc, giữa xanh ngọc, mép phải xanh dương. */
function paintGradient(geometries: BufferGeometry[], offsets: number[]): void {
  let min = Infinity;
  let max = -Infinity;
  geometries.forEach((geo, index) => {
    geo.computeBoundingBox();
    min = Math.min(min, geo.boundingBox!.min.x + offsets[index]!);
    max = Math.max(max, geo.boundingBox!.max.x + offsets[index]!);
  });
  const color = new Color();
  geometries.forEach((geo, index) => {
    const pos = geo.attributes['position']!;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i += 1) {
      const t = (pos.getX(i) + offsets[index]! - min) / (max - min);
      color.copy(PALE).lerp(TEAL, Math.min(1, t * 2)).lerp(BLUE, Math.max(0, t * 2 - 1));
      colors.set([color.r, color.g, color.b], i * 3);
    }
    geo.setAttribute('color', new BufferAttribute(colors, 3));
  });
}

/** Chấm sáng mềm cho hạt chạy trên vành. */
function glowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.3, 'rgba(255,255,255,.5)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Dựng logo vào `canvas` vuông cỡ `size` px (CSS). Ném lỗi nếu không có WebGL —
 * người gọi rơi về dấu SVG. Chỉ vẽ khi ô đang trong khung nhìn.
 */
export function createLogoOrbit(canvas: HTMLCanvasElement, size: number): LogoOrbit {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(size, size, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 9.6);

  scene.add(new HemisphereLight(0xffffff, 0x1b2a36, 0.5));
  const key = new DirectionalLight(0xffffff, 1.4);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(0x5eead4, 1.4);
  rim.position.set(4, 2, -3);
  scene.add(key, rim);

  const root = new Group();
  scene.add(root);

  // Khối chữ: P lệch trái ra trước, N lệch phải lùi sau — hai chữ khoá vào nhau chung thân.
  const p = letterGeometry(LETTER_P);
  const n = letterGeometry(LETTER_N);
  const offsets = [-0.4, 0.46];
  paintGradient([p, n], offsets);
  const metal = new MeshPhysicalMaterial({ vertexColors: true, metalness: 0.7, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.15, envMapIntensity: 1.2, emissive: 0x0b2a2f, emissiveIntensity: 0.6 });
  const P = new Mesh(p, metal);
  const N = new Mesh(n, metal);
  P.position.set(offsets[0]!, 0.06, 0.12);
  N.position.set(offsets[1]!, -0.06, -0.12);
  const mark = new Group();
  mark.add(P, N);
  mark.scale.setScalar(1.15);
  root.add(mark);

  // Hai vành sáng, mỗi vành một hạt chạy quanh.
  const glow = glowTexture();
  const ringMat = new MeshBasicMaterial({ color: 0x9ff5ea, transparent: true, opacity: 0.85 });
  const makeRing = (radius: number, tiltX: number, tiltZ: number): { group: Group; spark: Sprite; radius: number } => {
    const group = new Group();
    group.add(new Mesh(new TorusGeometry(radius, 0.02, 10, 128), ringMat));
    const spark = new Sprite(new SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, depthWrite: false, blending: AdditiveBlending }));
    spark.scale.set(0.55, 0.55, 1);
    group.add(spark);
    group.rotation.set(tiltX, 0, tiltZ);
    root.add(group);
    return { group, spark, radius };
  };
  const rings = [makeRing(1.9, 1.25, 0.3), makeRing(2.15, 1.05, -0.6)];

  // Tốc độ vành: rê chuột lên 3×, thả ra hạ dần — làm mượt mỗi khung hình, không cần thư viện tween.
  let speed = 1;
  let wantedSpeed = 1;
  let phase = 0;
  const clock = new Clock();
  let frameId = 0;
  let visible = true;

  const render = (): void => {
    frameId = requestAnimationFrame(render);
    if (!visible) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.getElapsedTime();
    speed += (wantedSpeed - speed) * Math.min(1, dt * 3);
    phase += dt * 0.9 * speed;
    rings.forEach((ring, index) => {
      const a = phase * (index ? -0.8 : 1) + index * 2;
      ring.spark.position.set(Math.cos(a) * ring.radius, Math.sin(a) * ring.radius, 0);
      ring.group.rotation.y += dt * 0.15 * speed * (index ? -1 : 1);
    });
    mark.rotation.y = Math.sin(t * 0.6) * 0.12;
    mark.position.y = Math.sin(t * 1.2) * 0.05;
    renderer.render(scene, camera);
  };

  // Ô cuộn khuất hay tab ẩn thì thôi vẽ — logo nằm trên mọi trang, không được ăn pin.
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
  });
  observer.observe(canvas);

  render();

  return {
    hover(on) {
      wantedSpeed = on ? 3.2 : 1;
    },
    dispose() {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      for (const geo of [p, n]) geo.dispose();
      metal.dispose();
      ringMat.dispose();
      glow.dispose();
      for (const ring of rings) {
        ring.spark.material.dispose();
        (ring.group.children[0] as Mesh).geometry.dispose();
      }
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
