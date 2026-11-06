/**
 * P&N — Lỗi toàn công ty (§3.9, §8.6).
 *
 * Nặng nhất lên trước, vạch màu theo mức độ, lọc một chạm. Mỗi dòng dẫn về dự án
 * để xem QA nói gì.
 */

'use client';

import { useEffect, useState } from 'react';

import { Badge, Chip, Empty, ErrorNote, PageHeader, RowLink, Skeleton } from '@/components/ui';
import { api, type BugRow, type ProjectRow } from '@/lib/api';
import { useRealtime } from '@/lib/store';

interface Entry extends BugRow {
  projectId: string;
  projectName: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  LOW: 'var(--tone-blue)',
  MEDIUM: 'var(--tone-amber)',
  HIGH: 'var(--tone-orange)',
  CRITICAL: 'var(--tone-red)',
};
const SEVERITY_LABEL: Record<string, string> = {
  LOW: 'Nhẹ',
  MEDIUM: 'Vừa',
  HIGH: 'Nặng',
  CRITICAL: 'Nghiêm trọng',
};

/** Nặng nhất lên trước — đó là thứ cần xử lý trước. */
const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export default function BugsPage(): React.JSX.Element {
  const { lastEventAt } = useRealtime();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<string>('all');

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const { projects } = await api<{ projects: ProjectRow[] }>('/projects');
        const lists = await Promise.all(
          projects
            .filter((project) => project.status !== 'ARCHIVED')
            .map(async (project) => {
              const result = await api<{ bugs: BugRow[] }>(`/projects/${project.id}/bugs`);
              return result.bugs.map((bug) => ({ ...bug, projectId: project.id, projectName: project.name }));
            }),
        );
        setEntries(
          lists
            .flat()
            .filter((bug) => bug.status === 'OPEN' || bug.status === 'IN_PROGRESS')
            .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)),
        );
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Không tải được danh sách lỗi');
      }
    };
    void load();
  }, [lastEventAt]);

  const shown = entries?.filter((bug) => severity === 'all' || bug.severity === severity) ?? [];
  const count = (level: string): number => entries?.filter((bug) => bug.severity === level).length ?? 0;

  return (
    <div className="pb-8">
      <PageHeader
        eyebrow="Chất lượng"
        title="Lỗi"
        subtitle={entries ? `${entries.length} lỗi đang mở` : undefined}
        action={
          <div className="flex gap-1.5">
            <Chip active={severity === 'all'} onClick={() => setSeverity('all')}>Tất cả</Chip>
            {SEVERITY_ORDER.map((level) => (
              <Chip key={level} active={severity === level} onClick={() => setSeverity(level)}>
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: SEVERITY_COLOR[level] }} />
                {SEVERITY_LABEL[level]} {count(level)}
              </Chip>
            ))}
          </div>
        }
      />
      <ErrorNote error={error} />

      {entries === null && <Skeleton rows={5} className="p-5" />}
      {entries !== null && shown.length === 0 && <Empty message="Không có lỗi nào đang mở." hint="QA và Security báo lỗi vào đây; sửa xong thì tự đóng." />}

      <div className="space-y-2 p-5">
        {shown.map((bug) => (
          <RowLink
            key={bug.id}
            href={`/projects/${bug.projectId}`}
            stripe={SEVERITY_COLOR[bug.severity]}
            leading={<Badge color={SEVERITY_COLOR[bug.severity]}>{SEVERITY_LABEL[bug.severity] ?? bug.severity}</Badge>}
            title={bug.title}
            meta={`${bug.projectName} · ${bug.description.slice(0, 140)}`}
          />
        ))}
      </div>
    </div>
  );
}
