/**
 * P&N — Bảng nhân viên AI (§11), mở từ văn phòng 3D và trang Nhân sự.
 *
 * Hai thẻ:
 *   - "Mô tả công việc": nhân viên này chịu trách nhiệm gì, làm theo các bước nào, thế nào là xong, đứng ở đâu trong
 *     dây chuyền — đọc từ chính bản chỉ dẫn nó đang làm theo (API `job`), không phải bản giới thiệu viết tay.
 *   - "Trạng thái": đang làm gì, tới đâu, model nào — và ĐỔI MODEL NGAY TẠI ĐÂY (cùng cơ chế "Thủ công" của trang
 *     Kết nối AI, nên hai nơi luôn khớp). Chỉ người có quyền đổi cài đặt AI mới thấy ô chọn.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { PROVIDER_META, TIER_WORD, shortModel, type AllocationPayload, type ProviderId, type Tier } from '@/components/settings/kit';
import { api, type AgentRow, type TaskRow } from '@/lib/api';
import { DEPARTMENT_LABEL, STATE_TONE, STATE_LABEL } from '@/lib/brand';
import { allowed, useMe } from '@/lib/me';
import { useRealtime } from '@/lib/store';
import { roomOf } from '@/three/layout';

interface RunRow {
  id: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorMessage: string | null;
  exitCode: number | null;
}

interface AgentJob {
  mission: string;
  steps: string[];
  done: string | null;
  rules: string[];
  stages: Array<{ flow: string; stage: string; from: string[]; to: string[]; parallel: string[] }>;
  document: string | null;
  active: boolean;
}

interface AgentDetail {
  agent: AgentRow;
  runs: RunRow[];
  currentTask: TaskRow | null;
  route: { provider: string; model: string; tier: string; mode: string } | null;
  capabilities: string[];
  job: AgentJob;
}

/** Quyền kỹ thuật đọc thành việc làm được — CEO không cần thuộc mã `code:write:frontend`. */
const CAPABILITY_TEXT: Record<string, string> = {
  'project:read': 'Xem dự án',
  'project:write': 'Tạo, sửa dự án',
  'task:read': 'Xem việc',
  'task:write': 'Tạo, sửa việc',
  'task:assign': 'Giao việc cho phòng khác',
  'bug:read': 'Xem lỗi',
  'bug:write': 'Báo lỗi',
  'code:read': 'Đọc mã nguồn',
  'code:write:docs': 'Viết tài liệu dự án',
  'code:write:frontend': 'Viết mã giao diện',
  'code:write:backend': 'Viết mã phần lõi',
  'code:write:mobile': 'Viết mã di động',
  'code:write:infra': 'Viết mã hạ tầng, đóng gói',
  'tests:run': 'Chạy kiểm thử',
  'git:create_branch': 'Tạo nhánh Git',
  'git:commit': 'Commit mã',
  'git:create_pr': 'Mở yêu cầu gộp mã',
  'agent:control': 'Điều khiển nhân viên AI khác',
  'approval:request': 'Xin CEO duyệt',
  'deploy:preview': 'Dựng bản xem trước',
  'deploy:staging': 'Dựng bản thử (staging)',
  'knowledge:discover': 'Tìm kiến thức mới',
  'knowledge:evaluate': 'Đánh giá kiến thức',
};

const RUN_TEXT: Record<string, { text: string; tone: string }> = {
  SUCCEEDED: { text: 'Xong', tone: 'text-state-completed' },
  FAILED: { text: 'Hỏng', tone: 'text-state-alert' },
  TIMEOUT: { text: 'Hết giờ', tone: 'text-state-blocked' },
  CANCELLED: { text: 'Đã dừng', tone: 'text-ink-500' },
  RUNNING: { text: 'Đang chạy', tone: 'text-state-working' },
  QUEUED: { text: 'Chờ lượt', tone: 'text-ink-500' },
};
const BUSY = ['working', 'reviewing', 'meeting', 'blocked', 'alert'];

