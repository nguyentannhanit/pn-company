/** Cảnh P&N mới: kiến trúc cắt mái ban ngày, bóng thật và camera điều hành từng phòng. */
'use client';
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  MOUSE,
  MathUtils,
  PCFSoftShadowMap,
  Plane,
  Raycaster,
  TOUCH,
  Vector2,
  Vector3,
  type OrthographicCamera,
} from 'three';
import type { Group } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { AgentRow } from '@/lib/api';
import { useRealtime } from '@/lib/store';
import { Block, Fixture } from './Furniture';
import { GuardFigure } from './Guard';
import { Couriers, type SeatOf } from './Courier';
import { LearningLayer } from './Learning';
import {
  FRONT_Z,
  LANE_X,
  LANE_Z,
  OFFICE_Y,
  ROOMS,
  SLAB_D,
  SLAB_W,
  STAIR,
  YARD_Y,
  deskSeats,
  personZ,
  roomOf,
} from './layout';
import { OfficeLobby } from './Reception';
import { RoomCard } from '@/components/RoomCard';
import { useBlocked, useTaskTitles } from '@/lib/insights';
import { onOpenRoom } from '@/lib/office-nav';
import type { Say } from './bubble';
import { Room } from './Room';
import { signTexture } from './textures';

/** Mặt tiền có kính, trụ đứng và mái che; khoảng sáng phía trong giữ chiều sâu. */
function Architecture(): React.JSX.Element {
  const sign = useMemo(() => signTexture('DIGITAL COMPANY', 'BUILD. LEARN. EVOLVE.'), []);
  return (
    <group>
      <Block at={[0, -0.27, 0]} size={[SLAB_W + 0.5, 0.58, SLAB_D + 0.5]} color="#9caeb6" soft />
      <Block
        at={[0, -OFFICE_Y / 2 - 0.3, 0]}
        size={[SLAB_W, OFFICE_Y, SLAB_D]}
        color="#556d7a"
        soft
      />
      <Block at={[0, 0.015, 0]} size={[SLAB_W - 0.22, 0.07, SLAB_D - 0.22]} color="#cad2ce" />
      <Block
        at={[0, -0.06, FRONT_Z + 0.22]}
        size={[SLAB_W + 0.68, 0.25, 0.8]}
        color="#ecede4"
        soft
      />
      {Array.from({ length: 18 }, (_, i) => -SLAB_W / 2 + 0.4 + (i * (SLAB_W - 3.4)) / 18).map(
        (x, i) => (
          <group key={i}>
            <Block at={[x, -1.48, FRONT_Z + 0.08]} size={[0.21, 2.42, 0.36]} color="#b4c0bf" />
            <mesh position={[x + 1.32, -1.47, FRONT_Z + 0.115]}>
              <planeGeometry args={[2.34, 1.92]} />
              <meshPhysicalMaterial
                color="#aac9ce"
                roughness={0.18}
                metalness={0.38}
                transparent
                opacity={0.53}
              />
            </mesh>
            <Block
              at={[x + 1.3, -1.5, FRONT_Z - 0.55]}
              size={[2.35, 1.7, 0.04]}
              color={i % 3 ? '#c0ab8a' : '#819d9f'}
            />
            <Block at={[x + 1.3, -2.57, FRONT_Z + 0.15]} size={[2.6, 0.08, 0.3]} color="#d6ddd8" />
          </group>
        ),
      )}
      <Block at={[0, -0.16, FRONT_Z + 1.08]} size={[12.5, 0.35, 2.1]} color="#f0ede1" soft />
      <Block at={[0, -0.61, FRONT_Z + 2.12]} size={[11.3, 0.94, 0.22]} color="#2f4653" soft />
      <mesh position={[0, -0.6, FRONT_Z + 2.245]}>
        <planeGeometry args={[10.7, 1.003]} />
        <meshBasicMaterial map={sign} toneMapped={false} />
      </mesh>
      <Block at={[0, -1.81, FRONT_Z + 0.35]} size={[4.5, 1.7, 0.12]} color="#263d4b" />
      {[-1.07, 1.07].map((x) => (
        <group key={x}>
          <mesh position={[x, -1.8, FRONT_Z + 0.44]}>
            <planeGeometry args={[2.08, 1.62]} />
            <meshPhysicalMaterial
              color="#acd5d6"
              metalness={0.42}
              roughness={0.12}
              transparent
              opacity={0.65}
            />
          </mesh>
          <Block
            at={[x / 8, -1.77, FRONT_Z + 0.54]}
            size={[0.055, 0.49, 0.065]}
            color="#e2d9bd"
            metal
          />
        </group>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <Block
          key={i}
          at={[0, -OFFICE_Y - 0.52 + i * 0.13, FRONT_Z + 3.2 - i * 0.43]}
          size={[12.2 - i * 0.4, 0.19, 1.1]}
          color="#cbd1c9"
          soft
        />
      ))}
      <OutdoorStair />
      {LANE_Z.map((z) => (
        <Block
          key={'horizontal' + z}
          at={[0, 0.068, z]}
          size={[SLAB_W - 0.5, 0.012, 0.13]}
          color="#f1ede0"
        />
      ))}
      {LANE_X.map((x) => (
        <Block
          key={'vertical' + x}
          at={[x, 0.067, 0]}
          size={[0.12, 0.012, SLAB_D - 0.5]}
          color="#f1ede0"
        />
      ))}
    </group>
  );
}

