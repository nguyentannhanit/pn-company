/**
 * P&N — Thẻ phòng ban nổi cạnh văn phòng 3D.
 *
 * Bấm vào phòng trước đây chỉ phóng camera tới; muốn biết ai làm gì, việc nào
 * kẹt và vì sao thì phải sang tab khác. Thẻ này trả lời tại chỗ: từng người
 * đang làm việc gì, việc kẹt nói bằng tiếng người, và nút chạy lại ngay.
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { AgentRow } from '@/lib/api';
import { STATE_LABEL, STATE_TONE } from '@/lib/brand';
import { rerunTask, stopTaskRun, useTaskTitles, type BlockedItem } from '@/lib/insights';

interface RoomInfo {
  number: string;
  label: string;
  labelEn: string;
  accent: string;
}

const ACTIVE = ['working', 'reviewing', 'meeting'];

/** Chữ viết tắt trên ảnh đại diện: hai chữ cái đầu của tên hiển thị. */
function initials(name: string): string {
  const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '') + (words.at(-1)?.[0] ?? '')).toUpperCase();
}

export function RoomCard({
  room,
  agents,
  blocked,
  onClose,
  onSelectAgent,
  onChanged,
}: {
  room: RoomInfo;
  agents: AgentRow[];
  /** Việc kẹt của những người trong phòng này. */
  blocked: BlockedItem[];
  onClose: () => void;
  onSelectAgent: (role: string) => void;
  /** Gọi sau khi chạy lại một việc, để nơi gọi tải lại danh sách việc kẹt. */
  onChanged: () => void;
}): React.JSX.Element {
  // Tên việc đang làm của từng người (agent chỉ mang mã việc).
  const titles = useTaskTitles(agents.map((agent) => agent.currentTaskId).filter((id): id is string => !!id));
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Người vừa được bấm "Chạy lại": hiện "đang chạy lại" tới khi họ thật sự bắt đầu làm (bấm xong vẫn
  // thấy "kẹt"). Việc có thể phải chờ lượt nếu dự án đang có việc khác chạy.
  const [rerunRoles, setRerunRoles] = useState<string[]>([]);

  // Đã bắt đầu làm thì bỏ nhãn; kẹt lại lần nữa thì nhãn "Kẹt việc" được ưu tiên hiện.
  useEffect(() => {
    setRerunRoles((current) => current.filter((role) => !agents.some((agent) => agent.role === role && ACTIVE.includes(agent.state))));
  }, [agents]);

  const rerun = async (item: BlockedItem): Promise<void> => {
    setBusy(item.taskId);
    const result = await rerunTask(item.taskId);
    setNotes((current) => ({ ...current, [item.taskId]: result.message }));
    const role = item.role;
    if (result.ok && role) setRerunRoles((current) => [...current, role]);
    setBusy(null);
    onChanged();
  };

  /** Dừng việc ngay trong thẻ phòng: kẹt thì bỏ hẳn được, đang làm thì tạm dừng hoặc bỏ. */
  const stop = async (taskId: string, mode: 'pause' | 'cancel'): Promise<void> => {
    setBusy(taskId);
    const result = await stopTaskRun(taskId, mode);
    setNotes((current) => ({ ...current, [taskId]: result.message }));
    setBusy(null);
    onChanged();
  };

  const working = agents.filter((agent) => ACTIVE.includes(agent.state)).length;
  const sorted = [...agents].sort(
    (a, b) => Number(blocked.some((item) => item.role === b.role)) - Number(blocked.some((item) => item.role === a.role)),
  );

  return (
    <aside className="office-room-card" aria-label={`Thẻ ${room.label}`}>
      <header>
        <span className="office-room-card-number" style={{ color: room.accent }}>
          {room.number}
        </span>
        <div className="min-w-0 flex-1">
          <span className="office-room-card-en">{room.labelEn}</span>
          <h2>{room.label}</h2>
          <p>
            {agents.length} người · {working} đang làm
            {blocked.length > 0 && <b> · {blocked.length} việc kẹt</b>}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Đóng thẻ phòng" className="office-room-card-close">
          ✕
        </button>
      </header>

      {blocked.length > 0 && (
        <section className="office-room-card-blocked">
          {blocked.map((item) => (
            <article key={item.taskId}>
              <p className="office-flag-title">⚑ {item.explained.title}</p>
              <p className="office-room-card-task">{item.title}</p>
              <p className="office-room-card-detail">{item.explained.detail}</p>
              {(item.explained.model || item.failedRuns > 1) && (
                <p className="office-room-card-meta">
                  {item.explained.model && <>Model {item.explained.model}</>}
                  {item.explained.model && item.failedRuns > 1 && ' · '}
                  {item.failedRuns > 1 && <>đã thử {item.failedRuns} lần</>}
                </p>
              )}
              <div className="office-room-card-actions">
                <button type="button" onClick={() => void rerun(item)} disabled={busy !== null}>
                  {busy === item.taskId ? 'Đang chạy…' : 'Chạy lại'}
                </button>
                <button type="button" onClick={() => void stop(item.taskId, 'cancel')} disabled={busy !== null}>
                  Dừng hẳn
                </button>
                <Link href={`/projects/${item.projectId}`}>Mở dự án</Link>
                {notes[item.taskId] && <span>{notes[item.taskId]}</span>}
              </div>
            </article>
          ))}
        </section>
      )}

      <ul className="office-room-card-people">
        {sorted.map((agent) => {
          const stuck = blocked.find((item) => item.role === agent.role);
          const rerunning = !stuck && rerunRoles.includes(agent.role) && !ACTIVE.includes(agent.state);
          const tone = stuck
            ? 'var(--tone-orange)'
            : rerunning
              ? 'var(--tone-blue)'
              : (STATE_TONE[agent.state] ?? 'var(--tone-gray)');
          const doing = agent.currentTaskId ? titles[agent.currentTaskId] : null;
          return (
            <li key={agent.role}>
              <button type="button" onClick={() => onSelectAgent(agent.role)}>
                <span className="office-room-card-avatar" style={{ borderColor: tone }}>
                  {initials(agent.displayName)}
                </span>
                <span className="min-w-0 flex-1">
                  <strong>{agent.displayName}</strong>
                  <small>
                    <i style={{ background: tone }} />
                    {stuck ? 'Kẹt việc' : rerunning ? 'Đang chạy lại · chờ tới lượt' : (STATE_LABEL[agent.state] ?? agent.state)}
                    {doing && <> · {doing}</>}
                  </small>
                </span>
              </button>
              {agent.currentTaskId && ACTIVE.includes(agent.state) && (
                <div className="office-room-card-stop">
                  <button type="button" onClick={() => void stop(agent.currentTaskId!, 'pause')} disabled={busy !== null}>
                    Tạm dừng
                  </button>
                  <button type="button" onClick={() => void stop(agent.currentTaskId!, 'cancel')} disabled={busy !== null}>
                    Dừng hẳn
                  </button>
                  {notes[agent.currentTaskId] && <span>{notes[agent.currentTaskId]}</span>}
                </div>
              )}
            </li>
          );
        })}
        {agents.length === 0 && <li className="office-room-card-empty">Phòng chưa có ai.</li>}
      </ul>
    </aside>
  );
}
