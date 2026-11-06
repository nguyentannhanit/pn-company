/**
 * P&N — Góc tay và độ gục đã dò sẵn cho ba mẫu người trong `public/models`.
 *
 * Dò lúc mở trang mất ~0.7 giây mỗi mẫu — cả văn phòng đứng hình
 * hơn 2 giây. Nên dò trước, ghi thành bảng; `pose.test.ts` dò lại từ mô hình và
 * so với bảng này: đổi mô hình mà quên cập nhật thì test đỏ kèm bảng mới.
 */

import type { Fit } from './pose';

export const FITS: Record<string, Fit> = {
  '/models/nv-nam-thuong.glb': {
    reach: {
      type: [{ s: -0.04, e: 1.72, f: -0.2 }, { s: -0.06, e: 1.72, f: -0.2 }],
      review: [{ s: 0.88, e: 2.02, f: 0 }, { s: 0.22, e: 1.42, f: -0.05 }],
      blocked: [{ s: 1.3, e: 1.7, f: 0 }, { s: -0.58, e: 2.06, f: 0.15 }],
      meeting: [{ s: 0.18, e: 1.86, f: 0 }, { s: -0.48, e: 1.88, f: 0.15 }],
      sleep: [{ s: -0.06, e: 1.88, f: 0 }, { s: -0.06, e: 1.8, f: 0.15 }],
      idle: [{ s: -0.4, e: 1.84, f: 0.05 }, { s: -0.4, e: 1.84, f: 0.05 }],
    },
    slump: { a: 0.1, n: 1 },
  },
  '/models/nv-nu-thuong.glb': {
    reach: {
      type: [{ s: 0.22, e: 2.04, f: -0.65 }, { s: 0.16, e: 2.04, f: -0.65 }],
      review: [{ s: 0.78, e: 2.22, f: 0 }, { s: 0.36, e: 1.8, f: -0.5 }],
      blocked: [{ s: 1.3, e: 1.7, f: 0 }, { s: -0.34, e: 2.42, f: -0.35 }],
      meeting: [{ s: 0.62, e: 1.96, f: 0 }, { s: -0.34, e: 2.3, f: -0.35 }],
      sleep: [{ s: -0.06, e: 2.6, f: -0.5 }, { s: -0.02, e: 2.46, f: -0.45 }],
      idle: [{ s: -0.24, e: 2.26, f: -0.4 }, { s: -0.26, e: 2.24, f: -0.4 }],
    },
    slump: { a: 0.15, n: 0.5 },
  },
  '/models/nv-nam-hoodie.glb': {
    reach: {
      type: [{ s: -0.02, e: 1.72, f: -0.2 }, { s: -0.04, e: 1.7, f: -0.15 }],
      review: [{ s: 0.82, e: 2.06, f: 0 }, { s: 0.22, e: 1.44, f: -0.1 }],
      blocked: [{ s: 1.3, e: 1.7, f: 0 }, { s: -0.56, e: 2.06, f: 0.15 }],
      meeting: [{ s: 0.2, e: 1.84, f: 0 }, { s: -0.46, e: 1.88, f: 0.1 }],
      sleep: [{ s: -0.04, e: 1.88, f: 0 }, { s: -0.04, e: 1.8, f: 0.1 }],
      idle: [{ s: -0.4, e: 1.86, f: 0.05 }, { s: -0.4, e: 1.84, f: 0.1 }],
    },
    slump: { a: 0.1, n: 0.9 },
  },
};
