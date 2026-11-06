/**
 * P&N — Khung điều hành chung của dashboard (§24, §25, §42, §86).
 *
 * Bố cục ưu tiên màn hình Tổng quan: điều hướng trái, không gian làm việc ở
 * giữa, tình trạng vận hành bên phải và dải KPI phía dưới. Mọi con số đều đến
 * từ API hoặc luồng realtime; phần trình bày không tự tạo tiến độ minh hoạ.
 */

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { AssistantDrawer } from '@/components/AssistantDrawer';
import { CommandBox } from '@/components/CommandBox';
import { SoundToggle } from '@/components/SoundToggle';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Glyph } from '@/components/icons';
import { LogoMark, Wordmark } from '@/components/Logo';
import { Tile3D } from '@/components/ui';
import { api, setToken, type AgentRow, type ApprovalRow, type CostSummary } from '@/lib/api';
import { onOpenAssistant } from '@/lib/assistant';
import { BRAND, DEPARTMENT_LABEL, NAV_TINT, STATE_TONE, STATE_LABEL, money } from '@/lib/brand';
import { useBlocked, useTaskTitles, type BlockedItem } from '@/lib/insights';
import { loadMe } from '@/lib/me';
import { openRoomIn3D } from '@/lib/office-nav';
import { useRealtime, type FeedEntry } from '@/lib/store';
import { roomOf } from '@/three/layout';

type NavIconName =
  | 'overview'
  | 'command'
  | 'projects'
  | 'agents'
  | 'tasks'
  | 'bugs'
  | 'deploy'
  | 'cost'
  | 'approvals'
  | 'reports'
  | 'knowledge'
  | 'settings';

/** §86 — cây điều hướng chính, giữ nguyên thứ tự của đặc tả. */
const NAV: Array<{ href: string; label: string; icon: NavIconName }> = [
  { href: '/overview', label: 'Tổng quan', icon: 'overview' },
  { href: '/command', label: 'Phòng điều hành', icon: 'command' },
  { href: '/projects', label: 'Dự án', icon: 'projects' },
  { href: '/agents', label: 'Nhân sự', icon: 'agents' },
  { href: '/tasks', label: 'Công việc', icon: 'tasks' },
  { href: '/bugs', label: 'Lỗi', icon: 'bugs' },
  { href: '/deploy', label: 'Triển khai', icon: 'deploy' },
  { href: '/cost', label: 'Chi phí AI', icon: 'cost' },
  { href: '/approvals', label: 'Phê duyệt', icon: 'approvals' },
  { href: '/reports', label: 'Báo cáo', icon: 'reports' },
  { href: '/knowledge', label: 'Kiến thức', icon: 'knowledge' },
  { href: '/settings', label: 'Cài đặt', icon: 'settings' },
];

