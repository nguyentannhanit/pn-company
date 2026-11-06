/**
 * P&N — "Phân bổ model cho nhân viên": bốn combo tự động (xem trước bằng đúng quy tắc máy chủ dùng, trong
 * `@pn/shared/allocation`) hoặc chọn tay hãng + bậc cho từng vai trò. Bảng bên dưới hiện số liệu 30 ngày
 * thật của từng vai trò, model đang chạy và lý do — kể cả khi định tuyến thông minh tự nâng bậc.
 */

'use client';

import { useMemo, useState } from 'react';

import { AGENT_PROFILES, COMBO_INFO, allocationLoad, planAllocation, tierMix, type AgentRole, type RoleUsage as SharedUsage } from '@pn/shared';

import { api } from '@/lib/api';
import { DEPARTMENT_LABEL, roleLabel } from '@/lib/brand';

import { Bar, PROVIDER_META, Pill, Sig, Stack, TIER_WORD, int, okTone, pct, seconds, shortModel, stamp, tokens, styles as s, type AllocationPayload, type Combo, type ProviderId, type Tier } from './kit';

const COMBOS: Combo[] = ['economy', 'balanced', 'quality', 'speed'];
const LEVEL_COLOR: Record<Tier, string> = { strong: 'var(--st-lv0)', medium: 'var(--st-lv1)', cheap: 'var(--st-lv2)' };

