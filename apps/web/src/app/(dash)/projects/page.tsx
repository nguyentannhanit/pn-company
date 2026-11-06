/**
 * P&N — Danh sách dự án (§12).
 *
 * Mỗi dự án là một thẻ bấm được: trạng thái và loại sản phẩm ở đầu, hai thước có
 * nhãn (tiến độ việc, ngân sách), và một dải cảnh báo ở đáy khi có việc bị chặn
 * hoặc dự án dừng vì hết tiền — CEO nhìn lướt là biết cái nào cần mình.
 *
 * Dải chặng: dự án đi qua từng phòng theo thứ tự thật của dây chuyền;
 * mỗi đoạn là một phòng, tô màu theo việc của phòng đó — nhìn là biết đang kẹt
 * ở khâu nào, không phải mở dự án ra đếm việc.
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Glyph } from '@/components/icons';
import { Badge, Button, Chip, Empty, ErrorNote, PageHeader, Skeleton, StatTile, Tile3D } from '@/components/ui';
import { AGENT_PROFILES } from '@pn/shared';

import { api, type ProjectRow, type TaskRow } from '@/lib/api';
import { PRODUCT_TYPE_LABEL, PROJECT_STATUS_LABEL, money } from '@/lib/brand';
import { useRealtime } from '@/lib/store';


const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: 'var(--tone-green)',
  PLANNING: 'var(--tone-blue)',
  REVIEW: 'var(--tone-blue)',
  DEPLOYING: 'var(--tone-purple)',
  BLOCKED: 'var(--tone-orange)',
  PAUSED_BUDGET: 'var(--tone-red)',
  PAUSED: 'var(--tone-orange)',
  CANCELLED: 'var(--tone-dim)',
  COMPLETED: 'var(--tone-teal)',
  DRAFT: 'var(--tone-gray)',
  ARCHIVED: 'var(--tone-dim)',
};

/** Thứ tự dây chuyền: phòng nào nhận việc trước đứng trước. Tên ngắn cho vừa một đoạn. */
const PIPELINE: Array<[string, string]> = [
  ['COMMAND_CENTER', 'Điều hành'],
  ['PRODUCT', 'Sản phẩm'],
  ['BUSINESS_ANALYSIS', 'Phân tích'],
  ['UIUX_STUDIO', 'Thiết kế'],
  ['FRONTEND', 'Giao diện'],
  ['BACKEND', 'Máy chủ'],
  ['MOBILE', 'Di động'],
  ['WEB_DEVELOPMENT', 'Web'],
  ['QA_LAB', 'Kiểm thử'],
  ['SECURITY_OPS', 'An ninh'],
  ['DEVOPS', 'Vận hành'],
];

const departmentOf = (role: string | null): string | null =>
  role ? ((AGENT_PROFILES as Record<string, { department: string }>)[role]?.department ?? null) : null;

/**
 * Dải chặng của một dự án: chỉ các phòng có việc, theo thứ tự dây chuyền. Xanh là
 * xong hết, lam là đang làm, cam là có việc kẹt, xám là chưa tới lượt.
 */