/**
 * Cầu thang ngoài trời dọc mặt tiền, từ sân lên sàn văn phòng: lối Khang mang
 * việc CEO giao từ quầy lễ tân lên các phòng. Số đo lấy từ `STAIR` để bậc thang
 * và đường đi của Khang (`Courier.tsx`) khớp nhau.
 */
function OutdoorStair(): React.JSX.Element {
  const rise = -YARD_Y;
  const run = STAIR.bottomX - STAIR.topX;
  return (
    <group>
      {Array.from({ length: STAIR.steps }, (_, i) => {
        const height = ((i + 1) * rise) / STAIR.steps;
        return (
          <Block
            key={i}
            at={[STAIR.bottomX - ((i + 0.5) * run) / STAIR.steps, YARD_Y + height / 2, STAIR.z]}
            size={[run / STAIR.steps + 0.01, height, STAIR.width]}
            color="#cbd1c9"
            soft
          />
        );
      })}
      {/* Chiếu nghỉ trên cùng, ngang sàn văn phòng, nối vào gờ mặt tiền. */}
      <Block at={[STAIR.topX - 0.6, YARD_Y + rise / 2, STAIR.z]} size={[1.2, rise, STAIR.width]} color="#cbd1c9" soft />
      {/* Tay vịn phía ngoài, chạy song song mặt dốc. */}
      <mesh
        position={[(STAIR.topX + STAIR.bottomX) / 2, YARD_Y + rise / 2 + 0.9, STAIR.z + STAIR.width / 2 - 0.05]}
        rotation={[0, 0, -Math.atan2(rise, run)]}
      >
        <boxGeometry args={[Math.hypot(run, rise), 0.07, 0.07]} />
        <meshStandardMaterial color="#8f9ea3" roughness={0.5} metalness={0.3} />
      </mesh>
    </group>
  );
}

/**
 * Hai bảo vệ đi tuần trước cửa, để mô hình luôn có nhịp sống chứ không
 * chỉ động khi có việc; bảo vệ là vai trò thật của một văn phòng, đi tuần là
 * việc của họ, nên đây không phải chuyển động giả (§9). Tắt khi calm.
 */
function Guards({ calm }: { calm: boolean }): React.JSX.Element {
  const guards = [
    // Đi nhanh cỡ người thật (~1.9 đơn vị/giây ở cỡ 3.2); chậm hơn thì clip bước bị kéo chậm như quay chậm.
    { x0: -8.5, x1: 8.5, z: FRONT_Z + 5.1, speed: 1.9, offset: 0 },
    { x0: 10.5, x1: -10.5, z: FRONT_Z + 6.3, speed: 1.7, offset: 7 },
  ];
  return (
    <>
      {guards.map((guard, i) => (
        <Guard key={i} {...guard} calm={calm} />
      ))}
    </>
  );
}

