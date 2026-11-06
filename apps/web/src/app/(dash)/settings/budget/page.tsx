/**
 * P&N — Cài đặt → Ngân sách, bản 4.
 *
 * Hai con số khác nhau được đặt cạnh nhau có chủ đích: tiền THẬT đã trả cho các hãng API cả tháng, và phần
 * TÍNH VÀO HẠN MỨC (đếm từ mốc "đặt lại" gần nhất) — hạn mức chỉ chặn theo con số thứ hai. Gói thuê bao ghi
 * $0 mỗi lượt; phí gói hằng tháng CEO nhập tay (tuỳ chọn) chỉ để thống kê tổng tiền AI.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AGENT_PROFILES } from '@pn/shared';

import { ErrorNote } from '@/components/ui';
import { Bar, Kpi, Pill, PROVIDER_META, Stack, ddmm, int, pct, stamp, styles as s, usd, limitTone, type ProviderId } from '@/components/settings/kit';
import { api, type BudgetPolicyRow } from '@/lib/api';
import { DEPARTMENT_LABEL, PROJECT_STATUS_LABEL } from '@/lib/brand';

interface Status { limitUsd: number; spentUsd: number; ratio: number; warned: boolean; exceeded: boolean; hardStop: boolean }
interface Overview {
  month: {
    monthStart: string;
    costUsd: number;
    calls: number;
    daily: Array<{ day: string; provider: string; costUsd: number; calls: number }>;
    byProvider: Array<{ provider: string; costUsd: number; calls: number }>;
    byRole: Array<{ role: string; costUsd: number; calls: number }>;
    unassigned: { costUsd: number; calls: number };
  };
  globalMonth: Status | null;
  countFrom: string | null;
  policies: Array<BudgetPolicyRow & { createdAt?: string }>;
  projects: Array<{ id: string; name: string; status: string; createdAt: string; budgetUsd: number; spentUsd: number; calls: number }>;
  planFees: { 'claude-code': number | null; codex: number | null };
}

const API_PROVIDERS: ProviderId[] = ['openai', 'anthropic', 'google'];
const color = (provider: string): string => PROVIDER_META[provider as ProviderId]?.color ?? '#94a3b8';
const name = (provider: string): string => {
  const meta = PROVIDER_META[provider as ProviderId];
  return meta ? meta.name : provider;
};

export default function BudgetPage(): React.JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Overview>('/api-center/budget-overview')
      .then(setData)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được ngân sách'));
  }, []);
  useEffect(load, [load]);

  if (!data) {
    return (
      <div className="pb-8">
        <ErrorNote error={error} />
        <div className={s.root}><div className="pn-skeleton h-[420px]" /></div>
      </div>
    );
  }

  const { month, globalMonth } = data;
  const monthPolicies = data.policies.filter((p) => p.scope === 'GLOBAL' && p.period === 'MONTH');
  const active = monthPolicies.find((p) => Number(p.limitUsd) === globalMonth?.limitUsd) ?? monthPolicies[0];
  const warnAt = active ? Number(active.warnThreshold) : 0.8;
  const monthLabel = String(new Date(month.monthStart).getMonth() + 1);
  const countFromInMonth = data.countFrom && new Date(data.countFrom) > new Date(month.monthStart) ? data.countFrom : null;
  const fees = (data.planFees['claude-code'] ?? 0) + (data.planFees.codex ?? 0);
  const byProvider = [...month.byProvider].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);

  // Gộp tiền theo phòng ban từ tiền theo vai trò; lượt gọi không gắn nhân viên (trợ lý, gọi thử) tách riêng.
  const depts = new Map<string, number>();
  for (const row of month.byRole) {
    const dept = AGENT_PROFILES[row.role as keyof typeof AGENT_PROFILES]?.department;
    const label = dept ? (DEPARTMENT_LABEL[dept] ?? dept) : row.role;
    depts.set(label, (depts.get(label) ?? 0) + row.costUsd);
  }
  if (month.unassigned.costUsd > 0) depts.set('Trợ lý, gọi thử', month.unassigned.costUsd);
  const deptRows = [...depts.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const deptMax = Math.max(0.01, ...deptRows.map(([, v]) => v));

  return (
    <div className="pb-8">
      <ErrorNote error={error} />

      <div className={s.root}>
        <section className={s.kpis} aria-label="Tình trạng ngân sách">
          <Kpi label={`Đã chi tháng ${monthLabel}`} value={usd(month.costUsd)} sub={`Trả theo token · ${int(month.calls)} lượt ghi chi phí`}>
            <Stack parts={byProvider.filter((row) => row.costUsd > 0).map((row) => ({ value: row.costUsd, color: color(row.provider), title: name(row.provider) }))} />
          </Kpi>
          <Kpi
            label="Tính vào hạn mức"
            value={globalMonth ? <>{usd(globalMonth.spentUsd)}<small>/ {usd(globalMonth.limitUsd)}</small></> : '—'}
            sub={countFromInMonth ? `Đếm từ ${stamp(countFromInMonth)}, lúc đặt lại mốc` : 'Đếm từ đầu tháng'}
          >
            {globalMonth && <Bar ratio={globalMonth.ratio} tone={limitTone(globalMonth.ratio, warnAt)} ticks={[warnAt]} />}
          </Kpi>
          <Kpi label="Còn được chi" value={globalMonth ? usd(Math.max(0, globalMonth.limitUsd - globalMonth.spentUsd)) : '—'} sub={globalMonth ? `Báo ở ${usd(globalMonth.limitUsd * warnAt)}, ${globalMonth.hardStop ? 'dừng' : 'chỉ cảnh báo'} ở ${usd(globalMonth.limitUsd)}` : 'Chưa đặt hạn mức tháng'}>
            {globalMonth && <Bar ratio={Math.max(0, 1 - globalMonth.ratio)} tone="brand" />}
          </Kpi>
          <Kpi label="Tổng tiền AI tháng này" value={usd(month.costUsd + fees)} sub={fees > 0 ? `Gồm ${usd(fees)} phí gói thuê bao` : 'Chưa nhập phí gói thuê bao'} />
        </section>

        <LimitCard data={data} warnAt={warnAt} onSaved={(message) => { setNotice(message); load(); }} onError={setError} />
        {notice && <p className={s.toast}>{notice}</p>}

        <section className={`${s.card} ${s.sec}`} aria-labelledby="daily-title">
          <div className={s.secHead}>
            <div>
              <h2 id="daily-title">Chi phí theo ngày, tháng {monthLabel}</h2>
              <div className={s.sub}>Rê chuột hoặc chạm vào một ngày để xem chi tiết.</div>
            </div>
            <div className={s.keys}>
              {API_PROVIDERS.map((id) => <span key={id}><i style={{ background: color(id) }} />{name(id)}</span>)}
            </div>
          </div>
          <DailyChart monthStart={month.monthStart} daily={month.daily} countFrom={countFromInMonth} />
        </section>

        <div className={s.two}>
          <section className={`${s.card} ${s.sec}`} aria-labelledby="byprov-title">
            <div className={s.secHead}><div><h2 id="byprov-title">Theo hãng</h2><div className={s.sub}>Tháng {monthLabel} · tiền và lượt gọi</div></div></div>
            <div className={s.blist}>
              {byProvider.length === 0 && <p className={s.note}>Chưa có lượt gọi nào trong tháng.</p>}
              {byProvider.map((row) => (
                <div key={row.provider} className={s.brow}>
                  <span className={s.browName}><i style={{ background: color(row.provider) }} /><span>{name(row.provider)}</span></span>
                  <Bar ratio={month.costUsd ? row.costUsd / month.costUsd : 0} color={color(row.provider)} />
                  <span className={s.val}>{usd(row.costUsd)}<small>{int(row.calls)} lượt</small></span>
                </div>
              ))}
            </div>
          </section>
          <section className={`${s.card} ${s.sec}`} aria-labelledby="bydept-title">
            <div className={s.secHead}><div><h2 id="bydept-title">Theo phòng ban</h2><div className={s.sub}>Tháng {monthLabel} · tiền trả theo token</div></div></div>
            <div className={s.blist}>
              {deptRows.length === 0 && <p className={s.note}>Chưa có chi phí nào trong tháng.</p>}
              {deptRows.slice(0, 5).map(([label, value]) => <DeptRow key={label} label={label} value={value} max={deptMax} total={month.costUsd} />)}
              {deptRows.length > 5 && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-ink-300">{deptRows.length - 5} mục còn lại · {usd(deptRows.slice(5).reduce((sum, [, v]) => sum + v, 0))}</summary>
                  <div className={s.blist} style={{ marginTop: 12 }}>
                    {deptRows.slice(5).map(([label, value]) => <DeptRow key={label} label={label} value={value} max={deptMax} total={month.costUsd} />)}
                  </div>
                </details>
              )}
            </div>
          </section>
        </div>

        <section className={`${s.card} ${s.sec}`} aria-labelledby="proj-title">
          <div className={s.secHead}><div><h2 id="proj-title">Theo dự án</h2><div className={s.sub}>Tiền thật đã tiêu từ trước tới nay so với hạn mức của dự án. Vàng từ 80%, đỏ khi chạm hạn.</div></div></div>
          <div className={s.projects}>
            <div className={`${s.proj} ${s.projHead}`}><span>Ngày</span><span>Dự án</span><span>Trạng thái</span><span>Đã dùng / hạn mức</span><span className="text-right">Tiền</span></div>
            {data.projects.length === 0 && <p className={s.empty}>Chưa có dự án nào.</p>}
            {data.projects.map((project) => {
              const ratio = project.budgetUsd > 0 ? project.spentUsd / project.budgetUsd : 0;
              return (
                <div key={project.id} className={s.proj}>
                  <span className={`${s.projD} ${s.num}`}>{ddmm(project.createdAt)}</span>
                  <span className={s.projT} title={project.name}>{project.name}</span>
                  <span className={s.projS}><Pill tone={project.status === 'COMPLETED' ? 'good' : project.status === 'ARCHIVED' ? 'off' : 'brand'}>{PROJECT_STATUS_LABEL[project.status] ?? project.status}</Pill></span>
                  <Bar ratio={ratio} tone={limitTone(ratio)} />
                  <span className={s.val}>{usd(project.spentUsd)}<small>/ {usd(project.budgetUsd)}</small></span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function DeptRow({ label, value, max, total }: { label: string; value: number; max: number; total: number }): React.JSX.Element {
  return (
    <div className={s.brow}>
      <span className={s.browName}><span>{label}</span></span>
      <Bar ratio={value / max} tone={total && value / total > 0.4 ? 'warn' : 'brand'} />
      <span className={s.val}>{usd(value)}<small>{total ? pct(value / total) : '—'}</small></span>
    </div>
  );
}

/** Hạn mức tháng: thanh lớn (đã tính / trần, khung nhạt tới tổng cả tháng), cảnh báo trùng hạn mức, form sửa, phí gói. */
function LimitCard({ data, warnAt, onSaved, onError }: { data: Overview; warnAt: number; onSaved: (message: string) => void; onError: (message: string) => void }): React.JSX.Element {
  const g = data.globalMonth;
  const [limit, setLimit] = useState(String(g?.limitUsd ?? 50));
  const [warn, setWarn] = useState(String(Math.round(warnAt * 100)));
  const [hardStop, setHardStop] = useState(g?.hardStop ?? true);
  const [claudeFee, setClaudeFee] = useState(data.planFees['claude-code']?.toString() ?? '');
  const [codexFee, setCodexFee] = useState(data.planFees.codex?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const monthPolicies = data.policies.filter((p) => p.scope === 'GLOBAL' && p.period === 'MONTH');
  const ratio = g?.ratio ?? 0;
  const ghost = g && g.limitUsd > 0 && data.month.costUsd > g.spentUsd ? data.month.costUsd / g.limitUsd : undefined;

  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true);
    try {
      onSaved(await action());
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không lưu được');
    } finally {
      setBusy(false);
    }
  };
  const save = (): Promise<void> =>
    run(async () => {
      const limitUsd = Number(limit);
      const warnThreshold = Number(warn) / 100;
      if (!Number.isFinite(limitUsd) || limitUsd <= 0) throw new Error('Hạn mức phải là số lớn hơn 0.');
      if (!Number.isFinite(warnThreshold) || warnThreshold <= 0 || warnThreshold > 1) throw new Error('Ngưỡng báo phải nằm trong khoảng 1–100%.');
      const fee = (value: string): number | null => (value.trim() === '' ? null : Number(value));
      const fees = { 'claude-code': fee(claudeFee), codex: fee(codexFee) };
      if (Object.values(fees).some((value) => value !== null && !(value >= 0))) throw new Error('Phí gói phải là số không âm, hoặc để trống.');
      await api('/api-center/budgets', { method: 'PUT', body: { scope: 'GLOBAL', scopeId: null, limitUsd, period: 'MONTH', warnThreshold, hardStop } });
      await api('/api-center/plan-fees', { method: 'PUT', body: fees });
      return 'Đã lưu hạn mức và phí gói.';
    });
  const reset = (): Promise<void> =>
    run(async () => {
      if (!window.confirm('Đặt lại mốc tính chi phí từ bây giờ? Lịch sử lượt gọi giữ nguyên; hạn mức, bảng điều khiển và bản tin tính lại từ 0.')) return '';
      await api('/cost/reset', { method: 'POST' });
      return 'Đã đặt lại mốc tính chi phí từ bây giờ.';
    });

  return (
    <section className={`${s.card} ${s.sec}`} aria-labelledby="limit-title">
      <div className={s.secHead}>
        <div>
          <h2 id="limit-title">Hạn mức tháng cho toàn công ty</h2>
          <div className={s.sub}>Chỉ tính tiền trả theo token cho hãng API. Gói thuê bao ghi $0 mỗi lượt.</div>
        </div>
        {g ? <Pill tone={g.exceeded ? 'bad' : g.warned ? 'warn' : 'good'}>{g.exceeded ? 'Đã chạm trần' : g.warned ? 'Đã qua ngưỡng báo' : 'Còn trong hạn mức'}</Pill> : <Pill tone="off">Chưa đặt</Pill>}
      </div>
      {g && (
        <div className={s.meter}>
          <div className={s.meterTop}><span>Đã tính <b>{usd(g.spentUsd)}</b> trên hạn mức <b>{usd(g.limitUsd)}</b></span><b>{pct(ratio)}</b></div>
          <Bar ratio={ratio} tone={limitTone(ratio, warnAt)} ticks={[warnAt]} ghost={ghost} big />
          <div className={s.scale}>
            <span style={{ left: 0 }}>$0</span>
            {ghost !== undefined && ghost < 0.92 && <span style={{ left: `${ghost * 100}%` }}>{usd(data.month.costUsd)}<small><br />nếu tính cả tháng</small></span>}
            <span style={{ left: `${warnAt * 100}%` }}>{usd(g.limitUsd * warnAt)}<small><br />báo CEO</small></span>
            <span style={{ left: '100%' }}>{usd(g.limitUsd)}<small><br />{g.hardStop ? 'dừng gọi API' : 'chỉ cảnh báo'}</small></span>
          </div>
        </div>
      )}
      {monthPolicies.length > 1 && (
        <div className={s.alert}>
          <span aria-hidden="true">⚠</span>
          <span>
            <b>Có {monthPolicies.length} hạn mức tháng cho toàn công ty.</b>{' '}
            {monthPolicies.map((p) => `${usd(Number(p.limitUsd))}${p.createdAt ? ` (tạo ${ddmm(p.createdAt)})` : ''}`).join(' và ')}. Máy chủ chỉ đọc một dòng
            {g ? `, hiện là ${usd(g.limitUsd)}` : ''}; các dòng còn lại không có tác dụng. Lưu form dưới đây chưa gộp được chúng — cần sửa phía máy chủ.
          </span>
        </div>
      )}
      <div className={s.formGrid}>
        <label>Hạn mức tháng (USD)<input className={`${s.field} ${s.num}`} value={limit} onChange={(event) => setLimit(event.target.value)} inputMode="decimal" /></label>
        <label>Báo trước khi chạm (%)<input className={`${s.field} ${s.num}`} value={warn} onChange={(event) => setWarn(event.target.value)} inputMode="numeric" /></label>
        <label>Khi vượt hạn mức<span className={s.switch}><input type="checkbox" checked={hardStop} onChange={(event) => setHardStop(event.target.checked)} /> Dừng gọi AI trả tiền</span></label>
      </div>
      <div className={s.formGrid}>
        <label>Phí gói Claude mỗi tháng (USD, tuỳ chọn)<input className={`${s.field} ${s.num}`} value={claudeFee} onChange={(event) => setClaudeFee(event.target.value)} placeholder="Chưa nhập" inputMode="decimal" /></label>
        <label>Phí gói ChatGPT mỗi tháng (USD, tuỳ chọn)<input className={`${s.field} ${s.num}`} value={codexFee} onChange={(event) => setCodexFee(event.target.value)} placeholder="Chưa nhập" inputMode="decimal" /></label>
      </div>
      <p className={s.note}>Phí gói chỉ để thống kê tổng tiền AI thật sự trả mỗi tháng, không tính vào hạn mức chặn. Hạn mức dự án ({usd(20)} mặc định) đặt lúc tạo dự án.</p>
      {data.policies.filter((p) => !(p.scope === 'GLOBAL' && p.period === 'MONTH')).length > 0 && (
        <div className={s.policies}>
          {data.policies.filter((p) => !(p.scope === 'GLOBAL' && p.period === 'MONTH')).map((p) => (
            <div key={p.id} className={s.policy}>
              <b>{p.scope === 'GLOBAL' ? 'Toàn công ty' : p.scope === 'PROJECT' ? 'Dự án' : p.scope === 'AGENT' ? 'Nhân sự' : p.scope}</b>
              <span>{p.period === 'DAY' ? 'mỗi ngày' : p.period === 'MONTH' ? 'mỗi tháng' : 'mỗi dự án'}</span>
              <span className={s.num}>{usd(Number(p.limitUsd))}</span>
              <span className={s.muted}>báo ở {Math.round(Number(p.warnThreshold) * 100)}%</span>
            </div>
          ))}
        </div>
      )}
      <div className={s.actions}>
        <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void save()}>Lưu</button>
        <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void reset()}>Đặt lại mốc tính…</button>
      </div>
    </section>
  );
}

