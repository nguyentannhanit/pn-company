/**
 * P&N — Chi tiết dự án (§12, §13).
 *
 * Một màn hình trả lời hết: task đang ở đâu, lỗi nào đang mở, tốn bao nhiêu,
 * Git đã làm gì. Bảng task xếp theo cột trạng thái đúng như §13.
 */

'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Stat } from '@/components/ui';
import { api, type BugRow, type ProjectRow, type TaskRow } from '@/lib/api';
import { PRODUCT_TYPE_LABEL, PROJECT_STATUS_LABEL, TASK_STATUS_LABEL, money, roleLabel } from '@/lib/brand';
import { useRealtime } from '@/lib/store';

interface GitEventRow {
  id: string;
  type: string;
  branch: string | null;
  summary: string;
  createdAt: string;
}

interface RunRow {
  id: string;
  status: string;
  errorMessage: string | null;
  stderr: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface MessageRow {
  id: string;
  author: string;
  role: string;
  content: string;
  createdAt: string;
}

interface TaskDetail {
  task: TaskRow;
  runs: RunRow[];
  messages: MessageRow[];
}

interface Detail {
  project: ProjectRow;
  tasks: TaskRow[];
  bugs: BugRow[];
  cost: { costUsd: number; calls: number; unpricedCalls: number };
  budget: { limitUsd: number; spentUsd: number; ratio: number; exceeded: boolean } | null;
  gitEvents: GitEventRow[];
}

/** §13 — thứ tự cột trên bảng task. */
const COLUMNS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'] as const;

/** Việc tạm dừng nằm ở cột Chờ làm, việc đã bỏ nằm ở cột Xong — kèm nhãn riêng, không thêm cột cho bảng khỏi chật. */
function columnOf(status: string): string {
  if (status === 'PAUSED') return 'TODO';
  if (status === 'CANCELLED') return 'DONE';
  return status;
}

const SEVERITY_LABEL: Record<string, string> = { LOW: 'Nhẹ', MEDIUM: 'Vừa', HIGH: 'Nặng', CRITICAL: 'Nghiêm trọng' };
const SEVERITY_COLOR: Record<string, string> = {
  LOW: 'var(--tone-blue)',
  MEDIUM: 'var(--tone-amber)',
  HIGH: 'var(--tone-orange)',
  CRITICAL: 'var(--tone-red)',
};

export default function ProjectDetailPage(): React.JSX.Element {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { lastEventAt } = useRealtime();
  // Khung "Làm lại dự án": danh sách bước của quy trình và bước đang chọn.
  const [redo, setRedo] = useState<{ stages: Array<{ id: string; description: string }>; from: string } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Task đang mở để xem chi tiết. Không có màn này thì task BLOCKED chỉ là một
  // ô đứng im, còn lý do thật nằm khuất trong luồng tin nhắn dưới database.
  const [openTask, setOpenTask] = useState<TaskDetail | null>(null);

  const load = useCallback(() => {
    api<Detail>(`/projects/${params.id}`)
      .then(setDetail)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Không tải được dự án'),
      );
  }, [params.id]);

  useEffect(load, [load, lastEventAt]);

