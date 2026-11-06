/**
 * P&N — Tổng quan: văn phòng sống động + giao việc (§6, §26, §42).
 *
 * §42 nói rõ CEO phải nhìn thấy: ai đang làm, làm gì, cho dự án nào, bao lâu,
 * tốn bao nhiêu, có lỗi không, ai chờ ai, khi nào cần mình quyết. Trang này gom
 * đúng những câu hỏi đó vào một màn hình.
 */

'use client';

import { useEffect, useRef, useState } from 'react';

import { AgentPanel } from '@/components/AgentPanel';
import { OfficeView } from '@/components/OfficeView';
import { api, type ProjectRow } from '@/lib/api';
import { PRODUCT_TYPE_LABEL, PROJECT_STATUS_LABEL, money } from '@/lib/brand';
import { useRealtime } from '@/lib/store';

export default function OverviewPage(): React.JSX.Element {
  const { agents, lastEventAt, connected } = useRealtime();
  const [selected, setSelected] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [composerOpen, setComposerOpen] = useState(false);
  // Nội dung đang soạn giữ lại khi giao lỗi, để "Mở lại" không bắt CEO gõ lại từ đầu.
  const [draft, setDraft] = useState<{ goal: string; productType: string } | null>(null);
  const [toast, setToast] = useState<{ kind: 'sending' | 'done' | 'error'; text: string; projectId?: string } | null>(null);

  // Gửi việc ngay lúc bấm; bảng giao việc tự bay vào phòng Điều hành rồi đóng, không chờ máy chủ.
  const send = (goal: string, productType: string): void => {
    setToast({ kind: 'sending', text: 'Đang giao việc cho CTO…' });
    api<{ project: ProjectRow }>('/orchestrator/intake', {
      method: 'POST',
      // Chạy nền: CTO qua gói Claude mất vài phút, chờ trong một request là bị đường hầm cắt sau 100 giây.
      body: { goal, productType, background: true },
    })
      .then((result) => {
        setProjects((current) => [result.project, ...current]);
        setDraft(null);
        setToast({
          kind: 'done',
          text: `Đã giao "${result.project.name}". Khang đang mang hồ sơ lên phòng Điều hành, CTO phân rã trong 2–5 phút.`,
          projectId: result.project.id,
        });
      })
      .catch((caught: unknown) => {
        setDraft({ goal, productType });
        setToast({ kind: 'error', text: caught instanceof Error ? caught.message : 'Không giao việc được' });
      });
  };

  // Báo "đã giao" tự tắt sau vài giây; báo lỗi giữ lại tới khi CEO đóng hoặc mở lại.
  useEffect(() => {
    if (toast?.kind !== 'done') return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  // `?nguoi=<vai trò>` (nút "Xem trong 3D" ở tab Nhân sự): mở với camera ở bàn người đó.
  const [focusRole, setFocusRole] = useState<string | null>(null);
  useEffect(() => setFocusRole(new URLSearchParams(window.location.search).get('nguoi')), []);

  useEffect(() => {
    api<{ projects: ProjectRow[] }>('/projects')
      .then((result) => setProjects(result.projects))
      .catch(() => undefined);
  }, [lastEventAt]);

  const active = projects.filter(
    (project) => ['IN_PROGRESS', 'PLANNING', 'BLOCKED', 'PAUSED_BUDGET', 'PAUSED'].includes(project.status),
  );

  return (
    // Chỉ vùng cảnh 3D luôn tối; khung quanh (menu, thanh trên, rail) theo lựa chọn sáng/tối.
    <div className="office-page pn-force-dark relative h-full min-h-[560px] overflow-hidden">
      {/* Cảnh 3D chiếm trọn vùng trung tâm như một phòng điều hành thu nhỏ. */}
      <div className="absolute inset-0">
        <OfficeView agents={agents} onSelect={setSelected} live={connected} focusRole={focusRole} />
      </div>

      {/* Tiêu đề nổi giữ thông tin điều hành nhưng không lấy mất chiều cao cảnh. */}
      <header className="pointer-events-none absolute left-3 top-3 z-10 flex max-w-[58%] items-start gap-3 sm:left-5 sm:top-5 sm:max-w-[calc(100%-2rem)]">
        <div className="office-brief">
          <div className="flex items-center gap-2">
            <span className={`office-live-dot ${connected ? 'is-connected' : ''}`} />
            <h1 className="text-sm font-semibold tracking-wide">Văn phòng P&amp;N</h1>
          </div>
          <p className="mt-1 text-[10px] leading-snug sm:mt-1.5 sm:text-[11px]">
            {connected ? `${active.length} dự án · ${agents.filter((agent) => ['working', 'reviewing', 'meeting'].includes(agent.state)).length} nhân viên đang làm việc` : 'Mất kết nối · Chưa xác nhận hoạt động hiện tại'}
          </p>
        </div>

        <button
          onClick={() => setComposerOpen(true)}
          className="office-primary pointer-events-auto hidden h-[42px] items-center gap-2 rounded-xl px-4 text-xs font-semibold sm:flex"
        >
          <span className="text-base font-light">＋</span>
          Giao việc mới
        </button>
      </header>

      {/* Điện thoại giao việc bằng nút tròn giữa thanh tab (Mẫu C), không cần nút riêng ở đây. */}

      {/* Dự án đang chạy: một hàng chip nhỏ ở chân cảnh, rê chuột mới mở chi tiết —
          thẻ to che mất hai hàng phòng phía trước. */}
      {active.length > 0 && (
        <div className="absolute bottom-[84px] left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-2 sm:bottom-[78px] sm:left-5 sm:max-w-[calc(100%-2rem)]">
          {active.slice(0, 4).map((project) => {
            const counts = project.taskCounts ?? {};
            const done = counts['DONE'] ?? 0;
            const blocked = counts['BLOCKED'] ?? 0;
            const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
            // Tiến độ đo theo task, không theo tiền (dự án chưa tiêu gì vẫn có thể đang chạy dở).
            const progress = total > 0 ? done / total : 0;
            const ring = 2 * Math.PI * 6.5;
            const short = project.name.length > 22 ? `${project.name.slice(0, 21)}…` : project.name;
            return (
              <div key={project.id} className="office-chip-wrap relative">
                <a href={`/projects/${project.id}`} className="office-chip" aria-label={`${project.name}: ${done}/${total} việc`}>
                  <svg className="office-chip-ring" viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="6.5" stroke="#ffffff22" />
                    <circle
                      cx="8"
                      cy="8"
                      r="6.5"
                      stroke={blocked > 0 ? '#fb923c' : '#6ee7b7'}
                      strokeDasharray={`${ring * progress} ${ring}`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="font-semibold">{short}</span>
                  <span className="font-mono text-[9px] text-[#bfd0d6]">{done}/{total}</span>
                  {blocked > 0 && <span className="text-[9px] font-semibold text-[#ffb266]">{blocked} chặn</span>}
                </a>
                <div className="office-chip-detail" role="tooltip">
                  <p className="text-xs font-semibold">{project.name}</p>
                  <p className="mt-0.5 text-[10px] text-[#bfd0d6]">
                    {PRODUCT_TYPE_LABEL[project.productType] ?? project.productType}
                    {' · '}
                    {PROJECT_STATUS_LABEL[project.status] ?? project.status}
                  </p>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.08]">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand-400 to-learn-400" style={{ width: `${progress * 100}%` }} />
                  </div>
                  <div className="mt-1.5 flex justify-between text-[10px] text-[#bfd0d6]">
                    <span>{total > 0 ? `${done}/${total} việc` : 'chưa có việc'}{blocked > 0 ? ` · ${blocked} bị chặn` : ''}</span>
                    <span className="font-mono">{money(project.spentUsd, 2)}</span>
                  </div>
                </div>
              </div>
            );
          })}
          {active.length > 4 && (
            <a href="/projects" className="office-chip" aria-label="Xem tất cả dự án">
              +{active.length - 4}
            </a>
          )}
        </div>
      )}

      {toast && (
        <div
          role="status"
          className={`pn-office-toast flex max-w-[min(560px,calc(100%-2rem))] items-center gap-3 rounded-xl border px-4 py-2.5 text-xs shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-md ${
            toast.kind === 'error' ? 'border-[#f87171]/40 bg-[#2a0f16]/90 text-[#fecaca]' : 'border-white/[0.12] bg-[#0a1928]/90 text-ink-100'
          }`}
        >
          {toast.kind === 'sending' && <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[2px] border-current border-r-transparent opacity-70" />}
          {toast.kind === 'done' && <span className="shrink-0 text-[#6ee7b7]">✓</span>}
          <span className="leading-relaxed">{toast.kind === 'error' ? `Chưa giao được: ${toast.text}` : toast.text}</span>
          {toast.kind === 'error' && draft && (
            <button
              onClick={() => {
                setToast(null);
                setComposerOpen(true);
              }}
              className="shrink-0 rounded-lg bg-white/[0.1] px-2.5 py-1 font-semibold text-white hover:bg-white/[0.16]"
            >
              Mở lại
            </button>
          )}
          {toast.kind === 'done' && toast.projectId && (
            <button
              onClick={() => {
                // Giao nhầm thì dừng hẳn ngay: CTO bị cắt giữa lúc phân rã, chưa chạy bước nào.
                const id = toast.projectId!;
                setToast({ kind: 'sending', text: 'Đang dừng…' });
                api(`/projects/${id}/stop`, { method: 'POST', body: { mode: 'cancel' } })
                  .then(() => setToast({ kind: 'done', text: 'Đã dừng hẳn việc vừa giao.' }))
                  .catch((caught: unknown) => setToast({ kind: 'error', text: caught instanceof Error ? caught.message : 'Không dừng được' }));
              }}
              className="shrink-0 rounded-lg bg-white/[0.1] px-2.5 py-1 font-semibold text-white hover:bg-white/[0.16]"
            >
              Dừng
            </button>
          )}
          {toast.kind !== 'sending' && (
            <button onClick={() => setToast(null)} aria-label="Đóng thông báo" className="shrink-0 rounded-md px-1.5 text-base leading-none text-ink-500 hover:text-ink-100">
              ×
            </button>
          )}
        </div>
      )}

      {selected && <AgentPanel role={selected} onClose={() => setSelected(null)} />}
      {composerOpen && (
        <TaskComposer
          initial={draft}
          onClose={() => setComposerOpen(false)}
          onSend={send}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Giao việc — §3.1                                                            */
/* -------------------------------------------------------------------------- */

/**
 * CEO mô tả bằng lời, CTO tự phân rã (§5.1). Form này cố tình chỉ có một ô văn
 * bản lớn: nếu bắt CEO điền mười trường thì đã không còn là "giao việc cho công
 * ty" nữa.
 */
function TaskComposer({
  initial,
  onClose,
  onSend,
}: {
  initial: { goal: string; productType: string } | null;
  onClose: () => void;
  onSend: (goal: string, productType: string) => void;
}): React.JSX.Element {
  const [goal, setGoal] = useState(initial?.goal ?? '');
  const [productType, setProductType] = useState(initial?.productType ?? 'WEB_APPLICATION');
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  /**
   * Gửi thì bảng thu nhỏ bay thẳng vào nhãn phòng Điều hành trong cảnh 3D, nhãn phòng loé sáng, bảng biến mất —
   * không che cảnh chờ máy chủ. Trong cảnh, Khang ở quầy lễ tân mang hồ sơ lên bàn CTO theo sự kiện
   * việc mới của máy chủ. Không thấy nhãn phòng (đang xem 2D) thì bay xuống giữa cảnh.
   */
  const submit = (): void => {
    if (sending || goal.trim().length < 10) return;
    onSend(goal.trim(), productType);
    const box = card.current;
    const room = document.querySelector<HTMLElement>('[data-room="COMMAND_CENTER"]');
    if (box) {
      const from = box.getBoundingClientRect();
      const to = room?.getBoundingClientRect();
      const dx = to ? to.left + to.width / 2 - (from.left + from.width / 2) : 0;
      const dy = to ? to.top + to.height / 2 - (from.top + from.height / 2) : window.innerHeight * 0.3;
      box.style.transform = `translate(${dx}px, ${dy}px) scale(0.05) rotate(-8deg)`;
    }
    setSending(true);
    window.setTimeout(() => {
      if (room) {
        room.dataset['incoming'] = '1';
        window.setTimeout(() => delete room.dataset['incoming'], 1600);
      }
      onClose();
    }, 700);
  };

  return (
    <div className={`pn-composer-backdrop fixed inset-0 z-50 flex items-center justify-center bg-[#020810]/80 p-4 backdrop-blur-md${sending ? ' is-sending' : ''}`}>
      <div
        ref={card}
        className={`pn-composer-card w-full max-w-lg rounded-2xl border border-white/[0.1] bg-[#0a1928] p-5 shadow-[0_28px_90px_rgba(0,0,0,0.5)]${sending ? ' is-sending' : ''}`}
      >
        <h2 className="text-base font-semibold text-ink-100">Giao việc cho công ty</h2>
        <p className="mt-1 text-xs text-ink-500">
          Mô tả bằng lời như đang nói với CTO. Đội sẽ tự phân rã và bắt đầu làm.
        </p>

        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
          }}
          rows={5}
          autoFocus
          placeholder="Ví dụ: Làm web đặt bàn cho quán cà phê, khách chọn giờ và số người, chủ quán xem lịch đặt theo ngày."
          className="mt-4 w-full resize-none rounded-xl border border-white/[0.1] bg-[#07131f] px-3 py-2.5 text-sm text-ink-100 outline-none transition-colors focus:border-brand-400/60"
        />

        <label className="mt-3 block">
          <span className="mb-1.5 block text-xs text-ink-300">Loại sản phẩm</span>
          <select
            value={productType}
            onChange={(event) => setProductType(event.target.value)}
            className="w-full rounded-xl border border-white/[0.1] bg-[#07131f] px-3 py-2.5 text-sm text-ink-100 outline-none focus:border-brand-400/60"
          >
            {Object.entries(PRODUCT_TYPE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        {goal.trim().length > 0 && goal.trim().length < 10 && (
          <p className="mt-2 text-[11px] text-ink-500">Mô tả thêm một chút (ít nhất 10 ký tự) để CTO đủ thông tin phân rã.</p>
        )}

        <div className="mt-4 flex gap-2">
          <button
            onClick={onClose}
            disabled={sending}
            className="flex-1 rounded-xl border border-white/[0.1] px-4 py-2.5 text-sm text-ink-300 transition-colors hover:bg-white/[0.04] hover:text-ink-100"
          >
            Huỷ
          </button>
          <button
            onClick={submit}
            disabled={sending || goal.trim().length < 10}
            className="flex-1 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-brand-400 disabled:opacity-50"
          >
            Giao việc
          </button>
        </div>
      </div>
    </div>
  );
}
