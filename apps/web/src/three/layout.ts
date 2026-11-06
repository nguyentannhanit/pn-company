/**
 * P&N — Mặt bằng văn phòng 3D: kích thước, vị trí phòng và đường đi hành lang.
 *
 * Tách khỏi `Office.tsx` vì hai thứ cùng cần nó: cảnh dựng phòng theo mặt bằng
 * này, còn người đưa việc thì phải tính được đường đi qua hành lang giữa hai
 * phòng. Có một nguồn duy nhất thì hai bên không bao giờ lệch nhau.
 */

/** Thông tin phòng dùng chung cho kiến trúc, ghế ngồi và đường bàn giao. */
export interface RoomSpec {
  department: string;
  x: number;
  z: number;
  width: number;
  depth: number;
  accent: string;
  label: string;
  /** Tên chuyên môn tiếng Anh trên biển phòng — ngắn, ≤ 17 ký tự để vừa biển. */
  labelEn: string;
  number: string;
  feature: 'command' | 'studio' | 'engineering' | 'planning' | 'servers' | 'meeting' | 'library';
}

/* -------------------------------------------------------------------------- */
/* Lưới phòng                                                                  */
/* -------------------------------------------------------------------------- */

// Kích thước phòng chọn theo lượng đồ đạc thực tế bên trong (hai hàng bàn,
// mỗi hàng ba chỗ) chứ không chọn cho "rộng rãi" — phòng quá khổ thì hơn nửa
// diện tích là sàn trống và cả mặt bằng trông bỏ hoang.
export const CELL_W = 8.8;
export const CELL_D = 7.6;

/**
 * Khoảng giữa hai phòng là HÀNH LANG THẬT, không phải khe hở trang trí. Đây là
 * chỗ người đưa việc đi bộ từ phòng này sang phòng kia, nên nó phải đủ rộng cho
 * một người đi lọt và nhìn thấy được từ camera toàn cảnh.
 */
export const GAP = 2.2;

/** Hành lang vòng quanh sàn, để phòng ở rìa cũng có lối ra. */
export const PERIM = 1.8;

/** Tâm cột theo chỉ số 0..4. */
export const col = (index: number): number => (index - 2) * (CELL_W + GAP);
/** Tâm hàng theo chỉ số 0..2. */
export const row = (index: number): number => (index - 1) * (CELL_D + GAP);
/** Phòng rộng hai cột: tâm nằm giữa hai cột. */
const span2 = (a: number, b: number): number => (col(a) + col(b)) / 2;
const WIDE = CELL_W * 2 + GAP;

export const FLOOR_W = CELL_W * 5 + GAP * 4;
export const FLOOR_D = CELL_D * 3 + GAP * 2;
/** Cao độ sàn văn phòng để mặt tiền bên dưới đọc thành một toà nhà thật. */
export const OFFICE_Y = 2.4;
/** Mép trước của sàn, tính cả hành lang vòng ngoài. */
export const FRONT_Z = FLOOR_D / 2 + PERIM;
/** Bề rộng toàn sàn kể cả hành lang vòng ngoài. */
export const SLAB_W = FLOOR_W + PERIM * 2;
export const SLAB_D = FLOOR_D + PERIM * 2;

/* -------------------------------------------------------------------------- */
/* Danh sách phòng — §7                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Mặt bằng tạo một trục thị giác giống phòng điều hành thật: Command Center
 * rộng ở hàng đầu, hai phòng nghiên cứu nằm ở lõi, các đội sản xuất trải đều
 * về phía mặt tiền. Giữ đủ mọi phòng bắt buộc, chỉ thay thứ tự không gian.
 */
