/**
 * P&N — Đội ngũ theo phòng ban (§3, §7, §11).
 *
 * Mỗi phòng là một thẻ: tên phòng, mấy người đang làm, thanh hoạt động, và
 * từng agent. Lọc theo trạng thái để CEO nhìn ra ngay ai đang bị chặn.
 *
 * Nay mỗi người có ảnh chân dung chụp từ chính mô hình 3D của họ, số liệu
 * thật 30 ngày (việc xong, lần chạy lỗi, tiền tiêu, lỗi gần nhất nói bằng tiếng
 * người) và nút "Xem trong 3D" lướt camera tới bàn người đó.
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AgentPanel } from '@/components/AgentPanel';
import { Badge, Chip, PageHeader } from '@/components/ui';
import { DEPARTMENT_LABEL, STATE_TONE, STATE_LABEL, money } from '@/lib/brand';
import { useAgentStats, type AgentStat } from '@/lib/insights';
import { portraitOf } from '@/lib/portraits';
import { modelForRole } from '@/three/Employee';
import { useRealtime } from '@/lib/store';

type Filter = 'all' | 'working' | 'blocked' | 'idle';

const ACTIVE = ['working', 'reviewing', 'meeting', 'celebrate'];

export default function AgentsPage(): React.JSX.Element {
  const { agents } = useRealtime();
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const stats = useAgentStats();

  const matches = (state: string): boolean =>
    filter === 'all' ||
    (filter === 'working' && ACTIVE.includes(state)) ||
    (filter === 'blocked' && (state === 'blocked' || state === 'alert')) ||
    (filter === 'idle' && (state === 'idle' || state === 'offline'));

  const byDepartment = new Map<string, typeof agents>();
  for (const agent of agents) {
    byDepartment.set(agent.department, [...(byDepartment.get(agent.department) ?? []), agent]);
  }
  const working = agents.filter((agent) => ACTIVE.includes(agent.state)).length;
  const blocked = agents.filter((agent) => agent.state === 'blocked' || agent.state === 'alert').length;

  const departments = [...byDepartment.entries()]
    .map(([department, list]) => ({ department, list: list.filter((agent) => matches(agent.state)), total: list.length }))
    .filter((entry) => entry.list.length > 0)
    .sort((a, b) => {
      const aActive = a.list.filter((agent) => ACTIVE.includes(agent.state)).length;
      const bActive = b.list.filter((agent) => ACTIVE.includes(agent.state)).length;
      return bActive - aActive || a.department.localeCompare(b.department);
    });

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Đội ngũ"
        title="Nhân sự"
        subtitle={`${agents.length} nhân sự · ${working} đang làm${blocked > 0 ? ` · ${blocked} bị chặn` : ''}`}
        action={
          <div className="flex gap-1.5">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')}>Tất cả</Chip>
            <Chip active={filter === 'working'} onClick={() => setFilter('working')}>Đang làm {working}</Chip>
            <Chip active={filter === 'blocked'} onClick={() => setFilter('blocked')}>Bị chặn {blocked}</Chip>
            <Chip active={filter === 'idle'} onClick={() => setFilter('idle')}>Rảnh</Chip>
          </div>
        }
      />

      <div className="grid items-start gap-3 p-5 md:grid-cols-2 xl:grid-cols-3">
        {departments.map(({ department, list, total }) => {
          const active = list.filter((agent) => ACTIVE.includes(agent.state)).length;
          const attention = list.some((agent) => agent.state === 'blocked' || agent.state === 'alert');
          const tone = attention ? 'var(--tone-orange)' : active > 0 ? 'var(--tone-green)' : 'var(--tone-muted)';
          return (
            <section
              key={department}
              className="depth-panel overflow-hidden rounded-xl border border-line bg-surface-1"
            >
              <header className="flex items-center gap-3 px-4 pt-4">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
                  style={{ background: `color-mix(in srgb, ${tone} 14%, transparent)`, color: tone }}
                >
                  {departmentMark(DEPARTMENT_LABEL[department] ?? department)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-sm font-semibold text-ink-100">{DEPARTMENT_LABEL[department] ?? department}</h2>
                  <p className="text-[11px] text-ink-500">
                    {attention ? 'có người bị chặn' : active > 0 ? `${active}/${total} đang làm` : `${total} người · rảnh`}
                  </p>
                </div>
                {active > 0 && <Badge color="var(--tone-green)" dot>{active}</Badge>}
              </header>
              <div className="mx-4 mt-3 h-1 overflow-hidden rounded-full bg-fill-2">
                <div
                  className="h-full rounded-full transition-[width] duration-500"
                  style={{ width: `${total > 0 ? (active / total) * 100 : 0}%`, background: tone }}
                />
              </div>

              <div className="mt-2 px-2 pb-2">
                {list.map((agent) => (
                  <Member
                    key={agent.id}
                    role={agent.role}
                    name={agent.displayName}
                    state={agent.state}
                    stat={stats.get(agent.role)}
                    onOpen={() => setSelected(agent.role)}
                  />
                ))}
              </div>
            </section>
          );
        })}
        {departments.length === 0 && (
          <p className="col-span-full px-1 text-sm text-ink-500">Không có nhân sự nào ở trạng thái này.</p>
        )}
      </div>

      {selected && <AgentPanel role={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * Một nhân viên: chân dung 3D, trạng thái, bốn con số 30 ngày, lỗi gần nhất, và
 * lối tắt sang văn phòng 3D. Bấm vào hàng mở bảng chi tiết như trước.
 */
