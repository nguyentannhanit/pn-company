/**
 * P&N — Task của toàn công ty (§13).
 *
 * Khác với bảng task trong từng dự án, màn hình này gom hết lại để CEO thấy đội
 * đang bị dồn ở đâu: gom theo dự án, lọc theo trạng thái và theo phòng, vạch màu
 * bên trái nói lên trạng thái không cần đọc chữ.
 *
 * Việc kẹt đứng riêng lên đầu, gom theo NGUYÊN NHÂN: năm việc kẹt vì
 * cùng hết lượt model là một vấn đề, sửa một lần bằng "Chạy lại cả nhóm".
 */

'use client';

import { useEffect, useRef, useState } from 'react';

import { AGENT_PROFILES, type FailureKind } from '@pn/shared';

import { Badge, Button, Chip, Empty, ErrorNote, PageHeader, RowLink, Section, Skeleton } from '@/components/ui';
import { api, type ProjectRow, type TaskRow } from '@/lib/api';
import { DEPARTMENT_LABEL, TASK_STATUS_LABEL, roleLabel } from '@/lib/brand';
import { rerunTask, useBlocked, type BlockedItem } from '@/lib/insights';
import { useRealtime } from '@/lib/store';

/** Phòng của một vai trò, để lọc việc theo phòng. */
const departmentOf = (role: string | null): string | null =>
  role ? ((AGENT_PROFILES as Record<string, { department: string }>)[role]?.department ?? null) : null;

/** Thứ tự nhóm nguyên nhân: thứ CEO phải tự tay xử lý (tiền, khoá, ngân sách) lên trước. */
const CAUSE_ORDER: FailureKind[] = ['credit', 'auth', 'budget', 'no-route', 'quota', 'overloaded', 'bad-output', 'timeout', 'restart', 'code', 'unknown'];