export const ROOMS: RoomSpec[] = [
  {
    department: 'COMMAND_CENTER',
    x: span2(0, 1),
    z: row(0),
    width: WIDE,
    depth: CELL_D,
    accent: '#d7ad62',
    label: 'Phòng điều hành',
    labelEn: 'Command Center',
    number: '01',
    feature: 'command',
  },
  {
    department: 'PRODUCT',
    x: col(2),
    z: row(0),
    width: CELL_W,
    depth: CELL_D,
    accent: '#469d87',
    label: 'Phòng sản phẩm',
    labelEn: 'Product',
    number: '02',
    feature: 'planning',
  },
  {
    department: 'BUSINESS_ANALYSIS',
    x: col(3),
    z: row(0),
    width: CELL_W,
    depth: CELL_D,
    accent: '#6b9dc0',
    label: 'Phòng phân tích',
    labelEn: 'Business Analysis',
    number: '03',
    feature: 'planning',
  },
  {
    department: 'KNOWLEDGE_RND',
    x: col(4),
    z: row(0),
    width: CELL_W,
    depth: CELL_D,
    accent: '#a28dc0',
    label: 'Phòng nghiên cứu',
    labelEn: 'R&D',
    number: '04',
    feature: 'library',
  },
  {
    department: 'UIUX_STUDIO',
    x: col(0),
    z: row(1),
    width: CELL_W,
    depth: CELL_D,
    accent: '#b888ae',
    label: 'Phòng thiết kế',
    labelEn: 'UI/UX Design',
    number: '05',
    feature: 'studio',
  },
  {
    department: 'FRONTEND',
    x: col(1),
    z: row(1),
    width: CELL_W,
    depth: CELL_D,
    accent: '#699dbb',
    label: 'Phòng giao diện',
    labelEn: 'Frontend',
    number: '06',
    feature: 'engineering',
  },
  {
    department: 'BACKEND',
    x: col(2),
    z: row(1),
    width: CELL_W,
    depth: CELL_D,
    accent: '#6383ad',
    label: 'Phòng máy chủ',
    labelEn: 'Backend',
    number: '07',
    feature: 'engineering',
  },
  {
    department: 'MOBILE',
    x: col(3),
    z: row(1),
    width: CELL_W,
    depth: CELL_D,
    accent: '#9c8bbd',
    label: 'Phòng di động',
    labelEn: 'Mobile',
    number: '08',
    feature: 'studio',
  },
  {
    department: 'WEB_DEVELOPMENT',
    x: col(4),
    z: row(1),
    width: CELL_W,
    depth: CELL_D,
    accent: '#4d9d98',
    label: 'Phòng web',
    labelEn: 'Web Development',
    number: '09',
    feature: 'engineering',
  },
  {
    department: 'QA_LAB',
    x: col(0),
    z: row(2),
    width: CELL_W,
    depth: CELL_D,
    accent: '#5cab9b',
    label: 'Phòng kiểm thử',
    labelEn: 'QA & Testing',
    number: '10',
    feature: 'planning',
  },
  {
    department: 'SECURITY_OPS',
    x: col(1),
    z: row(2),
    width: CELL_W,
    depth: CELL_D,
    accent: '#c78272',
    label: 'Phòng an ninh',
    labelEn: 'Security',
    number: '11',
    feature: 'servers',
  },
  {
    department: 'DEVOPS',
    x: col(2),
    z: row(2),
    width: CELL_W,
    depth: CELL_D,
    accent: '#bf9a55',
    label: 'Phòng vận hành',
    labelEn: 'DevOps',
    number: '12',
    feature: 'servers',
  },
  {
    department: 'MEETING_ROOM',
    x: span2(3, 4),
    z: row(2),
    width: WIDE,
    depth: CELL_D,
    accent: '#aa9270',
    label: 'Phòng họp',
    labelEn: 'Meeting Room',
    number: '13',
    feature: 'meeting',
  },
];

