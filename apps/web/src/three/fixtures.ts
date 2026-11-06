/** Hình học nội thất P&N: gộp chi tiết tĩnh theo màu để giảm số lệnh vẽ. */
import {
  BoxGeometry,
  BufferAttribute,
  Color,
  CylinderGeometry,
  SphereGeometry,
  type BufferGeometry,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Part = { geometry: BufferGeometry; color: string };
const cache = new Map<string, BufferGeometry>();

/** Ghép các mảnh có màu đỉnh thành một mô hình; vật liệu và bóng vẫn là 3D thật. */
function assemble(parts: Part[]): BufferGeometry {
  const pieces = parts.map(({ geometry, color }) => {
    const mesh = geometry.index ? geometry.toNonIndexed() : geometry;
    const shade = new Color(color);
    const rgb = new Float32Array(mesh.getAttribute('position').count * 3);
    for (let i = 0; i < rgb.length; i += 3) {
      rgb[i] = shade.r;
      rgb[i + 1] = shade.g;
      rgb[i + 2] = shade.b;
    }
    mesh.setAttribute('color', new BufferAttribute(rgb, 3));
    return mesh;
  });
  const merged = mergeGeometries(pieces)!;
  pieces.forEach((piece) => piece.dispose());
  parts.forEach(({ geometry }) => geometry.dispose());
  return merged;
}

/** Khối bo cạnh dùng cho mặt bàn, khung màn hình và nệm ghế. */
function box(
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: string,
  rounded = false,
): Part {
  const geometry = rounded
    ? new RoundedBoxGeometry(w, h, d, 2, Math.min(w, h, d, 0.22) * 0.23)
    : new BoxGeometry(w, h, d);
  return { geometry: geometry.translate(x, y, z), color };
}

/** Trụ tròn dùng cho chân ghế, cốc và thân cây. */
function cylinder(
  x: number,
  y: number,
  z: number,
  top: number,
  bottom: number,
  height: number,
  color: string,
): Part {
  return { geometry: new CylinderGeometry(top, bottom, height, 12).translate(x, y, z), color };
}

/** Mảng hữu cơ cho tán lá và các chi tiết trên khuôn mặt. */
function ellipsoid(
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  color: string,
): Part {
  return { geometry: new SphereGeometry(1, 12, 8).scale(sx, sy, sz).translate(x, y, z), color };
}

/** Mỗi loại nội thất chỉ tạo hình học một lần trong phiên WebGL. */
export function fixture(
  kind: 'desk' | 'chair' | 'plant' | 'server' | 'shelf' | 'table' | 'lamp',
  accent = '#637487',
): BufferGeometry {
  const key = kind + accent;
  const existing = cache.get(key);
  if (existing) return existing;
  const parts: Part[] = [];
  if (kind === 'desk') {
    parts.push(box(0, 1.22, 0, 2.65, 0.14, 1.25, '#c29b72', true));
    parts.push(box(0, 1.12, 0, 2.46, 0.08, 1.08, '#4a5054'));
    for (const x of [-1.1, 1.1]) {
      parts.push(box(x, 0.58, 0, 0.1, 1.1, 1.04, '#424d55', true));
      parts.push(box(x, 0.06, 0, 0.19, 0.12, 1.18, '#303b44', true));
    }
    parts.push(box(0, 1.33, -0.22, 0.53, 0.035, 0.4, '#354552', true));
    parts.push(box(0, 1.6, -0.28, 0.1, 0.55, 0.1, '#4c5f6e'));
    parts.push(box(0, 1.98, -0.32, 1.25, 0.77, 0.095, '#24313e', true));
    parts.push(box(0, 1.31, 0.3, 0.97, 0.045, 0.34, '#657582', true));
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 10; col++) {
        parts.push(
          box(-0.41 + col * 0.09, 1.341, 0.19 + row * 0.09, 0.065, 0.01, 0.065, '#d3d9da'),
        );
      }
    parts.push(ellipsoid(0.71, 1.335, 0.28, 0.09, 0.045, 0.14, '#283e4e'));
    parts.push(box(-0.92, 1.32, 0.21, 0.3, 0.045, 0.46, accent, true));
    parts.push(box(-0.92, 1.348, 0.21, 0.25, 0.01, 0.42, '#ebebe3'));
    parts.push(cylinder(1.04, 1.42, -0.17, 0.1, 0.08, 0.27, '#ece4d5'));
    parts.push(cylinder(1.04, 1.558, -0.17, 0.074, 0.074, 0.005, '#574039'));
    parts.push(box(0.94, 0.67, -0.05, 0.48, 0.66, 0.72, '#bbc6c8', true));
    for (const y of [0.45, 0.7, 0.93])
      parts.push(box(0.94, y, 0.325, 0.19, 0.025, 0.025, '#556874'));
  } else if (kind === 'chair') {
    parts.push(cylinder(0, 0.39, 0, 0.065, 0.095, 0.64, '#5c6b74'));
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5;
      const foot = box(0, 0.115, 0.22, 0.065, 0.06, 0.47, '#414f58');
      foot.geometry.rotateY(angle);
      parts.push(foot);
      parts.push(
        ellipsoid(
          Math.sin(angle) * 0.44,
          0.085,
          Math.cos(angle) * 0.44,
          0.08,
          0.085,
          0.085,
          '#253541',
        ),
      );
    }
    parts.push(box(0, 0.77, 0, 0.87, 0.18, 0.83, accent, true));
    parts.push(box(0, 1.23, 0.34, 0.83, 0.92, 0.17, accent, true));
    parts.push(box(0, 1.75, 0.34, 0.55, 0.22, 0.16, accent, true));
    for (const x of [-0.48, 0.48]) {
      parts.push(box(x, 1.05, 0.06, 0.06, 0.55, 0.06, '#465766'));
      parts.push(box(x, 1.3, 0.04, 0.13, 0.07, 0.56, '#586a78', true));
    }
    for (const y of [0.96, 1.11, 1.26, 1.41, 1.56])
      parts.push(box(0, y, 0.438, 0.66, 0.014, 0.006, '#89959b'));
  } else if (kind === 'plant') {
    parts.push(cylinder(0, 0.32, 0, 0.34, 0.23, 0.64, '#d6d4c9'));
    parts.push(cylinder(0, 0.66, 0, 0.29, 0.29, 0.025, '#4c4234'));
    parts.push(cylinder(0, 1.09, 0, 0.022, 0.04, 0.96, '#6e7654'));
    for (let i = 0; i < 9; i++) {
      const angle = i * 2.4;
      const leaf = ellipsoid(0, 0, 0, 0.16, 0.44, 0.065, i % 2 ? '#438866' : '#6c9b64');
      leaf.geometry
        .rotateZ(0.8)
        .rotateY(angle)
        .translate(Math.cos(angle) * 0.24, 0.91 + i * 0.09, Math.sin(angle) * 0.24);
      parts.push(leaf);
    }
  } else if (kind === 'server') {
    parts.push(box(0, 1.45, 0, 1.06, 2.9, 0.95, '#304354', true));
    parts.push(box(0, 1.45, 0.5, 0.91, 2.64, 0.05, '#1b2d3e'));
    for (let i = 0; i < 9; i++) {
      const y = 0.35 + i * 0.27;
      parts.push(box(0, y, 0.54, 0.81, 0.21, 0.035, '#4d6070', true));
      for (let k = 0; k < 5; k++)
        parts.push(box(-0.22 + k * 0.08, y, 0.564, 0.027, 0.115, 0.004, '#233647'));
      parts.push(box(0.28, y, 0.567, 0.038, 0.038, 0.008, i % 3 ? '#96d4c2' : '#f0ca76'));
    }
  } else if (kind === 'shelf') {
    parts.push(box(0, 1.35, -0.1, 2.6, 2.7, 0.15, '#c0a07d'));
    for (const x of [-1.3, 1.3]) parts.push(box(x, 1.35, 0.14, 0.09, 2.7, 0.56, '#d2b58f'));
    for (let row = 0; row < 4; row++) {
      const y = 0.12 + row * 0.67;
      parts.push(box(0, y, 0.16, 2.6, 0.075, 0.59, '#d2b58f'));
      for (let i = 0; i < 10; i++) {
        const colors = ['#647f92', '#b8a08c', '#869779', '#b18785', '#ded5bc'];
        parts.push(
          box(
            -1.1 + i * 0.23,
            y + 0.27,
            0.19,
            0.16,
            0.41 + (i % 3) * 0.055,
            0.31,
            colors[(i + row) % 5]!,
          ),
        );
      }
    }
  } else if (kind === 'table') {
    parts.push(box(0, 1.22, 0, 6.9, 0.18, 2.65, '#bd9770', true));
    parts.push(box(0, 1.325, 0, 5.9, 0.025, 1.9, '#465e67', true));
    for (const x of [-2.35, 2.35]) parts.push(box(x, 0.6, 0, 0.5, 1.2, 1.75, '#4f626d', true));
    for (const x of [-2.2, 0, 2.2])
      for (const z of [-0.8, 0.8]) {
        parts.push(box(x, 1.36, z, 0.49, 0.03, 0.42, '#e5e5dc'));
        parts.push(cylinder(x + 0.45, 1.45, z, 0.08, 0.07, 0.19, '#e6d9c5'));
      }
    parts.push(box(0, 1.39, 0, 0.75, 0.08, 0.4, '#293f4c', true));
  } else {
    parts.push(cylinder(0, 0.06, 0, 0.3, 0.3, 0.12, '#4b606b'));
    parts.push(cylinder(0, 1.18, 0, 0.028, 0.028, 2.25, '#a68d61'));
    parts.push(cylinder(0, 2.3, 0, 0.38, 0.63, 0.62, '#e5d8b9'));
  }
  const result = assemble(parts);
  cache.set(key, result);
  return result;
}