function Guard({
  x0, x1, z, speed, offset, calm,
}: { x0: number; x1: number; z: number; speed: number; offset: number; calm: boolean }): React.JSX.Element {
  const group = useRef<Group>(null);
  const moving = useRef(false);
  const length = Math.abs(x1 - x0);
  const period = length / speed + 2.4; // đi hết một chiều rồi đứng nhìn 1.2s mỗi đầu

  useFrame(({ clock }) => {
    if (!group.current || calm) return;
    const t = (clock.elapsedTime + offset) % (period * 2);
    const leg = t < period ? t : t - period; // 0..period trong một chiều
    const forward = t < period;
    const walk = Math.min(Math.max(leg - 1.2, 0) * speed, length); // đứng 1.2s ở đầu mỗi chiều
    const ratio = walk / length;
    const from = forward ? x0 : x1;
    const to = forward ? x1 : x0;
    group.current.position.x = from + (to - from) * ratio;
    // Nhân vật nhìn về -Z; quay theo hướng đi, lúc đứng thì quay mặt ra đường.
    moving.current = leg > 1.2 && walk < length;
    group.current.rotation.y = moving.current ? Math.atan2(-(to - from), 0) : Math.PI;
  });

  return (
    <group ref={group} position={[x0, 0.245, z]}>
      {/* Hai bảo vệ mặc đồ cảnh vệ: văn phòng luôn có người đi lại kể cả khi
          chưa có dự án nào chạy (§9 — đây là việc thật của họ, không phải hoạt cảnh). */}
      <GuardFigure moving={moving} speed={speed} calm={calm} />
    </group>
  );
}

/** Sân trước có bồn cây và mạch lát, cùng nhận bóng đổ từ kiến trúc. */
function Grounds(): React.JSX.Element {
  return (
    <group position={[0, -0.68, 0]}>
      <Block at={[0, 0.04, 1]} size={[SLAB_W + 8, 0.28, SLAB_D + 11]} color="#b3c1c4" soft />
      <Block at={[0, 0.2, FRONT_Z + 4.5]} size={[SLAB_W + 7, 0.05, 5.5]} color="#c9d0cb" />
      {Array.from({ length: 30 }, (_, i) => i).map((i) => (
        <Block
          key={i}
          at={[-SLAB_W / 2 - 2.8 + i * 2, 0.231, FRONT_Z + 4.4]}
          size={[0.02, 0.01, 5.5]}
          color="#aebcb9"
        />
      ))}
      {[-2.1, -0.15, 1.8].map((z) => (
        <Block
          key={z}
          at={[0, 0.234, FRONT_Z + 4.5 + z]}
          size={[SLAB_W + 6, 0.012, 0.025]}
          color="#acbcb9"
        />
      ))}
      {[-1, 1].flatMap((side) =>
        [-10, 0, 10].map((z) => (
          <group key={side + ':' + z} position={[side * (SLAB_W / 2 + 2.3), 0.22, z]}>
            <Block at={[0, 0.25, 0]} size={[1.8, 0.5, 3.4]} color="#6e858c" soft />
            <Block at={[0, 0.51, 0]} size={[1.6, 0.04, 3.1]} color="#5a6754" />
            {[-0.9, 0.9].map((p) => (
              <Fixture key={p} kind="plant" at={[0, 0.35, p]} scale={1.45} />
            ))}
          </group>
        )),
      )}
      {[-20, -12, 12, 20].map((x) => (
        <group key={x} position={[x, 0.22, FRONT_Z + 4.1]}>
          <Block at={[0, 0.28, 0]} size={[4.2, 0.56, 1.35]} color="#71898d" soft />
          <Block at={[0, 0.59, 0]} size={[3.95, 0.09, 1.17]} color="#92a180" />
          {[-1.2, 0, 1.2].map((p) => (
            <Fixture key={p} kind="plant" at={[p, 0.33, 0]} scale={0.81} />
          ))}
        </group>
      ))}
    </group>
  );
}

/** Hướng máy quay mặc định: nhìn từ trước-phải, chếch xuống. */
const HOME_DIRECTION = new Vector3(8, 39, 48);
/**
 * Xoay ngang chỉ trong khoảng ±55° quanh hướng mặc định. Phòng được cắt mái và
 * chỉ có tường sau, tường trái; xoay ra sau lưng thì tường che hết người bên trong.
 */
const HOME_AZIMUTH = Math.atan2(HOME_DIRECTION.x, HOME_DIRECTION.z);
const AZIMUTH_RANGE = 0.95;
/** Điểm nhìn chỉ đi trong phạm vi toà nhà và sân trước — dời quá tay cũng không lạc ra khoảng trống. */
const LOOK_BOUNDS = { minX: -SLAB_W / 2, maxX: SLAB_W / 2, minZ: -SLAB_D / 2, maxZ: FRONT_Z + 7 };
/** Mặt sàn văn phòng, nơi bấm đúp để lại gần. */
const OFFICE_FLOOR = new Plane(new Vector3(0, 1, 0), -OFFICE_Y);

