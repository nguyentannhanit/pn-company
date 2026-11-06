/**
 * P&N — CEO Command Center (§26).
 *
 * Khác ô "Giao việc mới" ở trang Tổng quan ở đúng một điểm quan trọng: ở đó CEO
 * gõ xong là công ty chạy luôn. Ở đây CTO trả kế hoạch kèm ước tính chi phí, và
 * chỉ chạy khi CEO bấm Duyệt — đúng ba nút APPROVE / EDIT / CANCEL của §26.
 *
 * Cuộc trò chuyện chỉ sống trong phiên xem này; lịch sử thật nằm ở từng dự án.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Badge, Button, Card, ErrorNote, PageHeader } from '@/components/ui';
import { api, type ProjectRow, type TaskRow } from '@/lib/api';
import { PRODUCT_TYPE_LABEL, money, roleLabel } from '@/lib/brand';

interface PlanEstimate {
  costUsd: number;
  unpricedTasks: number;
  estimatedRuns: number;
  assumption: string;
}

interface Proposal {
  project: ProjectRow;
  tasks: TaskRow[];
  plan: string;
  estimate: PlanEstimate;
}

/** Trạng thái kế hoạch từ GET /projects/:id/plan. */
interface PlanState {
  project: ProjectRow;
  tasks: TaskRow[];
  planning: boolean;
  plan: string | null;
  failed: string | null;
  estimate: PlanEstimate;
}

/**
 * Hỏi lại kế hoạch 3 giây một lần tới khi CTO xong. CTO chạy qua gói Claude mất vài phút; giữ một request
 * chờ suốt thời gian đó thì đường hầm Cloudflare cắt sau 100 giây và người dùng mất kế hoạch. Mạng chập
 * chờn vài lượt vẫn hỏi tiếp; hỏng liền 5 lượt mới báo lỗi.
 */
async function waitForPlan(projectId: string): Promise<PlanState> {
  let failures = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const state = await api<PlanState>(`/projects/${projectId}/plan`);
      failures = 0;
      if (!state.planning) return state;
    } catch (caught) {
      failures += 1;
      if (failures >= 5) throw caught;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('CTO lập kế hoạch quá lâu. Mở trang dự án để xem tiến độ.');
}

const toProposal = (state: PlanState): Proposal | null =>
  state.plan ? { project: state.project, tasks: state.tasks, plan: state.plan, estimate: state.estimate } : null;

/** Một lượt trao đổi trong khung chat. */
type Turn =
  | { kind: 'ceo'; text: string }
  | { kind: 'cto'; proposal: Proposal }
  | { kind: 'note'; text: string };

/** Ví dụ bấm là điền, mỗi cái một loại sản phẩm để CEO thấy công ty làm được gì. */
const EXAMPLES: Array<{ goal: string; productType: string }> = [
  { goal: 'Làm web đặt bàn cho quán cà phê. Khách chọn giờ và số người, chủ quán xem lịch đặt theo ngày.', productType: 'WEB_APPLICATION' },
  { goal: 'Phần mềm máy tính quản lý kho hàng: nhập, xuất, tồn theo mã hàng, in phiếu.', productType: 'DESKTOP_APPLICATION' },
  { goal: 'Landing page giới thiệu tiệm bánh ngọt, có form nhận đặt bánh.', productType: 'LANDING_PAGE' },
];

