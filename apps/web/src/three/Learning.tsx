/** Thông báo R&D ngắn tại đúng phòng nhận, chỉ xuất hiện từ sự kiện máy chủ. */
'use client';

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Group } from 'three';
import { useRealtime, type LearningPulse } from '@/lib/store';
import { roomOf } from './layout';

const PULSE_MS = 4200;
const KIND = {
  discover: { label: 'R&D · Đã đánh giá', color: '#86b9d2' },
  activate: { label: 'Kiến thức được kích hoạt', color: '#91c2ac' },
  levelUp: { label: 'Phòng ban lên cấp', color: '#dfbf7d' },
};

/** Nhãn nổi nhẹ, không dùng cột sáng che mất kiến trúc và công việc bên dưới. */
function LearningNotice({
  pulse,
  calm,
}: {
  pulse: LearningPulse;
  calm: boolean;
}): React.JSX.Element | null {
  const group = useRef<Group>(null);
  const room = roomOf(pulse.kind === 'discover' ? 'KNOWLEDGE_RND' : pulse.department);
  const kind = KIND[pulse.kind];
  useFrame(() => {
    if (group.current && !calm) {
      const progress = Math.min(1, (Date.now() - pulse.at) / PULSE_MS);
      group.current.position.y = 3.8 + Math.sin((progress * Math.PI) / 2) * 0.3;
    }
  });
  if (!room) return null;
  return (
    <group ref={group} position={[room.x, 3.8, room.z]}>
      <Html center zIndexRange={[16, 11]}>
        <div
          className="office-person-label pointer-events-none"
          style={{ borderColor: kind.color }}
        >
          <strong style={{ color: kind.color }}>{kind.label}</strong>
          <span>{pulse.label}</span>
        </div>
      </Html>
    </group>
  );
}

/** Dọn cả sự kiện quá hạn khi tab bị ẩn; mất kết nối thì không phát lại hoạt động cũ. */
export function LearningLayer({
  calm = false,
  live = true,
}: {
  calm?: boolean;
  live?: boolean;
}): React.JSX.Element {
  const learning = useRealtime((state) => state.learning);
  const clearLearning = useRealtime((state) => state.clearLearning);
  useEffect(() => {
    const timers = learning.map((pulse) =>
      setTimeout(() => clearLearning(pulse.id), Math.max(0, pulse.at + PULSE_MS - Date.now())),
    );
    return () => timers.forEach(clearTimeout);
  }, [learning, clearLearning]);
  return (
    <group>
      {live && learning.map((pulse) => <LearningNotice key={pulse.id} pulse={pulse} calm={calm} />)}
    </group>
  );
}
