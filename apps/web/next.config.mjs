/**
 * P&N — Cấu hình Next.js.
 *
 * Dashboard là ứng dụng nội bộ chạy phía client, lấy dữ liệu từ API bằng bearer
 * token, nên không dùng SSR để khỏi phải chuyển token qua tầng server.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Có file logo thật thì mới dùng ảnh; không có thì dấu SVG vẽ tay dùng ngay,
// không phải chờ ảnh lỗi 404 rồi mới đổi (tránh nháy "ảnh hỏng" lúc mở trang).
const hasLogo = existsSync(join(dirname(fileURLToPath(import.meta.url)), 'public', 'brand', 'logo.png'));

const nextConfig = {
  reactStrictMode: true,
  // Dự án đã có CLAUDE.md riêng ở thư mục gốc; không cần Next sinh thêm bản rút
  // gọn trong apps/web, tránh hai nguồn hướng dẫn mâu thuẫn nhau.
  agentRules: false,
  // three.js phát hành ESM; để Next transpile cho khớp với bundler.
  transpilePackages: ['three', '@react-three/fiber', '@react-three/drei'],
  env: {
    NEXT_PUBLIC_API_URL: process.env.API_PUBLIC_URL ?? 'http://localhost:4000',
    NEXT_PUBLIC_HAS_LOGO: hasLogo ? '1' : '0',
  },
};

export default nextConfig;
