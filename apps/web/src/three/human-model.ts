/**
 * P&N — Chuẩn bị mô hình người 3D (Quaternius, CC0 — xem `public/models/GHI-CONG.md`).
 *
 * Tách khỏi `human.ts` (hook React) để phần dò tư thế và test chạy được ngoài
 * trình duyệt: đây chỉ là three.js thuần, không cần React hay drei.
 */
import {
  Bone,
  Box3,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SkinnedMesh,
  TorusGeometry,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** Tên xương sau khi nạp không còn dấu chấm: `UpperLeg.L` thành `UpperLegL`. */
export const BONE = {
  hips: 'Hips',
  torso: 'Torso',
  head: 'Head',
  upperArm: (side: 'L' | 'R') => `UpperArm${side}`,
  lowerArm: (side: 'L' | 'R') => `LowerArm${side}`,
  upperLeg: (side: 'L' | 'R') => `UpperLeg${side}`,
  lowerLeg: (side: 'L' | 'R') => `LowerLeg${side}`,
  lowerLegEnd: (side: 'L' | 'R') => `LowerLeg${side}_end`,
  foot: (side: 'L' | 'R') => `Foot${side}`,
} as const;

/**
 * Bộ mô hình gốc chỉ có mắt và lông mày, không có miệng. Gắn một nụ cười mỏng vào xương đầu để nó đi theo mọi động tác; vị
 * trí và cỡ đo từ chính phần da của đầu nên đổi mô hình cùng bộ vẫn đúng chỗ.
 */
export function addMouth(model: Object3D): void {
  // GLTFLoader tách mesh nhiều vật liệu thành nhóm con, mỗi con một vật liệu;
  // phần da của đầu là con có vật liệu "Skin".
  const head = model.getObjectByName(BONE.head);
  if (!(head instanceof Bone)) return;
  // Mỗi mô hình đặt tên nhóm đầu khác nhau (`Suit_Head`, `Worker_Head`…), nhưng
  // đều có chữ "Head"; tìm trong nhóm đó để không nhặt nhầm da bàn tay.
  let headMesh: Object3D | undefined;
  model.traverse((node) => {
    if (!headMesh && !(node instanceof Bone) && /head/i.test(node.name) && node.children.length > 0) headMesh = node;
  });
  let face: SkinnedMesh | undefined;
  (headMesh ?? model).traverse((node) => {
    if (!face && node instanceof SkinnedMesh && !Array.isArray(node.material) && node.material.name === 'Skin') face = node;
  });
  if (!face) return;

  const geometry = face.geometry;
  const headIndex = face.skeleton.bones.indexOf(head);
  if (headIndex < 0) return;
  const position = geometry.getAttribute('position');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const index = geometry.index;

  // Đỉnh da do xương đầu kéo (bỏ cổ, bỏ tay), đo trong không gian mô hình.
  const points: Vector3[] = [];
  const end = index ? index.count : position.count;
  for (let i = 0; i < end; i++) {
    const vertex = index ? index.getX(i) : i;
    let strongest = 0;
    let weight = -1;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(vertex, k);
      if (w > weight) {
        weight = w;
        strongest = skinIndex.getComponent(vertex, k);
      }
    }
    if (strongest !== headIndex) continue;
    // Đúng phép biến đổi three dùng khi vẽ mesh có xương (bind + xương), rồi ra thế giới.
    points.push(
      face.applyBoneTransform(vertex, new Vector3().fromBufferAttribute(position, vertex)).applyMatrix4(face.matrixWorld),
    );
  }
  if (points.length === 0) return;

  const box = new Box3().setFromPoints(points);
  const size = box.getSize(new Vector3());
  // Miệng ở khoảng 1/4 chiều cao mặt tính từ cằm.
  const mouthY = box.min.y + size.y * 0.27;
  // Điểm nhô nhất của mặt ở ngang tầm miệng (dưới mũi), để miệng nằm trên da.
  let front = box.max.z;
  for (const point of points) {
    if (Math.abs(point.y - mouthY) < size.y * 0.06 && point.z > front) front = point.z;
  }
  const radius = size.x * 0.17;
  const target = new Vector3((box.min.x + box.max.x) / 2, mouthY + radius * 0.7, front + size.z * 0.01);

  // Cung tròn phía dưới của vòng = nụ cười nhẹ.
  const arc = Math.PI * 0.7;
  const mouth = new Mesh(
    new TorusGeometry(radius, size.x * 0.02, 6, 14, arc).rotateZ(Math.PI * 1.5 - arc / 2),
    new MeshStandardMaterial({ color: '#9c4f4d', roughness: 0.7 }),
  );
  mouth.name = 'mouth';
  // Con của xương thì nhận cả tỉ lệ 100 của armature; bù lại để cỡ đo được giữ nguyên.
  head.add(mouth);
  mouth.position.copy(head.worldToLocal(target));
  mouth.quaternion.copy(head.getWorldQuaternion(new Quaternion()).invert());
  const worldScale = head.getWorldScale(new Vector3());
  mouth.scale.set(1 / worldScale.x, 1 / worldScale.y, 1 / worldScale.z);
}

/**
 * Một bản sao riêng của mô hình, đã sẵn sàng để đặt vào cảnh.
 *
 * `height` là chiều cao muốn có trong cảnh: bàn ghế văn phòng dựng cho nhân vật
 * khối cao 2.05 nên nhân viên phòng ban cao hơn người thật một chút mới cân.
 */
export function prepareHuman(scene: Object3D, height: number): { model: Object3D; scale: number } {
  // Nhân bản có khung xương riêng: cùng mô hình dùng ở nhiều nơi không giật nhau.
  const copy = cloneSkinned(scene);
  copy.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = false;
    // Khối bao của mesh có xương không theo động tác; camera trực giao của văn
    // phòng dễ cắt nhầm khi tay vẫy ra ngoài khối.
    node.frustumCulled = false;
    // Vật liệu gốc đặt kim loại 0.4, độ nhám 0.27: mặt low-poly phản chiếu lệch
    // nhau thành ô loang lổ. Làm mờ như vải và da.
    const matte = (material: Material): Material => {
      const clone = material.clone() as MeshStandardMaterial;
      clone.metalness = 0;
      clone.roughness = 0.78;
      return clone;
    };
    node.material = Array.isArray(node.material) ? node.material.map(matte) : matte(node.material);
  });
  // Bản sao chưa có ma trận thế giới: không cập nhật thì đo ra số đo gốc bằng
  // centimet, trục Z hướng lên (54 × 62 × 180) và nhân vật bị thu còn ~5 cm.
  copy.updateMatrixWorld(true);
  addMouth(copy);
  const size = new Box3().setFromObject(copy).getSize(new Vector3());
  return { model: copy, scale: height / size.y };
}