export function Allocation({ data, onData, onError }: { data: AllocationPayload; onData: (next: AllocationPayload) => void; onError: (message: string) => void }): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, { provider: ProviderId; tier: Tier }> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const overrides = draft ?? data.overrides;
  const usage = data.usage as unknown as SharedUsage[];
  const tiers = data.defaultTiers as Record<AgentRole, Tier>;

  // Xem trước bốn combo trên số liệu hiện tại: cơ cấu mạnh/vừa/nhanh và tải hạn mức so với Cân bằng.
  const previews = useMemo(() => {
    const plan = (combo: Combo) => planAllocation({ usage, combo, defaultTiers: tiers, smartRouting: data.smartRouting });
    const base = allocationLoad(plan('balanced'), usage) || 1;
    return Object.fromEntries(COMBOS.map((combo) => {
      const p = plan(combo);
      return [combo, { mix: tierMix(p), load: allocationLoad(p, usage) / base }];
    })) as Record<Combo, { mix: [number, number, number]; load: number }>;
  }, [usage, tiers, data.smartRouting]);

  // Kế hoạch đang hiện: chế độ thủ công dùng bản nháp chọn tay để thấy ngay kết quả trước khi lưu.
  const plans = useMemo(
    () => (draft ? planAllocation({ usage, combo: data.combo, defaultTiers: tiers, smartRouting: data.smartRouting, overrides: draft as never }) : data.plans),
    [draft, data, usage, tiers],
  );

  const send = async (key: string, body: unknown, method = 'PUT', path = '/api-center/allocation'): Promise<void> => {
    setBusy(key);
    setNotice(null);
    try {
      const next = await api<AllocationPayload>(path, { method, body });
      onData(next);
      setDraft(null);
      setNotice(next.written ? `Đã ghi lại đường đi cho ${next.written} vai trò.` : 'Chưa có nguồn AI nào dùng được nên bảng định tuyến giữ nguyên.');
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không lưu được');
    } finally {
      setBusy(null);
    }
  };

  const auto = data.mode === 'auto';
  const roles = Object.keys(data.plans) as AgentRole[];
  const byRole = new Map(data.usage.map((row) => [row.role, row]));
  const totalTokens = data.usage.reduce((sum, row) => sum + row.tokens, 0);
  const withData = roles.filter((role) => (byRole.get(role)?.calls ?? 0) > 0).sort((a, b) => (byRole.get(b)?.tokens ?? 0) - (byRole.get(a)?.tokens ?? 0) || (byRole.get(b)?.calls ?? 0) - (byRole.get(a)?.calls ?? 0));
  const noData = roles.filter((role) => (byRole.get(role)?.calls ?? 0) === 0);
  const providerOf = new Map(data.providers.map((p) => [p.provider, p]));
  const usableOrder = data.order.filter((id) => data.usable.includes(id));
  const failures = data.totals.failures;

  const row = (role: AgentRole): React.JSX.Element => {
    const plan = plans[role]!;
    const u = byRole.get(role);
    const route = data.routes.find((r) => r.agentRole === role);
    const provider = (draft ? (plan.provider ?? usableOrder[0]) : route?.provider) as ProviderId | undefined;
    const model = provider ? shortModel(provider, providerOf.get(provider)?.models[plan.effectiveTier]) : null;
    const okRatio = u?.calls ? u.ok / u.calls : 0;
    const share = totalTokens ? (u?.tokens ?? 0) / totalTokens : 0;
    const current = overrides[role];
    return (
      <div key={role} className={`${s.arow} ${plan.manual ? s.arowEdit : ''}`}>
        <div className={s.who}>
          <b>{roleLabel(role)}{plan.manual && <span className={s.editTag}>chọn tay</span>}</b>
          <small>{DEPARTMENT_LABEL[AGENT_PROFILES[role].department] ?? ''} · hạng {TIER_WORD[tiers[role]]}</small>
        </div>
        {u?.calls ? (
          <div className={s.data}>
            <span className={s.dataLine}><span>{int(u.calls)} lượt · {seconds(u.avgLatencyMs)}</span><b>{pct(okRatio)}</b></span>
            <Bar ratio={okRatio} tone={okTone(okRatio)} />
          </div>
        ) : (
          <div className={`${s.data} ${s.muted}`}>Chưa chạy trong {data.windowDays} ngày</div>
        )}
        {u?.tokens ? (
          <div className={s.data}>
            <span className={s.dataLine}><span>{tokens(u.tokens)}</span><b>{(share * 100).toFixed(1).replace('.', ',')}%</b></span>
            <Bar ratio={share / 0.45} tone={share >= 0.1 ? 'warn' : 'brand'} />
          </div>
        ) : (
          <div className={`${s.data} ${s.muted}`}>—</div>
        )}
        <div>
          {auto ? (
            model ? (
              <span className={s.mchip}><Sig tier={plan.effectiveTier} />{model} <span className={s.by}>· {PROVIDER_META[provider!].name}</span></span>
            ) : (
              <span className={s.muted}>Chưa có nguồn AI</span>
            )
          ) : (
            <select
              className={s.msel}
              value={current ? `${current.provider}:${current.tier}` : ''}
              aria-label={`Model cho ${roleLabel(role)}`}
              onChange={(event) => {
                const next = { ...overrides };
                if (!event.target.value) delete next[role];
                else {
                  const [p, t] = event.target.value.split(':') as [ProviderId, Tier];
                  next[role] = { provider: p, tier: t };
                }
                setDraft(next);
              }}
            >
              <option value="">Theo combo ({model ?? '—'})</option>
              {usableOrder.map((id) => (
                <optgroup key={id} label={PROVIDER_META[id].name}>
                  {(['strong', 'medium', 'cheap'] as Tier[]).map((tier) => (
                    <option key={tier} value={`${id}:${tier}`}>{PROVIDER_META[id].name} · {shortModel(id, providerOf.get(id)?.models[tier])} ({TIER_WORD[tier]})</option>
                  ))}
                </optgroup>
              ))}
            </select>
          )}
        </div>
        <div className={s.why}>{plan.reason}</div>
      </div>
    );
  };

  const analyzed = data.analyzedAt ? stamp(data.analyzedAt) : null;
  const edits = Object.keys(overrides).length;

  return (
    <section className={`${s.card} ${s.sec}`} aria-labelledby="alloc-title">
      <div className={s.secHead}>
        <div>
          <h2 id="alloc-title">Phân bổ model cho nhân viên</h2>
          <div className={s.sub}>
            {auto
              ? 'Máy chọn bậc model cho từng nhân viên theo combo, dựa trên số liệu thật. Hãng nào nhận việc thì theo thứ tự ở trên.'
              : 'Bạn chọn hẳn hãng và model cho vai trò muốn sửa. Vai trò còn lại theo combo; hãng đã chọn lỗi hoặc hết lượt thì đi theo thứ tự chung.'}
          </div>
        </div>
        <div className={s.seg} role="group" aria-label="Cách phân bổ">
          {(['auto', 'manual'] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={data.mode === mode} disabled={busy !== null} onClick={() => mode !== data.mode && void send('mode', { mode })}>
              {mode === 'auto' ? 'Tự động' : 'Thủ công'}
            </button>
          ))}
        </div>
      </div>

      <div className={s.combos} role="radiogroup" aria-label="Combo">
        {COMBOS.map((combo) => {
          const preview = previews[combo];
          return (
            <button key={combo} type="button" role="radio" aria-checked={data.combo === combo} className={s.combo} disabled={busy !== null} onClick={() => combo !== data.combo && void send(`combo-${combo}`, { combo })}>
              <span className={s.comboTop}>
                <b>{COMBO_INFO[combo].name}</b>
                {data.combo === combo ? <Pill tone="brand">Đang dùng</Pill> : busy === `combo-${combo}` ? <Pill tone="off">Đang áp dụng…</Pill> : null}
              </span>
              <p>{COMBO_INFO[combo].description}</p>
              <Stack parts={(['strong', 'medium', 'cheap'] as Tier[]).map((tier, index) => ({ value: preview.mix[index]!, color: LEVEL_COLOR[tier] }))} />
              <span className={s.mix}>
                {(['strong', 'medium', 'cheap'] as Tier[]).map((tier, index) => (
                  <span key={tier}><i style={{ background: LEVEL_COLOR[tier] }} />{preview.mix[index]} {TIER_WORD[tier]}</span>
                ))}
              </span>
              <span className={s.load}>Tải hạn mức gói ≈ <b>{pct(preview.load)}</b> so với Cân bằng</span>
            </button>
          );
        })}
      </div>

      <div className={s.analysis}>
        <p>
          Phân tích từ {int(data.totals.calls)} lượt gọi và {(totalTokens / 1e6).toFixed(2).replace('.', ',')} triệu token trong {data.windowDays} ngày qua.
          {failures > 0 && ` ${int(data.totals.providerSideFailures)}/${int(failures)} lượt hỏng do hãng quá tải hoặc giới hạn, không do model yếu, nên máy không dựa vào tỉ lệ hỏng để nâng model.`}
          {' '}Tự phân tích lại khi một nguồn AI được bật, tắt, xoá key hoặc kiểm tra đổi kết quả.
          {analyzed && ` Lần gần nhất: ${analyzed}${data.trigger ? ` · ${data.trigger}` : ''}.`}
        </p>
        <div className={s.actions}>
          <label className={s.switch} title="Việc viết code, tìm lỗi và rà kiến trúc tự dùng bậc mạnh">
            <input type="checkbox" checked={data.smartRouting} disabled={busy !== null} onChange={(event) => void send('smart', { smartRouting: event.target.checked })} />
            Tự nâng bậc cho việc khó
          </label>
          {auto ? (
            <button type="button" className={`${s.btn} ${s.btnQuiet}`} disabled={busy !== null} onClick={() => void send('analyze', undefined, 'POST', '/api-center/allocation/analyze')}>
              {busy === 'analyze' ? 'Đang phân tích…' : 'Phân tích lại'}
            </button>
          ) : (
            <>
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} disabled={busy !== null || edits === 0} onClick={() => void send('clear', { overrides: {} })}>Bỏ chọn tay ({edits})</button>
              <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} disabled={busy !== null || draft === null} onClick={() => void send('overrides', { overrides })}>Lưu chọn tay</button>
            </>
          )}
        </div>
      </div>
      {notice && <p className={s.toast}>{notice}</p>}

      <div className={s.arows}>
        <div className={`${s.arow} ${s.arowHead}`}>
          <span>Nhân viên</span>
          <span>{data.windowDays} ngày · thành công</span>
          <span>Phần token</span>
          <span>Model đang chạy</span>
          <span>Lý do</span>
        </div>
        {withData.map(row)}
        {noData.length > 0 && (
          <details className={s.fold}>
            <summary>{noData.length} vai trò chưa chạy lần nào trong {data.windowDays} ngày</summary>
            {noData.map(row)}
          </details>
        )}
      </div>
    </section>
  );
}