  const openTaskDetail = (id: string): void => {
    api<TaskDetail>(`/tasks/${id}`)
      .then(setOpenTask)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Không tải được việc'),
      );
  };

  /** Duyệt kế hoạch CTO đã lập: dự án chuyển sang chạy thật (§26). */
  const approvePlan = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/approve-plan`, { method: 'POST' });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không duyệt được');
    } finally {
      setBusy(false);
    }
  };

  const advance = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/advance`, { method: 'POST', body: {} });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không chạy tiếp được');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Dừng dự án (trước đây phải tắt CLI/API bằng tay): lượt AI và bản dựng đang chạy bị cắt ngay, không nhận
   * việc mới. Tạm dừng thì bấm "Tiếp tục" làm nối; dừng hẳn thì không tự chạy nữa, làm tiếp bằng "Làm lại dự án".
   */
  const stop = async (mode: 'pause' | 'cancel'): Promise<void> => {
    const name = detail?.project.name ?? '';
    const question =
      mode === 'pause'
        ? `Tạm dừng dự án "${name}"? Lượt AI đang chạy bị cắt ngay; tệp đã viết và tiến độ vẫn giữ để bấm Tiếp tục làm nối.`
        : `Dừng hẳn dự án "${name}"? Mọi lượt AI và bản dựng bị cắt, dự án không tự chạy nữa. Mã đã viết vẫn giữ — muốn làm tiếp thì bấm "Làm lại dự án".`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/stop`, { method: 'POST', body: { mode } });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không dừng được');
    } finally {
      setBusy(false);
    }
  };

  const resume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/resume`, { method: 'POST', body: {} });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tiếp tục được');
    } finally {
      setBusy(false);
    }
  };

  /** Mở khung chọn bước làm lại; mặc định bước Sản phẩm (giữ bản phân rã của CTO). */
  const openRedo = async (): Promise<void> => {
    try {
      const { stages } = await api<{ stages: Array<{ id: string; description: string }> }>(`/projects/${params.id}/stages`);
      setRedo({ stages, from: stages.find((stage) => stage.id === 'product')?.id ?? stages[0]?.id ?? '' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải được các bước');
    }
  };

  /** Làm lại dự án từ bước đã chọn: các bước từ đó chạy lại theo quy trình mới. */
  const runRedo = async (): Promise<void> => {
    if (!redo) return;
    const stage = redo.stages.find((item) => item.id === redo.from);
    const touchesBuild = redo.stages.findIndex((item) => item.id === redo.from) <= redo.stages.findIndex((item) => item.id === 'build');
    if (
      !window.confirm(
        `Làm lại dự án từ bước "${stage?.description}"? Các việc từ bước này trở đi sẽ chạy lại` +
          (touchesBuild ? '; mã nguồn cũ được cất sang thư mục lưu (không xoá).' : '.'),
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/redo`, { method: 'POST', body: { fromStage: redo.from } });
      setRedo(null);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không làm lại được');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Xoá hẳn dự án (dự án lỗi không muốn giữ). Không lấy lại được
   * nên phải gõ đúng tên. Chi phí đã tiêu vẫn giữ trong sổ chi phí.
   */
  const remove = async (): Promise<void> => {
    const name = detail?.project.name ?? '';
    const typed = window.prompt(
      `Xoá vĩnh viễn dự án "${name}"? Việc, trao đổi, mã nguồn và sản phẩm sẽ mất, không lấy lại được. ` +
        'Chi phí đã tiêu vẫn giữ trong sổ.\n\nGõ đúng tên dự án để xác nhận:',
    );
    if (typed === null) return;
    if (typed.trim() !== name) {
      setError('Tên gõ vào không khớp — chưa xoá gì.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}`, { method: 'DELETE' });
      router.push('/projects');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không xoá được');
      setBusy(false);
    }
  };

  // Lưu trữ đưa dự án ra khỏi danh sách đang chạy và văn phòng 3D nhưng vẫn giữ để
  // tra lại; muốn bỏ hẳn thì dùng "Xoá dự án".
  const archive = async (): Promise<void> => {
    if (!window.confirm(`Lưu trữ dự án "${detail?.project.name}"? Nó sẽ rời khỏi danh sách đang chạy.`))
      return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${params.id}/status`, { method: 'PATCH', body: { status: 'ARCHIVED' } });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không lưu trữ được');
    } finally {
      setBusy(false);
    }
  };

  // Task hỏng vì thiếu cấu hình (chưa có định tuyến, key sai) thì sau khi CEO
  // sửa cấu hình phải chạy lại được đúng bước đó, không phải tạo lại dự án.
  // Sản phẩm do API phục vụ ở /product/<slug>/ sau khi Deploy → Staging dựng xong.
  const openProduct = async (): Promise<void> => {
    try {
      const { url } = await api<{ url: string }>(`/projects/${params.id}/product-link`);
      window.open(url, '_blank', 'noopener');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không mở được sản phẩm');
    }
  };

  /** Tạm dừng hay bỏ riêng một việc; dự án vẫn chạy các việc khác. */
  const stopTask = async (id: string, mode: 'pause' | 'cancel'): Promise<void> => {
    if (mode === 'cancel' && !window.confirm('Bỏ hẳn việc này? Lượt đang chạy bị cắt, dự án đi tiếp mà không đợi việc này nữa.')) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/tasks/${id}/stop`, { method: 'POST', body: { mode } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không dừng được việc');
    } finally {
      setBusy(false);
      openTaskDetail(id);
      load();
    }
  };

  const retryTask = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Chạy nền: một lượt qua gói Claude mất nhiều phút; trang tự cập nhật qua realtime khi việc xong.
      await api(`/tasks/${id}/run`, { method: 'POST', body: {} });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không chạy lại được');
    } finally {
      setBusy(false);
      openTaskDetail(id);
      load();
    }
  };

  if (!detail) {
    return (
      <div>
        <PageHeader title="Dự án" />
        <ErrorNote error={error} />
        {!error && <Empty message="Đang tải…" />}
      </div>
    );
  }

  const stopped = detail.project.status === 'PAUSED';
  const cancelled = detail.project.status === 'CANCELLED';
  const canStop = !stopped && !['COMPLETED', 'ARCHIVED', 'CANCELLED'].includes(detail.project.status);
  const openBugs = detail.bugs.filter(
    (bug) => bug.status === 'OPEN' || bug.status === 'IN_PROGRESS',
  );

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow={PRODUCT_TYPE_LABEL[detail.project.productType] ?? detail.project.productType}
        title={detail.project.name}
        subtitle={PROJECT_STATUS_LABEL[detail.project.status] ?? detail.project.status}
        action={
          <div className="flex gap-2">
            <Button variant="quiet" onClick={() => void openProduct()}>
              Mở sản phẩm
            </Button>
            {detail.project.status !== 'ARCHIVED' && (
              <Button variant="quiet" onClick={() => void archive()} disabled={busy}>
                Lưu trữ
              </Button>
            )}
            <Button variant="quiet" onClick={() => void remove()} disabled={busy}>
              Xoá dự án
            </Button>
            <Button variant="quiet" onClick={() => void openRedo()} disabled={busy}>
              Làm lại dự án
            </Button>
            {canStop && (
              <Button variant="quiet" onClick={() => void stop('pause')} disabled={busy}>
                Tạm dừng
              </Button>
            )}
            {(canStop || stopped) && (
              <Button variant="danger" onClick={() => void stop('cancel')} disabled={busy}>
                Dừng hẳn
              </Button>
            )}
            {stopped ? (
              <Button onClick={() => void resume()} disabled={busy}>
                {busy ? 'Đang xếp việc…' : 'Tiếp tục'}
              </Button>
            ) : (
              !cancelled && (
                <Button onClick={() => void advance()} disabled={busy}>
                  {busy ? 'Đang xếp việc…' : 'Chạy tiếp'}
                </Button>
              )
            )}
          </div>
        }
      />
      <ErrorNote error={error} />

      {stopped && (
        <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--tone-orange)_40%,var(--line))] bg-[color-mix(in_srgb,var(--tone-orange)_8%,var(--panel))] px-4 py-3 text-sm">
          <span className="flex-1 text-ink-100">
            Dự án đang dừng — không nhân viên nào làm việc của dự án này. Tệp đã viết và tiến độ vẫn giữ; bấm Tiếp tục là
            việc dở chạy nối từ chỗ đã dừng.
          </span>
          <Button onClick={() => void resume()} disabled={busy}>Tiếp tục</Button>
        </div>
      )}

      {cancelled && (
        <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-fill-1 px-4 py-3 text-sm">
          <span className="flex-1 text-ink-100">
            Dự án đã dừng hẳn — không nhân viên nào làm việc của dự án này và nó không tự chạy lại. Mã đã viết vẫn giữ; muốn
            làm tiếp thì chọn bước ở "Làm lại dự án".
          </span>
          <Button variant="quiet" onClick={() => void openRedo()} disabled={busy}>Làm lại dự án</Button>
        </div>
      )}

      {detail.project.status === 'PLANNING' && (
        <PlanningBanner tasks={detail.tasks} busy={busy} onApprove={() => void approvePlan()} />
      )}

      {redo && (
        <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-fill-1 px-4 py-3 text-sm">
          <label htmlFor="redoFrom" className="font-medium text-ink-100">Làm lại từ bước</label>
          <select
            id="redoFrom"
            value={redo.from}
            onChange={(event) => setRedo({ ...redo, from: event.target.value })}
            className="rounded-lg border border-line bg-surface-1 px-3 py-2 text-ink-100"
          >
            {redo.stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.description}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-500">Các bước sau nó cũng chạy lại theo thứ tự.</span>
          <span className="flex-1" />
          <Button variant="quiet" onClick={() => setRedo(null)} disabled={busy}>
            Thôi
          </Button>
          <Button onClick={() => void runRedo()} disabled={busy || !redo.from}>
            {busy ? 'Đang xếp việc…' : 'Làm lại'}
          </Button>
        </div>
      )}

      <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Việc"
          value={`${detail.tasks.filter((task) => task.status === 'DONE').length}/${detail.tasks.length}`}
          hint="đã xong"
        />
        <Stat
          label="Lỗi đang mở"
          value={String(openBugs.length)}
          tone={openBugs.length > 0 ? 'alert' : 'default'}
        />
        <Stat
          label="Chi phí"
          value={money(detail.cost.costUsd, 4)}
          hint={`${detail.cost.calls} lượt gọi model`}
          tone="produce"
        />
        <Stat
          label="Ngân sách"
          value={detail.budget ? `${Math.round(detail.budget.ratio * 100)}%` : '—'}
          hint={detail.budget ? `trần ${money(detail.budget.limitUsd)}` : undefined}
          tone={detail.budget?.exceeded ? 'alert' : 'default'}
        />
      </div>

      {/* §16 — nói rõ phần chưa tính được tiền thay vì báo con số thiếu */}
      {detail.cost.unpricedCalls > 0 && (
        <p className="mx-5 rounded-md bg-produce-600/10 px-3 py-2 text-xs text-produce-400">
          {detail.cost.unpricedCalls} lượt gọi dùng model chưa cấu hình giá nên chưa tính vào tổng.
        </p>
      )}

      {/* §13 — bảng task */}
      <section className="px-5 pt-5">
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
          Bảng công việc
        </h2>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const tasks = detail.tasks.filter((task) => columnOf(task.status) === column);
            return (
              <div key={column} className="rounded-lg border border-base-700 bg-base-800/50 p-2.5">
                <p className="mb-2 flex items-baseline justify-between text-xs">
                  <span className="text-ink-300">{TASK_STATUS_LABEL[column]}</span>
                  <span className="text-ink-500">{tasks.length}</span>
                </p>
                <div className="space-y-1.5">
                  {tasks.map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => openTaskDetail(task.id)}
                      className="w-full rounded border border-base-700 bg-base-800 p-2 text-left hover:border-produce-600"
                    >
                      <p className="text-xs leading-snug text-ink-100">{task.title}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {task.assignedRole && <Badge>{roleLabel(task.assignedRole)}</Badge>}
                        {task.fixLoopCount > 0 && (
                          <Badge color="var(--tone-orange)">sửa lần {task.fixLoopCount}</Badge>
                        )}
                        {column === 'BLOCKED' && <Badge color="var(--tone-orange)">xem lý do</Badge>}
                        {task.status === 'PAUSED' && <Badge color="var(--tone-amber)">tạm dừng</Badge>}
                        {task.status === 'CANCELLED' && <Badge color="var(--tone-dim)">đã bỏ</Badge>}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-3 p-5 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Lỗi đang mở
          </h2>
          {openBugs.length === 0 ? (
            <p className="text-xs text-ink-500">Không có lỗi nào đang mở.</p>
          ) : (
            <div className="space-y-2">
              {openBugs.map((bug) => (
                <div key={bug.id}>
                  <p className="flex items-center gap-2 text-xs text-ink-100">
                    <Badge color={SEVERITY_COLOR[bug.severity]}>{SEVERITY_LABEL[bug.severity] ?? bug.severity}</Badge>
                    {bug.title}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-500">
                    {bug.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        {/* §17 — dấu vết Git của dự án */}
        <Card>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
            Hoạt động Git
          </h2>
          {detail.gitEvents.length === 0 ? (
            <p className="text-xs text-ink-500">
              Chưa có hoạt động Git. Cấu hình repo trong Cài đặt để agent commit được.
            </p>
          ) : (
            <div className="space-y-1.5">
              {detail.gitEvents.map((event) => (
                <div key={event.id} className="flex gap-2 text-xs">
                  <span className="shrink-0 text-ink-500">
                    {new Date(event.createdAt).toLocaleTimeString('vi-VN')}
                  </span>
                  <span className="text-ink-300">{event.summary}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {openTask && (
        <TaskDrawer
          detail={openTask}
          busy={busy}
          onRetry={() => void retryTask(openTask.task.id)}
          onStop={(mode) => void stopTask(openTask.task.id, mode)}
          onClose={() => setOpenTask(null)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Chi tiết một task                                                           */
/* -------------------------------------------------------------------------- */

/**
 * §13, §28 — toàn bộ dấu vết của một task: các lần chạy và trao đổi giữa agent.
 * Đây là chỗ trả lời câu "sao task này đứng im", nên lỗi của lần chạy hỏng được
 * đặt lên đầu chứ không chôn dưới cuối danh sách.
 */
function TaskDrawer({
  detail,
  busy,
  onRetry,
  onStop,
  onClose,
}: {
  detail: TaskDetail;
  busy: boolean;
  onRetry: () => void;
  onStop: (mode: 'pause' | 'cancel') => void;
  onClose: () => void;
}): React.JSX.Element {
  const failed = detail.runs.filter((run) => run.errorMessage || run.status === 'FAILED');
  const status = detail.task.status;
  // Task đã xong thì không chạy lại dù có lần chạy hỏng cũ: bấm nhầm là CTO
  // phân rã lần nữa và dự án có hai bộ task trùng nhau.
  const retryable = status !== 'DONE' && status !== 'PAUSED' && (failed.length > 0 || status === 'BLOCKED' || status === 'CANCELLED');
  // Việc chưa xong, chưa bỏ thì dừng được: đang chạy thì cắt lượt, chưa tới lượt thì không cho chạy nữa.
  const stoppable = !['DONE', 'CANCELLED'].includes(status);

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-base-700 bg-base-900 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 flex items-start justify-between gap-3 border-b border-base-700 bg-base-900 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-ink-500">
              {TASK_STATUS_LABEL[detail.task.status] ?? detail.task.status}
            </p>
            <h2 className="mt-1 text-sm font-semibold text-ink-100">{detail.task.title}</h2>
            <div className="mt-2 flex flex-wrap gap-1">
              {detail.task.assignedRole && <Badge>{roleLabel(detail.task.assignedRole)}</Badge>}
              {detail.task.fixLoopCount > 0 && (
                <Badge color="var(--tone-orange)">sửa lần {detail.task.fixLoopCount}</Badge>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-xs text-ink-500 hover:bg-base-700 hover:text-ink-100"
          >
            Đóng
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          {failed.length > 0 && (
            <div className="rounded-md border border-state-alert/30 bg-state-alert/10 p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-state-alert">
                Lần chạy thất bại
              </p>
              {failed.map((run) => (
                <p
                  key={run.id}
                  className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-100"
                >
                  {run.errorMessage ?? run.stderr ?? 'Không có thông báo lỗi.'}
                </p>
              ))}
            </div>
          )}

          {retryable && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-base-700 bg-base-800/60 p-3">
              <p className="text-xs leading-relaxed text-ink-300">
                {status === 'CANCELLED'
                  ? 'Việc này đã bị bỏ. Chạy lại nếu muốn đưa nó trở lại dự án.'
                  : 'Đã sửa cấu hình (định tuyến model, API key)? Chạy lại đúng bước này, không cần tạo lại dự án.'}
              </p>
              <Button size="sm" variant="quiet" onClick={onRetry} disabled={busy}>
                {busy ? 'Đang chạy…' : 'Chạy lại'}
              </Button>
            </div>
          )}

          {stoppable && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-base-700 bg-base-800/60 p-3">
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-300">
                {status === 'PAUSED'
                  ? 'Việc đang tạm dừng — tệp đã viết và tiến độ vẫn giữ. Tiếp tục thì làm nối từ chỗ dừng.'
                  : 'Tạm dừng: cắt lượt đang chạy, giữ tiến độ. Dừng hẳn: bỏ việc này, dự án đi tiếp phần còn lại.'}
              </p>
              <div className="flex gap-2">
                {status === 'PAUSED' ? (
                  <Button size="sm" onClick={onRetry} disabled={busy}>
                    Tiếp tục
                  </Button>
                ) : (
                  <Button size="sm" variant="quiet" onClick={() => onStop('pause')} disabled={busy}>
                    Tạm dừng
                  </Button>
                )}
                <Button size="sm" variant="danger" onClick={() => onStop('cancel')} disabled={busy}>
                  Dừng hẳn
                </Button>
              </div>
            </div>
          )}

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Mô tả
            </h3>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-300">
              {detail.task.description || 'Không có mô tả.'}
            </p>
          </section>

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Trao đổi ({detail.messages.length})
            </h3>
            {detail.messages.length === 0 ? (
              <p className="text-xs text-ink-500">Chưa có trao đổi nào.</p>
            ) : (
              <div className="space-y-2.5">
                {detail.messages.map((message) => (
                  <div
                    key={message.id}
                    className="rounded-md border border-base-700 bg-base-800/60 p-2.5"
                  >
                    <p className="flex items-baseline justify-between gap-2 text-[11px] text-ink-500">
                      <span className="font-medium text-ink-300">{message.author}</span>
                      <span>{new Date(message.createdAt).toLocaleString('vi-VN')}</span>
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-ink-100">
                      {message.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Lịch sử chạy ({detail.runs.length})
            </h3>
            {detail.runs.length === 0 ? (
              <p className="text-xs text-ink-500">Việc này chưa được chạy lần nào.</p>
            ) : (
              <div className="space-y-1.5">
                {detail.runs.map((run) => (
                  <p key={run.id} className="flex items-center gap-2 text-xs text-ink-300">
                    <Badge color={run.status === 'FAILED' ? 'var(--tone-red)' : undefined}>
                      {run.status}
                    </Badge>
                    <span className="text-ink-500">
                      {run.startedAt
                        ? new Date(run.startedAt).toLocaleString('vi-VN')
                        : 'chưa bắt đầu'}
                    </span>
                  </p>
                ))}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

/**
 * Dự án đứng ở PLANNING: hoặc CTO còn đang phân rã, hoặc kế hoạch đã xong và chờ CEO duyệt mới chạy. Trước
 * Trước đây trang chỉ ghi "Đang lập kế hoạch" nên CEO không biết dự án đang chờ mình bấm duyệt.
 */
function PlanningBanner({ tasks, busy, onApprove }: { tasks: TaskRow[]; busy: boolean; onApprove: () => void }): React.JSX.Element {
  const planning = tasks.some((task) => task.assignedRole === 'CTO_ORCHESTRATOR' && (task.status === 'TODO' || task.status === 'IN_PROGRESS'));
  const work = tasks.filter((task) => task.assignedRole !== 'CTO_ORCHESTRATOR').length;
  return (
    <div className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--tone-blue)_35%,var(--line))] bg-[color-mix(in_srgb,var(--tone-blue)_8%,var(--panel))] px-4 py-3 text-sm">
      <span className="flex-1 text-ink-100">
        {planning
          ? 'CTO đang lập kế hoạch (qua gói Claude thường 2–5 phút). Trang tự cập nhật khi xong.'
          : `Kế hoạch đã xong: ${work} việc cho các phòng. Dự án chờ bạn duyệt mới bắt đầu, chưa việc nào chạy.`}
      </span>
      {!planning && (
        <Button onClick={onApprove} disabled={busy}>
          Duyệt và bắt đầu
        </Button>
      )}
    </div>
  );
}
