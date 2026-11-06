/**
 * P&N — Báo cáo CEO (§29).
 *
 * Chín mục theo đúng §29. Thứ tự cố ý: tiến độ và việc bị chặn lên trên, chi
 * phí ở giữa, rủi ro và việc cần làm ở cuối — vì đó là thứ CEO đọc rồi hành
 * động ngay, và cuối trang là chỗ mắt dừng lại.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Stat } from '@/components/ui';
import { api } from '@/lib/api';
import { PROJECT_STATUS_LABEL, money } from '@/lib/brand';

/** §149 — 30 mục nghiệm thu, kiểm từ hệ thống đang chạy. */
interface Acceptance {
  items: Array<{ no: number; label: string; ok: boolean | null; detail: string }>;
  passed: number;
  failed: number;
  manual: number;
}

interface CeoReport {
  generatedAt: string;
  projects: Array<{
    id: string;
    name: string;
    status: string;
    done: number;
    total: number;
    blocked: number;
    openBugs: number;
    spentUsd: number;
    budgetUsd: number;
  }>;
  tasks: { done: number; blocked: number; inProgress: number; total: number };
  bugs: { open: number; critical: number };
  security: { open: number; note: string };
  deployments: Array<{ id: string; environment: string; status: string; createdAt: string }>;
  costs: { todayUsd: number; monthUsd: number; unpricedCalls: number };
  risks: string[];
  nextActions: string[];
}

