/**
 * P&N — Knowledge & R&D (§98–§130).
 *
 * Ba câu hỏi màn hình này phải trả lời được, theo đúng thứ tự đó:
 *   1. Có gì đang chờ tôi duyệt? (§108)
 *   2. Công ty đang biết những gì? (§110)
 *   3. Phòng nào đang khá lên, phòng nào đứng yên? (§111)
 *
 * Phần bị loại cũng hiện ra: biết vì sao một thứ bị loại có ích ngang biết thứ
 * gì được chọn, và nó là cách duy nhất phát hiện bộ lọc đang quá tay.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { DEPARTMENT_LABEL, money } from '@/lib/brand';

interface KnowledgeItem {
  id: string;
  title: string;
  kind: string;
  summary: string;
  license: string | null;
  status: string;
  activeVersion: number;
  updatedAt: string;
}

interface Candidate {
  id: string;
  title: string;
  url: string | null;
  summary: string;
  stage: string;
  rejectReason: string | null;
  createdAt: string;
}

interface DepartmentLevel {
  department: string;
  level: number;
  totalXp: number;
  xpToNext: number | null;
  ratio: number;
}

interface DiscoveryReport {
  found: number;
  duplicates: number;
  rejected: Array<{ fullName: string; stage: string; reason: string }>;
  promoted: Array<{ itemId: string; title: string; score: number }>;
  costUsd: number;
  note: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Nháp',
  PENDING_APPROVAL: 'Chờ duyệt',
  ACTIVE: 'Đang áp dụng',
  DEPRECATED: 'Ngừng dùng',
  ROLLED_BACK: 'Đã quay lui',
  REJECTED: 'Bị từ chối',
};

const STATUS_COLOR: Record<string, string | undefined> = {
  PENDING_APPROVAL: 'var(--tone-amber)',
  ACTIVE: 'var(--tone-teal)',
  REJECTED: 'var(--tone-red)',
};

export default function KnowledgePage(): React.JSX.Element {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [levels, setLevels] = useState<DepartmentLevel[]>([]);
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [topics, setTopics] = useState('');

  const load = useCallback(() => {
    Promise.all([
      api<{ items: KnowledgeItem[] }>('/knowledge/items'),
      api<{ candidates: Candidate[] }>('/knowledge/candidates?stage=REJECTED'),
      api<{ levels: DepartmentLevel[] }>('/knowledge/levels'),
    ])
      .then(([itemResult, candidateResult, levelResult]) => {
        setItems(itemResult.items);
        setCandidates(candidateResult.candidates);
        setLevels(levelResult.levels);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Không tải được dữ liệu'),
      );
  }, []);

  useEffect(load, [load]);

  async function discover(): Promise<void> {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const wantedTopics = topics
        .split(',')
        .map((topic) => topic.trim())
        .filter(Boolean);

      const result = await api<{ report: DiscoveryReport }>('/knowledge/discover', {
        method: 'POST',
        body: wantedTopics.length > 0 ? { wantedTopics } : {},
      });
      setReport(result.report);
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không chạy được vòng khám phá');
    } finally {
      setBusy(false);
    }
  }

  /** Dừng vòng khám phá đang chạy: máy chủ dừng sau bước đang làm và trả phần đã xong. */
  async function stopDiscover(): Promise<void> {
    try {
      await api('/knowledge/discover/stop', { method: 'POST', body: {} });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không dừng được');
    }
  }

  const pending = items.filter((item) => item.status === 'PENDING_APPROVAL');
  const active = items.filter((item) => item.status === 'ACTIVE');

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Học hỏi"
        title="Kiến thức &amp; R&amp;D"
        subtitle={`${active.length} gói đang áp dụng · ${pending.length} chờ duyệt`}
      />
      <ErrorNote error={error} />

      <div className="grid gap-3 p-5 sm:grid-cols-3">
        <Stat label="Đang áp dụng" value={String(active.length)} />
        <Stat
          label="Chờ bạn duyệt"
          value={String(pending.length)}
          tone={pending.length > 0 ? 'produce' : 'default'}
        />
        <Stat
          label="Phòng ban cấp cao nhất"
          value={levels[0] ? `${levels[0].level}` : '1'}
          hint={levels[0] ? (DEPARTMENT_LABEL[levels[0].department] ?? levels[0].department) : undefined}
        />
      </div>

      <Section title="Chạy vòng khám phá (§106)">
        <Card>
          <p className="text-xs leading-relaxed text-ink-500">
            GitHub Scout tìm repo, chấm điểm theo §102, lọc năm tầng, rồi Curator viết thành gói
            kiến thức. Không gói nào chạm tới agent trước khi bạn duyệt.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <input
              value={topics}
              onChange={(event) => setTopics(event.target.value)}
              placeholder="Chủ đề đang cần, ngăn bằng dấu phẩy — ví dụ: react, performance"
              className="h-[38px] min-w-[280px] flex-1 rounded-lg border border-base-600 bg-base-900 px-3 text-xs text-ink-100 outline-none transition-colors focus:border-brand-400"
            />
            <Button onClick={() => void discover()} disabled={busy}>
              {busy ? 'Đang tìm…' : 'Chạy khám phá'}
            </Button>
            {busy && (
              <Button variant="danger" onClick={() => void stopDiscover()}>
                Dừng
              </Button>
            )}
          </div>

          {report && (
            <div className="mt-3 rounded-lg bg-base-900 px-3 py-2.5 text-xs">
              <p className="text-ink-300">
                Quét {report.found} repo · {report.duplicates} đã biết ·{' '}
                {report.rejected.length} bị loại ·{' '}
                <span className="text-state-completed">{report.promoted.length} chờ duyệt</span> ·{' '}
                <span className="font-mono text-produce-400">{money(report.costUsd, 4)}</span>
              </p>
              {report.note && <p className="mt-1.5 text-[11px] text-ink-500">{report.note}</p>}
            </div>
          )}
        </Card>
      </Section>

      {pending.length > 0 && (
        <Section title="Chờ bạn duyệt (§108)">
          <div className="space-y-2">
            {pending.map((item) => (
              <PendingCard key={item.id} item={item} onDone={load} onError={setError} />
            ))}
          </div>
        </Section>
      )}

      <Section title="Công ty đang biết những gì (§110)">
        {active.length === 0 ? (
          <Empty
            message="Chưa có kiến thức nào được áp dụng"
            hint="Chạy một vòng khám phá, rồi duyệt gói bạn thấy hợp."
          />
        ) : (
          <div className="space-y-1.5">
            {active.map((item) => (
              <Card key={item.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={STATUS_COLOR[item.status]}>
                    {STATUS_LABEL[item.status] ?? item.status}
                  </Badge>
                  <Badge>{item.kind}</Badge>
                  <span className="text-xs font-medium text-ink-100">{item.title}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-500">
                    v{item.activeVersion}
                    {item.license ? ` · ${item.license}` : ''}
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{item.summary}</p>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Cấp độ phòng ban (§111)">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {levels.map((level) => (
            <Card key={level.department}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-ink-100">
                  {DEPARTMENT_LABEL[level.department] ?? level.department}
                </span>
                <span className="font-mono text-sm text-brand-300">Lv {level.level}</span>
              </div>

              <div className="mt-2 h-1 overflow-hidden rounded-full bg-base-700">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-400 to-learn-400"
                  style={{ width: `${Math.round(level.ratio * 100)}%` }}
                />
              </div>

              <p className="mt-1.5 font-mono text-[10px] text-ink-500">
                {level.totalXp} XP
                {level.xpToNext === null ? ' · cấp cao nhất' : ` · còn ${level.xpToNext} để lên cấp`}
              </p>
            </Card>
          ))}
        </div>
      </Section>

      {candidates.length > 0 && (
        <Section title="Đã loại và vì sao">
          <div className="space-y-1">
            {candidates.slice(0, 15).map((candidate) => (
              <Card key={candidate.id} className="text-xs">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-ink-300">{candidate.title}</span>
                  {candidate.url && (
                    <span className="truncate font-mono text-[10px] text-ink-500">
                      {candidate.url}
                    </span>
                  )}
                </div>
                <p className="mt-1 leading-relaxed text-ink-500">{candidate.rejectReason}</p>
              </Card>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="px-5 pb-5">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">{title}</h2>
      {children}
    </section>
  );
}

/**
 * §108 + §113 — duyệt nghĩa là chọn phòng ban nào nhận kiến thức này. Không có
 * bước chọn thì "duyệt" chỉ đổi một cột trạng thái mà không ai học được gì.
 */
function PendingCard({
  item,
  onDone,
  onError,
}: {
  item: KnowledgeItem;
  onDone: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [evaluation, setEvaluation] = useState<string | null>(null);
  // Riêng lúc chạy thử: nút Chạy thử đổi thành Dừng chạy thử.
  const [evaluating, setEvaluating] = useState(false);

  const toggle = (department: string): void =>
    setSelected((current) =>
      current.includes(department)
        ? current.filter((item) => item !== department)
        : [...current, department],
    );

  /** §116 — chạy cùng bài toán hai lần, có và không có kiến thức, rồi so. */
  async function evaluate(): Promise<void> {
    setBusy(true);
    setEvaluating(true);
    setEvaluation(null);
    try {
      const result = await api<{ result: { verdict: string; passed: boolean } }>(
        `/knowledge/items/${item.id}/evaluate`,
        { method: 'POST' },
      );
      setEvaluation(result.result.verdict);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không chạy thử được');
    } finally {
      setBusy(false);
      setEvaluating(false);
    }
  }

  /** Dừng lượt chạy thử: lệnh trong sandbox bị cắt ngay, không chấm điểm. */
  async function stopEvaluate(): Promise<void> {
    try {
      await api(`/knowledge/items/${item.id}/evaluate/stop`, { method: 'POST', body: {} });
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không dừng được');
    }
  }

  async function activate(acknowledgeNoEvaluation = false): Promise<void> {
    if (selected.length === 0) {
      onError('Chọn ít nhất một phòng ban sẽ dùng kiến thức này.');
      return;
    }
    setBusy(true);
    try {
      await api(`/knowledge/items/${item.id}/activate`, {
        method: 'POST',
        body: { departments: selected, acknowledgeNoEvaluation },
      });
      onDone();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Không kích hoạt được';
      // Chưa chạy thử thì hỏi lại thay vì bắt người dùng đoán (§116).
      if (message.includes('chưa chạy thử')) {
        setEvaluation(
          'Gói này chưa chạy thử trong sandbox. Bấm "Chạy thử" để đo, hoặc "Kích hoạt không đo" ' +
            'nếu bạn đã tự đọc kỹ — lựa chọn đó được ghi vào nhật ký.',
        );
      } else {
        onError(message);
      }
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    setBusy(true);
    try {
      await api(`/knowledge/items/${item.id}/deprecate`, {
        method: 'POST',
        body: { reason: 'CEO không duyệt gói kiến thức này.' },
      });
      onDone();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không từ chối được');
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <Badge color={STATUS_COLOR.PENDING_APPROVAL}>Chờ duyệt</Badge>
        <Badge>{item.kind}</Badge>
        <span className="text-sm font-medium text-ink-100">{item.title}</span>
        {item.license && (
          <span className="ml-auto font-mono text-[10px] text-ink-500">{item.license}</span>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-ink-300">{item.summary}</p>

      <p className="mt-3 text-[10px] uppercase tracking-wider text-ink-500">Phòng ban sẽ dùng</p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {Object.entries(DEPARTMENT_LABEL).map(([value, label]) => (
          <button
            key={value}
            onClick={() => toggle(value)}
            className={`rounded-lg px-2 py-1 text-[11px] transition-colors ${
              selected.includes(value)
                ? 'bg-brand-500/20 font-medium text-brand-300'
                : 'bg-base-700 text-ink-500 hover:text-ink-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void activate()} disabled={busy}>
          Duyệt và áp dụng
        </Button>
        {evaluating ? (
          <Button size="sm" variant="danger" onClick={() => void stopEvaluate()}>
            Dừng chạy thử
          </Button>
        ) : (
          <Button size="sm" variant="quiet" onClick={() => void evaluate()} disabled={busy}>
            Chạy thử trong sandbox
          </Button>
        )}
        <Button size="sm" variant="quiet" onClick={() => void reject()} disabled={busy}>
          Không dùng
        </Button>
      </div>

      {evaluation && (
        <div className="mt-2 rounded-lg bg-base-900 px-3 py-2">
          <p className="text-[11px] leading-relaxed text-ink-300">{evaluation}</p>
          {evaluation.includes('chưa chạy thử') && (
            <Button
              size="sm"
              variant="quiet"
              className="mt-2"
              onClick={() => void activate(true)}
              disabled={busy}
            >
              Kích hoạt không đo
            </Button>
          )}
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-ink-500">
        Chạy thử tốn hai lượt gọi model: một lần không có kiến thức để lấy mốc so sánh, một lần
        có. §116 — tệ hơn mốc thì không kích hoạt được.
      </p>
    </Card>
  );
}