/** Một nhóm việc kẹt cùng nguyên nhân, có nút chạy lại cả nhóm. */
function CauseGroup({ items, onDone }: { items: BlockedItem[]; onDone: () => void }): React.JSX.Element {
  const first = items[0]!;
  const [progress, setProgress] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Bấm Dừng giữa vòng: không xếp thêm việc nào nữa (việc đã xếp thì dừng từng việc ở trang dự án).
  const halt = useRef(false);
  const runAll = async (): Promise<void> => {
    setRunning(true);
    halt.current = false;
    let ok = 0;
    // Lần lượt từng việc: chạy song song chính là thứ làm gói miễn phí hết lượt.
    for (const [index, item] of items.entries()) {
      if (halt.current) break;
      setProgress(`Đang chạy ${index + 1}/${items.length}…`);
      if ((await rerunTask(item.taskId)).ok) ok += 1;
    }
    setProgress(halt.current ? `Đã dừng: ${ok}/${items.length} việc đã xếp chạy` : `Xong: ${ok}/${items.length} việc chạy được`);
    setRunning(false);
    onDone();
  };
  const settings = first.explained.action === 'settings';
  return (
    <article className="rounded-2xl border border-[color-mix(in_srgb,var(--tone-orange)_45%,transparent)] bg-[color-mix(in_srgb,var(--tone-orange)_7%,var(--panel))] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink-100">
            <span className="mr-1.5 text-[color:var(--tone-orange)]">⚑</span>
            {first.explained.title}
            <span className="ml-2 text-xs font-medium text-ink-500">{items.length} việc</span>
          </p>
          <p className="mt-1 max-w-[70ch] text-xs leading-relaxed text-ink-300">{first.explained.detail}</p>
        </div>
        {settings ? (
          <Button size="sm" variant="quiet" href="/settings">Mở Cài đặt</Button>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void runAll()} loading={running}>
              {items.length > 1 ? 'Chạy lại cả nhóm' : 'Chạy lại'}
            </Button>
            {running && items.length > 1 && (
              <Button size="sm" variant="danger" onClick={() => (halt.current = true)}>
                Dừng
              </Button>
            )}
          </div>
        )}
      </div>
      {progress && <p className="mt-2 text-xs text-ink-300">{progress}</p>}
      <ul className="mt-3 space-y-1">
        {items.map((item) => (
          <li key={item.taskId} className="flex flex-wrap items-baseline gap-x-2 text-xs">
            <a href={`/projects/${item.projectId}`} className="font-medium text-ink-100 hover:underline">{item.title}</a>
            <span className="text-ink-500">
              {item.role ? roleLabel(item.role) : 'chưa giao'} · {item.projectName}
              {item.explained.model && ` · ${item.explained.model}`}
              {item.failedRuns > 1 && ` · đã thử ${item.failedRuns} lần`}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

interface Entry extends TaskRow {
  projectName: string;
}

const STATUS_COLOR: Record<string, string> = {
  IN_PROGRESS: 'var(--tone-green)',
  REVIEW: 'var(--tone-blue)',
  BLOCKED: 'var(--tone-orange)',
  PAUSED: 'var(--tone-amber)',
  TODO: 'var(--tone-gray)',
  BACKLOG: 'var(--tone-dim)',
};

type Filter = 'open' | 'IN_PROGRESS' | 'BLOCKED' | 'TODO' | 'PAUSED';

export default function TasksPage(): React.JSX.Element {
  const { lastEventAt } = useRealtime();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [room, setRoom] = useState<string | null>(null);
  const { items: blocked, reload } = useBlocked();

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const { projects } = await api<{ projects: ProjectRow[] }>('/projects');
        const lists = await Promise.all(
          projects
            .filter((project) => project.status !== 'ARCHIVED')
            .map(async (project) => {
              const result = await api<{ tasks: TaskRow[] }>(`/projects/${project.id}/tasks`);
              return result.tasks.map((task) => ({ ...task, projectName: project.name }));
            }),
        );
        setEntries(lists.flat());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Không tải được danh sách việc');
      }
    };
    void load();
  }, [lastEventAt]);

  const inRoom = (role: string | null): boolean => room === null || departmentOf(role) === room;
  const open = entries?.filter((task) => task.status !== 'DONE' && task.status !== 'CANCELLED' && inRoom(task.assignedRole)) ?? [];
  // Các phòng đang có việc mở, để làm chip lọc.
  const rooms = [...new Set((entries ?? []).filter((task) => task.status !== 'DONE' && task.status !== 'CANCELLED').map((task) => departmentOf(task.assignedRole)).filter((id): id is string => !!id))];
  const causes = new Map<FailureKind, BlockedItem[]>();
  for (const item of blocked.filter((entry) => inRoom(entry.role))) {
    causes.set(item.explained.kind, [...(causes.get(item.explained.kind) ?? []), item]);
  }
  const count = (status: string): number => open.filter((task) => task.status === status).length;
  const shown = filter === 'open' ? open : open.filter((task) => task.status === filter);

  const byProject = new Map<string, Entry[]>();
  for (const task of shown) byProject.set(task.projectName, [...(byProject.get(task.projectName) ?? []), task]);

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Vận hành"
        title="Công việc"
        subtitle={entries ? `${open.length} việc chưa xong` : undefined}
        action={
          <div className="flex gap-1.5">
            <Chip active={filter === 'open'} onClick={() => setFilter('open')}>Tất cả {open.length}</Chip>
            <Chip active={filter === 'IN_PROGRESS'} onClick={() => setFilter('IN_PROGRESS')}>Đang làm {count('IN_PROGRESS')}</Chip>
            <Chip active={filter === 'BLOCKED'} onClick={() => setFilter('BLOCKED')}>Bị chặn {count('BLOCKED')}</Chip>
            <Chip active={filter === 'TODO'} onClick={() => setFilter('TODO')}>Chờ {count('TODO')}</Chip>
            {count('PAUSED') > 0 && (
              <Chip active={filter === 'PAUSED'} onClick={() => setFilter('PAUSED')}>Tạm dừng {count('PAUSED')}</Chip>
            )}
          </div>
        }
      />
      <ErrorNote error={error} />

      {rooms.length > 1 && (
        <div className="flex flex-wrap gap-1.5 px-5 pt-4" role="group" aria-label="Lọc theo phòng">
          <Chip active={room === null} onClick={() => setRoom(null)}>Mọi phòng</Chip>
          {rooms.map((id) => (
            <Chip key={id} active={room === id} onClick={() => setRoom(id)}>
              {DEPARTMENT_LABEL[id] ?? id}
            </Chip>
          ))}
        </div>
      )}

      {causes.size > 0 && (
        <div className="px-5 pt-5">
          <Section title="Đang kẹt" description="Gom theo nguyên nhân — sửa một nguyên nhân là gỡ được cả nhóm">
            <div className="grid gap-3 lg:grid-cols-2">
              {CAUSE_ORDER.filter((kind) => causes.has(kind)).map((kind) => (
                <CauseGroup key={kind} items={causes.get(kind)!} onDone={reload} />
              ))}
            </div>
          </Section>
        </div>
      )}

      {entries === null && <Skeleton rows={5} className="p-5" />}
      {entries !== null && shown.length === 0 && (
        <Empty message={filter === 'open' ? 'Không còn việc nào đang mở.' : 'Không có việc nào ở trạng thái này.'} />
      )}

      <div className="space-y-6 p-5">
        {[...byProject.entries()].map(([projectName, tasks]) => (
          <Section key={projectName} title={projectName} description={`${tasks.length} việc`}>
            <div className="space-y-1.5">
              {tasks.map((task) => (
                <RowLink
                  key={task.id}
                  href={`/projects/${task.projectId}`}
                  stripe={STATUS_COLOR[task.status] ?? 'var(--tone-gray)'}
                  title={task.title}
                  meta={task.assignedRole ? roleLabel(task.assignedRole) : 'chưa giao'}
                  trailing={
                    <>
                      {task.fixLoopCount > 0 && <Badge color="var(--tone-orange)">sửa {task.fixLoopCount}</Badge>}
                      <Badge color={STATUS_COLOR[task.status]} dot>{TASK_STATUS_LABEL[task.status] ?? task.status}</Badge>
                    </>
                  }
                />
              ))}
            </div>
          </Section>
        ))}
      </div>
    </div>
  );
}