function Member({
  role,
  name,
  state,
  stat,
  onOpen,
}: {
  role: string;
  name: string;
  state: string;
  stat: AgentStat | undefined;
  onOpen: () => void;
}): React.JSX.Element {
  const [photo, setPhoto] = useState('');
  useEffect(() => {
    let alive = true;
    void portraitOf(modelForRole(role)).then((image) => alive && setPhoto(image));
    return () => {
      alive = false;
    };
  }, [role]);
  const tone = STATE_TONE[state] ?? 'var(--tone-gray)';
  const runs = stat ? stat.succeeded + stat.failed : 0;
  return (
    <div className="rounded-lg px-2 py-2 hover:bg-fill-1">
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={onOpen} className="pn-press pn-focus flex min-w-0 flex-1 items-center gap-2.5 text-left text-xs">
          <span className="relative h-11 w-11 shrink-0 overflow-hidden rounded-full border-2 bg-fill-2" style={{ borderColor: tone }}>
            {photo ? (
              // Ảnh là data URL chụp tại chỗ, không qua tối ưu ảnh của Next.
              <img src={photo} alt="" className="h-full w-full scale-[1.15] object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-ink-300">{initials(name)}</span>
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-ink-100">{name}</span>
            <span className={`mt-0.5 inline-flex items-center gap-1.5 text-[10px] ${ACTIVE.includes(state) ? 'font-medium' : ''}`} style={{ color: tone }}>
              <span className={`h-1.5 w-1.5 rounded-full ${state === 'working' ? 'pn-pulse' : ''}`} style={{ background: tone }} />
              {STATE_LABEL[state] ?? state}
            </span>
          </span>
        </button>
        <Link href={`/overview?nguoi=${role}`} className="pn-focus shrink-0 rounded-md px-2 py-1 text-[10.5px] font-semibold text-ink-300 hover:bg-fill-2 hover:text-ink-100" title="Lướt tới bàn người này trong văn phòng 3D">
          Xem trong 3D ›
        </Link>
      </div>
      {stat && (
        <dl className="mt-2 grid grid-cols-4 gap-1 pl-[54px] text-[10px]">
          <div><dt className="text-ink-500">Xong</dt><dd className="font-mono font-semibold tabular-nums text-ink-100">{stat.done}</dd></div>
          <div><dt className="text-ink-500">Đang mở</dt><dd className="font-mono font-semibold tabular-nums text-ink-100">{stat.open}</dd></div>
          <div>
            <dt className="text-ink-500">Lỗi / chạy</dt>
            <dd className={`font-mono font-semibold tabular-nums ${stat.failed > 0 ? 'text-[color:var(--tone-orange)]' : 'text-ink-100'}`}>{stat.failed}/{runs}</dd>
          </div>
          <div><dt className="text-ink-500">Tiền 30 ngày</dt><dd className="font-mono font-semibold tabular-nums text-ink-100">{money(stat.costUsd, 2)}</dd></div>
        </dl>
      )}
      {stat?.lastError && (
        <p className="mt-1.5 pl-[54px] text-[10.5px] text-[color:var(--tone-orange)]">⚑ Lỗi gần nhất: {stat.lastError}</p>
      )}
    </div>
  );
}

/** Hai chữ cái đầu của tên hiển thị, đủ để nhận ra trong danh sách dày. */
function initials(name: string): string {
  const words = name.replace(/[/()]/g, ' ').trim().split(/\s+/);
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase() || name.slice(0, 2).toUpperCase();
}

/** Chữ cái đại diện phòng: bỏ chữ "Phòng" ở đầu ("Phòng máy chủ" → "MC", "Phòng web" → "WE"). */
function departmentMark(label: string): string {
  const words = label.replace(/^Phòng\s+/i, '').trim().split(/\s+/);
  return (words.length > 1 ? (words[0]?.[0] ?? '') + (words[1]?.[0] ?? '') : (words[0] ?? '').slice(0, 2)).toUpperCase();
}