/** Dựng toàn bộ khung dashboard và giữ kết nối dữ liệu dùng chung. */
export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const { connect, disconnect, connected, agents, pendingApprovals, feed } = useRealtime();
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [initials, setInitials] = useState('CEO');

  // Khang ở sảnh văn phòng 3D bấm được: cảnh phát tín hiệu, khung mở ở đây.
  const [assistantQuestion, setAssistantQuestion] = useState<string | undefined>(undefined);
  useEffect(
    () =>
      onOpenAssistant((question) => {
        setAssistantQuestion(question);
        setAssistantOpen(true);
      }),
    [],
  );

  // Chữ cái đầu tên người đang đăng nhập cho ảnh đại diện (nhiều tài khoản — không còn mặc định là CEO).
  useEffect(() => {
    loadMe()
      .then(({ user }) => setInitials(initialsOf(user.displayName)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // Chi phí và danh sách duyệt không đi qua WebSocket nên tải lại định kỳ.
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      // Tải riêng từng thứ: người không có quyền xem chi phí (hay duyệt) vẫn thấy phần còn lại.
      // Mất mạng tạm thời thì giữ số liệu cũ, không xoá trắng màn hình.
      await Promise.all([
        api<CostSummary>('/cost/summary').then((summary) => alive && setCost(summary), () => undefined),
        api<{ approvals: ApprovalRow[] }>('/approvals').then((pending) => alive && setApprovals(pending.approvals), () => undefined),
      ]);
    };
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [pathname]);

  /** Kết thúc phiên hiện tại và quay về màn hình đăng nhập. */
  const signOut = (): void => {
    setToken(null);
    disconnect();
    router.push('/login');
  };

  return (
    <div className={`dashboard-shell ${pathname === '/overview' ? 'office-dashboard' : ''} flex h-dvh flex-col overflow-hidden bg-base-900`}>
      <MobileTopBar pendingApprovals={pendingApprovals} initials={initials} onMore={() => setMoreOpen(true)} />

      {/* Thanh trên cùng (máy tính) — nhận diện, tìm nhanh và trạng thái phiên. */}
      <header className="relative z-30 hidden h-[calc(70px+env(safe-area-inset-top))] shrink-0 items-center border-b pt-[env(safe-area-inset-top)] sm:flex border-line bg-[var(--head-bg)] shadow-[var(--shadow-panel)] backdrop-blur-xl">
        <div className="flex h-full w-[64px] shrink-0 items-center justify-center border-line sm:w-[76px] sm:border-r xl:w-[216px] xl:justify-start xl:px-5">
          <span className="xl:hidden"><LogoMark /></span>
          <span className="hidden xl:inline"><Wordmark /></span>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 xl:px-6">
          <CommandBox pages={NAV} />

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            <SoundToggle />
            <ThemeToggle />
            <span
              className="hidden items-center gap-2 rounded-lg border border-line bg-fill-1 px-3 py-2 text-xs text-ink-300 sm:flex"
              title={connected ? 'Đang nhận dữ liệu thời gian thực' : 'Mất kết nối, đang thử lại'}
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${connected ? 'pn-pulse' : ''}`}
                style={{ background: connected ? STATE_TONE['working'] : STATE_TONE['offline'] }}
              />
              {connected ? 'Realtime' : 'Mất kết nối'}
            </span>

            {pendingApprovals > 0 && (
              <Link
                href="/approvals"
                className="rounded-lg border border-produce-400/25 bg-produce-400/10 px-3 py-2 text-xs font-medium text-produce-400 transition-colors hover:bg-produce-400/15"
              >
                {pendingApprovals} chờ duyệt
              </Link>
            )}

            <button
              onClick={signOut}
              title="Đăng xuất"
              className="flex h-10 items-center gap-2 rounded-xl border border-line bg-fill-1 px-2.5 text-ink-300 transition-colors hover:border-line hover:text-ink-100 sm:px-3"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-brand-400 to-learn-400 text-[10px] font-bold text-white">
                {initials}
              </span>
              <span className="hidden text-xs font-medium lg:inline">Đăng xuất</span>
              <LogoutIcon />
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar — thu gọn thành cột biểu tượng trên màn hình vừa. */}
        <nav className="relative z-20 hidden w-[76px] shrink-0 flex-col border-r border-line bg-[var(--nav-bg)] py-4 sm:flex xl:w-[216px]">
          <div className="space-y-1 px-2.5 xl:px-3">
            {NAV.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  title={item.label}
                  className={`pn-press group relative flex h-11 items-center justify-center gap-3 rounded-xl px-3 text-sm xl:justify-start ${
                    active
                      ? 'pn-nav-active bg-gradient-to-r from-brand-600/80 to-brand-500/60 font-medium text-white shadow-[0_8px_24px_rgba(79,70,229,0.24)] ring-1 ring-brand-400/40'
                      : 'text-ink-300 hover:bg-fill-1 hover:text-ink-100'
                  }`}
                >
                  <NavIcon name={item.icon} />
                  <span className="hidden xl:inline">{item.label}</span>
                </Link>
              );
            })}
          </div>

          <div className="mt-auto px-2.5 xl:px-3">
            {/* Trợ lý thật: bấm là mở khung hỏi đáp dùng /assistant/ask (cùng bộ não với bot Telegram). */}
            <button
              type="button"
              onClick={() => setAssistantOpen(true)}
              title="Mở trợ lý P&N"
              className="pn-press pn-lift pn-focus flex w-full items-center justify-center rounded-2xl border border-brand-400/25 bg-[linear-gradient(145deg,rgba(92,76,255,0.16),rgba(16,185,230,0.06))] p-2.5 text-left xl:block xl:p-3.5"
            >
              <span className="flex items-center gap-2.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-brand-400/30 bg-brand-500/15 text-brand-300">
                  <SparkIcon />
                </span>
                <span className="hidden xl:block">
                  <span className="block text-xs font-semibold text-ink-100">Trợ lý P&amp;N</span>
                  <span className="mt-0.5 block text-[10px] text-ink-500">Hỏi gì về công ty cũng được</span>
                </span>
              </span>
              <span className="mt-3 hidden text-[10px] leading-relaxed text-ink-500 xl:block">
                "Hôm nay tiêu bao nhiêu?", "phòng nào rảnh?", hay mô tả một sản phẩm muốn làm.
              </span>
            </button>

            <div className="mt-4 hidden border-t border-line pt-4 xl:block">
              <p className="text-[10px] font-semibold tracking-[0.12em] text-ink-500">
                {BRAND.companyName.toUpperCase()}
              </p>
              <p className="mt-1 text-[10px] text-ink-500">{BRAND.tagline}</p>
            </div>
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {/* Nội dung trang — Tổng quan dùng toàn bộ chiều cao cho cảnh 3D. */}
            {/* Khu Cài đặt dùng chung một khoá: bấm thẻ con không dựng lại cả trang ("nhảy tưng tưng"). */}
            <main key={pathname.startsWith('/settings') ? '/settings' : pathname} className="pn-page min-w-0 flex-1 overflow-y-auto bg-surface-0">{children}</main>

            {/* Rail điều hành — chỉ hiện khi đủ bề rộng để không ép cảnh 3D. */}
            <OverviewRail agents={agents} approvals={approvals} cost={cost} feed={feed} />
          </div>

          <KpiBar agents={agents} pendingApprovals={pendingApprovals} cost={cost} connected={connected} />
          <MobileTabs pathname={pathname} pendingApprovals={pendingApprovals} moreOpen={moreOpen} onMore={() => setMoreOpen(true)} />
        </div>
      </div>
      <MoreSheet
        open={moreOpen}
        pathname={pathname}
        onClose={() => setMoreOpen(false)}
        onAssistant={() => setAssistantOpen(true)}
        onSignOut={signOut}
      />
      <AssistantDrawer open={assistantOpen} initialQuestion={assistantQuestion} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}

/**
 * Cột phải (Mẫu B): phòng ban như dây chuyền người thật, chi phí
 * dạng đồng hồ tháng, sự kiện như tin nhắn giữa các phòng. Bấm một phòng là văn
 * phòng 3D lướt tới phòng đó (đang ở trang khác thì chuyển về Tổng quan trước).
 */
function OverviewRail({
  agents,
  approvals,
  cost,
  feed,
}: {
  agents: AgentRow[];
  approvals: ApprovalRow[];
  cost: CostSummary | null;
  feed: FeedEntry[];
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const { items: blocked } = useBlocked();
  const titles = useTaskTitles(agents.map((agent) => agent.currentTaskId).filter((id): id is string => !!id));
  const departments = useMemo(
    () => summarizeDepartments(agents, blocked, titles),
    [agents, blocked, titles],
  );
  const hot = departments.filter((department) => department.tone !== 'idle');
  const quiet = departments.filter((department) => department.tone === 'idle');
  const people = departments.reduce((sum, department) => sum + department.people.length, 0);
  const activePeople = departments.reduce((sum, department) => sum + department.active, 0);
  const stuck = hot.filter((department) => department.tone === 'block').length;

  /** Lướt văn phòng 3D tới phòng; cảnh 3D chỉ có ở Tổng quan nên chuyển trang trước nếu cần. */
  const showRoom = (name: string): void => {
    openRoomIn3D(name);
    if (pathname !== '/overview') router.push('/overview');
  };

  return (
    <aside className="hidden w-[306px] shrink-0 flex-col overflow-y-auto border-l border-line bg-surface-1 p-3 2xl:flex">
      <section className="depth-panel rounded-2xl border border-line bg-fill-1 p-3">
        <div className="mb-2 flex items-center justify-between px-0.5">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-300">Trạng thái phòng ban</h2>
            <p className="mt-1 text-[10px] text-ink-500">
              {activePeople > 0
                ? `${activePeople} người đang làm${stuck > 0 ? ` · ${stuck} phòng kẹt` : ''}`
                : `0/${people} người đang làm`}
            </p>
          </div>
          <PulseIcon />
        </div>

        <div className="space-y-0.5">
          {hot.map((department) => (
            <DepartmentRow key={department.name} department={department} onOpen={showRoom} />
          ))}
        </div>

        {hot.length > 0 && quiet.length > 0 && (
          <p className="mt-1.5 border-t border-dashed border-line px-2 pb-0.5 pt-2 text-[10px] text-ink-500">Rảnh: {quiet.length} phòng</p>
        )}
        {/* Có phòng đang chạy thì nhóm rảnh thu vào một khung cuộn, để phòng đang chạy luôn nằm trong tầm mắt. */}
        <div className={`space-y-0.5 ${hot.length > 0 ? 'max-h-[150px] overflow-y-auto' : ''}`}>
          {quiet.map((department) => (
            <DepartmentRow key={department.name} department={department} onOpen={showRoom} />
          ))}
        </div>

        {departments.length === 0 && (
          <p className="rounded-xl border border-dashed border-line px-3 py-5 text-center text-xs text-ink-500">Đang chờ dữ liệu agent…</p>
        )}
      </section>

      {approvals.length > 0 && (
        <section className="depth-panel mt-3 rounded-2xl border border-produce-400/20 bg-produce-400/[0.045] p-3.5">
          <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.13em] text-produce-400">Chờ bạn duyệt</h2>
          <div className="space-y-2">
            {approvals.slice(0, 2).map((approval) => <ApprovalCard key={approval.id} approval={approval} />)}
          </div>
        </section>
      )}

      <CostPanel cost={cost} />
      <RoomTalk feed={feed} agents={agents} />
    </aside>
  );
}

type RailTone = 'work' | 'review' | 'block' | 'idle';

interface RailPerson {
  tone: RailTone;
}

interface DepartmentSummary {
  name: string;
  number: string;
  label: string;
  people: RailPerson[];
  active: number;
  tone: RailTone;
  /** Câu dưới tên phòng: việc đang làm, lý do kẹt, hoặc đã rảnh bao lâu. */
  what: string;
}

const RAIL_TONE: Record<RailTone, string> = {
  work: 'var(--tone-green)',
  review: 'var(--tone-blue)',
  block: 'var(--tone-orange)',
  idle: 'var(--tone-gray)',
};

/** Trạng thái agent → một trong bốn màu của cột phải. Họp, ăn mừng vẫn tính là đang làm. */
function railTone(state: string): RailTone {
  if (state === 'blocked' || state === 'alert') return 'block';
  if (state === 'reviewing') return 'review';
  if (state === 'working' || state === 'meeting' || state === 'celebrate') return 'work';
  return 'idle';
}

/** "Phòng máy chủ" → "Máy chủ": trong cột hẹp chữ "Phòng" lặp lại 13 lần là thừa. */
function shortRoomLabel(label: string): string {
  const rest = label.replace(/^Phòng\s+/i, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Thời gian rảnh viết như người nói: quá hai ngày thì đếm ngày, không ghi "673 giờ". */
function idleFor(since: number): string {
  const minutes = Math.max(0, (Date.now() - since) / 60_000);
  if (minutes < 60) return minutes < 5 ? 'vừa rảnh' : `rảnh ${Math.round(minutes)} phút`;
  const hours = minutes / 60;
  return hours < 48 ? `rảnh ${Math.round(hours)} giờ` : `rảnh ${Math.round(hours / 24)} ngày`;
}

/**
 * Gom agent theo phòng. Câu mô tả lấy đúng thứ
 * văn phòng 3D đang nói trong bong bóng: lý do kẹt đã dịch, tên việc đang làm.
 */
function summarizeDepartments(
  agents: AgentRow[],
  blocked: BlockedItem[],
  titles: Record<string, string>,
): DepartmentSummary[] {
  const reasons = new Map<string, string>();
  for (const item of blocked) if (item.role && !reasons.has(item.role)) reasons.set(item.role, item.explained.title);

  const rows: Array<{ department: string; state: string; since: string; what: string | null }> = agents.map((agent) => ({
    department: agent.department,
    state: agent.state,
    since: agent.stateChangedAt,
    what:
      reasons.get(agent.role) ??
      (agent.currentTaskId ? titles[agent.currentTaskId] : undefined) ??
      `${agent.displayName} ${STATE_LABEL[agent.state] ?? agent.state}`,
  }));

  const groups = new Map<string, typeof rows>();
  for (const row of rows) groups.set(row.department, [...(groups.get(row.department) ?? []), row]);

  return [...groups.entries()]
    .map(([name, list]) => {
      const room = roomOf(name);
      const people = list.map((row) => ({ tone: railTone(row.state) }));
      const lead = list.find((row) => railTone(row.state) === 'block') ?? list.find((row) => railTone(row.state) !== 'idle');
      const tone = lead ? railTone(lead.state) : 'idle';
      const lastChange = Math.max(...list.map((row) => Date.parse(row.since) || 0));
      return {
        name,
        number: room?.number ?? '',
        label: shortRoomLabel(room?.label ?? DEPARTMENT_LABEL[name] ?? name),
        people,
        active: people.filter((person) => person.tone !== 'idle').length,
        tone,
        what: lead ? (lead.what ?? STATE_LABEL[lead.state] ?? lead.state) : idleFor(lastChange),
      };
    })
    .sort((a, b) => {
      const rank = (department: DepartmentSummary): number => (department.tone === 'block' ? 0 : department.tone === 'idle' ? 2 : 1);
      return rank(a) - rank(b) || b.active - a.active || a.number.localeCompare(b.number);
    });
}

/**
 * Một phòng: mỗi người một chấm (nhấp nhô khi đang làm), nhịp tim khi phòng có
 * việc, cờ khi kẹt, "z z" khi rảnh. Cả hàng là nút mở phòng trong 3D.
 */
function DepartmentRow({ department, onOpen }: { department: DepartmentSummary; onOpen: (name: string) => void }): React.JSX.Element {
  const busy = department.tone !== 'idle';
  const color = RAIL_TONE[department.tone];
  const shown = department.people.slice(0, 6);
  const extra = department.people.length - shown.length;
  return (
    <button
      type="button"
      onClick={() => onOpen(department.name)}
      title={`Xem ${department.label} trong văn phòng 3D`}
      className={`pn-focus group grid w-full grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-[10px] px-2 py-1.5 text-left transition-colors hover:bg-fill-2 ${busy ? 'bg-fill-1' : ''}`}
    >
      <span className={`min-w-0 truncate text-xs ${busy ? 'font-semibold text-ink-100' : 'font-medium text-ink-300'}`}>
        {department.number && <span className="font-mono text-ink-500">{department.number} · </span>}
        {department.label}
      </span>
      <span className="flex pl-1.5">
        {shown.map((person, index) => (
          <span
            key={index}
            className={`pn-rail-face -ml-1.5 h-4 w-4 rounded-full border-2 border-surface-1 ${person.tone === 'work' ? 'is-working' : ''}`}
            style={{ background: person.tone === 'idle' ? 'var(--tone-dim)' : RAIL_TONE[person.tone], animationDelay: `${index * 0.18}s` }}
          />
        ))}
        {extra > 0 && (
          <span className="-ml-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-surface-1 bg-[var(--tone-dim)] text-[7px] font-bold text-white">
            +{extra}
          </span>
        )}
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-1.5 text-[10.5px] text-ink-500">
        {department.tone === 'block' ? (
          <span className="font-bold" style={{ color }} aria-hidden>⚑</span>
        ) : busy ? (
          <svg className="pn-rail-ekg h-3.5 w-[46px] shrink-0" viewBox="0 0 46 14" aria-hidden>
            <path d="M0 7 H12 L15 2 L19 12 L23 4 L26 7 H46" style={{ stroke: color }} />
          </svg>
        ) : (
          <span className="font-bold italic tracking-[1px] text-[var(--tone-dim)]" aria-hidden>z z</span>
        )}
        <span className="min-w-0 truncate" style={department.tone === 'block' ? { color } : undefined}>{department.what}</span>
      </span>
      {busy && (
        <span className="col-span-2 h-[3px] overflow-hidden rounded-full bg-fill-2">
          <span
            className="block h-full rounded-full transition-[width] duration-700"
            style={{ width: `${Math.round((department.active / Math.max(1, department.people.length)) * 100)}%`, background: color }}
          />
        </span>
      )}
    </button>
  );
}

/** Bậc làm tròn mốc đồng hồ: 5, 10, 25, 50, 100… để mốc cuối luôn là số dễ đọc. */
function gaugeCap(value: number): number {
  for (let scale = 1; ; scale *= 10) {
    for (const step of [5, 10, 25]) if (step * scale >= value) return step * scale;
  }
}

/**
 * Chi phí tháng dạng đồng hồ: cung đậm là đã tiêu, cung nhạt nét đứt là dự báo
 * tới cuối tháng (tiêu đều như từ đầu tháng tới nay). Bên dưới là cột từng ngày.
 */
function CostPanel({ cost }: { cost: CostSummary | null }): React.JSX.Element {
  const now = new Date();
  const today = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const month = now.getMonth() + 1;
  const spent = cost?.month.costUsd ?? 0;
  // Vừa "đếm lại chi phí" giữa tháng thì bình quân tính từ mốc đó, không từ đầu tháng.
  const countFrom = cost?.countFrom ? new Date(cost.countFrom) : null;
  const daysCounted =
    countFrom && countFrom > new Date(now.getFullYear(), now.getMonth(), 1)
      ? Math.max(1, (now.getTime() - countFrom.getTime()) / 86_400_000)
      : today;
  const forecast = spent + (spent / daysCounted) * (daysInMonth - today);
  const cap = gaugeCap(Math.max(forecast, spent, 1) * 1.15);

  // Toạ độ trên cung nửa tròn tâm (110,100): 0 ở trái, mốc cuối ở phải.
  const at = (value: number, radius: number): [number, number] => {
    const angle = Math.PI * (1 - Math.min(value, cap) / cap);
    return [110 + radius * Math.cos(angle), 100 - radius * Math.sin(angle)];
  };
  const arc = (from: number, to: number): string => {
    const [x1, y1] = at(from, 80);
    const [x2, y2] = at(to, 80);
    return `M${x1.toFixed(1)},${y1.toFixed(1)} A80,80 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`;
  };
  const [dotX, dotY] = at(spent, 80);
  const [labelX, labelY] = at(forecast, 100);

  const prefix = `${now.getFullYear()}-${String(month).padStart(2, '0')}-`;
  const perDay = new Map((cost?.daily ?? []).filter((row) => row.day.startsWith(prefix)).map((row) => [Number(row.day.slice(8, 10)), row.costUsd]));
  const peak = Math.max(0, ...perDay.values());

  return (
    <section className="depth-panel mt-3 rounded-2xl border border-line bg-fill-1 p-3.5">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-300">Chi phí AI tháng {month}</h2>
        <span className="rounded-full bg-state-completed/12 px-2 py-0.5 text-[10px] font-semibold text-state-completed">
          còn {daysInMonth - today} ngày
        </span>
      </div>

      <svg viewBox="0 -6 220 124" className="mt-1 block h-[118px] w-full" aria-label={cost ? `Đã tiêu ${money(spent, 2)} trên mốc ${money(cap, 0)}` : 'Đang tải chi phí'}>
        <path d={arc(0, cap)} stroke="var(--color-fill-2, rgba(127,149,163,0.2))" strokeWidth="14" fill="none" strokeLinecap="round" />
        {spent > 0 && <path d={arc(0, spent)} stroke="var(--tone-violet)" strokeWidth="14" fill="none" strokeLinecap="round" />}
        {forecast > spent && <path d={arc(spent, forecast)} stroke="var(--tone-violet)" strokeOpacity="0.35" strokeWidth="14" fill="none" strokeDasharray="3 3" />}
        {cost && <circle cx={dotX} cy={dotY} r="5" fill="var(--color-surface-1)" stroke="var(--color-ink-100)" strokeWidth="2.5" />}
        {cost && forecast > spent && (
          <text x={labelX} y={labelY - 2} fontSize="8.5" fill="var(--color-ink-500)" textAnchor="middle" className="font-mono">
            dự báo {money(forecast, 0)}
          </text>
        )}
        <text x="30" y="114" fontSize="9" fill="var(--color-ink-500)" textAnchor="middle" className="font-mono">$0</text>
        <text x="190" y="114" fontSize="9" fill="var(--color-ink-500)" textAnchor="middle" className="font-mono">{money(cap, 0)}</text>
        <text x="110" y="92" fontSize="19" fontWeight="600" fill="var(--color-ink-100)" textAnchor="middle" className="font-mono">
          {cost ? money(spent, 2) : '—'}
        </text>
      </svg>

      <div className="mt-1 flex h-10 items-end gap-[2px]" aria-label={`Chi phí từng ngày tháng ${month}`}>
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const value = perDay.get(day) ?? 0;
          return (
            <span
              key={day}
              title={`${day}/${month}: ${money(value, 2)}`}
              className="flex-1 rounded-t-[2px]"
              style={{
                height: value > 0 && peak > 0 ? `${Math.max(8, (value / peak) * 100)}%` : '2px',
                background: day === today ? 'var(--tone-green)' : value > 0 ? 'var(--tone-violet)' : 'var(--color-line)',
                opacity: day > today ? 0.45 : 1,
              }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9.5px] text-ink-500">
        <span>1/{month}</span>
        <span>hôm nay {today}/{month}</span>
        <span>{daysInMonth}/{month}</span>
      </div>
    </section>
  );
}

/** Loại sự kiện → màu bong bóng; lỗi, kẹt, vượt ngân sách tô cam để nổi lên. */
function talkTone(type: string): { color: string; warn: boolean } {
  if (/FAILED|BUG_CREATED|REJECTED|BUDGET/.test(type)) return { color: 'var(--tone-orange)', warn: true };
  if (/COMPLETED|SUCCESS|APPROVED|LEVEL_UP/.test(type)) return { color: 'var(--tone-teal)', warn: false };
  if (/KNOWLEDGE|PROFILE|XP/.test(type)) return { color: 'var(--tone-purple)', warn: false };
  return { color: 'var(--tone-violet)', warn: false };
}

/** Chữ viết tắt của phòng trên ảnh đại diện: "Máy chủ" → "MC". */
function roomInitials(label: string): string {
  return label
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/**
 * Sự kiện viết như tin nhắn giữa các phòng: ai gửi, gửi cho ai, nói gì. Đổi
 * trạng thái agent không đưa vào đây — khung phòng ban phía trên đã cho thấy.
 */
function RoomTalk({ feed, agents }: { feed: FeedEntry[]; agents: AgentRow[] }): React.JSX.Element {
  const byRole = useMemo(() => new Map(agents.map((agent) => [agent.role, agent])), [agents]);
  const roomName = (role: string | null): string | null => {
    const agent = role ? byRole.get(role) : undefined;
    if (!agent) return null;
    return shortRoomLabel(roomOf(agent.department)?.label ?? DEPARTMENT_LABEL[agent.department] ?? agent.department);
  };
  const messages = feed.filter((entry) => entry.type !== 'AGENT_STATE_CHANGED').slice(0, 4);

  return (
    <section className="depth-panel mt-3 rounded-2xl border border-line bg-fill-1 p-3.5">
      <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.13em] text-ink-300">Trao đổi giữa các phòng</h2>
      <div className="space-y-2">
        {messages.map((entry) => {
          const from = roomName(entry.fromRole);
          const to = roomName(entry.toRole);
          const tone = talkTone(entry.type);
          // Nhãn sự kiện còn mang mã vai trò (FE_DEV…); đổi sang tên người cho dễ đọc.
          let text = entry.label;
          for (const role of [entry.fromRole, entry.toRole]) {
            const agent = role ? byRole.get(role) : undefined;
            if (role && agent) text = text.replaceAll(role, agent.displayName);
          }
          return (
            <div key={entry.id} className="pn-rail-in grid grid-cols-[22px_1fr] gap-2 text-[11px] leading-snug">
              <span
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[8px] font-bold text-white"
                style={{ background: tone.color }}
              >
                {from ? roomInitials(from) : 'P&N'}
              </span>
              <span
                className="rounded-[4px_10px_10px_10px] px-2 py-1.5 text-ink-300"
                style={{ background: tone.warn ? 'color-mix(in srgb, var(--tone-orange) 14%, transparent)' : 'var(--color-fill-2)' }}
              >
                {(from || to) && (
                  <b className="font-semibold text-ink-100">
                    {from ?? 'P&N'}
                    {to && to !== from ? ` → ${to}` : ''}:{' '}
                  </b>
                )}
                {text}
                <span className="mt-0.5 block font-mono text-[9.5px] text-ink-500">
                  {new Date(entry.ts).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </span>
            </div>
          );
        })}
        {messages.length === 0 && <p className="text-xs text-ink-500">Yên ắng — chưa có trao đổi nào từ lúc mở trang.</p>}
      </div>
    </section>
  );
}

/** Dựng dải KPI dưới cùng từ trạng thái đang có trong store. */
/** Hai chữ cái đầu của tên ("CEO An" → "CA") cho ảnh đại diện. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || 'CEO';
}

/**
 * Thanh trên điện thoại (Mẫu C): dải chuyển sắc theo logo chạy lên
 * dưới đồng hồ/sóng/pin, nội dung bắt đầu dưới vùng an toàn. Chuông dẫn tới Phê
 * duyệt kèm số phiếu chờ; ảnh đại diện mở ngăn "Thêm".
 */
function MobileTopBar({
  pendingApprovals,
  initials,
  onMore,
}: {
  pendingApprovals: number;
  initials: string;
  onMore: () => void;
}): React.JSX.Element {
  return (
    <header className="pn-hero relative z-30 flex shrink-0 items-center gap-2.5 px-[18px] pb-2.5 pt-[calc(env(safe-area-inset-top)+10px)] text-white sm:hidden">
      <Link href="/overview" aria-label="Về Tổng quan" className="pn-press flex min-w-0 items-center gap-2.5">
        <LogoMark size={40} glass />
        <span className="min-w-0 leading-tight">
          <span className="block text-base font-extrabold tracking-[-0.01em]">{BRAND.companyName}</span>
          <span className="block truncate text-[8.5px] font-semibold uppercase tracking-[0.18em] text-white/75">{BRAND.productName}</span>
        </span>
      </Link>
      <span className="flex-1" />
      <Link
        href="/approvals"
        aria-label={pendingApprovals > 0 ? `${pendingApprovals} phiếu chờ duyệt` : 'Phê duyệt'}
        className="pn-press pn-glass relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ '--badge-ring': 'rgba(255,255,255,0.85)' } as React.CSSProperties}
      >
        <Glyph name="bell" size={21} />
        {pendingApprovals > 0 && <span className="pn-badge -right-1 -top-1">{pendingApprovals}</span>}
      </Link>
      <button
        type="button"
        onClick={onMore}
        aria-label="Mở menu"
        className="pn-press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(140deg,#8b7bff,#25445f)] text-[13px] font-bold shadow-[0_0_0_2.5px_rgba(255,255,255,0.8),0_6px_12px_-4px_rgba(10,20,60,0.5)]"
      >
        {initials}
      </button>
    </header>
  );
}

/**
 * Thanh tab dưới cùng cho điện thoại (Mẫu C): Tổng quan, Dự án, nút "Giao việc"
 * tròn 3D nhô giữa, Phê duyệt, Thêm. Icon 25px; mục đang chọn nằm trong ô tím
 * nhạt nổi khối. Vùng an toàn đáy cộng thêm vào chiều cao, không ăn vào chữ.
 */
const MOBILE_PRIMARY = ['/overview', '/projects', '/approvals'];

function MobileTabs({
  pathname,
  pendingApprovals,
  moreOpen,
  onMore,
}: {
  pathname: string;
  pendingApprovals: number;
  moreOpen: boolean;
  onMore: () => void;
}): React.JSX.Element {
  const onPrimary = MOBILE_PRIMARY.some((href) => pathname.startsWith(href)) || pathname.startsWith('/command');
  const tab = (href: string, label: string, icon: NavIconName): React.JSX.Element => {
    const active = pathname.startsWith(href);
    return (
      <Link key={href} href={href} className={tabClass(active)}>
        <TabFace active={active} icon={<NavIcon name={icon} size={25} stroke={active ? 2.1 : 1.9} />} />
        {label}
        {href === '/approvals' && pendingApprovals > 0 && <span className="pn-badge -top-1 right-1.5">{pendingApprovals}</span>}
      </Link>
    );
  };

  return (
    <nav className="relative z-30 flex h-[calc(68px+env(safe-area-inset-bottom))] shrink-0 items-start justify-around border-t border-line bg-surface-1 px-1 pt-2 pb-[env(safe-area-inset-bottom)] shadow-[0_-12px_26px_-20px_rgba(20,40,63,0.55)] sm:hidden">
      {tab('/overview', 'Tổng quan', 'overview')}
      {tab('/projects', 'Dự án', 'projects')}
      <Link href="/command" className={`pn-press flex w-16 flex-col items-center gap-1.5 text-[11px] font-bold ${pathname.startsWith('/command') ? 'text-brand-300' : 'text-ink-300'}`}>
        <span className="pn-3d pn-fab -mt-8 h-16 w-16 rounded-full">
          <Glyph name="plus" size={28} stroke={2.6} />
        </span>
        Giao việc
      </Link>
      {tab('/approvals', 'Phê duyệt', 'approvals')}
      <button type="button" onClick={onMore} className={tabClass(moreOpen || !onPrimary)}>
        <TabFace active={moreOpen || !onPrimary} icon={<Glyph name="more" size={25} stroke={moreOpen || !onPrimary ? 2.1 : 1.9} />} />
        Thêm
      </button>
    </nav>
  );
}

function tabClass(active: boolean): string {
  return `pn-press relative flex w-16 flex-col items-center gap-1.5 text-[11px] font-semibold ${active ? 'text-brand-300' : 'text-ink-500'}`;
}

/** Ô chứa icon tab: đang chọn thì nền tím nhạt nổi khối. */
function TabFace({ active, icon }: { active: boolean; icon: React.ReactNode }): React.JSX.Element {
  return (
    <span
      className={`flex h-8 w-11 items-center justify-center rounded-[11px] transition-colors ${
        active ? 'bg-brand-500/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_4px_10px_-4px_rgba(79,59,216,0.45)]' : ''
      }`}
    >
      {icon}
    </span>
  );
}

/**
 * Ngăn "Thêm" trượt từ đáy: mọi mục không có trên thanh tab, mỗi mục một ô 3D màu
 * riêng; thẻ Trợ lý; đổi sáng/tối; đăng xuất. Nhân sự lên đầu vì Mẫu C bỏ nó khỏi
 * thanh tab để nhường chỗ cho nút "Giao việc".
 */
function MoreSheet({
  open,
  pathname,
  onClose,
  onAssistant,
  onSignOut,
}: {
  open: boolean;
  pathname: string;
  onClose: () => void;
  onAssistant: () => void;
  onSignOut: () => void;
}): React.JSX.Element | null {
  if (!open) return null;
  const items = NAV.filter((entry) => !MOBILE_PRIMARY.includes(entry.href) && entry.href !== '/command')
    .sort((a, b) => Number(b.href === '/agents') - Number(a.href === '/agents'));
  const command = NAV.find((entry) => entry.href === '/command');
  const all = command ? [items[0]!, command, ...items.slice(1)] : items;

  return (
    <div className="fixed inset-0 z-50 sm:hidden" onClick={onClose}>
      <div className="absolute inset-0 bg-[rgba(15,23,42,0.38)]" />
      <div
        className="pn-sheet-in absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-[28px] border-t border-line bg-surface-1 px-[18px] pt-2.5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[0_-18px_40px_-18px_rgba(15,23,42,0.5)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-[5px] w-10 rounded-full bg-line-strong" />
        <p className="text-base font-extrabold tracking-[-0.01em] text-ink-100">Tất cả mục</p>
        <p className="mt-0.5 text-[11.5px] text-ink-500">Chạm để mở · chạm ra ngoài để đóng</p>

        <div className="mt-4 grid grid-cols-4 gap-x-2 gap-y-4">
          {all.map((entry) => {
            const active = pathname.startsWith(entry.href);
            return (
              <Link key={entry.href} href={entry.href} onClick={onClose} className="pn-press flex flex-col items-center gap-1.5 text-center">
                <Tile3D
                  tint={NAV_TINT[entry.href] ?? ['#94a3b8', '#475569']}
                  size={56}
                  radius={18}
                  className={active ? 'outline-2 outline-offset-2 outline-brand-400' : ''}
                >
                  <NavIcon name={entry.icon} size={26} stroke={2} />
                </Tile3D>
                <span className={`text-[11.5px] font-semibold leading-tight ${active ? 'text-brand-300' : 'text-ink-300'}`}>{entry.label}</span>
              </Link>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => {
            onClose();
            onAssistant();
          }}
          className="pn-press pn-assist-card mt-5 flex w-full items-center gap-3 rounded-2xl p-3 text-left"
        >
          <Tile3D tint={['#2dd4bf', '#5b48e6']} size={44} radius={14}>
            <Glyph name="spark" size={22} stroke={1.8} />
          </Tile3D>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-ink-100">Trợ lý P&amp;N</span>
            <span className="block text-[11.5px] text-ink-500">Hỏi gì về công ty cũng được</span>
          </span>
          <Glyph name="chevron" size={20} stroke={2.2} className="text-brand-300" />
        </button>

        <div className="mt-4 flex items-center justify-between border-t border-line pt-3.5">
          <span className="flex items-center gap-2">
            <ThemeToggle variant="segmented" />
            <SoundToggle className="h-[42px] w-[42px] px-0" />
          </span>
          <button type="button" onClick={onSignOut} className="pn-press pn-danger-soft flex h-10 items-center gap-2 rounded-xl px-3.5 text-[13px] font-semibold">
            <Glyph name="logout" size={17} stroke={2} />
            Đăng xuất
          </button>
        </div>
      </div>
    </div>
  );
}

function KpiBar({ agents, pendingApprovals, cost, connected }: { agents: AgentRow[]; pendingApprovals: number; cost: CostSummary | null; connected: boolean }): React.JSX.Element {
  const working = agents.filter((agent) => agent.state === 'working').length;
  const attention = agents.filter((agent) => agent.state === 'alert' || agent.state === 'blocked').length;
  return (
    <footer className="hidden h-[70px] shrink-0 grid-cols-2 gap-px border-t border-line bg-line sm:grid sm:grid-cols-3 xl:grid-cols-5">
      <KpiCard icon="agents" label="Nhân sự đang làm" value={String(working)} tone="green" />
      <KpiCard icon="bugs" label="Cần chú ý" value={String(attention)} tone={attention > 0 ? 'red' : 'muted'} />
      <KpiCard icon="tasks" label="Chờ phê duyệt" value={String(pendingApprovals)} tone="violet" className="hidden sm:flex" />
      <KpiCard icon="cost" label="Chi phí tháng" value={cost ? money(cost.month.costUsd, 2) : '—'} tone="blue" className="hidden xl:flex" />
      <KpiCard icon="deploy" label="Kết nối hệ thống" value={connected ? 'Ổn định' : 'Đang nối lại'} tone={connected ? 'green' : 'muted'} className="hidden xl:flex" />
    </footer>
  );
}

/** Hiển thị một KPI có màu nhấn mang ý nghĩa. */
function KpiCard({ icon, label, value, tone, className = 'flex' }: { icon: NavIconName; label: string; value: string; tone: 'green' | 'red' | 'violet' | 'blue' | 'muted'; className?: string }): React.JSX.Element {
  const tones = {
    green: 'text-state-completed bg-state-completed/10 border-state-completed/15',
    red: 'text-state-alert bg-state-alert/10 border-state-alert/15',
    violet: 'text-brand-300 bg-brand-400/10 border-brand-400/15',
    blue: 'text-learn-400 bg-learn-400/10 border-learn-400/15',
    muted: 'text-ink-500 bg-fill-1 border-line',
  };
  return (
    <div className={`${className} items-center gap-3 bg-surface-1 px-3 xl:px-4`}>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${tones[tone]}`}><NavIcon name={icon} /></span>
      <div className="min-w-0">
        <p className="truncate text-[9px] font-medium uppercase tracking-[0.08em] text-ink-500">{label}</p>
        <p className="mt-0.5 truncate font-mono text-base font-semibold text-ink-100">{value}</p>
      </div>
    </div>
  );
}

