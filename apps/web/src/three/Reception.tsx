/**
 * P&N — Quầy lễ tân và nhân viên trợ lý 3D (Khang).
 *
 * Nhân viên là mô hình người thật tỉ lệ (không dùng nhân vật khối đầu to của
 * văn phòng — phóng cận thì lộ thô), có động tác sẵn: chờ, thao tác, vẫy chào.
 * Mô hình: bộ "Ultimate Modular Men" của Quaternius (CC0), tải từ poly.pizza
 * vào `public/models/`. Cùng một nhân viên đứng ở hai nơi: cận cảnh
 * trong khung hỏi đáp (`ReceptionStage`) và ở sân trước văn phòng 3D
 * (`OfficeLobby` — bấm vào là mở khung).
 */
'use client';
import { Html, useAnimations, useGLTF } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACESFilmicToneMapping,
  BoxGeometry,
  CanvasTexture,
  IcosahedronGeometry,
  LoopOnce,
  LoopRepeat,
  PCFShadowMap,
  SRGBColorSpace,
  type AnimationAction,
  type Group,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { openAssistant } from '@/lib/assistant';
import { useHuman } from './human';
import { LOBBY_Z } from './layout';
import { RECEPTIONIST_ROLE, awayFromDesk } from './presence';

/** Nhân viên trợ lý — mẫu B được chọn trong hai mẫu đã dựng. */
export const RECEPTIONIST = {
  name: 'Khang',
  title: 'Thư ký điều hành',
  model: '/models/le-tan-nam.glb',
  /** Màu điểm nhấn: dải đèn dưới gờ quầy và vạch trên biển P&N — xanh ngọc như logo. */
  accent: '#5eead4',
};
useGLTF.preload(RECEPTIONIST.model);

/** Trạng thái của trợ lý trong khung hỏi đáp. */
export type AssistantMood = 'idle' | 'thinking' | 'answering' | 'done' | 'error';

/** Động tác cho từng trạng thái; `once` chạy một lần rồi về tư thế chờ. */
const CLIPS: Record<AssistantMood, { clip: string; once?: boolean }> = {
  idle: { clip: 'Idle_Neutral' },
  thinking: { clip: 'Interact' },
  answering: { clip: 'Idle' },
  done: { clip: 'Wave', once: true },
  error: { clip: 'HitRecieve_2', once: true },
};
const REST = 'Idle_Neutral';
/** Cao trong ô cận cảnh của khung hỏi đáp. */
const HEIGHT = 1.75;
/**
 * Cao ở sân văn phòng: bằng nhân viên phòng ban và bảo vệ (3.2). Trước đây
 * Khang ở sảnh cao 1.75, đứng cạnh bảo vệ như trẻ con, và khi mang việc vào
 * văn phòng thì sẽ "lớn vọt" thành cỡ nhân viên.
 */
const YARD_HEIGHT = 3.2;
const YARD_SCALE = YARD_HEIGHT / HEIGHT;

// Tên clip trong file có tiền tố khung xương ("CharacterArmature|Wave").
const clipName = (short: string): string => `CharacterArmature|${short}`;

/** Nhân viên đứng tại gốc toạ độ, mặt hướng +Z; đổi động tác mượt khi trạng thái đổi. */
export function Staff({
  mood,
  calm = false,
  height = HEIGHT,
}: {
  mood: AssistantMood;
  calm?: boolean;
  height?: number;
}): React.JSX.Element {
  const { animations } = useGLTF(RECEPTIONIST.model);
  const { model, scale } = useHuman(RECEPTIONIST.model, height);

  const root = useRef<Group>(null);
  const { actions, mixer } = useAnimations(animations, root);
  const current = useRef<AnimationAction | null>(null);

  useEffect(() => {
    const play = (short: string, once = false): void => {
      const next = actions[clipName(short)];
      if (!next || next === current.current) return;
      next.reset();
      next.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
      next.clampWhenFinished = once;
      next.fadeIn(0.35).play();
      current.current?.fadeOut(0.35);
      current.current = next;
    };
    const { clip, once } = CLIPS[mood];
    play(clip, once);
    if (!once) return;
    // Chạy xong động tác một lần thì về tư thế chờ.
    const onFinished = (): void => play(REST);
    mixer.addEventListener('finished', onFinished);
    return () => mixer.removeEventListener('finished', onFinished);
  }, [mood, actions, mixer]);

  // Văn phòng ở chế độ tĩnh thì nhân viên cũng đứng yên như mọi người khác.
  useEffect(() => {
    mixer.timeScale = calm ? 0 : 1;
  }, [calm, mixer]);

  return (
    <group ref={root} scale={scale}>
      <primitive object={model} />
    </group>
  );
}

