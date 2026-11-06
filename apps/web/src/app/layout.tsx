/**
 * P&N — Layout gốc (§150.3).
 *
 * Khai báo manifest và icon để cài dashboard thành ứng dụng trên điện thoại
 * (PWA); PwaSetup đăng ký service worker và nhận địa chỉ API từ đường dẫn.
 * Giao diện sáng là mặc định; đoạn script nhỏ đọc lựa chọn tối đã lưu và gắn
 * `data-theme` trước khi trang vẽ, để không nháy từ sáng sang tối.
 */

import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';

import { ClickSounds } from '@/components/ClickSounds';
import { CompanyEntrance } from '@/components/CompanyEntrance';
import { PressRipple } from '@/components/PressRipple';
import { PwaSetup } from '@/components/PwaSetup';

import './globals.css';

// Chữ có dấu tiếng Việt đầy đủ, nét rõ ở cỡ nhỏ trên điện thoại.
const beVietnam = Be_Vietnam_Pro({
  subsets: ['vietnamese', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-be-vietnam',
  display: 'swap',
});
const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
  display: 'swap',
});

const THEME_INIT = `try{if(localStorage.getItem('pn.theme')==='dark')document.documentElement.dataset.theme='dark'}catch(e){}`;

export const metadata: Metadata = {
  // §150 — tên hiển thị trên tab trình duyệt cũng phải là P&N.
  title: 'P&N — Digital Company',
  description: 'Build. Learn. Evolve. — trung tâm điều hành công ty phần mềm AI P&N.',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  // Đầu trang điện thoại là dải chuyển sắc đậm: chữ trạng thái trắng, nền dải chạy lên dưới đồng hồ/pin.
  appleWebApp: { capable: true, title: 'P&N', statusBarStyle: 'black-translucent' },
};

// Khung trang cố định trên điện thoại: không cho chụm ngón phóng to — lỡ phóng là cả
// trang lệch, thanh dưới và nút đăng nhập trôi khỏi màn hình. Chữ vẫn phóng được bằng cài đặt cỡ chữ của máy.
export const viewport: Viewport = {
  themeColor: '#2563eb',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="vi" className={`${beVietnam.variable} ${jetbrains.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <PwaSetup />
        <PressRipple />
        <ClickSounds />
        {children}
        <CompanyEntrance />
      </body>
    </html>
  );
}
