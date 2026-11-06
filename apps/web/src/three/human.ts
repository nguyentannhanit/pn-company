/**
 * P&N — Nạp mô hình người 3D dùng chung cho trợ lý và nhân viên phòng ban.
 *
 * Cùng một bộ mô hình (Quaternius, CC0 — xem `public/models/GHI-CONG.md`) nên
 * cùng một cách chuẩn bị: nhân bản riêng khung xương, làm mờ vật liệu, gắn
 * miệng và quy về chiều cao mong muốn. Khác nhau chỉ ở cách điều khiển: trợ lý
 * chạy clip có sẵn (`Reception.tsx`), nhân viên phòng ban đặt góc khớp theo
 * trạng thái công việc như nhân vật cũ (`Employee.tsx`).
 */
'use client';
import { useGLTF } from '@react-three/drei';
import { useMemo } from 'react';
import type { Object3D } from 'three';

import { prepareHuman } from './human-model';

export { BONE, addMouth, prepareHuman } from './human-model';

/**
 * Một bản sao riêng của mô hình, đã sẵn sàng để đặt vào cảnh (xem `prepareHuman`).
 */
export function useHuman(url: string, height: number): { model: Object3D; scale: number } {
  const { scene } = useGLTF(url);
  return useMemo(() => prepareHuman(scene, height), [scene, height]);
}