function StageStrip({ projectId }: { projectId: string }): React.JSX.Element | null {
  const { lastEventAt } = useRealtime();
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  useEffect(() => {
    api<{ tasks: TaskRow[] }>(`/projects/${projectId}/tasks`)
      .then((result) => setTasks(result.tasks))
      .catch(() => setTasks([]));
  }, [projectId, lastEventAt]);
  if (!tasks || tasks.length === 0) return null;

  const stages = PIPELINE.map(([department, label]) => {
    const own = tasks.filter((task) => departmentOf(task.assignedRole) === department && task.status !== 'CANCELLED');
    const count = (status: string): number => own.filter((task) => task.status === status).length;
    const state =
      own.length === 0
        ? null
        : count('BLOCKED') > 0
          ? 'blocked'
          : count('DONE') === own.length
            ? 'done'
            : count('IN_PROGRESS') + count('REVIEW') > 0
              ? 'active'
              : 'waiting';
    return { department, label, state, done: count('DONE'), total: own.length };
  }).filter((stage) => stage.state !== null);
  const stuck = stages.filter((stage) => stage.state === 'blocked').map((stage) => stage.label);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] font-medium text-ink-500">
        <span>Dây chuyền</span>
        {stuck.length > 0 && <span className="font-semibold text-[color:var(--tone-orange)]">Kẹt ở {stuck.join(', ')}</span>}
      </div>
      <ol className="mt-1.5 flex gap-1" aria-label="Tiến độ theo phòng">
        {stages.map((stage) => (
          <li
            key={stage.department}
            className={`pn-stage is-${stage.state}`}
            title={`${stage.label}: ${stage.done}/${stage.total} việc xong`}
          >
            <span>{stage.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Trạng thái đang cần người: lên đầu danh sách. */
const ORDER = ['BLOCKED', 'PAUSED_BUDGET', 'PAUSED', 'REVIEW', 'IN_PROGRESS', 'DEPLOYING', 'PLANNING', 'DRAFT', 'COMPLETED', 'CANCELLED', 'ARCHIVED'];

export default function ProjectsPage(): React.JSX.Element {
  const { lastEventAt } = useRealtime();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dự án lưu trữ vẫn tra được (chi phí, nhật ký) nhưng không chen vào danh sách đang làm.
  const [view, setView] = useState<'all' | 'running' | 'archived'>('all');

  useEffect(() => {
    api<{ projects: ProjectRow[] }>('/projects')
      .then((result) => setProjects(result.projects))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được danh sách'));
  }, [lastEventAt]);

  const archived = projects?.filter((project) => project.status === 'ARCHIVED') ?? [];
  const pool = view === 'archived' ? archived : projects?.filter((project) => project.status !== 'ARCHIVED' && (view === 'all' || project.status === 'IN_PROGRESS'));
  const visible = pool
    ?.slice()
    .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.createdAt.localeCompare(a.createdAt));
  const running = projects?.filter((project) => project.status === 'IN_PROGRESS').length ?? 0;
  const live = projects?.filter((project) => project.status !== 'ARCHIVED') ?? [];
  const blockedTasks = live.reduce((sum, project) => sum + (project.taskCounts?.['BLOCKED'] ?? 0), 0);
  const spent = live.reduce((sum, project) => sum + project.spentUsd, 0);

  // Ba con số CEO cần trước khi đọc từng thẻ; `glass` khi nằm trên đầu trang chuyển sắc.
  const stats = (glass: boolean): React.JSX.Element => (
    <div className="grid grid-cols-3 gap-2.5">
      <StatTile glass={glass} tint={['#9a8cff', '#5b48e6']} icon={<Glyph name="folder" size={16} stroke={2} />} value={String(live.length)} label="Dự án" />
      <StatTile glass={glass} tint={['#fb7185', '#e11d48']} icon={<Glyph name="alert" size={16} stroke={2} />} value={String(blockedTasks)} label="Việc bị chặn" />
      <StatTile glass={glass} tint={['#fbbf24', '#d97706']} icon={<Glyph name="coin" size={16} stroke={2} />} value={money(spent, 2)} label="Đã tiêu" />
    </div>
  );

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Sản phẩm"
        title="Dự án"
        subtitle={visible ? `${visible.length} dự án · ${blockedTasks > 0 ? `${blockedTasks} việc đang bị chặn` : `${running} đang chạy`}` : undefined}
        hero={projects ? stats(true) : undefined}
        action={
          <>
            <Chip active={view === 'all'} onClick={() => setView('all')}>Tất cả {live.length}</Chip>
            <Chip active={view === 'running'} onClick={() => setView('running')}>Đang chạy {running}</Chip>
            {archived.length > 0 && (
              <Chip active={view === 'archived'} onClick={() => setView(view === 'archived' ? 'all' : 'archived')}>
                Đã lưu trữ {archived.length}
              </Chip>
            )}
            {/* Điện thoại giao việc bằng nút tròn giữa thanh tab. */}
            <span className="hidden sm:contents">
              <Button href="/command">
                <span className="text-base font-light leading-none">＋</span>
                Giao việc mới
              </Button>
            </span>
          </>
        }
      />
      <ErrorNote error={error} />

      {projects === null && <Skeleton rows={4} className="p-5" />}
      {visible?.length === 0 && view !== 'all' && <Empty message={view === 'running' ? 'Không có dự án nào đang chạy.' : 'Chưa có dự án nào được lưu trữ.'} />}
      {visible?.length === 0 && view === 'all' && (
        <Empty
          message="Chưa có dự án nào."
          hint="Vào Phòng điều hành và mô tả việc bạn muốn làm. CTO chia thành từng việc, bạn duyệt rồi công ty chạy."
          action={<Button href="/command">Giao việc đầu tiên</Button>}
        />
      )}

      {projects && <div className="hidden px-5 pt-5 sm:block">{stats(false)}</div>}

      <div className="grid gap-3.5 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
        {visible?.map((project) => {
          const ratio = project.spentUsd / Math.max(project.budgetUsd, 0.01);
          const counts = project.taskCounts ?? {};
          const done = counts['DONE'] ?? 0;
          const blocked = counts['BLOCKED'] ?? 0;
          const active = counts['IN_PROGRESS'] ?? 0;
          const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
          const paused = project.status === 'PAUSED_BUDGET';
          // CEO tự dừng: dải cam, khác dải đỏ "hết ngân sách" — không phải sự cố, chỉ đang chờ bấm Tiếp tục.
          const stopped = project.status === 'PAUSED';
          // Mô tả thường chính là câu CEO gõ vào ô giao việc, nên trùng luôn với
          // tên dự án. In hai lần chỉ tổ chiếm chỗ.
          const description = project.description === project.name ? null : project.description;
          return (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="pn-focus pn-lift depth-panel flex flex-col overflow-hidden rounded-[20px] border border-line bg-surface-1"
            >
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-center justify-between gap-2">
                  <Badge size="md" color={STATUS_COLOR[project.status]} dot>{PROJECT_STATUS_LABEL[project.status] ?? project.status}</Badge>
                  <Badge size="md">{PRODUCT_TYPE_LABEL[project.productType] ?? project.productType}</Badge>
                </div>

                <h2 className="mt-3 text-[15.5px] font-bold leading-snug tracking-[-0.01em] text-ink-100">{project.name}</h2>
                {description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{description}</p>}
                {project.repoFullName && <p className="mt-1 truncate font-mono text-[10px] text-ink-500">{project.repoFullName}</p>}

                <div className="mt-auto space-y-3 pt-4">
                  <StageStrip projectId={project.id} />
                  {total > 0 && (
                    <Meter
                      label={active > 0 ? `Tiến độ · ${active} đang làm` : 'Tiến độ'}
                      value={`${done}/${total} việc`}
                      share={done / total}
                      fill="bg-[linear-gradient(90deg,#2dd4bf,#22c55e)]"
                    />
                  )}
                  <Meter
                    label="Ngân sách"
                    value={`${money(project.spentUsd, 2)} / ${money(project.budgetUsd)}`}
                    share={Math.min(1, ratio)}
                    fill={ratio >= 1 ? 'bg-state-alert' : ratio >= 0.8 ? 'bg-state-blocked' : 'bg-[linear-gradient(90deg,#f59e0b,#d97706)]'}
                  />
                </div>
              </div>

              {(blocked > 0 || paused || stopped) && (
                <div className={`flex items-center gap-2.5 px-4 py-2.5 text-[12.5px] font-semibold ${paused ? 'pn-strip-alert' : 'pn-strip-warn'}`}>
                  <Tile3D tint={paused ? ['#fb7185', '#e11d48'] : ['#fb923c', '#ea580c']} size={26} radius={8}>
                    <Glyph name="alert" size={14} stroke={2.2} />
                  </Tile3D>
                  {paused ? 'Dừng vì hết ngân sách' : stopped ? 'Đã dừng — mở để bấm Tiếp tục' : `${blocked} việc đang bị chặn`}
                  <span className="ml-auto font-bold">Xem ›</span>
                </div>
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** Một thước có nhãn trái, số phải — tiến độ việc hoặc ngân sách. */
function Meter({ label, value, share, fill }: { label: string; value: string; share: number; fill: string }): React.JSX.Element {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11.5px] font-medium text-ink-500">
        <span className="truncate">{label}</span>
        <span className="shrink-0 font-mono text-xs font-semibold tabular-nums text-ink-100">{value}</span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-fill-2 shadow-[inset_0_1px_2px_rgba(20,40,63,0.08)]">
        <div className={`h-full rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.45)] transition-[width] duration-500 ${fill}`} style={{ width: `${Math.max(0, share) * 100}%` }} />
      </div>
    </div>
  );
}
