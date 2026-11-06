/**
 * P&N — Ảnh chân dung nhân viên chụp từ chính mô hình 3D của họ.
 *
 * Tab Nhân sự trước chỉ có hai chữ cái đầu; nhân viên trong văn phòng 3D lại là
 * người thật có tóc, áo. Chụp thẳng từ mô hình để hai nơi là một người. Chỉ có
 * vài mô hình nên mỗi mô hình chụp một lần, giữ ảnh trong bộ nhớ trang.
 */

'use client';

import { DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Material, type MeshStandardMaterial } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { addMouth } from '@/three/human';

const cache = new Map<string, Promise<string>>();
const SIZE = 192;

/** Ảnh PNG (data URL) nửa người trên nhìn thẳng; lỗi (máy không có WebGL) thì trả chuỗi rỗng. */
export function portraitOf(url: string): Promise<string> {
  let pending = cache.get(url);
  if (!pending) {
    pending = render(url).catch(() => '');
    cache.set(url, pending);
  }
  return pending;
}

async function render(url: string): Promise<string> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    // Cùng cách làm mờ như trong văn phòng, để ảnh và cảnh 3D cùng một chất liệu.
    const matte = (material: Material): Material => {
      const copy = material.clone() as MeshStandardMaterial;
      copy.metalness = 0;
      copy.roughness = 0.78;
      return copy;
    };
    node.material = Array.isArray(node.material) ? node.material.map(matte) : matte(node.material);
  });
  model.updateMatrixWorld(true);
  addMouth(model);
  const head = model.getObjectByName('Head')?.getWorldPosition(new Vector3()) ?? new Vector3(0, 1.6, 0);

  const scene = new Scene();
  scene.add(model);
  scene.add(new HemisphereLight('#f2f6fa', '#6b5a44', 1.6));
  const key = new DirectionalLight('#fff1dc', 2.4);
  key.position.set(-1, 2, 3);
  scene.add(key);
  // Mô hình nhìn về +Z: máy quay đứng trước mặt, ngang tầm cằm.
  const camera = new PerspectiveCamera(24, 1, 0.05, 20);
  camera.position.set(0.12, head.y + 0.02, head.z + 1.25);
  camera.lookAt(0, head.y - 0.06, head.z);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.render(scene, camera);
  const image = renderer.domElement.toDataURL('image/png');
  renderer.dispose();
  renderer.forceContextLoss();
  return image;
}
