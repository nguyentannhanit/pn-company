/** Phòng ban mới: chất liệu sáng, vách cắt mái và nội thất riêng cho từng chuyên môn. */
'use client';
import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { createRef, useMemo, useRef, useState } from 'react';
import { AdditiveBlending, type Group, type Mesh, type MeshBasicMaterial } from 'three';
import type { AgentRow } from '@/lib/api';
import { idleText, type Say } from './bubble';
import { Employee } from './Employee';
import { awayFromDesk } from './presence';
import { Block, Board, Fixture, LightStrip, Workstation } from './Furniture';
import { DOOR_WIDTH, SEAT_BACK, deskSeats, roomName, type RoomSpec } from './layout';
import { IDLE } from './pose';
import { carpetTexture, woodTexture, type ScreenKind } from './textures';
export type { RoomSpec } from './layout';

const WALL = 2.95;

/** Cho từng bộ phận một kiểu màn hình nhất quán với công việc của họ. */
function screenKind(spec: RoomSpec): ScreenKind {
  if (spec.feature === 'command') return 'dashboard';
  if (spec.feature === 'planning') return 'kanban';
  if (spec.feature === 'studio') return spec.department === 'MOBILE' ? 'mobile' : 'design';
  if (spec.feature === 'servers') return spec.department === 'DEVOPS' ? 'pipeline' : 'security';
  if (spec.feature === 'library') return 'chart';
  return 'code';
}

/** Cửa trước luôn nằm đúng trên tuyến đi; mặt kính thấp để nhìn được nhân viên. */
function FrontGlass({ width, depth }: { width: number; depth: number }): React.JSX.Element {
  const panelWidth = (width - DOOR_WIDTH) / 2;
  return (
    <group>
      {[-1, 1].map((side) => (
        <group key={side} position={[(side * (width + DOOR_WIDTH)) / 4, 0, depth / 2]}>
          <mesh position={[0, 0.49, 0]}>
            <boxGeometry args={[panelWidth, 0.93, 0.045]} />
            <meshPhysicalMaterial
              color="#b2d1d2"
              transparent
              opacity={0.17}
              roughness={0.13}
              metalness={0.12}
              depthWrite={false}
            />
          </mesh>
          <Block at={[0, 0.96, 0]} size={[panelWidth, 0.043, 0.09]} color="#9eaeb0" metal />
          <Block at={[0, 0.04, 0]} size={[panelWidth, 0.08, 0.12]} color="#526873" />
        </group>
      ))}
    </group>
  );
}

/** Nội thất đặc trưng từng bộ phận; phòng họp để trống khi chưa có người. */
function Specialism({ spec, active }: { spec: RoomSpec; active: boolean }): React.JSX.Element {
  const back = -spec.depth / 2 + 0.25;
  if (spec.feature === 'meeting' || spec.feature === 'command')
    return (
      <>
        {spec.feature === 'command' ? (
          [-2.75, 0, 2.75].map((x) => (
            <Board key={x} at={[x, 2.05, back]} width={2.55} kind="dashboard" active={active} />
          ))
        ) : (
          // Phòng họp còn một ô: bảng lệch trái nhường tường phải cho kệ sách.
          <Board at={[-1.2, 1.7, back]} width={3.2} kind="meeting" active={active} />
        )}
        <Fixture kind="table" at={[0, 0, 0.1]} />
        {[-2.2, 0, 2.2].flatMap((x) => [
          <Fixture key={x + 'a'} kind="chair" at={[x, 0, 2.1]} accent="#6d828b" />,
          <Fixture
            key={x + 'b'}
            kind="chair"
            at={[x, 0, -1.85]}
            rotation={Math.PI}
            accent="#6d828b"
          />,
        ])}
        {spec.feature === 'meeting' && (
          <>
            <Fixture kind="shelf" at={[spec.width / 2 - 1.5, 0, back]} />
            <Fixture kind="lamp" at={[-spec.width / 2 + 0.8, 0, -2.5]} />
          </>
        )}
      </>
    );
  if (spec.feature === 'library')
    return (
      <>
        <Fixture kind="shelf" at={[-2.8, 0, back]} />
        <Fixture kind="shelf" at={[2.8, 0, back]} />
        <Board at={[0, 2.05, back + 0.03]} width={2.1} kind="chart" active={active} />
      </>
    );
  return (
    <>
      <Board
        at={[spec.feature === 'servers' ? -0.7 : 0, 1.7, back]}
        width={spec.feature === 'servers' ? 3.2 : 4.1}
        kind={screenKind(spec)}
        active={active}
      />
      {spec.feature === 'servers' && <Fixture kind="server" at={[3.4, 0, back + 0.48]} />}
      {spec.feature === 'studio' && (
        <group position={[-3.72, 1.5, back + 0.13]}>
          {[0, 1, 2, 3].map((i) => (
            <Block
              key={i}
              at={[0, i * 0.32, 0]}
              size={[0.65, 0.25, 0.06]}
              color={['#b0c9c4', '#cbb6d2', '#dec291', '#839fae'][i]!}
            />
          ))}
        </group>
      )}
    </>
  );
}

