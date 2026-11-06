/**
 * P&N — Trang xem trước văn phòng 3D, CHỈ dùng khi phát triển.
 *
 * Vì sao cần: chỉnh bố cục và ánh sáng của cảnh 3D phải nhìn thấy kết quả, mà
 * trang thật thì đòi đăng nhập và đòi API đang chạy. Trang này dựng cảnh với dữ
 * liệu mẫu để lặp nhanh, và tự khoá ở bản build production để không lọt ra ngoài
 * một màn hình hiển thị dữ liệu giả (§89 — không được làm giả dữ liệu thật).
 */

'use client';

import { useEffect, useMemo, useState } from 'react';

import { OfficeView } from '@/components/OfficeView';
import type { AgentRow } from '@/lib/api';
import { STATE_LABEL } from '@/lib/brand';
import { useRealtime, type Handoff } from '@/lib/store';

/** Dữ liệu mẫu phủ đủ 9 trạng thái ở §8.1 để soi từng tư thế. */
const SAMPLE: Array<[string, string, string, string]> = [
  // [role, displayName, department, state]
  ['CTO_ORCHESTRATOR', 'Giám đốc kỹ thuật (CTO)', 'COMMAND_CENTER', 'working'],
  ['SOLUTION_ARCHITECT', 'Kiến trúc sư giải pháp', 'COMMAND_CENTER', 'reviewing'],
  ['PRODUCT_MANAGER', 'Quản lý sản phẩm', 'PRODUCT', 'working'],
  ['BUSINESS_ANALYST', 'Phân tích nghiệp vụ', 'BUSINESS_ANALYSIS', 'idle'],
  ['UIUX_DESIGNER', 'Thiết kế giao diện', 'UIUX_STUDIO', 'working'],
  ['FRONTEND_DEVELOPER', 'Lập trình giao diện', 'FRONTEND', 'working'],
  ['BACKEND_DEVELOPER', 'Lập trình máy chủ', 'BACKEND', 'working'],
  ['MOBILE_DEVELOPER', 'Lập trình di động', 'MOBILE', 'blocked'],
  ['QA', 'Kiểm thử', 'QA_LAB', 'alert'],
  ['SECURITY', 'Kỹ sư an ninh', 'SECURITY_OPS', 'reviewing'],
  ['RED_TEAM', 'Đội tấn công thử', 'SECURITY_OPS', 'idle'],
  ['DEVOPS', 'Kỹ sư vận hành', 'DEVOPS', 'celebrate'],
  ['WEB_PRODUCT_LEAD', 'Trưởng sản phẩm web', 'WEB_DEVELOPMENT', 'meeting'],
  ['SEO', 'Chuyên viên SEO', 'WEB_DEVELOPMENT', 'working'],
  ['WEB_PERFORMANCE', 'Tối ưu tốc độ web', 'WEB_DEVELOPMENT', 'idle'],
  ['ACCESSIBILITY', 'Chuyên viên dễ tiếp cận', 'WEB_DEVELOPMENT', 'completed'],
  ['KNOWLEDGE_DIRECTOR', 'Giám đốc tri thức', 'KNOWLEDGE_RND', 'working'],
  ['GITHUB_SCOUT', 'Trinh sát GitHub', 'KNOWLEDGE_RND', 'working'],
  ['TECHNOLOGY_RADAR', 'Radar công nghệ', 'KNOWLEDGE_RND', 'idle'],
  ['SKILL_SCOUT', 'Trinh sát kỹ năng', 'KNOWLEDGE_RND', 'offline'],
  ...Array.from({ length: 6 }, (_, i): [string, string, string, string] => [
    `RND_PREVIEW_${i}`,
    `R&D mẫu ${i + 5}`,
    'KNOWLEDGE_RND',
    i % 2 ? 'idle' : 'working',
  ]),
];

/**
 * Vài lần chuyển giao mẫu để soi đường đi của người đưa việc qua hành lang. CTO
 * có ba hồ sơ nên đi một vòng: việc gấp trước, rồi theo bước quy trình.
 */
