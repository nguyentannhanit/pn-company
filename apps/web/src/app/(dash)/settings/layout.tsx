/**
 * P&N — Bố cục chung khu Cài đặt: tiêu đề + hàng thẻ đứng yên khi chuyển thẻ con.
 */

import { SettingsFrame } from '@/components/settings/SettingsFrame';

export default function SettingsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <SettingsFrame>{children}</SettingsFrame>;
}