const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—');
function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'vừa xong';
  if (minutes < 60) return `${minutes} phút`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} giờ`;
  return `${Math.round(minutes / 1440)} ngày`;
}

export function AgentPanel({ role, onClose }: { role: string; onClose: () => void }): React.JSX.Element {
  const liveAgent = useRealtime((state) => state.agents.find((agent) => agent.role === role));
  const me = useMe();
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'job' | 'status' | null>(null);

  // Đổi người đang xem thì không để thông tin của người trước lưu lại trong panel.
  useEffect(() => { setDetail(null); setError(null); setTab(null); }, [role]);

  const load = useCallback(() => {
    let cancelled = false;
    api<AgentDetail>(`/agents/${role}`)
      .then((result) => { if (!cancelled) { setDetail(result); setError(null); } })
      .catch((caught: unknown) =>
        !cancelled && setError(caught instanceof Error ? caught.message : 'Không tải được thông tin agent'),
      );
    return () => { cancelled = true; };
  }, [role]);
  useEffect(load, [load, liveAgent?.state, liveAgent?.currentTaskId, liveAgent?.lastCompletedAt]);

  // Đóng bằng phím Esc — panel che nội dung nên phải thoát được nhanh.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const agent = liveAgent ?? detail?.agent;
  // Mở người đang bận thì vào thẳng Trạng thái (điều cần biết ngay); người rảnh thì đọc Mô tả công việc.
  const shown = tab ?? (agent && BUSY.includes(agent.state) ? 'status' : 'job');
  const room = agent ? roomOf(agent.department) : null;
  const accent = room?.accent ?? '#8b9aa3';

  return (
    <>
      <div className="fixed inset-0 z-40 bg-base-900/60" onClick={onClose} aria-hidden />
      <aside
        className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-base-600 bg-base-800 shadow-2xl"
        aria-label={`Nhân viên ${agent?.displayName ?? role}`}
      >
        <header className="border-b border-base-700 px-4 pb-0 pt-4">
          <div className="flex items-start gap-3">
            <span
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-sm font-bold text-white"
              style={{ background: `linear-gradient(145deg, ${accent}, color-mix(in srgb, ${accent} 55%, #0b1720))` }}
              aria-hidden
            >
              {room?.number ?? '··'}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-base font-semibold text-ink-100">{agent?.displayName ?? role}</h2>
              <p className="mt-0.5 truncate text-xs text-ink-500">
                {room ? <><span className="font-semibold uppercase tracking-[0.1em]">{room.labelEn}</span> · {room.label}</> : DEPARTMENT_LABEL[agent?.department ?? ''] ?? ''}
              </p>
              {agent && (
                <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-base-700 px-2 py-0.5 text-[11px] font-medium text-ink-100">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: STATE_TONE[agent.state] }} />
                  {STATE_LABEL[agent.state] ?? agent.state} · {since(agent.stateChangedAt)}
                </p>
              )}
            </div>
            <button onClick={onClose} aria-label="Đóng" className="rounded-md px-2 py-1 text-ink-500 hover:bg-base-700 hover:text-ink-100">
              ✕
            </button>
          </div>
          <div className="mt-3 flex gap-1" role="tablist" aria-label="Thông tin nhân viên">
            {([['job', 'Mô tả công việc'], ['status', 'Trạng thái']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={shown === id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors ${
                  shown === id ? 'border-[var(--brand-text)] text-ink-100' : 'border-transparent text-ink-500 hover:text-ink-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="text-sm text-state-alert">{error}</p>}
          {!detail && !error && <p className="text-sm text-ink-500">Đang tải…</p>}
          {detail && shown === 'job' && <JobTab detail={detail} />}
          {detail && shown === 'status' && (
            <StatusTab
              detail={detail}
              live={liveAgent ?? null}
              canRead={allowed(me, 'settings:read')}
              canEdit={Boolean(me) && allowed(me, 'settings:write')}
              onSaved={load}
            />
          )}
        </div>
      </aside>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Thẻ Mô tả công việc                                                         */
/* -------------------------------------------------------------------------- */

function JobTab({ detail }: { detail: AgentDetail }): React.JSX.Element {
  const { job } = detail;
  return (
    <div className="space-y-5">
      {!job.active && (
        <p className="rounded-lg border border-base-600 bg-base-700/60 px-3 py-2 text-xs text-ink-300">
          Vai trò này đã có chỗ ngồi trong văn phòng nhưng chưa được giao việc tự động — chưa có lượt chạy nào.
        </p>
      )}
      {job.mission && <p className="text-[15px] leading-relaxed text-ink-100">{sentence(job.mission)}</p>}

      {job.steps.length > 0 && (
        <Section title="Việc cụ thể">
          <ol className="space-y-2">
            {job.steps.map((step, index) => (
              <li key={step} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-300">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-base-700 text-[10px] font-bold text-ink-100">{index + 1}</span>
                <span>{sentence(step)}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {job.done && (
        <Section title="Xong việc khi">
          <p className="rounded-lg border-l-4 border-state-completed bg-base-700/50 px-3 py-2 text-[13px] leading-relaxed text-ink-100">{sentence(job.done)}</p>
        </Section>
      )}

      {job.stages.length > 0 && (
        <Section title="Vị trí trong dây chuyền">
          <div className="space-y-3">
            {job.stages.map((stage) => (
              <div key={stage.flow} className="rounded-lg border border-base-700 bg-base-700/40 p-3">
                <p className="text-[11px] text-ink-500">{stage.flow}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
                  {stage.from.length > 0 ? stage.from.map((name) => <Chip key={name}>{name}</Chip>) : <Chip muted>CEO giao việc</Chip>}
                  <span className="text-ink-500">→</span>
                  <span className="rounded-md bg-[var(--brand-text)] px-2 py-0.5 font-semibold text-white">{stage.stage}</span>
                  <span className="text-ink-500">→</span>
                  {stage.to.length > 0 ? stage.to.map((name) => <Chip key={name}>{name}</Chip>) : <Chip muted>Bàn giao CEO</Chip>}
                </div>
                {stage.parallel.length > 0 && <p className="mt-2 text-[11px] text-ink-500">Làm song song với: {stage.parallel.join(', ')}</p>}
              </div>
            ))}
          </div>
        </Section>
      )}

      {job.document && (
        <Section title="Tài liệu phụ trách">
          <p className="text-[13px] text-ink-300">{job.document} — các phòng sau đọc tài liệu này để làm tiếp.</p>
        </Section>
      )}

      {job.rules.length > 0 && (
        <Section title="Nguyên tắc">
          <ul className="list-disc space-y-1 pl-4 text-[13px] leading-relaxed text-ink-300">
            {job.rules.map((rule) => <li key={rule}>{sentence(rule)}</li>)}
          </ul>
        </Section>
      )}

      <Section title="Được phép">
        <div className="flex flex-wrap gap-1.5">
          {detail.capabilities.map((capability) => (
            <span key={capability} className="rounded-md bg-base-700 px-2 py-0.5 text-[11px] text-ink-300" title={capability}>
              {CAPABILITY_TEXT[capability] ?? capability}
            </span>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-500">Khoá bí mật, tiền, tài khoản và phát hành chính thức luôn bị chặn với nhân viên AI.</p>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Thẻ Trạng thái                                                              */
/* -------------------------------------------------------------------------- */

function StatusTab({ detail, live, canRead, canEdit, onSaved }: {
  detail: AgentDetail;
  live: AgentRow | null;
  canRead: boolean;
  canEdit: boolean;
  onSaved: () => void;
}): React.JSX.Element {
  const agent = live ?? detail.agent;
  const task = detail.currentTask;
  const progress = live?.progress;
  const finished = detail.runs.filter((run) => run.status !== 'RUNNING' && run.status !== 'QUEUED');
  const ok = finished.filter((run) => run.status === 'SUCCEEDED').length;
  const tone = STATE_TONE[agent.state] ?? '#8b9aa3';

  return (
    <div className="space-y-5">
      <section className="rounded-xl border p-3.5" style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, background: `color-mix(in srgb, ${tone} 9%, transparent)` }}>
        <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: tone }}>
          {STATE_LABEL[agent.state] ?? agent.state} · {since(agent.stateChangedAt)}
        </p>
        {task ? (
          <>
            <p className="mt-1.5 text-sm font-semibold text-ink-100">{task.title}</p>
            {task.description && <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-ink-300">{task.description}</p>}
            {task.fixLoopCount > 0 && <p className="mt-2 text-xs text-state-blocked">Đã qua {task.fixLoopCount} vòng sửa lỗi</p>}
          </>
        ) : (
          <p className="mt-1.5 text-sm text-ink-300">Không có việc trong tay.</p>
        )}
        {progress && agent.state === 'working' && (
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-ink-300">
              <span>{progress.text}</span>
              <b className="tabular-nums text-ink-100">{progress.pct}%</b>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-base-700">
              <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${progress.pct}%`, background: tone }} />
            </div>
          </div>
        )}
      </section>

      <ModelCard role={agent.role} route={detail.route} canRead={canRead} canEdit={canEdit} onSaved={onSaved} />

      <Section title="Lượt chạy gần đây">
        {detail.runs.length === 0 ? (
          <p className="text-xs text-ink-500">Chưa có lần chạy nào.</p>
        ) : (
          <>
            {finished.length > 0 && (
              <div className="mb-3 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-base-700">
                  <div className="h-full rounded-full bg-state-completed" style={{ width: `${(ok / finished.length) * 100}%` }} />
                </div>
                <span className="text-[11px] tabular-nums text-ink-300">{ok}/{finished.length} lượt xong</span>
              </div>
            )}
            <div className="space-y-1.5">
              {detail.runs.map((run) => {
                const state = RUN_TEXT[run.status] ?? { text: run.status, tone: 'text-ink-500' };
                return (
                  <div key={run.id} className="grid grid-cols-[58px_92px_1fr] items-baseline gap-2 text-xs">
                    <span className={`font-semibold ${state.tone}`}>{state.text}</span>
                    <span className="whitespace-nowrap tabular-nums text-ink-500">{when(run.startedAt)}</span>
                    <span className="truncate text-ink-500" title={run.errorMessage ?? undefined}>{run.errorMessage ?? ''}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

/** Model đang phục vụ nhân viên này; có quyền thì đổi được ngay tại đây. */
function ModelCard({ role, route, canRead, canEdit, onSaved }: {
  role: string;
  route: AgentDetail['route'];
  canRead: boolean;
  canEdit: boolean;
  onSaved: () => void;
}): React.JSX.Element {
  const [alloc, setAlloc] = useState<AllocationPayload | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!canRead) return;
    api<AllocationPayload>('/api-center/allocation').then(setAlloc, () => undefined);
  }, [canRead, role]);

  const providerOf = new Map(alloc?.providers.map((p) => [p.provider, p]) ?? []);
  const provider = route?.provider as ProviderId | undefined;
  const meta = provider ? PROVIDER_META[provider] : null;
  const modelName = provider && route ? shortModel(provider, providerOf.get(provider)?.models[route.tier as Tier] ?? { id: route.model, name: route.model }) : null;
  const override = alloc?.mode === 'manual' ? alloc.overrides[role] : undefined;
  const current = override ? `${override.provider}:${override.tier}` : '';
  const selected = choice ?? current;
  const usable = alloc ? alloc.order.filter((id) => alloc.usable.includes(id)) : [];

  const save = async (): Promise<void> => {
    if (!alloc) return;
    setBusy(true);
    setNote(null);
    const overrides = { ...alloc.overrides };
    if (!selected) delete overrides[role];
    else {
      const [p, t] = selected.split(':') as [ProviderId, Tier];
      overrides[role] = { provider: p, tier: t };
    }
    try {
      // Chọn tay một vai trò = chế độ "Thủ công" của Kết nối AI; các vai trò khác vẫn theo combo như trước.
      // Bỏ chọn tay cuối cùng thì về "Tự động" — thủ công mà không chọn tay vai trò nào chỉ làm trang Kết nối AI khó hiểu.
      const next = await api<AllocationPayload>('/api-center/allocation', {
        method: 'PUT',
        body: Object.keys(overrides).length > 0 ? { mode: 'manual', overrides } : { mode: 'auto', overrides: {} },
      });
      setAlloc(next);
      setChoice(null);
      setNote({ bad: false, text: selected ? 'Đã đổi. Lượt chạy kế tiếp của nhân viên này dùng model mới.' : 'Đã trả về theo combo chung.' });
      onSaved();
    } catch (caught) {
      setNote({ bad: true, text: caught instanceof Error ? caught.message : 'Không đổi được model' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Model đang dùng">
      <div className="rounded-xl border border-base-700 bg-base-700/40 p-3.5">
        {route && meta ? (
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: meta.color }}>
              {meta.mark}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink-100">{modelName}</p>
              <p className="text-[11px] text-ink-500">
                {meta.name} · bậc {TIER_WORD[route.tier as Tier] ?? route.tier}
                {override ? ' · chọn tay' : ' · theo combo'}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-ink-500">Chưa có nguồn AI nào phục vụ vai trò này. Vào Cài đặt → Kết nối AI.</p>
        )}

        {canEdit && alloc && (
          <div className="mt-3 border-t border-base-700 pt-3">
            <label className="block text-[11px] text-ink-500" htmlFor={`model-${role}`}>Đổi model cho nhân viên này</label>
            <div className="mt-1.5 flex gap-2">
              <select
                id={`model-${role}`}
                value={selected}
                onChange={(event) => setChoice(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-base-600 bg-base-800 px-2.5 py-2 text-[13px] text-ink-100"
              >
                <option value="">Theo combo chung</option>
                {usable.map((id) => (
                  <optgroup key={id} label={PROVIDER_META[id].name}>
                    {(['strong', 'medium', 'cheap'] as Tier[]).map((tier) => (
                      <option key={tier} value={`${id}:${tier}`}>
                        {PROVIDER_META[id].name} · {shortModel(id, providerOf.get(id)?.models[tier])} ({TIER_WORD[tier]})
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <button
                type="button"
                disabled={busy || selected === current}
                onClick={() => void save()}
                className="rounded-lg bg-[var(--brand-text)] px-3 text-[13px] font-semibold text-white disabled:opacity-40"
              >
                {busy ? 'Đang lưu…' : 'Lưu'}
              </button>
            </div>
            {usable.length === 0 && <p className="mt-1.5 text-[11px] text-state-blocked">Chưa có nguồn AI nào dùng được để chọn.</p>}
          </div>
        )}
        {!canEdit && route && <p className="mt-2 text-[11px] text-ink-500">Chỉ người có quyền đổi cài đặt AI mới đổi được model.</p>}
        {note && <p className={`mt-2 text-[12px] ${note.bad ? 'text-state-alert' : 'text-state-completed'}`}>{note.text}</p>}
      </div>
    </Section>
  );
}

function Chip({ children, muted = false }: { children: React.ReactNode; muted?: boolean }): React.JSX.Element {
  return <span className={`rounded-md border border-base-600 px-2 py-0.5 ${muted ? 'text-ink-500' : 'text-ink-300'}`}>{children}</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{title}</h3>
      {children}
    </section>
  );
}