// Hình học dùng chung cho các khối kiến trúc của quầy.
const square = new BoxGeometry(1, 1, 1);
const rounded = new RoundedBoxGeometry(1, 1, 1, 3, 0.06);
const leafShape = new IcosahedronGeometry(1, 1);

/** Khối có bóng; `glow` cho dải đèn tự phát sáng. */
function Slab({
  at,
  size,
  color,
  round = false,
  glow = false,
  shadow = true,
  roughness = 0.6,
}: {
  at: [number, number, number];
  size: [number, number, number];
  color: string;
  round?: boolean;
  glow?: boolean;
  shadow?: boolean;
  roughness?: number;
}): React.JSX.Element {
  return (
    <mesh position={at} scale={size} geometry={round ? rounded : square} castShadow={shadow} receiveShadow>
      <meshStandardMaterial
        color={color}
        roughness={roughness}
        emissive={glow ? color : '#000000'}
        emissiveIntensity={glow ? 2 : 0}
      />
    </mesh>
  );
}

/** Biển P&N vẽ lên canvas: tên, dòng "Quầy trợ lý" và khẩu hiệu. */
function Sign({ accent }: { accent: string }): React.JSX.Element {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#10212d';
    ctx.fillRect(0, 0, 512, 160);
    ctx.fillStyle = '#f3efe4';
    ctx.font = 'bold 84px "Be Vietnam Pro", sans-serif';
    ctx.fillText('P&N', 36, 104);
    ctx.fillStyle = accent;
    ctx.fillRect(250, 58, 4, 52);
    ctx.fillStyle = '#9fb3bf';
    ctx.font = '26px "Be Vietnam Pro", sans-serif';
    ctx.fillText('Quầy trợ lý', 274, 78);
    ctx.fillText('Build. Learn. Evolve.', 274, 112);
    const map = new CanvasTexture(canvas);
    map.colorSpace = SRGBColorSpace;
    return map;
  }, [accent]);
  return (
    <group position={[-1.3, 1.9, -1.38]}>
      <mesh>
        <planeGeometry args={[1.15, 0.36]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      <Slab at={[0, -0.21, -0.01]} size={[1.15, 0.02, 0.02]} color={accent} glow shadow={false} />
    </group>
  );
}

/** Quầy gỗ sồi nan dọc, mặt đá kem, dải đèn màu nhấn dưới gờ. Gốc ở chân quầy, mặt trước hướng +Z. */
function Counter({ accent }: { accent: string }): React.JSX.Element {
  const deskH = 0.95;
  return (
    <group>
      <Slab at={[0, deskH / 2, 0]} size={[2.4, deskH, 0.4]} color="#c29b72" round />
      {Array.from({ length: 19 }, (_, i) => (
        <Slab key={i} at={[(i - 9) * 0.12, deskH / 2 - 0.02, 0.205]} size={[0.035, deskH - 0.14, 0.02]} color="#a67f58" shadow={false} />
      ))}
      <Slab at={[0, deskH + 0.02, 0]} size={[2.5, 0.04, 0.5]} color="#efe9dd" round roughness={0.35} />
      <Slab at={[0, deskH - 0.02, 0.255]} size={[2.5, 0.02, 0.01]} color={accent} glow shadow={false} />
    </group>
  );
}

/** Sảnh lễ tân cận cảnh: tường ốp nan, biển P&N, chậu cây và quầy. */
function Lobby({ accent }: { accent: string }): React.JSX.Element {
  return (
    <group>
      <Slab at={[0, 1.6, -1.5]} size={[6, 3.4, 0.1]} color="#233a49" shadow={false} />
      {Array.from({ length: 13 }, (_, i) => (
        <Slab key={i} at={[(i - 6) * 0.34, 1.6, -1.44]} size={[0.05, 3.4, 0.03]} color="#2b4556" shadow={false} />
      ))}
      <Sign accent={accent} />
      <Slab at={[0, 0.02, 0]} size={[8, 0.04, 6]} color="#cfc7b8" />
      {/* Chậu cây góc phải cho cảnh có tầng trước – sau. */}
      <Slab at={[1.55, 0.3, -0.6]} size={[0.36, 0.6, 0.36]} color="#e7e1d4" round />
      {(
        [
          [1.55, 0.95, -0.6, 0.28],
          [1.45, 1.2, -0.55, 0.22],
          [1.66, 1.15, -0.68, 0.2],
          [1.52, 1.42, -0.62, 0.17],
        ] as const
      ).map(([x, y, z, r]) => (
        <mesh key={y} geometry={leafShape} position={[x, y, z]} scale={r} castShadow>
          <meshStandardMaterial color="#4f7d5c" roughness={0.8} flatShading />
        </mesh>
      ))}
      <group position={[0, 0, 0.8]}>
        <Counter accent={accent} />
      </group>
    </group>
  );
}