export default function ReportsPage(): React.JSX.Element {
  const [report, setReport] = useState<CeoReport | null>(null);
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    Promise.all([
      api<{ report: CeoReport }>('/reports/ceo'),
      api<Acceptance>('/reports/acceptance'),
    ])
      .then(([ceo, done]) => {
        setReport(ceo.report);
        setAcceptance(done);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Không dựng được báo cáo'),
      )
      .finally(() => setBusy(false));
  }, []);

  useEffect(load, [load]);

  /** §29 — gửi đúng bản báo cáo đang xem, không dựng lại một bản khác. */
  async function sendToTelegram(): Promise<void> {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      const result = await api<{ delivered: number }>('/reports/ceo/telegram', { method: 'POST' });
      setSent(`Đã gửi tới ${result.delivered} chat Telegram.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không gửi được');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Nhìn lại"
        title="Báo cáo"
        subtitle={
          report ? `Dựng lúc ${new Date(report.generatedAt).toLocaleString('vi-VN')}` : undefined
        }
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="quiet" onClick={load} disabled={busy}>
              {busy ? 'Đang dựng…' : 'Dựng lại'}
            </Button>
            <Button size="sm" onClick={() => void sendToTelegram()} disabled={busy}>
              Gửi Telegram
            </Button>
          </div>
        }
      />
      <ErrorNote error={error} />

      {sent && (
        <p className="mx-5 mt-4 rounded-md bg-state-completed/10 px-3 py-2 text-xs text-state-completed">
          {sent}
        </p>
      )}

      {report && (
        <>
          <div className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Việc hoàn thành"
              value={`${report.tasks.done}/${report.tasks.total}`}
              hint={`${report.tasks.inProgress} đang làm`}
            />
            <Stat
              label="Việc bị chặn"
              value={String(report.tasks.blocked)}
              tone={report.tasks.blocked > 0 ? 'alert' : 'default'}
            />
            <Stat
              label="Lỗi đang mở"
              value={String(report.bugs.open)}
              tone={report.bugs.critical > 0 ? 'alert' : 'default'}
              hint={`${report.bugs.critical} nghiêm trọng`}
            />
            <Stat
              label="Chi phí tháng"
              value={money(report.costs.monthUsd, 2)}
              tone="produce"
              hint={`hôm nay ${money(report.costs.todayUsd, 2)}`}
            />
          </div>

          <Section title="Tiến độ dự án">
            {report.projects.length === 0 ? (
              <Empty message="Chưa có dự án nào" hint="Giao việc đầu tiên ở trang Tổng quan." />
            ) : (
              <div className="space-y-1.5">
                {report.projects.map((project) => (
                  <Link key={project.id} href={`/projects/${project.id}`}>
                    <Card className="transition-colors hover:border-brand-400/35">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                        <span className="font-medium text-ink-100">{project.name}</span>
                        <Badge>{PROJECT_STATUS_LABEL[project.status] ?? project.status}</Badge>
                        <span className="font-mono text-ink-300">
                          {project.done}/{project.total} task
                        </span>
                        {project.blocked > 0 && (
                          <span className="text-state-blocked">{project.blocked} bị chặn</span>
                        )}
                        {project.openBugs > 0 && (
                          <span className="text-state-alert">{project.openBugs} lỗi</span>
                        )}
                        <span className="ml-auto font-mono text-ink-500">
                          {money(project.spentUsd, 2)} / {money(project.budgetUsd)}
                        </span>
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>
            )}
          </Section>

          <Section title="Bảo mật">
            <Card>
              <p className="text-xs text-ink-300">
                {report.security.open > 0
                  ? `${report.security.open} phát hiện đang mở. `
                  : 'Không có phát hiện nào đang mở. '}
                <span className="text-ink-500">{report.security.note}</span>
              </p>
            </Card>
          </Section>

          <Section title="Triển khai">
            {report.deployments.length === 0 ? (
              <Empty
                message="Chưa có lần triển khai nào"
                hint="Triển khai bản chính thức luôn phải qua cổng duyệt của CEO."
              />
            ) : (
              <div className="space-y-1">
                {report.deployments.map((deployment) => (
                  <Card key={deployment.id} className="flex items-center gap-3 text-xs">
                    <Badge>{deployment.environment}</Badge>
                    <span className="text-ink-300">{deployment.status}</span>
                    <span className="ml-auto font-mono text-[10px] text-ink-500">
                      {new Date(deployment.createdAt).toLocaleString('vi-VN')}
                    </span>
                  </Card>
                ))}
              </div>
            )}
          </Section>

          <Section title="Rủi ro">
            {report.risks.length === 0 ? (
              <Card>
                <p className="text-xs text-ink-500">Không có rủi ro nào đang nổi lên.</p>
              </Card>
            ) : (
              <Card>
                <ul className="space-y-1.5">
                  {report.risks.map((risk) => (
                    <li key={risk} className="flex gap-2 text-xs leading-relaxed text-ink-300">
                      <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-state-alert" />
                      {risk}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </Section>

          {acceptance && (
            <Section title={`Nghiệm thu §149 — ${acceptance.passed}/${acceptance.items.length} mục đạt`}>
              <div className="space-y-1">
                {acceptance.items.map((item) => (
                  <Card key={item.no} className="flex gap-3 text-xs">
                    <span
                      className={`mt-0.5 font-mono text-[10px] ${
                        item.ok === true
                          ? 'text-state-completed'
                          : item.ok === false
                            ? 'text-state-alert'
                            : 'text-ink-500'
                      }`}
                    >
                      {item.ok === true ? '✓' : item.ok === false ? '✕' : '?'} {item.no}
                    </span>
                    <div className="min-w-0">
                      <p className={item.ok === false ? 'text-ink-300' : 'text-ink-100'}>
                        {item.label}
                      </p>
                      <p className="mt-0.5 leading-relaxed text-ink-500">{item.detail}</p>
                    </div>
                  </Card>
                ))}
              </div>
            </Section>
          )}

          <Section title="Việc cần CEO làm tiếp">
            <Card>
              <ul className="space-y-1.5">
                {report.nextActions.map((action) => (
                  <li key={action} className="flex gap-2 text-xs leading-relaxed text-ink-100">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-brand-400" />
                    {action}
                  </li>
                ))}
              </ul>
            </Card>
          </Section>
        </>
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
