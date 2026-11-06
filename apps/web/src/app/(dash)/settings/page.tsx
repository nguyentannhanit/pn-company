/**
 * P&N — Cài đặt → Kết nối AI, bản 4.
 *
 * Từ trên xuống: dải chỉ số; sơ đồ 3D các nguồn AI theo thứ tự dùng + bảng chi tiết nguồn đang chọn (đăng
 * nhập, dán key/token, kiểm tra, tắt, xoá); danh sách thứ tự kéo thả; phân bổ model cho 26 nhân viên; bảng
 * giá model và kiểm tra hệ thống gập lại ở cuối. Mọi số là số thật từ máy chủ.
 *
 * §88.3 giữ nguyên: key/token không bao giờ quay về trình duyệt, chỉ có chuỗi preview đã che.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import { ErrorNote } from '@/components/ui';
import { Allocation } from '@/components/settings/Allocation';
import { OrderList } from '@/components/settings/OrderList';
import { PricingCard, type ModelRow } from '@/components/settings/PricingCard';
import { ProviderDetail } from '@/components/settings/ProviderDetail';
import { RackStage } from '@/components/settings/RackStage';
import { Bar, Cells, Kpi, PROVIDER_META, Stack, int, okTone, pct, styles as s, usd, limitTone, type AllocationPayload, type ProviderId, type Tier } from '@/components/settings/kit';
import { COMBO_INFO, DEFAULT_PROVIDER_ORDER } from '@pn/shared';
import { api, type HealthReport } from '@/lib/api';

const LEVEL_COLOR: Record<Tier, string> = { strong: 'var(--st-lv0)', medium: 'var(--st-lv1)', cheap: 'var(--st-lv2)' };

export default function SettingsPage(): React.JSX.Element {
  const [data, setData] = useState<AllocationPayload | null>(null);
  const [draftOrder, setDraftOrder] = useState<ProviderId[] | null>(null);
  const [selected, setSelected] = useState<ProviderId>('claude-code');
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      api<AllocationPayload>('/api-center/allocation'),
      api<HealthReport>('/api-center/health'),
      api<{ models: ModelRow[] }>('/api-center/models'),
    ])
      .then(([allocation, healthResult, modelResult]) => {
        setData(allocation);
        setHealth(healthResult);
        setModels(modelResult.models);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được cấu hình'));
  }, []);
  useEffect(load, [load]);

  const order = draftOrder ?? data?.order ?? [];
  const dirty = draftOrder !== null && data !== null && draftOrder.join() !== data.order.join();
  const providers = useMemo(() => (data ? order.map((id) => data.providers.find((p) => p.provider === id)!).filter(Boolean) : []), [data, order]);
  const mix = useMemo(() => {
    const counts: Record<Tier, number> = { strong: 0, medium: 0, cheap: 0 };
    for (const plan of Object.values(data?.plans ?? {})) counts[plan.effectiveTier] += 1;
    return counts;
  }, [data]);

  const saveOrder = async (): Promise<void> => {
    if (!draftOrder) return;
    setSaving(true);
    try {
      const next = await api<AllocationPayload>('/api-center/allocation', { method: 'PUT', body: { order: draftOrder } });
      setData(next);
      setDraftOrder(null);
      setNotice(next.written ? `Đã lưu thứ tự và ghi lại đường đi cho ${next.written} vai trò.` : 'Đã lưu thứ tự. Chưa có nguồn AI nào dùng được nên bảng định tuyến giữ nguyên.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không lưu được thứ tự');
    } finally {
      setSaving(false);
    }
  };

  if (!data) {
    return (
      <div className="pb-8">
        <ErrorNote error={error} />
        <div className={s.root}><div className="pn-skeleton h-[480px]" /></div>
      </div>
    );
  }

  const live = providers.filter((p) => p.usable);
  const current = providers.find((p) => p.provider === selected) ?? providers[0]!;
  const okRatio = data.totals.calls ? data.totals.ok / data.totals.calls : 0;
  const budget = data.budget;
  const hasApiBackup = live.some((p) => p.kind === 'api');

  return (
    <div className="pb-8">
      <ErrorNote error={error} />

      <div className={s.root}>
        <section className={s.kpis} aria-label="Tình trạng AI">
          <Kpi label="Nguồn AI dùng được" value={<>{live.length}<small>/ {providers.length}</small></>} sub={live.map((p) => PROVIDER_META[p.provider].name).join(', ') || 'Chưa có'}>
            <Cells total={providers.length} on={live.length} />
          </Kpi>
          <Kpi
            label={`Lượt gọi AI ${data.windowDays} ngày`}
            value={int(data.totals.calls)}
            sub={data.totals.calls ? `${pct(okRatio)} thành công${data.totals.failures ? ` · ${data.totals.providerSideFailures}/${data.totals.failures} lượt hỏng do hãng` : ''}` : 'Chưa có lượt gọi'}
          >
            <Bar ratio={okRatio} tone={data.totals.calls ? okTone(okRatio) : 'off'} />
          </Kpi>
          <Kpi
            label="Chi phí tính vào hạn mức"
            value={budget ? <>{usd(budget.spentUsd)}<small>/ {usd(budget.limitUsd)}</small></> : usd(0)}
            sub={<>Gói thuê bao ghi $0 · <Link href="/settings/budget">xem ngân sách</Link></>}
          >
            {budget ? <Bar ratio={budget.ratio} tone={limitTone(budget.ratio)} ticks={[0.8]} /> : <Bar ratio={0} tone="off" />}
          </Kpi>
          <Kpi label="Phân bổ model" value={data.mode === 'auto' ? COMBO_INFO[data.combo].name : 'Thủ công'} sub={`${mix.strong} mạnh · ${mix.medium} vừa · ${mix.cheap} nhanh`}>
            <Stack parts={(['strong', 'medium', 'cheap'] as Tier[]).map((tier) => ({ value: mix[tier], color: LEVEL_COLOR[tier] }))} />
          </Kpi>
        </section>

        <section className={s.hero}>
          <RackStage providers={providers} selected={current.provider} onSelect={(id) => setSelected(id as ProviderId)} modeLabel={data.mode === 'auto' ? `Tự động · ${COMBO_INFO[data.combo].name}` : 'Thủ công'} />
          <ProviderDetail
            key={current.provider}
            provider={current}
            slot={order.indexOf(current.provider)}
            rank={live.indexOf(current)}
            onChanged={load}
            onMoveTop={(id) => setDraftOrder([id as ProviderId, ...order.filter((x) => x !== id)])}
          />
        </section>

        <section className={`${s.card} ${s.sec}`} aria-labelledby="chain-title">
          <div className={s.secHead}>
            <div>
              <h2 id="chain-title">Thứ tự dùng hãng</h2>
              <div className={s.sub}>Kéo tay nắm ⋮⋮ hoặc bấm mũi tên để xếp. Hãng chưa dùng được vẫn giữ chỗ, tới lượt thì bị bỏ qua.</div>
            </div>
            <div className={s.tools}>
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={() => setDraftOrder([...DEFAULT_PROVIDER_ORDER] as ProviderId[])}>Gói trước, API sau</button>
            </div>
          </div>
          {dirty && (
            <div className={s.savebar}>
              <span>Thứ tự mới chưa lưu. Sơ đồ phía trên đang hiện thứ tự mới.</span>
              <span className={s.actions}>
                <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} disabled={saving} onClick={() => setDraftOrder(null)}>Hoàn tác</button>
                <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} disabled={saving} onClick={() => void saveOrder()}>{saving ? 'Đang lưu…' : 'Lưu cho 26 vai trò'}</button>
              </span>
            </div>
          )}
          {notice && !dirty && <p className={s.toast}>{notice}</p>}
          <OrderList order={order} providers={data.providers} selected={current.provider} mix={mix} totalCalls={data.totals.calls} onSelect={setSelected} onChange={setDraftOrder} />
          {live.length === 0 ? (
            <div className={`${s.alert} ${s.alertBad}`}><span aria-hidden="true">⚠</span><span><b>Chưa có nguồn AI nào dùng được.</b> Nhân viên AI không làm việc được cho tới khi bật một gói thuê bao hoặc dán một key API ở bảng chi tiết phía trên.</span></div>
          ) : !hasApiBackup ? (
            <div className={s.alert}><span aria-hidden="true">⚠</span><span><b>Không có API dự phòng.</b> Khi mọi gói thuê bao đều chạm hạn mức khung 5 giờ hoặc tuần, việc sẽ dừng tới khi hạn mức hồi. Dán một key API để có lưới an toàn.</span></div>
          ) : null}
        </section>

        <Allocation data={data} onData={setData} onError={setError} />

        <details className={`${s.card} ${s.sec}`}>
          <summary className="cursor-pointer text-[15px] font-semibold">Giá model (chỉ dùng cho nguồn API trả theo token)</summary>
          <PricingCard
            models={models}
            routes={data.routes}
            connected={data.usable}
            onSaved={(message) => { setNotice(message); load(); }}
            onError={setError}
          />
        </details>

        {health && (
          <details className={`${s.card} ${s.sec}`}>
            <summary className="cursor-pointer text-[15px] font-semibold">
              Kiểm tra hệ thống · <span className={health.ready ? 'text-state-completed' : 'text-produce-400'}>{health.ready ? 'sẵn sàng' : 'còn thiếu cấu hình'}</span>
            </summary>
            <div className="grid gap-2 sm:grid-cols-2">
              {health.checks.map((check) => (
                <div key={check.id} className="flex items-start gap-2 text-sm">
                  <span className="shrink-0">{check.ok ? '✅' : '⬜'}</span>
                  <span>
                    <span className="text-ink-100">{check.label}</span>
                    <span className="mt-0.5 block text-ink-500">{check.detail}</span>
                  </span>
                </div>
              ))}
            </div>
            {health.sandboxEnforcement['note'] && <p className={s.note}>Sandbox: {String(health.sandboxEnforcement['note'])}</p>}
          </details>
        )}
      </div>
    </div>
  );
}