/** Sân khấu cận cảnh cho khung hỏi đáp: nhân viên sau quầy, ánh sáng ba điểm. */
export function ReceptionStage({ mood }: { mood: AssistantMood }): React.JSX.Element {
  return (
    <Canvas
      shadows={{ type: PCFShadowMap }}
      dpr={[1, 1.5]}
      // Ô trong khung hỏi đáp thấp (150px) nên máy quay đứng gần, ngang vai: thấy mặt và cử chỉ tay.
      camera={{ position: [0.4, 1.42, 2.7], fov: 24, near: 0.1, far: 40 }}
      onCreated={({ camera }) => camera.lookAt(0, 1.32, 0)}
      gl={{ antialias: true, toneMapping: ACESFilmicToneMapping }}
    >
      <color attach="background" args={['#1c3140']} />
      <hemisphereLight args={['#e7f1fa', '#6b5a44', 1]} />
      <directionalLight
        position={[-2.5, 4, 4]}
        color="#fff1dc"
        intensity={2.6}
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-normalBias={0.03}
      />
      {/* Đèn viền lạnh phía sau tách người khỏi tường; đèn phụ phía trước làm sáng mặt. */}
      <directionalLight position={[2.5, 3, -3]} color="#9fd4ff" intensity={2.2} />
      <directionalLight position={[1.5, 1.8, 5]} color="#ffffff" intensity={1.1} />
      <Lobby accent={RECEPTIONIST.accent} />
      {/* Mô hình tải qua mạng; trong lúc chờ vẫn thấy quầy. */}
      <Suspense fallback={null}>
        <group position={[0, 0, 0.35]}>
          <Staff mood={mood} />
        </group>
      </Suspense>
    </Canvas>
  );
}

/**
 * Khang ở sân trước văn phòng 3D, sau quầy nhỏ ngay trước cửa toà nhà. Bấm vào
 * là vẫy tay và mở khung hỏi đáp — đúng việc của lễ tân, không phải trang trí (§9).
 * Toạ độ theo nhóm mặt đất của Office (cùng cao độ với bảo vệ đi tuần).
 */
export function OfficeLobby({ calm }: { calm: boolean }): React.JSX.Element {
  const [mood, setMood] = useState<AssistantMood>('idle');
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // Khang đang mang việc CEO giao lên văn phòng thì quầy vắng người.
  const person = useRef<Group>(null);
  useFrame(() => {
    if (person.current) person.current.visible = !awayFromDesk.has(RECEPTIONIST_ROLE);
  });

  const greet = (): void => {
    setMood('done');
    // Vẫy xong về tư thế chờ để lần bấm sau lại vẫy được.
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMood('idle'), 2600);
    openAssistant();
  };

  return (
    <group
      position={[0, 0.245, LOBBY_Z]}
      onClick={(event) => {
        event.stopPropagation();
        greet();
      }}
    >
      <group ref={person}>
        <Suspense fallback={null}>
          <Staff mood={mood} calm={calm} height={YARD_HEIGHT} />
        </Suspense>
      </group>
      {/* Quầy sát trước người; xa hơn thì chạm đường tuần của bảo vệ (FRONT_Z + 5.1). */}
      <group position={[0, 0, 1]} scale={YARD_SCALE}>
        <Counter accent={RECEPTIONIST.accent} />
      </group>
      {/* Nhãn cùng kiểu với nhãn phòng, treo cao để không che người ở góc toàn cảnh. */}
      <Html position={[0, YARD_HEIGHT + 0.9, 0]} center zIndexRange={[10, 1]}>
        <button className="office-room-label" onClick={greet} title="Bấm để hỏi bất cứ gì" aria-label="Khang · Trợ lý, mở khung hỏi đáp">
          <span className="office-room-number" style={{ color: RECEPTIONIST.accent }}>
            ✦
          </span>
          <span className="office-room-title">{RECEPTIONIST.name} · Trợ lý</span>
          <i style={{ background: RECEPTIONIST.accent }} />
        </button>
      </Html>
    </group>
  );
}
