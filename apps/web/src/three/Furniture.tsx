/** Nội thất mới: các cụm tĩnh gộp hình học, màn hình và vật liệu tách theo trạng thái. */
'use client';
import { useMemo, type Ref } from 'react';
import { BoxGeometry, MeshStandardMaterial, type Mesh } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { fixture } from './fixtures';
import { SEAT_BACK } from './layout';
import { screenTexture, type ScreenKind } from './textures';

const square = new BoxGeometry(1, 1, 1);
const rounded = new RoundedBoxGeometry(1, 1, 1, 2, 0.08);
const surfaces = new Map<string, MeshStandardMaterial>();
const fixtureSurface = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.7,
  metalness: 0.08,
});
const serverSurface = new MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.45,
  metalness: 0.35,
});

/** Vật liệu dùng lại cho các chi tiết kiến trúc cùng màu. */
function surface(color: string, metal = false): MeshStandardMaterial {
  const key = color + metal;
  if (!surfaces.has(key))
    surfaces.set(
      key,
      new MeshStandardMaterial({
        color,
        roughness: metal ? 0.36 : 0.68,
        metalness: metal ? 0.5 : 0.04,
      }),
    );
  return surfaces.get(key)!;
}

/** Khối kiến trúc có bóng; bo cạnh chỉ bật với những phần cần thấy độ dày. */
export function Block({
  at = [0, 0, 0],
  size,
  color,
  soft = false,
  metal = false,
}: {
  at?: [number, number, number];
  size: [number, number, number];
  color: string;
  soft?: boolean;
  metal?: boolean;
}): React.JSX.Element {
  return (
    <mesh
      position={at}
      scale={size}
      geometry={soft ? rounded : square}
      material={surface(color, metal)}
      castShadow
      receiveShadow
      dispose={null}
    />
  );
}

/** Một lệnh vẽ cho cả mô hình bàn, ghế hoặc chậu cây nhiều chi tiết. */
export function Fixture({
  kind,
  at = [0, 0, 0],
  rotation = 0,
  accent,
  scale = 1,
  ref,
}: {
  kind: Parameters<typeof fixture>[0];
  at?: [number, number, number];
  rotation?: number;
  accent?: string;
  scale?: number;
  ref?: Ref<Mesh>;
}): React.JSX.Element {
  const geometry = useMemo(() => fixture(kind, accent), [kind, accent]);
  return (
    <mesh
      ref={ref}
      position={at}
      rotation={[0, rotation, 0]}
      scale={scale}
      geometry={geometry}
      material={kind === 'server' ? serverSurface : fixtureSurface}
      castShadow
      receiveShadow
      dispose={null}
    />
  );
}

/** Màn hình hướng vào phòng, phát sáng vừa đủ để không cháy chi tiết. */
export function Screen({
  at,
  width = 1.14,
  kind = 'code',
  active = false,
}: {
  at: [number, number, number];
  width?: number;
  kind?: ScreenKind;
  active?: boolean;
}): React.JSX.Element {
  const map = useMemo(() => screenTexture(kind, active), [kind, active]);
  return (
    <mesh position={at}>
      <planeGeometry args={[width, width * 0.5625]} />
      <meshBasicMaterial map={map} toneMapped={false} color={active ? '#ffffff' : '#9aaeba'} />
    </mesh>
  );
}

/**
 * Bàn làm việc gồm màn hình, bàn phím, sổ và cốc; ghế nằm ở phía nhân viên.
 * `chairRef`: người ngồi xoay ghế lúc rảnh thì ghế xoay theo (`Employee.tsx`).
 */
export function Workstation({
  at,
  accent,
  active = false,
  kind = 'code',
  chair = true,
  chairRef,
}: {
  at: [number, number, number];
  accent: string;
  active?: boolean;
  kind?: ScreenKind;
  chair?: boolean;
  chairRef?: Ref<Mesh>;
}): React.JSX.Element {
  return (
    <group position={at}>
      <Fixture kind="desk" accent={accent} />
      <Screen at={[0, 1.98, -0.266]} active={active} kind={kind} />
      {chair && <Fixture ref={chairRef} kind="chair" at={[0, 0, SEAT_BACK]} accent={accent} />}
    </group>
  );
}

/** Bảng kế hoạch có khung nhôm và các thẻ công việc trang trí. */
export function Board({
  at,
  width = 4.6,
  kind = 'kanban',
  active = false,
}: {
  at: [number, number, number];
  width?: number;
  kind?: ScreenKind;
  active?: boolean;
}): React.JSX.Element {
  return (
    <group position={at}>
      <Block size={[width + 0.18, width * 0.5625 + 0.18, 0.13]} color="#394f5c" soft metal />
      <Screen at={[0, 0, 0.075]} width={width} kind={kind} active={active} />
      <Block
        at={[0, -width * 0.28125 - 0.14, 0.14]}
        size={[width + 0.16, 0.045, 0.35]}
        color="#8c9da4"
        metal
      />
    </group>
  );
}

/** Thanh đèn kiến trúc gắn tường, sáng cả khi phòng chưa nhận việc. */
export function LightStrip({
  at,
  width,
}: {
  at: [number, number, number];
  width: number;
}): React.JSX.Element {
  return (
    <group position={at}>
      <Block size={[width, 0.095, 0.2]} color="#66777b" metal />
      <mesh position={[0, -0.01, 0.105]}>
        <planeGeometry args={[width - 0.1, 0.045]} />
        <meshBasicMaterial color="#fff0c8" toneMapped={false} />
      </mesh>
    </group>
  );
}
