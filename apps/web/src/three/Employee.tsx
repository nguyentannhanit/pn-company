/**
 * P&N — Nhân viên phòng ban: mô hình người 3D, chuyển động theo trạng thái việc.
 *
 * Khác trợ lý lễ tân: trợ lý chạy clip quay sẵn trong tệp, còn nhân viên ở đây
 * đặt thẳng góc từng khớp mỗi khung hình (`pose.ts`) — chuyển động do trạng thái
 * thật của agent quyết định (§9), không phải hoạt cảnh trang trí.
 *
 * Trên đầu có bong bóng trạng thái (`bubble.ts`) thay cho vạch màu nhấp nhô cũ:
 * đang làm gì, kẹt vì sao, hay đang ngủ gật vì rảnh. Sếp rê chuột vào người
 * đang rảnh thì người đó giật mình tỉnh dậy xin lỗi.
 */
'use client';
import { Html, useGLTF } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef, type RefObject } from 'react';
import { Vector3, type Group, type Mesh } from 'three';

import { bubbleKey, bubbleView, paintBubble, type Say } from './bubble';
import { useHuman } from './human';
import { HEIGHT, Rig, WAKE, fitFor } from './pose';
import { received } from './presence';

/** Nhận hồ sơ xong mà mãi chưa tới lượt làm thì thôi báo "đã nhận" sau chừng này. */
const RECEIVED_HOLD_MS = 10 * 60_000;

/**
 * Ba mô hình công sở cho các phòng. Bản trước cho phòng an ninh và vận hành mặc
 * đồ bảo hộ đội mũ công trường — đã bị bác ngay: đây là công ty phần mềm.
 */
const MODELS = ['/models/nv-nam-thuong.glb', '/models/nv-nu-thuong.glb', '/models/nv-nam-hoodie.glb'];

/** Chia mô hình theo tên vai trò để cùng một phòng không toàn người giống nhau. */
export function modelForRole(role: string): string {
  let sum = 0;
  for (let i = 0; i < role.length; i++) sum += role.charCodeAt(i);
  return MODELS[sum % MODELS.length]!;
}

export interface EmployeeProps {
  state: string;
  role?: string;
  model?: string;
  seated?: boolean;
  calm?: boolean;
  completedAt?: number;
  /** Thời điểm (ms) bắt đầu trạng thái hiện tại — rảnh quá lâu thì gục ngủ. */
  since?: number;
  /** Câu trong bong bóng khi có việc; không có thì rảnh (ngủ gật) hoặc không hiện gì. */
  say?: Say | null;
  name?: string;
  /** Con trỏ đang trỏ vào người này. */
  hovered?: boolean;
  roomAsleep?: boolean;
  /** Ghế của người này — xoay theo khi người xoay ghế lúc rảnh. */
  chairRef?: RefObject<Mesh | null>;
}

export function Employee({
  state,
  role = '',
  model,
  seated = true,
  calm = false,
  completedAt = 0,
  since,
  say = null,
  name = '',
  hovered = false,
  roomAsleep = false,
  chairRef,
}: EmployeeProps): React.JSX.Element {
  const url = model ?? modelForRole(role);
  const { scene } = useGLTF(url);
  const { model: body, scale } = useHuman(url, HEIGHT);
  const root = useRef<Group>(null);
  const rig = useRef<Rig | null>(null);
  const anchor = useRef<Group>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const drawn = useRef('');
  const wake = useRef<{ at: number; until: number } | null>(null);
  // Sau khi bị sếp đánh thức: giây (theo đồng hồ cảnh) tới lúc được phép ngủ gật lại.
  const alertUntil = useRef(0);
  // Lần nhận hồ sơ đang đáp lại: khoá theo lúc nhận (ms) và giây của cảnh lúc thấy nó.
  const got = useRef<{ key: number; at: number } | null>(null);
  const head = useRef(new Vector3());
  const scaleOf = useRef(new Vector3());

  useFrame(({ clock }, delta) => {
    if (!root.current) return;
    if (!rig.current || rig.current.root !== root.current) rig.current = new Rig(root.current, body, role, fitFor(scene, url));
    const now = Date.now();
    const idleMinutes = state === 'idle' && since ? (now - since) / 60_000 : 0;
    const time = clock.elapsedTime;
    // Rê chuột vào người đang rảnh (không có việc, không chờ gì): thức, và thức thêm 3 giây sau khi rời chuột.
    if (seated && hovered && state === 'idle' && !say) {
      if (wake.current && wake.current.until > time) wake.current.until = time + WAKE.hold;
      else wake.current = { at: time, until: time + WAKE.hold };
      alertUntil.current = time + WAKE.guilt;
    }
    // Được trao hồ sơ: giật mình tỉnh, gật đầu đáp lại, rồi ngồi tỉnh tới khi bắt tay làm.
    // Hết hạn chờ, hoặc đã vào việc và đáp xong, thì bỏ — người ngồi trở về nhịp thường.
    const handed = seated ? received.get(role) : undefined;
    if (handed && (now - handed.at > RECEIVED_HOLD_MS || (state !== 'idle' && now - handed.at > WAKE.sorry * 1000))) {
      received.delete(role);
      got.current = null;
    } else if (handed) {
      if (got.current?.key !== handed.at) got.current = { key: handed.at, at: time };
      if (state === 'idle') wake.current = { at: got.current.at, until: time + WAKE.hold };
    } else got.current = null;
    // Dáng ngồi: còn trong 3 phút "vừa bị bắt gặp" thì vẫn tỉnh (không gật, không gục), bong bóng thì chỉ đáp vài giây.
    const posture =
      alertUntil.current > time && state === 'idle' ? { at: wake.current?.at ?? time, until: alertUntil.current } : wake.current;
    rig.current.update({ state, seated, calm, clock: time, delta, now, completedAt, idleMinutes, wake: posture });
    if (chairRef?.current) chairRef.current.rotation.y = root.current.rotation.y;
    if (!seated || !anchor.current || !bubble.current) return;

    // Neo đuôi bong bóng ngay trên đỉnh đầu (xương đầu ở gáy, đỉnh đầu cao hơn ~0.5).
    const parent = anchor.current.parent;
    if (parent) {
      const point = parent.worldToLocal(rig.current.headPosition(head.current));
      point.y += 0.5 / parent.getWorldScale(scaleOf.current).y;
      anchor.current.position.copy(point);
    }
    const reply = handed && got.current ? { at: got.current.at, text: handed.label } : null;
    const view = bubbleView({ state, role, say, name, hovered, idleMinutes, roomAsleep, clock: time, calm, wake: wake.current, received: reply });
    const key = bubbleKey(view);
    if (key !== drawn.current) {
      drawn.current = key;
      paintBubble(bubble.current, view);
    }
  });

  return (
    <group>
      <group ref={root} name={'employee-' + role + '-' + state}>
        {/* Mô hình nhìn về +Z, nhân vật khối cũ nhìn về -Z.
            Quay nửa vòng ở đây để phòng ban, người đưa việc và bảo vệ giữ nguyên hướng. */}
        <group scale={scale} rotation={[0, Math.PI, 0]}>
          <primitive object={body} />
        </group>
      </group>
      {seated && (
        <group ref={anchor}>
          <Html zIndexRange={[9, 1]} style={{ pointerEvents: 'none' }}>
            <div ref={bubble} className="say" hidden />
          </Html>
        </group>
      )}
    </group>
  );
}
