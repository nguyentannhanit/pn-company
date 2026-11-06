/**
 * P&N — Khung chung của năm trang Cài đặt: tiêu đề + hàng thẻ dựng MỘT lần cho cả khu.
 *
 * Trước đây mỗi trang tự vẽ tiêu đề và hàng thẻ, nên bấm sang thẻ khác là cả khối bị dựng lại: trượt lên 6px, mờ dần,
 * các con số trên thẻ biến mất rồi hiện lại làm thẻ co giãn — CEO thấy "nhảy tưng tưng". Nay khối này đứng yên, chỉ
 * phần nội dung bên dưới đổi (mờ nhẹ, không dịch chuyển). Trang nào cần nút trên đầu (ví dụ "+ Thêm người") gửi nút
 * lên qua `useSettingsAction`.
 */

'use client';

import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { SettingsNav } from '@/components/SettingsNav';
import { PageHeader } from '@/components/ui';

/** Tiêu đề từng thẻ — chữ đổi tại chỗ, không đổi chiều cao khối. */
const HEADINGS: Record<string, { title: string; subtitle: string }> = {
  '/settings': { title: 'Kết nối AI', subtitle: 'Công ty gọi AI theo thứ tự bạn xếp; hãng đầu tiên dùng được nhận việc' },
  '/settings/integrations': { title: 'Tích hợp', subtitle: 'Dịch vụ ngoài công ty dùng để nhận việc, lưu code, phát hành và báo tin' },
  '/settings/budget': { title: 'Ngân sách', subtitle: 'Tiền trả theo token cho các hãng API, theo ngày, hãng, phòng ban và dự án' },
  '/settings/audit': { title: 'Nhật ký kiểm toán', subtitle: 'Ai đã đổi gì trong hệ thống, lúc nào, kết quả ra sao' },
  '/settings/accounts': { title: 'Tài khoản & phân quyền', subtitle: 'Ai được vào công ty và được làm gì' },
};

const ActionContext = createContext<(node: React.ReactNode) => void>(() => undefined);

/** Đặt nút lên đầu trang Cài đặt trong lúc trang này đang mở; rời trang thì nút tự gỡ. */
export function useSettingsAction(node: React.ReactNode, deps: React.DependencyList): void {
  const setAction = useContext(ActionContext);
  useEffect(() => {
    setAction(node);
    return () => setAction(null);
    // Nút dựng lại theo deps của trang, không theo từng lần vẽ (vẽ lại liên tục thì khối tiêu đề vẽ lại theo).
  }, deps);
}

export function SettingsFrame({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const [action, setAction] = useState<React.ReactNode>(null);
  const heading = HEADINGS[pathname] ?? HEADINGS['/settings']!;
  // Dựng hàng thẻ một lần: giữ nguyên số đếm và vị trí cuộn ngang giữa các lần bấm.
  const tabs = useMemo(() => <SettingsNav />, []);
  const body = useRef<HTMLDivElement>(null);

  // Sang thẻ khác: nội dung mới bắt đầu ngay dưới hàng thẻ. Chỉ kéo lên khi đang cuộn quá chỗ hàng thẻ ghim lại, để hàng
  // thẻ đứng nguyên chỗ trên màn hình (điện thoại: không bật lại khối tiêu đề màu phía trên). Chạy trước khi vẽ.
  useLayoutEffect(() => {
    const main = body.current?.closest('main');
    const start = main?.querySelector<HTMLElement>('[data-pn-pin-start]');
    if (main && start && main.scrollTop > start.offsetTop) main.scrollTop = start.offsetTop;
  }, [pathname]);

  return (
    <ActionContext.Provider value={setAction}>
      <PageHeader eyebrow="Cài đặt" title={heading.title} subtitle={heading.subtitle} action={action ?? undefined} tabs={tabs} />
      <div ref={body} key={pathname} className="pn-tab-in">
        {children}
      </div>
    </ActionContext.Provider>
  );
}
