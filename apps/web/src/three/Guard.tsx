/**
 * P&N — Bảo vệ đi tuần ngoài sân, mặc đồ cảnh vệ.
 *
 * Bảo vệ không phải nhân viên phòng ban nên không cần giữ bộ cử động của nhân
 * vật khối cũ; dáng đi chép từ đó lên người thật nhìn cứng như rô-bốt. Dùng clip "Walk" / "Idle_Neutral" quay sẵn trong tệp, như trợ lý.
 * Đường đi và lúc dừng vẫn do `Office.tsx` quyết định — đây chỉ là phần nhìn.
 */
'use client';
import { useAnimations, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, type RefObject } from 'react';
import { LoopRepeat, type AnimationAction, type Group } from 'three';
import { useHuman } from './human';

export const GUARD_MODEL = '/models/bao-ve.glb';
useGLTF.preload(GUARD_MODEL);

/** Cùng cỡ với nhân viên phòng ban để đứng cạnh nhau không lệch. */
const HEIGHT = 3.2;
/** Clip Walk quay cho người thật bước ~2.4 đơn vị/giây ở cỡ này; chậm hơn thì giảm nhịp để chân không trượt. */
const WALK_SPEED_OF_CLIP = 2.4;
const clipName = (short: string): string => `CharacterArmature|${short}`;

export function GuardFigure({
  moving,
  speed,
  calm,
}: {
  /** Đang bước hay đang đứng — `Office.tsx` cập nhật mỗi khung hình. */
  moving: RefObject<boolean>;
  speed: number;
  calm: boolean;
}): React.JSX.Element {
  const { animations } = useGLTF(GUARD_MODEL);
  const { model, scale } = useHuman(GUARD_MODEL, HEIGHT);
  const root = useRef<Group>(null);
  const { actions, mixer } = useAnimations(animations, root);
  const current = useRef<AnimationAction | null>(null);

  const play = (short: string): void => {
    const next = actions[clipName(short)];
    if (!next || next === current.current) return;
    next.reset().setLoop(LoopRepeat, Infinity);
    next.timeScale = short === 'Walk' ? speed / WALK_SPEED_OF_CLIP : 1;
    next.fadeIn(0.3).play();
    current.current?.fadeOut(0.3);
    current.current = next;
  };

  useFrame(() => play(!calm && moving.current ? 'Walk' : 'Idle_Neutral'));

  // Văn phòng ở chế độ tĩnh thì bảo vệ cũng đứng yên như mọi người.
  useEffect(() => {
    mixer.timeScale = calm ? 0 : 1;
  }, [calm, mixer]);

  return (
    // Mô hình nhìn về +Z; `Office.tsx` quay theo hướng đi với quy ước nhìn -Z.
    <group ref={root} scale={scale} rotation={[0, Math.PI, 0]}>
      <primitive object={model} />
    </group>
  );
}