/** §27 — duyệt ngay tại chỗ, không cần rời màn hình đang xem. */
function ApprovalCard({ approval }: { approval: ApprovalRow }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  /** Gửi quyết định của CEO và giữ phản hồi ngay trên thẻ. */
  const decide = async (decision: 'APPROVED' | 'REJECTED'): Promise<void> => {
    setBusy(true);
    try {
      await api(`/approvals/${approval.id}/decide`, { method: 'POST', body: { decision } });
      setDone(decision === 'APPROVED' ? 'Đã duyệt' : 'Đã từ chối');
    } catch (error) {
      setDone(error instanceof Error ? error.message : 'Không xử lý được');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="depth-panel rounded-xl border border-line bg-surface-3 p-2.5">
      <p className="text-xs font-medium text-ink-100">{approval.title}</p>
      <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-ink-500">{approval.summary}</p>
      {done ? <p className="mt-2 text-[10px] text-state-completed">{done}</p> : (
        <div className="mt-2 flex gap-1.5">
          <button disabled={busy} onClick={() => void decide('APPROVED')} className="flex-1 rounded-lg bg-state-completed/15 px-2 py-1.5 text-[10px] font-medium text-state-completed transition-colors hover:bg-state-completed/25 disabled:opacity-50">Duyệt</button>
          <button disabled={busy} onClick={() => void decide('REJECTED')} className="flex-1 rounded-lg bg-state-alert/15 px-2 py-1.5 text-[10px] font-medium text-state-alert transition-colors hover:bg-state-alert/25 disabled:opacity-50">Từ chối</button>
        </div>
      )}
    </div>
  );
}

/** Bộ icon nét mảnh dùng nhất quán cho điều hướng và KPI. */
function NavIcon({ name, size = 18, stroke = 1.7 }: { name: NavIconName; size?: number; stroke?: number }): React.JSX.Element {
  const paths: Record<NavIconName, React.ReactNode> = {
    overview: <path d="M3.5 10.5 12 3l8.5 7.5M5.5 9.5V21h13V9.5M9.5 21v-6h5v6" />,
    command: <path d="M4 5.5h16v11H13l-4 3v-3H4zM8 9.5h8M8 12.5h5" />,
    projects: <path d="M3.5 6.5h6l1.5 2h9.5v11h-17zM3.5 6.5v-2h6l1.5 2" />,
    agents: <path d="M8 9a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8 4a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM1.5 21v-3a5.5 5.5 0 0 1 11 0v3M13 21v-2.5a4 4 0 0 1 8 0V21" />,
    tasks: <path d="M7 4h12v17H5V6h2m2-3h6v4H9zM9 12h6M9 16h6" />,
    bugs: <path d="m9 4 1.5 2h3L15 4M7 10h10v5a5 5 0 0 1-10 0zM3 11h4m10 0h4M3 17h4m10 0h4M8 7 6 5m10 2 2-2" />,
    deploy: <path d="M12 3 7 8h3v6h4V8h3zM5 13v7h14v-7M8 17h8" />,
    cost: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm2.5-13.5H11a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4H9.5M12 5v13" />,
    approvals: <path d="M6 3.5h12v17H6zM9.5 11.5l2 2 3.5-4M9 6.5h6" />,
    knowledge: <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v14H5.5A1.5 1.5 0 0 0 4 19.5zM4 19.5A1.5 1.5 0 0 1 5.5 18H19v2.5H5.5A1.5 1.5 0 0 1 4 19.5zM8 8h7M8 11h5" />,
    reports: <path d="M5 20V9m4.5 11V4m4.5 16v-7m4.5 7V7" />,
    settings: <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm0-12.5 1 2.2 2.4.6 2-1.3 2.1 2.1-1.3 2 .6 2.4 2.2 1-2.2 1-.6 2.4 1.3 2-2.1 2.1-2-1.3-2.4.6-1 2.2-1-2.2-2.4-.6-2 1.3-2.1-2.1 1.3-2-.6-2.4-2.2-1 2.2-1 .6-2.4-1.3-2 2.1-2.1 2 1.3 2.4-.6z" />,
  };
  return <svg aria-hidden viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

/** Icon nhịp tín hiệu cho panel trạng thái. */
function PulseIcon(): React.JSX.Element {
  return <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2 14h4l2-7 4 12 3-9 2 4h5" /></svg>;
}

/** Icon tia sáng cho thẻ Copilot. */
function SparkIcon(): React.JSX.Element {
  return <svg aria-hidden viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8zM19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7z" /></svg>;
}

/** Icon đăng xuất đặt cạnh hồ sơ điều hành. */
function LogoutIcon(): React.JSX.Element {
  return <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 text-ink-500" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M6.5 3H3v10h3.5M9 5l3 3-3 3m3-3H6" /></svg>;
}