/** Gộp mắt, má và nét mặt; tay chân vẫn tách riêng để chuyển động. */
export function faceGeometry(skin: string): BufferGeometry {
  const key = 'face' + skin;
  const saved = cache.get(key);
  if (saved) return saved;
  const parts = [ellipsoid(0, 0, 0, 0.29, 0.31, 0.265, skin)];
  for (const x of [-0.103, 0.103]) {
    parts.push(ellipsoid(x, 0.008, -0.241, 0.044, 0.054, 0.026, '#f6f2e8'));
    parts.push(ellipsoid(x, 0.006, -0.264, 0.026, 0.034, 0.012, '#2d3542'));
    parts.push(ellipsoid(x - 0.007, 0.02, -0.274, 0.009, 0.012, 0.005, '#ffffff'));
    parts.push(box(x, 0.084, -0.25, 0.092, 0.021, 0.025, '#574439', true));
    parts.push(ellipsoid(x * 1.45, -0.068, -0.223, 0.047, 0.019, 0.01, '#d8937f'));
  }
  parts.push(ellipsoid(0, -0.04, -0.269, 0.034, 0.042, 0.038, skin));
  parts.push(box(0, -0.141, -0.232, 0.072, 0.013, 0.013, '#9d6858', true));
  for (const x of [-0.28, 0.28]) parts.push(ellipsoid(x, -0.005, 0, 0.047, 0.079, 0.052, skin));
  const model = assemble(parts);
  cache.set(key, model);
  return model;
}