const SAMPLE_HANDOFFS: Array<Omit<Handoff, 'id' | 'startedAt' | 'priority' | 'step'> & Partial<Pick<Handoff, 'priority' | 'step'>>> = [
  {
    fromRole: 'CTO_ORCHESTRATOR',
    toRole: 'BACKEND_DEVELOPER',
    kind: 'task',
    label: 'Dựng API đăng nhập',
    step: 4,
  },
  { fromRole: 'CTO_ORCHESTRATOR', toRole: 'QA', kind: 'task', label: 'Kịch bản kiểm thử', step: 5 },
  { fromRole: 'CTO_ORCHESTRATOR', toRole: 'UIUX_DESIGNER', kind: 'task', label: 'Thiết kế màn hình', step: 3, priority: 2 },
  {
    fromRole: 'QA',
    toRole: 'FRONTEND_DEVELOPER',
    kind: 'bug',
    label: 'Lỗi: nút gửi không phản hồi',
  },
  {
    fromRole: 'UIUX_DESIGNER',
    toRole: 'MOBILE_DEVELOPER',
    kind: 'task',
    label: 'Giao diện màn hình chính',
  },
  { fromRole: 'DEVOPS', toRole: 'CTO_ORCHESTRATOR', kind: 'report', label: 'Bàn giao kết quả' },
  // CEO giao thẳng (không có vai trò gửi): Khang mang từ quầy lễ tân lên.
  { fromRole: null, toRole: 'PRODUCT_MANAGER', kind: 'task', label: 'Yêu cầu mới từ CEO' },
];

/** Trang thử tư thế, mật độ nhân viên và mất kết nối, không chạy bất kỳ model AI nào. */
export default function OfficePreviewPage(): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [calm, setCalm] = useState(false);

  // Trang thật lấy chuyển giao từ WebSocket; ở đây bơm tay để nhìn thấy đường đi.
  const [round, setRound] = useState(0);
  const simulate = (): void => setRound((value) => value + 1);

  useEffect(() => {
    useRealtime.setState({
      handoffs: SAMPLE_HANDOFFS.map((handoff, index) => ({
        priority: 1,
        step: null,
        ...handoff,
        id: `preview-handoff-${round}-${index}`,
        startedAt: Date.now(),
      })),
    });
  }, [round]);

  const agents = useMemo<AgentRow[]>(
    () =>
      SAMPLE.map(([role, displayName, department, state], index) => ({
        id: `preview-${index}`,
        role: role!,
        displayName: displayName!,
        department: department!,
        state: state!,
        currentTaskId: null,
        currentProjectId: null,
        isEnabled: true,
        xp: 0,
        // Rảnh bao lâu quyết định ngủ gật hay gục ngủ (≥ 30 phút): mẫu thường rảnh 5 phút,
        // Phòng nghiên cứu rảnh 3 giờ để soi dáng gục ngủ.
        stateChangedAt: new Date(Date.now() - (department === 'KNOWLEDGE_RND' ? 3 * 3600_000 : 5 * 60_000)).toISOString(),
      })),
    [],
  );

  if (process.env.NODE_ENV === 'production') {
    return (
      <main className="flex h-screen items-center justify-center px-6 text-center text-sm text-ink-500">
        Trang xem trước chỉ hoạt động ở chế độ phát triển. Vào /overview để xem văn phòng thật.
      </main>
    );
  }

  return (
    <main className="flex h-screen flex-col bg-base-900">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-base-700 px-5 py-2.5">
        <div>
          <h1 className="text-sm font-semibold text-ink-100">Xem trước văn phòng 3D</h1>
          <p className="text-[11px] text-ink-500">
            Dữ liệu mẫu, chỉ để chỉnh hình khối và ánh sáng — không phải trạng thái thật.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
          <button
            type="button"
            onClick={simulate}
            className="rounded border border-produce-400/40 bg-produce-400/10 px-2 py-0.5 text-produce-400 hover:bg-produce-400/20"
          >
            Mô phỏng chuyển giao
          </button>
          {[...new Set(SAMPLE.map(([, , , state]) => state))].map((state) => (
            <span key={state} className="rounded bg-base-700 px-1.5 py-0.5">
              {STATE_LABEL[state!] ?? state}
            </span>
          ))}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-4 border-b border-base-700 px-5 py-2 text-[11px] text-ink-300">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={live}
            onChange={(event) => setLive(event.target.checked)}
          />
          Kết nối mô phỏng
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={calm}
            onChange={(event) => setCalm(event.target.checked)}
          />
          Giảm chuyển động
        </label>
        <span>
          {live
            ? '26 nhân viên mẫu · không gọi AI'
            : 'Mất kết nối mô phỏng · nhân viên dừng chuyển động'}
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <OfficeView agents={agents} onSelect={setSelected} live={live} calm={calm} />
      </div>

      {selected && (
        <p className="border-t border-base-700 px-5 py-2 text-xs text-ink-300">
          Đã bấm vào: <span className="text-produce-400">{selected}</span>
        </p>
      )}
    </main>
  );
}