/** Cột chồng theo ngày trong tháng, mỗi hãng một màu; vẽ theo đúng bề rộng thẻ để chữ không co. */
function DailyChart({ monthStart, daily, countFrom }: { monthStart: string; daily: Overview['month']['daily']; countFrom: string | null }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const start = new Date(monthStart);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const today = new Date().getMonth() === start.getMonth() ? new Date().getDate() : days;
  const [focus, setFocus] = useState(today);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const byDay = new Map<number, Array<{ provider: string; costUsd: number; calls: number }>>();
  for (const row of daily) {
    const d = Number(row.day.slice(8, 10));
    byDay.set(d, [...(byDay.get(d) ?? []), row]);
  }
  const dayTotal = (d: number): number => (byDay.get(d) ?? []).reduce((sum, row) => sum + row.costUsd, 0);
  const peak = Math.max(1, ...Array.from({ length: days }, (_, i) => dayTotal(i + 1)));
  const step = peak <= 2 ? 0.5 : peak <= 5 ? 1 : peak <= 10 ? 2 : Math.ceil(peak / 5);
  const max = Math.ceil(peak / step) * step;
  const W = width, H = 230, L = 46, R = 10, T = 30, B = 30;
  const bw = W > 0 ? (W - L - R) / days : 0;
  const y = (v: number): number => T + (H - T - B) * (1 - v / max);
  const narrow = W < 480;
  const axis = narrow ? [1, 10, 20, today] : [1, 5, 10, 15, 20, 25, days, today];
  const focusRows = (byDay.get(focus) ?? []).filter((row) => row.costUsd > 0);
  const marker = countFrom ? (() => {
    const at = new Date(countFrom);
    return L + (at.getDate() - 1 + (at.getHours() + at.getMinutes() / 60) / 24) * bw;
  })() : null;

  return (
    <>
      <div ref={boxRef} className={s.chart}>
        {W > 0 && (
          <svg viewBox={`0 0 ${W} ${H}`} height={H} role="img" aria-label={`Chi phí theo ngày trong tháng, cao nhất ${usd(peak)}`}>
            {Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step).map((v) => (
              <g key={v}>
                <line className={s.gl} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
                <text className={s.ax} x={L - 8} y={y(v) + 4} textAnchor="end">${v}</text>
              </g>
            ))}
            {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
              const x = L + (d - 1) * bw;
              let acc = 0;
              return (
                <g key={d}>
                  {API_PROVIDERS.concat(['claude-code', 'codex'] as ProviderId[]).map((provider) => {
                    const v = (byDay.get(d) ?? []).find((row) => row.provider === provider)?.costUsd ?? 0;
                    if (v <= 0) return null;
                    const rect = <rect key={provider} x={x + bw * 0.18} y={y(acc + v)} width={bw * 0.64} height={Math.max(1.5, y(acc) - y(acc + v))} rx={2} fill={color(provider)} />;
                    acc += v;
                    return rect;
                  })}
                  {d > today && <rect x={x + bw * 0.18} y={y(0) - 2} width={bw * 0.64} height={2} fill="var(--line-strong)" />}
                  {[...new Set(axis)].includes(d) && !(d !== today && Math.abs(d - today) < (narrow ? 4 : 2)) && (
                    <text className={s.ax} x={x + bw / 2} y={H - 10} textAnchor="middle" fontWeight={d === today ? 700 : undefined}>{d === today && !narrow ? `${d} · nay` : d}</text>
                  )}
                  <rect className={`${s.hit} ${d === focus ? s.hitOn : ''}`} x={x} y={T - 6} width={bw} height={H - T - B + 6} onPointerEnter={() => setFocus(d)} onClick={() => setFocus(d)} />
                </g>
              );
            })}
            {marker !== null && (
              <g pointerEvents="none">
                <line className={s.mk} x1={marker} x2={marker} y1={T - 14} y2={y(0)} />
                <text className={s.mkT} x={marker - 6} y={T - 16} textAnchor="end">Đặt lại mốc {stamp(countFrom!)}</text>
              </g>
            )}
          </svg>
        )}
      </div>
      <p className={s.toast}>
        <b>{String(focus).padStart(2, '0')}/{String(start.getMonth() + 1).padStart(2, '0')}:</b> {usd(dayTotal(focus))}
        {focusRows.length > 0 ? ` · ${focusRows.map((row) => `${name(row.provider)} ${usd(row.costUsd)}`).join(' · ')}` : focus > today ? ' · chưa tới' : ' · không gọi API trả tiền'}
      </p>
    </>
  );
}