/**
 * Camera tự ôm vừa khối nhà và chuyển nhẹ đến phòng được chọn.
 *
 * Điều khiển kiểu bản đồ (vì hay bị lệch khỏi chỗ đang nhìn):
 * kéo trái dời trên mặt sàn, kéo phải xoay, cuộn phóng tới đúng chỗ con trỏ,
 * bấm đúp lướt lại gần chỗ đó. Điện thoại: một ngón dời, hai ngón xoay/phóng.
 * Trước đây cuộn phóng vào giữa toà nhà, xoay quanh tâm toà nhà, và mỗi lần
 * khung trang đổi cỡ (mở khung trợ lý…) camera nhảy về toàn cảnh.
 */
function CameraRig({
  focus,
  reset,
  calm,
  spot,
}: {
  focus: string | null;
  reset: number;
  calm: boolean;
  /** Lướt tới một điểm trên sàn (bàn đang kẹt…); `key` đổi mỗi lần gọi. */
  spot: { x: number; z: number; key: number } | null;
}): React.JSX.Element {
  const camera = useThree((state) => state.camera) as OrthographicCamera;
  const size = useThree((state) => state.size);
  const gl = useThree((state) => state.gl);
  const controls = useRef<OrbitControlsImpl>(null);
  const goal = useRef({
    target: new Vector3(),
    position: new Vector3(10, 42, 52),
    zoom: 14,
    moving: true,
  });
  // Người xem đã tự chỉnh góc nhìn chưa; rồi thì đổi cỡ khung không kéo camera về toàn cảnh.
  const touched = useRef(false);
  const framed = useRef({ focus: undefined as string | null | undefined, reset: -1 });
  // Mức phóng của toàn cảnh; nhìn xa hơn ~1.45 lần mức này thì nhãn thu gọn.
  const homeZoom = useRef(14);
  const lod = useRef<'far' | 'near' | null>(null);

  useEffect(() => {
    const sameView = framed.current.focus === focus && framed.current.reset === reset;
    if (sameView && touched.current) return;
    framed.current = { focus, reset };
    touched.current = false;
    const room = focus ? roomOf(focus) : null;
    const target = room ? new Vector3(room.x, OFFICE_Y + 0.7, room.z) : new Vector3(0, 1.4, 1.8);
    const position = target.clone().add(HOME_DIRECTION);
    const previousPosition = camera.position.clone();
    camera.position.copy(position);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const w = room ? room.width + 2 : SLAB_W + 7;
    const d = room ? room.depth + 2 : SLAB_D + 10;
    const points = [-1, 1].flatMap((x) =>
      [-1, 1].flatMap((z) =>
        [0, room ? 4 : 7].map((y) =>
          new Vector3(target.x + (x * w) / 2, y, target.z + (z * d) / 2).applyMatrix4(
            camera.matrixWorldInverse,
          ),
        ),
      ),
    );
    const spanX = Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
    const spanY = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
    const zoom = Math.min(size.width / spanX, Math.max(180, size.height - 75) / spanY) * 0.97;
    if (!room) homeZoom.current = zoom;
    goal.current = { target, position, zoom, moving: true };
    camera.position.copy(previousPosition);
  }, [camera, size.width, size.height, focus, reset]);

  // Lướt tới một bàn cụ thể (nút Điểm nghẽn, "Xem trong 3D" từ tab Nhân sự): gần như khi chọn phòng.
  useEffect(() => {
    if (!spot) return;
    const target = new Vector3(spot.x, OFFICE_Y + 0.7, spot.z);
    goal.current = {
      target,
      position: target.clone().add(HOME_DIRECTION),
      zoom: homeZoom.current * 3.2,
      moving: true,
    };
    touched.current = true;
  }, [spot]);

  // Bấm đúp vào sàn: lướt tới giữa màn hình chỗ đó, lại gần gấp 1.8, giữ nguyên góc đang nhìn.
  useEffect(() => {
    const element = gl.domElement;
    const ray = new Raycaster();
    const onDoubleClick = (event: MouseEvent): void => {
      const c = controls.current;
      if (!c) return;
      const rect = element.getBoundingClientRect();
      const pointer = new Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      ray.setFromCamera(pointer, camera);
      const hit = ray.ray.intersectPlane(OFFICE_FLOOR, new Vector3());
      if (!hit) return;
      hit.x = MathUtils.clamp(hit.x, LOOK_BOUNDS.minX, LOOK_BOUNDS.maxX);
      hit.z = MathUtils.clamp(hit.z, LOOK_BOUNDS.minZ, LOOK_BOUNDS.maxZ);
      const offset = camera.position.clone().sub(c.target);
      goal.current = {
        target: hit,
        position: hit.clone().add(offset),
        zoom: Math.min(camera.zoom * 1.8, 60),
        moving: true,
      };
      touched.current = true;
    };
    element.addEventListener('dblclick', onDoubleClick);
    return () => element.removeEventListener('dblclick', onDoubleClick);
  }, [gl, camera]);

  useFrame((_, delta) => {
    const c = controls.current;
    if (!c) return;
    const g = goal.current;
    if (g.moving) {
      const k = calm ? 1 : 1 - Math.exp(-delta * 5);
      c.target.lerp(g.target, k);
      camera.position.lerp(g.position, k);
      camera.zoom = MathUtils.lerp(camera.zoom, g.zoom, k);
      camera.updateProjectionMatrix();
      c.update();
      if (Math.abs(camera.zoom - g.zoom) < 0.001 && c.target.distanceTo(g.target) < 0.001) g.moving = false;
    }
    // Nhìn xa thì nhãn phòng thu thành số + chấm màu (CSS đọc `data-lod`): ở toàn
    // cảnh 13 nhãn đầy đủ chồng lên nhau và che người.
    const nextLod = camera.zoom < homeZoom.current * 1.45 ? 'far' : 'near';
    if (nextLod !== lod.current) {
      lod.current = nextLod;
      gl.domElement.closest('.office-world')?.setAttribute('data-lod', nextLod);
    }
    // Giữ điểm nhìn trong toà nhà: dời cả điểm nhìn lẫn máy quay cùng một đoạn nên góc không đổi.
    const x = MathUtils.clamp(c.target.x, LOOK_BOUNDS.minX, LOOK_BOUNDS.maxX);
    const z = MathUtils.clamp(c.target.z, LOOK_BOUNDS.minZ, LOOK_BOUNDS.maxZ);
    if (x !== c.target.x || z !== c.target.z) {
      camera.position.x += x - c.target.x;
      camera.position.z += z - c.target.z;
      c.target.x = x;
      c.target.z = z;
    }
  });
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.09}
      // Dời trên mặt sàn (không theo mặt màn hình) nên điểm xoay luôn nằm trên sàn, không trôi lên xuống.
      screenSpacePanning={false}
      zoomToCursor
      mouseButtons={{ LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE }}
      touches={{ ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE }}
      minAzimuthAngle={HOME_AZIMUTH - AZIMUTH_RANGE}
      maxAzimuthAngle={HOME_AZIMUTH + AZIMUTH_RANGE}
      minPolarAngle={Math.PI / 7}
      maxPolarAngle={Math.PI / 2.5}
      minZoom={5}
      maxZoom={100}
      onStart={() => {
        goal.current.moving = false;
        touched.current = true;
      }}
    />
  );
}