/** Vầng sáng trên sàn phòng đang có việc: viền đậm và lớp phủ mờ, thở chậm để mắt bắt được từ xa. */
function RoomPulse({
  width,
  depth,
  color,
  calm,
}: {
  width: number;
  depth: number;
  color: string;
  calm: boolean;
}): React.JSX.Element {
  const ring = useRef<MeshBasicMaterial>(null);
  const fill = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock }) => {
    const level = calm ? 0.5 : 0.5 + Math.sin(clock.elapsedTime * 2.2) * 0.5;
    if (ring.current) ring.current.opacity = 0.35 + level * 0.45;
    if (fill.current) fill.current.opacity = 0.06 + level * 0.12;
  });
  return (
    <group rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.085, 0]}>
      <mesh>
        <planeGeometry args={[width - 0.3, depth - 0.3]} />
        <meshBasicMaterial
          ref={fill}
          color={color}
          transparent
          opacity={0.1}
          blending={AdditiveBlending}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
      <mesh>
        <ringGeometry args={[Math.min(width, depth) * 0.36, Math.min(width, depth) * 0.36 + 0.28, 48]} />
        <meshBasicMaterial
          ref={ring}
          color={color}
          transparent
          opacity={0.6}
          blending={AdditiveBlending}
          toneMapped={false}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}