/** Tên Việt trên biển: bỏ chữ "Phòng" — biển đã treo ở cửa phòng, lặp chữ này chỉ làm biển dài thêm. */
export function roomName(spec: Pick<RoomSpec, 'label'>): string {
  const rest = spec.label.replace(/^Phòng\s+/i, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function roomOf(department: string | null | undefined): RoomSpec | null {
  if (!department) return null;
  return ROOMS.find((spec) => spec.department === department) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Hành lang                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chỉ giữ lại trục nào KHÔNG bị phòng nào chắn. Phòng rộng hai cột (Command
 * Center, Phòng họp) nằm đè lên khe giữa hai cột, nên khe
 * đó không phải hành lang — coi nó là hành lang thì người đưa việc đi xuyên
 * tường. Lọc theo danh sách phòng thật nên đổi mặt bằng là hành lang tự đúng.
 */
const clear = (lanes: number[], axis: 'x' | 'z'): number[] =>
  lanes.filter((lane) =>
    ROOMS.every((spec) =>
      axis === 'x'
        ? Math.abs(lane - spec.x) > spec.width / 2 - 0.05
        : Math.abs(lane - spec.z) > spec.depth / 2 - 0.05,
    ),
  );

/** Trục dọc (giá trị x) của các hành lang đi được. */
export const LANE_X: number[] = clear(
  [
    -FLOOR_W / 2 - PERIM / 2,
    (col(0) + col(1)) / 2,
    (col(1) + col(2)) / 2,
    (col(2) + col(3)) / 2,
    (col(3) + col(4)) / 2,
    FLOOR_W / 2 + PERIM / 2,
  ],
  'x',
);

/** Trục ngang (giá trị z) của các hành lang đi được. */
export const LANE_Z: number[] = clear(
  [-FLOOR_D / 2 - PERIM / 2, (row(0) + row(1)) / 2, (row(1) + row(2)) / 2, FLOOR_D / 2 + PERIM / 2],
  'z',
);

export type Point = readonly [number, number];

const nearest = (lanes: number[], value: number): number =>
  lanes.reduce(
    (best, lane) => (Math.abs(lane - value) < Math.abs(best - value) ? lane : best),
    lanes[0]!,
  );

/**
 * Bề rộng ô cửa trên vách kính phía trước.
 *
 * Xuất ra ngoài vì HAI nơi phải khớp nhau tuyệt đối: `Room.tsx` chừa đúng khoảng
 * này khi dựng vách, và `door()` bên dưới đặt điểm đi bộ vào giữa nó. Lệch nhau
 * là người đưa việc đi xuyên kính — đúng thứ đường đi này sinh ra để tránh.
 */
export const DOOR_WIDTH = 2.4;

/** Cửa phòng: nằm giữa ô cửa trên vách kính trước, nơi camera nhìn thấy người ra vào. */
export function door(spec: RoomSpec): Point {
  return [spec.x, spec.z + spec.depth / 2 - 0.4];
}

/**
 * Đường đi từ phòng này sang phòng kia, bám theo hành lang chứ không cắt xuyên
 * qua tường. Đi ra cửa → ra hành lang ngang trước phòng → sang hành lang dọc →
 * tới hành lang ngang của phòng đích → vào cửa.
 */
export function routeBetween(from: RoomSpec, to: RoomSpec): Point[] {
  const laneFrom = nearest(LANE_Z, from.z + from.depth / 2 + GAP / 2);
  const laneTo = nearest(LANE_Z, to.z + to.depth / 2 + GAP / 2);
  const laneX = nearest(LANE_X, to.x);

  const points: Point[] = [
    door(from),
    [from.x, laneFrom],
    [laneX, laneFrom],
    [laneX, laneTo],
    [to.x, laneTo],
    door(to),
  ];

  // Bỏ các điểm trùng nhau để đoạn đường không có bước dài bằng 0 (chia cho 0
  // khi tính hướng quay).
  return points.filter(
    (point, index) =>
      index === 0 ||
      Math.hypot(point[0] - points[index - 1]![0], point[1] - points[index - 1]![1]) > 0.05,
  );
}

/** Tổng chiều dài một đường đi, dùng để tính thời gian đi bộ. */
export function routeLength(points: Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      points[index]![0] - points[index - 1]![0],
      points[index]![1] - points[index - 1]![1],
    );
  }
  return total;
}

/** Một chỗ ngồi trong phòng (toạ độ trong phòng) và lối đi dọc cạnh bàn đó. */
export interface Seat {
  x: number;
  z: number;
  scale: number;
  /** Trục x của lối đi cạnh bàn — người đứng dậy bước ra đây rồi mới đi. */
  aisle: number;
}

/**
 * Bố trí bàn theo số nhân sự thật, chừa trục cửa giữa phòng cho bàn giao.
 *
 * Ở đây (không ở `Room.tsx`) vì người đưa việc phải biết đúng bàn của người
 * gửi và người nhận: phòng và đường đi đọc cùng một nguồn thì không lệch nhau.
 */
export function deskSeats(spec: RoomSpec, count: number): Seat[] {
  if (spec.feature === 'meeting') return [];
  if (spec.feature === 'command')
    return Array.from({ length: Math.max(count, 2) }, (_, i) => ({
      x: i % 2 === 0 ? -6.8 : 6.8,
      z: -1.1 + Math.floor(i / 2) * 2.8,
      scale: 1,
      // Bàn sát tường hai bên; lối đi ở phía trong, về giữa phòng.
      aisle: i % 2 === 0 ? -5 : 5,
    }));
  const dense = count > 4;
  const columns = dense ? 3 : 2;
  const total = Math.max(count, 4);
  const spacing = dense ? 2.6 : 4;
  return Array.from({ length: total }, (_, i) => {
    // Vị trí cột so với giữa phòng: 2 cột → −0.5, 0.5; 3 cột → −1, 0, 1.
    const offset = (i % columns) - (columns - 1) / 2;
    const x = offset * spacing;
    return {
      x,
      z: (dense ? -1.75 : -1.05) + Math.floor(i / columns) * (dense ? 1.35 : 2.75),
      scale: dense ? 0.64 : 0.95,
      // Lối đi giữa hai cột bàn, về phía giữa phòng; cột giữa thì lối bên phải.
      aisle: x + (offset > 0 ? -1 : 1) * (spacing / 2),
    };
  });
}

/**
 * Ghế và người lùi khỏi bàn bao nhiêu (chưa nhân cỡ chỗ ngồi). Ghế, người ngồi
 * (`Room.tsx`, `Furniture.tsx`), tư thế tay (`pose.ts`) và đường người đưa việc
 * đứng dậy đều đọc số này. Bản cũ 0.78 dựng cho nhân vật khối cao 2.05; người 3D
 * cao 3.2 ngồi đó thì bụng lấn vào mép bàn 0.15–0.18 và tay buông xuyên mặt bàn
 *. 0.98 để bụng vừa chạm mép bàn.
 */
export const SEAT_BACK = 0.98;

/** Chỗ người ngồi: sau bàn, lùi SEAT_BACK (đã tính cỡ bàn) về phía trong phòng. */
export function personZ(seat: Seat): number {
  return seat.z - SEAT_BACK * seat.scale;
}

/** Ba chiều: x, cao độ so với sàn văn phòng, z. */
export type Point3 = readonly [number, number, number];

/**
 * Đường trong phòng từ chỗ ngồi ra cửa: đứng dậy → bước sang lối đi cạnh bàn →
 * đi dọc lối ra hàng trước → tới giữa → cửa. Toạ độ thế giới (trên sàn văn phòng).
 */
export function deskToDoor(spec: RoomSpec, seat: Seat): Point3[] {
  const front = spec.depth / 2 - 0.9;
  const at = (x: number, z: number): Point3 => [spec.x + x, 0, spec.z + z];
  return [
    at(seat.x, personZ(seat)),
    at(seat.aisle, personZ(seat)),
    at(seat.aisle, front),
    at(0, front),
    [door(spec)[0], 0, door(spec)[1]],
  ];
}

/**
 * Đường từ hành lang trước mặt tiền tới cửa một phòng — cho Khang vừa lên cầu
 * thang ngoài, đứng ở hành lang trước tại hoành độ `x`.
 */
export function frontToRoom(x: number, to: RoomSpec): Point[] {
  const front = LANE_Z[LANE_Z.length - 1]!;
  const laneTo = nearest(LANE_Z, to.z + to.depth / 2 + GAP / 2);
  const laneX = nearest(LANE_X, to.x);
  const points: Point[] = [[x, front], [laneX, front], [laneX, laneTo], [to.x, laneTo], door(to)];
  return points.filter(
    (point, index) =>
      index === 0 ||
      Math.hypot(point[0] - points[index - 1]![0], point[1] - points[index - 1]![1]) > 0.05,
  );
}

/**
 * Cầu thang ngoài trời dọc mặt tiền, bên phải lối vào tầng trệt: chân thang ở
 * sân (x lớn), đỉnh thang ngang sàn văn phòng (x nhỏ). Đây là lối Khang từ quầy
 * lễ tân dưới sân lên văn phòng — không có nó thì Khang chỉ có thể "hiện ra"
 * trên tầng. `Office.tsx` dựng bậc theo đúng các số này.
 */
export const STAIR = { topX: 7.4, bottomX: 13.4, z: FRONT_Z + 1.2, width: 1.1, steps: 14 } as const;
/**
 * Chỗ Khang đứng sau quầy lễ tân ngoài sân. Lùi ra trước biển hiệu tầng trệt
 * (mặt ngoài biển ở FRONT_Z + 2.23): Khang cao 3.2, đứng sát hơn thì đầu xuyên biển.
 */
export const LOBBY_Z = FRONT_Z + 2.9;
/** Mặt sân nơi quầy lễ tân đứng, tính so với sàn văn phòng (sân thấp hơn 2.835). */
export const YARD_Y = -0.68 + 0.245 - OFFICE_Y;