/** Số liệu renderer chỉ được mở cho công cụ đo ở chế độ phát triển. */
function SceneProbe(): null {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const host = window as unknown as { __pnScene?: unknown };
    host.__pnScene = { gl, scene, camera };
    return () => {
      delete host.__pnScene;
    };
  }, [gl, scene, camera]);
  return null;
}

/** Cảnh chính và điều khiển camera; danh sách nhân viên lấy từ máy chủ. */
export function Office({
  agents,
  onSelect,
  calm = false,
  live = true,
  focusRole = null,
}: {
  agents: AgentRow[];
  onSelect: (role: string) => void;
  calm?: boolean;
  live?: boolean;
  /** Mở trang với camera ở bàn người này (từ nút "Xem trong 3D" ở tab Nhân sự). */
  focusRole?: string | null;
}): React.JSX.Element {
  const [focus, setFocus] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  // Thẻ phòng đang mở (mã phòng ban), và điểm camera cần lướt tới.
  const [card, setCard] = useState<string | null>(null);
  const [spot, setSpot] = useState<{ x: number; z: number; key: number } | null>(null);
  const [stop, setStop] = useState(0);
  const { items: blocked, reload: reloadBlocked } = useBlocked();
  const handoffs = useRealtime((s) => s.handoffs);
  const clearHandoff = useRealtime((s) => s.clearHandoff);
  const departments = useMemo(() => {
    const map = new Map<string, AgentRow[]>();
    agents.forEach((agent) => map.set(agent.department, [...(map.get(agent.department) ?? []), agent]));
    return map;
  }, [agents]);
  // Bàn của từng vai trò, xếp đúng như `Room.tsx` xếp (theo tên vai trò), để
  // người đưa việc đứng dậy đúng ghế và đi tới đúng bàn người nhận.
  const seatOf = useMemo<SeatOf>(() => {
    const map = new Map<string, NonNullable<ReturnType<SeatOf>>>();
    departments.forEach((list, department) => {
      const spec = roomOf(department);
      if (!spec) return;
      const sorted = [...list].sort((a, b) => a.role.localeCompare(b.role));
      const seats = deskSeats(spec, sorted.length);
      sorted.forEach((agent, index) => {
        const seat = seats[index];
        if (seat) map.set(agent.role, { spec, seat });
      });
    });
    return (role) => map.get(role) ?? null;
  }, [departments]);
  /** Mở phòng: phóng camera tới và mở thẻ phòng. */
  const openRoom = (department: string | null): void => {
    setFocus(department);
    setCard(department);
  };
  /** Lướt camera tới bàn một người và mở thẻ phòng của họ. */
  const goToDesk = (role: string): void => {
    const place = seatOf(role);
    if (!place) return;
    const z = place.spec.z + personZ(place.seat);
    setSpot({ x: place.spec.x + place.seat.x, z, key: Date.now() });
    setCard(place.spec.department);
  };
  // Cờ đỏ trên bàn người đang kẹt: lý do đã dịch; người kẹt mà chưa rõ lý do vẫn có cờ.
  const flags = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of blocked) if (item.role && !map.has(item.role)) map.set(item.role, item.explained.title);
    for (const agent of agents) {
      if ((agent.state === 'blocked' || agent.state === 'alert') && !map.has(agent.role)) map.set(agent.role, 'Bị chặn');
    }
    return map;
  }, [blocked, agents]);
  const stuckRoles = [...flags.keys()].filter((role) => seatOf(role));
  // Câu trong bong bóng trên đầu: việc đang làm, lý do kẹt.
  const titles = useTaskTitles(agents.map((agent) => agent.currentTaskId).filter((id): id is string => !!id));
  const says = useMemo(() => {
    const map = new Map<string, Say>();
    for (const agent of agents) {
      const title = agent.currentTaskId ? titles[agent.currentTaskId] : undefined;
      const reviewing = agent.state === 'reviewing' || (agent.state === 'working' && /QA|SECURITY|REVIEW|RED_TEAM/.test(agent.role));
      if (flags.has(agent.role)) map.set(agent.role, { kind: 'blocked', text: flags.get(agent.role)! });
      else if (agent.state === 'working' || agent.state === 'reviewing')
        map.set(agent.role, {
          kind: reviewing ? 'reviewing' : 'working',
          text: agent.progress ? `${title ?? 'Đang làm'} — ${agent.progress.text}` : (title ?? 'Đang nhận việc…'),
          ...(agent.progress ? { pct: agent.progress.pct } : {}),
        });
      else if (agent.state === 'meeting') map.set(agent.role, { kind: 'meeting', text: title ?? 'Họp bàn công việc' });
      else if (agent.state === 'celebrate' || agent.state === 'completed')
        map.set(agent.role, { kind: 'celebrate', text: title ?? 'Xong một việc' });
    }
    return map;
  }, [agents, titles, flags]);
  // Bấm tên phòng ở cột phải: lướt tới phòng đó và mở thẻ phòng. Tăng `reset` để
  // bấm lại đúng phòng đang xem (sau khi đã tự kéo camera đi chỗ khác) vẫn lướt về.
  useEffect(
    () =>
      onOpenRoom((department) => {
        openRoom(department);
        setReset((r) => r + 1);
      }),
    [],
  );
  const agentsReady = agents.length > 0;
  useEffect(() => {
    if (focusRole && agentsReady) goToDesk(focusRole);
    // Chỉ chạy khi trang mở với một người cụ thể (và danh sách đã về), không chạy lại mỗi lần danh sách đổi.
  }, [focusRole, agentsReady]);
  const departmentOfRole = useMemo(() => {
    const map = new Map(agents.map((a) => [a.role, a.department]));
    return (role: string): string | null => map.get(role) ?? null;
  }, [agents]);

  return (
    <div className={`office-world ${focus ? 'has-focus' : ''}`}>
      <Canvas
        shadows={{ type: PCFSoftShadowMap }}
        dpr={[1, 1.5]}
        orthographic
        camera={{ position: [8, 40, 50], zoom: 14, near: 0.1, far: 300 }}
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          toneMapping: ACESFilmicToneMapping,
          toneMappingExposure: 1,
        }}
      >
        <SceneProbe />
        <CameraRig focus={focus} reset={reset} calm={calm} spot={spot} />
        <color attach="background" args={['#c2d0d5']} />
        <hemisphereLight args={['#e1eff9', '#b1a080', 1.25]} />
        <ambientLight intensity={0.2} />
        <directionalLight
          position={[-20, 42, 24]}
          color="#fff0d4"
          intensity={2.6}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-43}
          shadow-camera-right={43}
          shadow-camera-top={37}
          shadow-camera-bottom={-37}
          shadow-camera-near={1}
          shadow-camera-far={110}
          shadow-bias={-0.00015}
          shadow-normalBias={0.04}
          shadow-radius={3}
        />
        <directionalLight position={[30, 22, -30]} color="#c5e5fc" intensity={0.8} />
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.84, 0]} receiveShadow>
          <planeGeometry args={[500, 500]} />
          <meshStandardMaterial color="#b4c4cb" roughness={1} />
        </mesh>
        <Grounds />
        <group position={[0, -0.68, 0]}>
          <Guards calm={calm} />
          {/* Khang — trợ lý lễ tân trước cửa; bấm vào là mở khung hỏi đáp. */}
          <Suspense fallback={null}>
            <OfficeLobby calm={calm} />
          </Suspense>
        </group>
        <group position={[0, OFFICE_Y, 0]}>
          <Architecture />
          {ROOMS.map((spec) => (
            <Room
              key={spec.department}
              spec={spec}
              agents={departments.get(spec.department) ?? []}
              onSelect={onSelect}
              onFocus={openRoom}
              says={says}
              calm={calm || !live}
            />
          ))}
          <Couriers
            handoffs={live ? handoffs : []}
            departmentOfRole={departmentOfRole}
            seatOf={seatOf}
            onArrive={clearHandoff}
            calm={calm}
          />
          <LearningLayer calm={calm} live={live} />
        </group>
      </Canvas>
      <div className="office-view-controls">
        <button
          onClick={() => {
            setFocus(null);
            setCard(null);
            setReset((r) => r + 1);
          }}
          title="Trở về góc nhìn toàn công ty"
        >
          <span>⌂</span> Toàn cảnh
        </button>
        <span className="office-control-divider" />
        <label>
          Phòng{' '}
          <select
            aria-label="Phóng to phòng ban"
            value={focus ?? ''}
            onChange={(event) => openRoom(event.target.value || null)}
          >
            <option value="">Tất cả phòng ban</option>
            {ROOMS.map((room) => (
              <option key={room.department} value={room.department}>
                {room.number} · {room.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {/* Điểm nghẽn: mỗi lần bấm lướt tới bàn kẹt kế tiếp, mở thẻ phòng có lý do và nút chạy lại. */}
      {stuckRoles.length > 0 && (
        <button
          type="button"
          className="office-bottleneck"
          onClick={() => {
            goToDesk(stuckRoles[stop % stuckRoles.length]!);
            setStop((value) => value + 1);
          }}
          title="Lướt tới từng bàn đang kẹt"
        >
          <span>⚑</span> Điểm nghẽn <b>{stuckRoles.length}</b>
          {stop > 0 && <small>{((stop - 1) % stuckRoles.length) + 1}/{stuckRoles.length}</small>}
        </button>
      )}
      {card && roomOf(card) && (
        <RoomCard
          room={roomOf(card)!}
          agents={departments.get(card) ?? []}
          blocked={blocked.filter((item) => item.role && departmentOfRole(item.role) === card)}
          onClose={() => setCard(null)}
          onSelectAgent={(role) => {
            goToDesk(role);
            onSelect(role);
          }}
          onChanged={reloadBlocked}
        />
      )}
      <div className="office-camera-hint">
        Kéo để dời · Chuột phải kéo để xoay · Cuộn phóng tới chỗ con trỏ · Bấm đúp để lại gần
      </div>
    </div>
  );
}