/** Dựng phòng và cho phép mở chi tiết đúng nhân viên bằng chuột hoặc bàn phím. */
export function Room({
  spec,
  agents,
  onSelect,
  onFocus,
  says,
  calm = false,
}: {
  spec: RoomSpec;
  agents: AgentRow[];
  onSelect: (role: string) => void;
  onFocus: (department: string) => void;
  /** Câu trong bong bóng trên đầu từng người có việc (việc đang làm, lý do kẹt…). */
  says?: Map<string, Say>;
  calm?: boolean;
}): React.JSX.Element {
  const [hovered, setHovered] = useState<string | null>(null);
  const { width, depth, accent } = spec;
  const list = useMemo(() => [...agents].sort((a, b) => a.role.localeCompare(b.role)), [agents]);
  const positions = useMemo(() => deskSeats(spec, list.length), [spec, list.length]);
  const wood = useMemo(woodTexture, []);
  const carpet = useMemo(carpetTexture, []);
  const active = list.filter((agent) =>
    ['working', 'reviewing', 'meeting'].includes(agent.state),
  ).length;
  const blocked = list.some((agent) => ['blocked', 'alert'].includes(agent.state) || says?.get(agent.role)?.kind === 'blocked');
  // Ghế từng chỗ ngồi, để người xoay ghế lúc rảnh thì ghế xoay theo.
  const chairs = useMemo(() => positions.map(() => createRef<Mesh>()), [positions]);
  // Cả phòng cùng rảnh quá lâu → nhãn phòng ghi "rảnh 3 giờ" một lần, người trong phòng gục ngủ.
  const idleMinutes = (agent: AgentRow): number =>
    agent.state === 'idle' ? (Date.now() - Date.parse(agent.stateChangedAt)) / 60_000 : 0;
  const asleep =
    list.length > 0 && list.every((agent) => !says?.has(agent.role) && idleMinutes(agent) >= IDLE.longMin);
  // Người đứng dậy đi giao việc thì ghế trống: đọc mỗi khung hình, không dựng lại phòng.
  const people = useRef(new Map<string, Group>());
  useFrame(() => {
    people.current.forEach((person, role) => {
      person.visible = !awayFromDesk.has(role);
    });
  });
  return (
    <group position={[spec.x, 0, spec.z]} name={'department-' + spec.department}>
      <Block at={[0, -0.07, 0]} size={[width + 0.12, 0.18, depth + 0.12]} color="#dccbb5" />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.07, 0]} receiveShadow>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial map={wood} roughness={0.74} />
      </mesh>
      {spec.feature !== 'library' && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.079, 0.38]} receiveShadow>
          <planeGeometry args={[width * 0.86, depth * 0.63]} />
          <meshStandardMaterial
            map={carpet}
            color={spec.feature === 'command' ? '#aabac1' : '#c5cfd0'}
            roughness={0.96}
          />
        </mesh>
      )}
      {/* Ở góc toàn cảnh, một người ngồi gõ phím nhỏ quá để nhận ra phòng đang chạy.
          Sàn phát sáng theo nhịp khi có người làm việc THẬT, cam đứng yên khi bị chặn. */}
      {(active > 0 || blocked) && (
        <RoomPulse
          width={width}
          depth={depth}
          color={blocked ? '#fb923c' : '#4ade80'}
          calm={calm || blocked}
        />
      )}
      <Block at={[0, WALL / 2, -depth / 2]} size={[width + 0.2, WALL, 0.2]} color="#e2e4df" />
      <Block at={[-width / 2, WALL / 2, 0]} size={[0.18, WALL, depth]} color="#c3ccce" />
      <Block
        at={[0, WALL + 0.06, -depth / 2]}
        size={[width + 0.32, 0.16, 0.32]}
        color="#f4f3e9"
        soft
      />
      <Block at={[-width / 2, WALL + 0.06, 0]} size={[0.3, 0.16, depth]} color="#e8eeea" soft />
      <Block at={[0, 0.17, -depth / 2 + 0.12]} size={[width, 0.3, 0.06]} color="#819097" />
      <Block at={[-width / 2 + 0.11, 0.17, 0]} size={[0.05, 0.3, depth]} color="#819097" />
      <LightStrip at={[0, 2.79, -depth / 2 + 0.18]} width={width * 0.8} />
      <FrontGlass width={width} depth={depth} />
      <Specialism spec={spec} active={active > 0} />
      <Fixture kind="plant" at={[width / 2 - 0.52, 0, depth / 2 - 0.5]} scale={0.91} />
      {width > 12 && (
        <Fixture kind="plant" at={[-width / 2 + 0.9, 0, -depth / 2 + 0.8]} scale={1.2} />
      )}
      {positions.map((seat, i) => {
        const agent = list[i];
        return (
          // Xoay nửa vòng cả cụm bàn – ghế – người: trước đây nhân viên ngồi phía
          // camera nên chỉ thấy lưng. Giờ bàn nằm giữa, người ngồi phía trong và
          // quay mặt ra, đổi lại màn hình quay lưng về phía người xem.
          <group
            key={agent?.id ?? 'desk-' + i}
            position={[seat.x, 0.04, seat.z]}
            rotation={[0, Math.PI, 0]}
            scale={seat.scale}
          >
            <Workstation
              at={[0, 0, 0]}
              accent={accent}
              active={!!agent && ['working', 'reviewing'].includes(agent.state)}
              kind={screenKind(spec)}
              chairRef={chairs[i]}
            />
            {agent && (
              <group
                ref={(node) => {
                  if (node) people.current.set(agent.role, node);
                  else people.current.delete(agent.role);
                }}
                position={[0, 0, SEAT_BACK]}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect(agent.role);
                }}
                onPointerOver={(event) => {
                  event.stopPropagation();
                  setHovered(agent.role);
                }}
                onPointerOut={() => setHovered(null)}
              >
                {/* Rê chuột vào: bong bóng ghi tên người; người đang rảnh thì giật mình tỉnh dậy. */}
                <Employee
                  state={agent.state}
                  role={agent.role}
                  calm={calm}
                  completedAt={agent.lastCompletedAt}
                  since={Date.parse(agent.stateChangedAt)}
                  say={says?.get(agent.role) ?? null}
                  name={agent.displayName}
                  hovered={hovered === agent.role}
                  roomAsleep={asleep}
                  chairRef={chairs[i]}
                />
              </group>
            )}
          </group>
        );
      })}
      <Html position={[0, WALL + 0.4, -depth / 2]} center zIndexRange={[10, 1]}>
        <button
          onClick={() => onFocus(spec.department)}
          data-room={spec.department}
          // Nhìn từ toàn cảnh, chấm 5px và tay gõ quá nhỏ để thấy phòng nào
          // đang làm; nhãn phòng đổi màu và lan toả là thứ mắt bắt được ngay.
          className={`office-room-label${active > 0 ? ' is-active' : ''}${blocked ? ' is-blocked' : ''}${calm ? ' is-calm' : ''}`}
          title={`Phóng to ${spec.label} (${spec.labelEn})`}
          aria-label={`${spec.number} ${spec.label}${active > 0 ? ` · ${active} đang làm` : ''}`}
        >
          <span className="office-room-number" style={{ color: accent }}>
            {spec.number}
          </span>
          {/* Biển hai tầng: tên chuyên môn tiếng Anh nhỏ ở trên, tên Việt đậm ở dưới — song ngữ mà không dài ra. */}
          <span className="office-room-title">
            <span className="office-room-en">{spec.labelEn}</span>
            <span className="office-room-vi">{roomName(spec)}</span>
          </span>
          <i style={{ background: blocked ? '#d59058' : active ? '#6ec5a0' : '#84969b' }} />
          {active > 0 && <small>{active}</small>}
          {asleep && <em>{idleText(Math.min(...list.map(idleMinutes))).toLowerCase()}</em>}
        </button>
      </Html>
    </group>
  );
}
