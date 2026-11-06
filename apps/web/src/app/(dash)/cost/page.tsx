/**
 * P&N — Chi phí AI (§16, §29).
 *
 * §16 yêu cầu bóc tách theo dự án, agent, model và provider — bốn khối ở đây.
 * Cột "chưa có giá" luôn hiện ra thay vì bị gộp im lặng vào 0. Biểu đồ 30 ngày
 * có trục và nhãn ngày để đọc được con số, không chỉ nhìn hình.
 *
 * Thêm: dự báo tiền tới cuối tháng, và số lần việc thất bại vì nhà cung
 * cấp AI từ chối (hết lượt gói miễn phí, hết tiền, quá tải) theo từng model —
 * nguyên nhân số một khiến việc bị kẹt từ khi chuyển sang Gemini gói miễn phí.
 */

'use client';

import { useEffect, useState } from 'react';

import { Button, Card, ErrorNote, PageHeader, Section, Skeleton, Stat } from '@/components/ui';
import { api, type CostSummary } from '@/lib/api';
import { money } from '@/lib/brand';
import { useRefusals, type Refusals } from '@/lib/insights';

export default function CostPage(): React.JSX.Element {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = (): void => {
    api<CostSummary>('/cost/summary')
      .then(setSummary)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được số liệu chi phí'));
  };
  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Đếm lại chi phí từ bây giờ (cho giai đoạn thử nghiệm). Không
   * xoá lịch sử — tiền đã trả nhà cung cấp là thật; chỉ các con số tính lại từ mốc mới.
   */
  const resetCount = async (): Promise<void> => {
    if (!window.confirm('Đếm lại chi phí từ bây giờ? Hôm nay, tháng này, chi phí từng dự án và ngân sách sẽ tính lại từ 0. Lịch sử lượt gọi vẫn giữ.')) return;
    setResetting(true);
    setError(null);
    try {
      await api('/cost/reset', { method: 'POST', body: {} });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không đếm lại được');
    } finally {
      setResetting(false);
    }
  };

  const average = summary && summary.month.calls > 0 ? summary.month.costUsd / summary.month.calls : null;
  const refusals = useRefusals(7);
  // Dự báo tuyến tính: tiêu đều như những ngày đã qua của tháng thì cuối tháng hết bao nhiêu.
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // Vừa đếm lại giữa tháng thì chia cho số ngày kể từ mốc, không phải từ đầu tháng.
  const countFrom = summary?.countFrom ? new Date(summary.countFrom) : null;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysCounted =
    countFrom && countFrom > monthStart ? Math.max(1, (now.getTime() - countFrom.getTime()) / 86_400_000) : now.getDate();
  const forecast = summary ? summary.month.costUsd + (summary.month.costUsd / daysCounted) * (daysInMonth - now.getDate()) : null;

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Tài chính"
        title="Chi phí AI"
        subtitle={
          countFrom
            ? `Đang đếm từ ${countFrom.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })} · giá theo bảng ở Cài đặt`
            : 'Ghi theo từng lượt gọi model, giá theo bảng ở Cài đặt'
        }
        action={
          <Button variant="quiet" onClick={() => void resetCount()} disabled={resetting}>
            {resetting ? 'Đang đếm lại…' : 'Đếm lại từ bây giờ'}
          </Button>
        }
      />
      <ErrorNote error={error} />

      {!summary && <Skeleton rows={4} className="p-5" />}

      {summary && (
        <>
          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Hôm nay" value={money(summary.today.costUsd, 2)} hint={`${summary.today.calls} lượt gọi`} tone="produce" />
            <Stat label="Tháng này" value={money(summary.month.costUsd, 2)} hint={`${summary.month.calls} lượt gọi`} />
            <Stat
              label="Chưa có giá"
              value={String(summary.month.unpricedCalls)}
              hint={summary.month.unpricedCalls > 0 ? 'lượt gọi chưa tính được tiền' : 'mọi lượt gọi đều đã tính tiền'}
              tone={summary.month.unpricedCalls > 0 ? 'alert' : 'live'}
            />
            <Stat
              label="Dự báo cuối tháng"
              value={forecast === null ? '—' : money(forecast, 2)}
              hint={`nếu tiêu đều như ${daysCounted < now.getDate() ? 'từ lúc đếm lại' : `${now.getDate()} ngày qua`}${average === null ? '' : ` · ${money(average, 4)}/lượt`}`}
              tone="learn"
            />
          </div>

          {summary.note && (
            <p className="mx-5 rounded-lg border border-produce-400/25 bg-produce-600/10 px-3 py-2 text-xs text-produce-400">{summary.note}</p>
          )}

          {refusals && (
            <div className="px-5 pt-1">
              <RefusalPanel data={refusals} />
            </div>
          )}

          <div className="grid gap-4 p-5 lg:grid-cols-2">
            <Breakdown title="Theo dự án" rows={summary.byProject} color="var(--tone-violet)" />
            <Breakdown title="Theo nhân sự" rows={summary.byAgent} color="var(--tone-sky)" />
            <Breakdown title="Theo model" rows={summary.byModel} color="var(--tone-amber)" />
            <Breakdown title="Theo provider" rows={summary.byProvider} color="var(--tone-teal)" />
          </div>

          {summary.daily.length > 0 && (
            <div className="px-5">
              <Section title="30 ngày gần nhất" description="Cột cao nhất là ngày tốn nhất; rê chuột để xem số">
                <Card>
                  <DailyChart data={summary.daily} />
                </Card>
              </Section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const REFUSAL_LABEL: Record<string, { label: string; tone: string }> = {
  quota: { label: 'Hết lượt gọi', tone: 'var(--tone-orange)' },
  credit: { label: 'Hết tiền', tone: 'var(--tone-red)' },
  overloaded: { label: 'Quá tải', tone: 'var(--tone-amber)' },
};

/**
 * Số lần việc thất bại vì nhà cung cấp từ chối, theo model, 7 ngày. Nhà cung cấp
 * không cho biết còn bao nhiêu lượt, nên đây là số đo được thật chứ không phải
 * "đồng hồ còn lại" — nói rõ để không ai hiểu nhầm.
 */
function RefusalPanel({ data }: { data: Refusals }): React.JSX.Element {
  const top = Math.max(1, ...data.byModel.map((row) => row.count));
  return (
    <Section
      title={`Bị nhà cung cấp từ chối · ${data.days} ngày`}
      description="Số lần việc thất bại vì model từ chối. Nhà cung cấp không cho biết còn bao nhiêu lượt — đây là số đo được thật."
    >
      <Card>
        {data.total === 0 ? (
          <p className="text-sm text-ink-300">Không lần nào bị từ chối — hạn mức hiện đủ dùng.</p>
        ) : (
          <div className="space-y-2.5">
            {data.byModel.map((row) => {
              const kind = REFUSAL_LABEL[row.kind] ?? { label: row.kind, tone: 'var(--tone-gray)' };
              return (
                <div key={`${row.provider}-${row.model}-${row.kind}`} className="grid grid-cols-[minmax(0,1.3fr)_auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
                  <span className="truncate font-mono text-ink-100" title={row.provider ?? ''}>{row.model ?? row.provider ?? 'không rõ model'}</span>
                  <span className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold" style={{ color: kind.tone, background: `color-mix(in srgb, ${kind.tone} 14%, transparent)` }}>
                    {kind.label}
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-fill-2">
                    <span className="block h-full rounded-full" style={{ width: `${(row.count / top) * 100}%`, background: kind.tone }} />
                  </span>
                  <span className="text-right font-mono font-semibold tabular-nums text-ink-100">{row.count} lần</span>
                </div>
              );
            })}
            <p className="border-t border-line pt-2.5 text-[11px] leading-relaxed text-ink-500">
              Hết lượt gọi: gói miễn phí giới hạn số lượt mỗi phút — bật thanh toán ở nhà cung cấp là hết. Quá tải: máy chủ nhà cung cấp bận, tự hết sau vài phút.
            </p>
          </div>
        )}
      </Card>
    </Section>
  );
}

function Breakdown({
  title,
  rows,
  color,
}: {
  title: string;
  rows: Array<{ key: string; label: string; costUsd: number; calls: number }>;
  color: string;
}): React.JSX.Element {
  const total = rows.reduce((sum, row) => sum + row.costUsd, 0);

  return (
    <Section title={title} description={total > 0 ? `${money(total, 2)} · ${rows.length} mục` : undefined}>
      <Card>
        {rows.length === 0 ? (
          <p className="text-xs text-ink-500">Chưa có dữ liệu.</p>
        ) : (
          <div className="space-y-2.5">
            {rows.slice(0, 8).map((row) => {
              const share = total > 0 ? (row.costUsd / total) * 100 : 0;
              return (
                <div key={row.key || row.label}>
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-ink-300">{row.label}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      <span className="font-mono text-[10px] text-ink-500">{Math.round(share)}%</span>
                      <span className="font-mono tabular-nums text-ink-100">{money(row.costUsd, 3)}</span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-fill-2">
                    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${share}%`, background: `linear-gradient(90deg, ${color}, color-mix(in srgb, ${color} 55%, transparent))` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </Section>
  );
}

/**
 * Biểu đồ cột bằng div, có trục và nhãn ngày. Không kéo thêm thư viện vẽ chart
 * cho một hình — dữ liệu chỉ có một chiều.
 */
function DailyChart({ data }: { data: Array<{ day: string; costUsd: number }> }): React.JSX.Element {
  const max = Math.max(...data.map((point) => point.costUsd), 0.0001);
  const peak = data.reduce((best, point) => (point.costUsd > best.costUsd ? point : best), data[0]!);

  return (
    <div className="grid grid-cols-[52px_1fr] gap-2">
      <div className="flex h-32 flex-col justify-between text-right font-mono text-[9px] text-ink-500">
        <span>{money(max, 2)}</span>
        <span>{money(max / 2, 2)}</span>
        <span>$0</span>
      </div>
      <div>
        <div className="relative flex h-32 items-end gap-[3px] border-b border-l border-line pl-1">
          <span className="absolute left-0 right-0 top-1/2 border-t border-dashed border-line" />
          {data.map((point) => (
            <div
              key={point.day}
              className={`group relative flex-1 rounded-t transition-colors ${point === peak ? 'bg-produce-400' : 'bg-produce-600/60 hover:bg-produce-400'}`}
              style={{ height: `${Math.max(2, (point.costUsd / max) * 100)}%` }}
              title={`${point.day}: ${money(point.costUsd, 4)}`}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-500">
          <span>{data[0]?.day.slice(5)}</span>
          <span>{data[Math.floor(data.length / 2)]?.day.slice(5)}</span>
          <span>{data.at(-1)?.day.slice(5)}</span>
        </div>
      </div>
    </div>
  );
}
