/**
 * P&N — Phê duyệt của CEO (§27).
 *
 * Mỗi phiếu là một quyết định, nên thẻ phải nói được ba điều trước khi CEO bấm:
 * vì sao hỏi, hậu quả của từng nút, và đã tốn bao nhiêu. Nút mang tên hậu quả
 * ("Sửa thêm một vòng" / "Chấp nhận, đi tiếp") thay vì "Duyệt" / "Từ chối" khô.
 *
 * Trên điện thoại vuốt thẻ sang phải để duyệt, sang trái để từ chối.
 * Vuốt chỉ CHỌN, không ghi ngay: thẻ hiện nút xác nhận mang tên hậu quả, vì
 * một cú vuốt nhầm khi cuộn trang không được phép thành "triển khai bản chính thức".
 *
 * §20 — quyết định là quyền của người, không phải của agent. Nút ở đây gọi
 * đúng endpoint có kiểm tra `approval:decide`, thứ mà AGENT không bao giờ có.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Skeleton } from '@/components/ui';
import { api, type ApprovalRow, type ProjectRow } from '@/lib/api';
import { money } from '@/lib/brand';
import { useRealtime } from '@/lib/store';

/** §27 — vì sao phiếu này tồn tại, nói bằng tiếng người. */
const KIND_LABEL: Record<string, string> = {
  PROJECT_PLAN: 'Kế hoạch dự án',
  ARCHITECTURE: 'Kiến trúc hệ thống',
  PRODUCTION_DEPLOY: 'Triển khai bản chính thức',
  BUDGET_INCREASE: 'Chi phí phát sinh',
  SECRET_ACCESS: 'Truy cập bí mật',
  KNOWLEDGE_ITEM: 'Kiến thức mới',
  DEPARTMENT_UPGRADE: 'Nâng cấp phòng ban',
};

const KIND_COLOR: Record<string, string> = {
  PRODUCTION_DEPLOY: 'var(--tone-red)',
  ARCHITECTURE: 'var(--tone-blue)',
  BUDGET_INCREASE: 'var(--tone-amber)',
  PROJECT_PLAN: 'var(--tone-violet)',
};

interface ApprovalDetail extends ApprovalRow {
  projectId: string | null;
  taskId: string | null;
}