export default function CommandCenterPage(): React.JSX.Element {
  const router = useRouter();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [goal, setGoal] = useState('');
  const [productType, setProductType] = useState('WEB_APPLICATION');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Dự án CTO đang phân rã — để nút "Dừng lập kế hoạch" biết dừng dự án nào.
  const [planningId, setPlanningId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /** Đang chờ quyết định cho đúng một đề xuất; không xếp chồng nhiều cái. */
  const last = turns.at(-1);
  const pending = last?.kind === 'cto' ? last.proposal : null;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns.length, busy]);

  // Mở lại trang (hoặc lỡ tắt giữa chừng): dự án mới nhất còn ở PLANNING thì hiện lại kế hoạch kèm nút Duyệt,
  // CTO chưa xong thì chờ tiếp. Trước đây mất trang là mất luôn nút duyệt, dự án đứng im mãi.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { projects } = await api<{ projects: ProjectRow[] }>('/projects');
      const waiting = projects.filter((p) => p.status === 'PLANNING').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!waiting || cancelled) return;
      setTurns([{ kind: 'note', text: `Dự án "${waiting.name}" đang chờ ở bước kế hoạch.` }, { kind: 'ceo', text: waiting.description }]);
      setBusy(true);
      setPlanningId(waiting.id);
      const state = await waitForPlan(waiting.id);
      if (cancelled) return;
      const proposal = toProposal(state);
      setTurns((current) => [...current, proposal ? { kind: 'cto', proposal } : { kind: 'note', text: state.failed ?? 'CTO không đưa ra kế hoạch.' }]);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        setBusy(false);
        setPlanningId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(): Promise<void> {
    const text = goal.trim();
    if (text.length < 10) {
      setError('Hãy mô tả dài hơn một chút — CTO cần đủ thông tin để phân rã.');
      return;
    }

    setBusy(true);
    setError(null);
    setTurns((current) => [...current, { kind: 'ceo', text }]);

    try {
      const opened = await api<{ project: ProjectRow }>('/orchestrator/intake', {
        method: 'POST',
        body: { goal: text, productType, autoStart: false, background: true },
      });
      setGoal('');
      setPlanningId(opened.project.id);
      const state = await waitForPlan(opened.project.id);
      const proposal = toProposal(state);
      if (proposal) setTurns((current) => [...current, { kind: 'cto', proposal }]);
      else setError(state.failed ?? 'CTO không đưa ra kế hoạch.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'CTO không nhận được việc');
    } finally {
      setBusy(false);
      setPlanningId(null);
    }
  }

  /** Dừng CTO giữa lúc phân rã: cắt lượt ngay, dự án dừng hẳn, chưa chạy bước nào. */
  async function stopPlanning(): Promise<void> {
    if (!planningId) return;
    try {
      await api(`/projects/${planningId}/stop`, { method: 'POST', body: { mode: 'cancel' } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không dừng được');
    }
  }

  async function approve(proposal: Proposal): Promise<void> {
    setBusy(true);
    try {
      await api(`/projects/${proposal.project.id}/approve-plan`, { method: 'POST' });
      router.push(`/projects/${proposal.project.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không bắt đầu được');
      setBusy(false);
    }
  }

  async function cancel(proposal: Proposal): Promise<void> {
    setBusy(true);
    try {
      await api(`/projects/${proposal.project.id}/status`, {
        method: 'PATCH',
        body: { status: 'CANCELLED' },
      });
      setTurns((current) => [...current, { kind: 'note', text: `Đã huỷ "${proposal.project.name}". Chưa có bước nào chạy.` }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không huỷ được');
    } finally {
      setBusy(false);
    }
  }

  /** EDIT — huỷ bản này rồi trả nguyên văn yêu cầu về ô nhập để CEO sửa. */
  async function edit(proposal: Proposal): Promise<void> {
    setGoal(proposal.project.description);
    await cancel(proposal);
  }

  const locked = busy || pending !== null;

  return (
    <div className="flex h-full flex-col">
      <PageHeader eyebrow="CEO ↔ CTO" title="Phòng điều hành" subtitle="Nói với CTO bằng lời. Kế hoạch chỉ chạy khi bạn duyệt." />
      <ErrorNote error={error} />

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
        {turns.length === 0 && (
          <div className="mx-auto max-w-xl pt-8 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-500">Bắt đầu một dự án</p>
            <h2 className="mt-2 text-lg font-semibold text-ink-100">Mô tả thứ bạn muốn công ty làm</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-ink-500">
              CTO phân rã thành task cho từng phòng, báo ước tính chi phí, rồi chờ bạn duyệt. Chưa duyệt thì chưa tốn đồng nào.
            </p>
            <div className="mt-5 grid gap-2 text-left">
              {EXAMPLES.map((example) => (
                <button
                  key={example.goal}
                  type="button"
                  onClick={() => {
                    setGoal(example.goal);
                    setProductType(example.productType);
                  }}
                  className="pn-press pn-focus pn-lift depth-panel rounded-xl border border-line bg-surface-1 px-4 py-3 text-left"
                >
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-learn-400">{PRODUCT_TYPE_LABEL[example.productType]}</span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-300">{example.goal}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn, index) => (
          <TurnView
            key={index}
            turn={turn}
            actionable={pending !== null && index === turns.length - 1}
            busy={busy}
            onApprove={approve}
            onEdit={edit}
            onCancel={cancel}
          />
        ))}

        {busy && pending === null && turns.length > 0 && (
          <div className="pn-slide-in flex items-center gap-2 text-xs text-ink-500">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-[2px] border-current border-r-transparent opacity-60" />
            <span className="flex-1">CTO đang đọc yêu cầu và phân rã… thường mất 2–5 phút. Có thể rời trang, kế hoạch vẫn chờ bạn ở đây.</span>
            {planningId && (
              <Button size="sm" variant="danger" onClick={() => void stopPlanning()}>
                Dừng lập kế hoạch
              </Button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-line bg-surface-0/70 p-5 backdrop-blur-xl">
        <div className="rounded-xl border border-line bg-surface-0 transition-colors focus-within:border-brand-400/60">
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit();
            }}
            rows={3}
            placeholder="Mô tả việc cần làm… (Ctrl+Enter để gửi)"
            disabled={locked}
            className="w-full resize-none bg-transparent px-3.5 py-3 text-sm text-ink-100 outline-none placeholder:text-ink-500 disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-2">
            <select
              value={productType}
              onChange={(event) => setProductType(event.target.value)}
              disabled={locked}
              className="pn-focus h-8 rounded-lg border border-line bg-fill-1 px-2 text-xs text-ink-100 outline-none disabled:opacity-50"
            >
              {Object.entries(PRODUCT_TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value} className="bg-surface-0">
                  {label}
                </option>
              ))}
            </select>
            {pending !== null && <span className="text-xs text-ink-500">Quyết định đề xuất đang chờ trước khi giao việc tiếp.</span>}
            <span className="flex-1" />
            <Button size="sm" onClick={() => void submit()} disabled={locked} loading={busy && pending === null}>
              Gửi cho CTO
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnView({
  turn,
  actionable,
  busy,
  onApprove,
  onEdit,
  onCancel,
}: {
  turn: Turn;
  actionable: boolean;
  busy: boolean;
  onApprove: (proposal: Proposal) => void;
  onEdit: (proposal: Proposal) => void;
  onCancel: (proposal: Proposal) => void;
}): React.JSX.Element {
  if (turn.kind === 'ceo') {
    return (
      <div className="pn-slide-in flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[linear-gradient(135deg,#5b48e6,#4636b8)] px-4 py-2.5 text-sm leading-relaxed text-white shadow-[0_10px_26px_rgba(79,70,229,0.25)]">
          {turn.text}
        </div>
      </div>
    );
  }

  if (turn.kind === 'note') {
    return <p className="pn-slide-in text-center text-xs text-ink-500">{turn.text}</p>;
  }

  const { proposal } = turn;
  const byRole = new Map<string, TaskRow[]>();
  for (const task of proposal.tasks) {
    if (!task.assignedRole || task.assignedRole === 'CTO_ORCHESTRATOR') continue;
    byRole.set(task.assignedRole, [...(byRole.get(task.assignedRole) ?? []), task]);
  }

  return (
    <div className="pn-slide-in flex max-w-[92%] gap-2.5">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(135deg,#38bdf8,#25445f)] text-[10px] font-bold text-white">CTO</span>
      <Card tone="learn" className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-ink-100">Kế hoạch</span>
          <Badge color="var(--tone-sky)">{proposal.project.name}</Badge>
          <Badge>{PRODUCT_TYPE_LABEL[proposal.project.productType] ?? proposal.project.productType}</Badge>
        </div>

        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-300">{proposal.plan}</p>

        {byRole.size > 0 && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[...byRole.entries()].map(([role, tasks]) => (
              <div key={role} className="rounded-lg bg-fill-3 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  {roleLabel(role)} <span className="font-mono normal-case tracking-normal">· {tasks.length}</span>
                </p>
                <ul className="mt-1 space-y-0.5">
                  {tasks.map((task) => (
                    <li key={task.id} className="flex gap-2 text-xs text-ink-300">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-learn-400" />
                      {task.title}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-produce-400/20 bg-produce-600/10 px-3 py-2">
          <span className="font-mono text-sm text-produce-400">{money(proposal.estimate.costUsd, 2)}</span>
          <span className="text-xs text-ink-300">ước tính · {proposal.estimate.estimatedRuns} lượt nhân sự</span>
          <span className="basis-full text-[10px] leading-relaxed text-ink-500">{proposal.estimate.assumption}</span>
        </div>

        {actionable && (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => onApprove(proposal)} disabled={busy} loading={busy}>
              Duyệt và bắt đầu
            </Button>
            <Button size="sm" variant="quiet" onClick={() => onEdit(proposal)} disabled={busy}>
              Sửa lại yêu cầu
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onCancel(proposal)} disabled={busy}>
              Huỷ
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