export default function ApprovalsPage(): React.JSX.Element {
  const { lastEventAt } = useRealtime();
  const [approvals, setApprovals] = useState<ApprovalDetail[] | null>(null);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api<{ approvals: ApprovalDetail[] }>('/approvals'), api<{ projects: ProjectRow[] }>('/projects')])
      .then(([approvalResult, projectResult]) => {
        setApprovals(approvalResult.approvals);
        setProjects(projectResult.projects);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được danh sách phê duyệt'));
  }, []);

  useEffect(load, [load, lastEventAt]);

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Quyết định của CEO"
        title="Phê duyệt"
        subtitle={approvals ? (approvals.length > 0 ? `${approvals.length} phiếu đang chờ bạn` : 'Không có gì chờ') : undefined}
      />
      <ErrorNote error={error} />

      <div className="p-5">
        {approvals === null && <Skeleton rows={3} />}
        {approvals !== null && approvals.length === 0 && (
          <Empty
            message="Không có phiếu nào đang chờ"
            hint="Phiếu xuất hiện khi một bước cần CEO quyết định: kiến trúc, triển khai bản chính thức, hoặc kiểm thử không đạt sau nhiều vòng sửa. Telegram cũng nhận cùng lúc."
          />
        )}
        <div className="grid gap-3 xl:grid-cols-2">
          {approvals?.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              project={projects.find((project) => project.id === approval.projectId) ?? null}
              onDecided={load}
              onError={setError}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ApprovalCard({
  approval,
  project,
  onDecided,
  onError,
}: {
  approval: ApprovalDetail;
  project: ProjectRow | null;
  onDecided: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  // Vuốt bằng ngón tay: `drag` là độ lệch hiện tại, `armed` là lựa chọn chờ xác nhận.
  const [drag, setDrag] = useState(0);
  const [armed, setArmed] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  const SWIPE = 96;

  // Phiếu leo thang fix loop có ngữ nghĩa riêng cho hai nút (§55).
  const fixLoop = approval.title.startsWith('QA vẫn không đạt');
  const labels = fixLoop
    ? { yes: 'Sửa thêm một vòng', no: 'Chấp nhận, đi tiếp', hintYes: 'lập trình sửa rồi kiểm thử lại', hintNo: 'lỗi còn lại ghi vào danh sách lỗi' }
    : approval.kind === 'PRODUCTION_DEPLOY'
      ? { yes: 'Cho phép triển khai', no: 'Không triển khai', hintYes: 'đưa bản chính thức lên ngay', hintNo: 'dự án dừng ở bản thử' }
      : { yes: 'Duyệt', no: 'Từ chối', hintYes: 'các bước sau chạy tiếp', hintNo: 'bước này dừng lại' };

  async function decide(decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    setBusy(decision);
    try {
      await api(`/approvals/${approval.id}/decide`, {
        method: 'POST',
        body: { decision, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      onDecided();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không ghi được quyết định');
      setBusy(null);
    }
  }

  const summary = approval.summary.trim();
  const long = summary.length > 420;
  const tone = approval.kind === 'PRODUCTION_DEPLOY' ? 'alert' : approval.kind === 'ARCHITECTURE' ? 'learn' : fixLoop ? 'warn' : 'brand';
  const age = Math.max(1, Math.round((Date.now() - Date.parse(approval.createdAt)) / 60_000));

  // Chỉ nhận vuốt bằng ngón tay; chuột vẫn bấm nút như trước (kéo chuột là để bôi đen chữ).
  const onPointerDown = (event: React.PointerEvent): void => {
    if (event.pointerType !== 'touch' || busy) return;
    start.current = { x: event.clientX, y: event.clientY, horizontal: null };
  };
  const onPointerMove = (event: React.PointerEvent): void => {
    const origin = start.current;
    if (!origin) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    // Quyết định hướng sau vài điểm ảnh đầu: dọc là cuộn trang, ngang mới là vuốt duyệt.
    if (origin.horizontal === null && Math.hypot(dx, dy) > 8) origin.horizontal = Math.abs(dx) > Math.abs(dy);
    if (origin.horizontal) setDrag(Math.max(-160, Math.min(160, dx)));
  };
  const onPointerEnd = (): void => {
    if (start.current?.horizontal) {
      if (drag >= SWIPE) setArmed('APPROVED');
      else if (drag <= -SWIPE) setArmed('REJECTED');
    }
    start.current = null;
    setDrag(0);
  };
  const leaning = drag >= SWIPE ? 'APPROVED' : drag <= -SWIPE ? 'REJECTED' : null;

  return (
    <div className="pn-swipe relative" data-lean={leaning ?? (drag > 0 ? 'yes' : drag < 0 ? 'no' : undefined)}>
      {/* Nền lộ ra dưới thẻ khi vuốt: xanh bên trái (đang vuốt phải = duyệt), đỏ bên phải. */}
      <div className="pn-swipe-under" aria-hidden>
        <span>✓ {labels.yes}</span>
        <span>{labels.no} ✕</span>
      </div>
    <div
      className="relative"
      style={{ transform: drag ? `translateX(${drag}px) rotate(${drag / 60}deg)` : undefined, transition: drag ? 'none' : 'transform 0.2s', touchAction: 'pan-y' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
    <Card tone={tone} className="flex flex-col">
      {armed && (
        <div className={`pn-swipe-confirm is-${armed === 'APPROVED' ? 'yes' : 'no'}`} role="alertdialog" aria-label="Xác nhận quyết định">
          <p>Bạn vừa vuốt chọn: <b>{armed === 'APPROVED' ? labels.yes : labels.no}</b></p>
          <div>
            <Button size="sm" variant={armed === 'APPROVED' ? 'primary' : 'danger'} onClick={() => void decide(armed)} loading={busy !== null}>
              Xác nhận
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setArmed(null)} disabled={busy !== null}>
              Huỷ
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={KIND_COLOR[approval.kind]} dot>{KIND_LABEL[approval.kind] ?? approval.kind}</Badge>
        {project && <span className="truncate text-xs text-ink-300">📁 {project.name}</span>}
        <span className="ml-auto font-mono text-[10px] text-ink-500" title={new Date(approval.createdAt).toLocaleString('vi-VN')}>
          {age < 60 ? `${age} phút trước` : age < 60 * 24 ? `${Math.round(age / 60)} giờ trước` : new Date(approval.createdAt).toLocaleDateString('vi-VN')}
        </span>
      </div>

      <h3 className="mt-2.5 text-sm font-semibold leading-snug text-ink-100">{approval.title}</h3>

      <div className="mt-2 rounded-lg bg-fill-3 px-3 py-2.5">
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-300">
          {expanded || !long ? summary : `${summary.slice(0, 420)}…`}
        </p>
        {long && (
          <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-1.5 text-[11px] text-learn-400 hover:underline">
            {expanded ? 'Thu gọn' : 'Xem đầy đủ'}
          </button>
        )}
      </div>

      {project && (
        <p className="mt-2 font-mono text-[11px] text-ink-500">
          Dự án đã tiêu {money(project.spentUsd, 2)} / {money(project.budgetUsd)}
        </p>
      )}

      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Ghi chú cho quyết định (không bắt buộc)"
        className="pn-focus mt-3 w-full rounded-lg border border-line bg-surface-0 px-2.5 py-2 text-xs text-ink-100 outline-none transition-colors focus:border-brand-400/60"
      />

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <Button className="h-auto flex-col gap-0 py-2" onClick={() => void decide('APPROVED')} disabled={busy !== null} loading={busy === 'APPROVED'}>
          <span>{labels.yes}</span>
          <span className="text-[10px] font-normal opacity-80">{labels.hintYes}</span>
        </Button>
        <Button className="h-auto flex-col gap-0 py-2" variant="quiet" onClick={() => void decide('REJECTED')} disabled={busy !== null} loading={busy === 'REJECTED'}>
          <span>{labels.no}</span>
          <span className="text-[10px] font-normal opacity-70">{labels.hintNo}</span>
        </Button>
      </div>
      <p className="pn-swipe-hint">Vuốt phải để {labels.yes.toLowerCase()} · vuốt trái để {labels.no.toLowerCase()}</p>
    </Card>
    </div>
    </div>
  );
}
