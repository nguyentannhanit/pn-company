/**
 * P&N — Đo kiến thức có cải thiện thật không (§124).
 *
 * §124 đưa ba ví dụ và tất cả đều có dạng "before → after". Nên phép đo ở đây
 * cắt lịch sử của một phòng ban tại đúng thời điểm kiến thức được kích hoạt,
 * rồi so hai bên.
 *
 * Hai điều làm cho con số này trung thực, và cả hai đều dễ bỏ qua:
 *
 *   - Mẫu quá nhỏ thì KHÔNG kết luận. Ba task trước và hai task sau mà chênh
 *     nhau 30% thì đó là nhiễu, không phải cải thiện. Ngưỡng nói rõ ở dưới.
 *   - Không cải thiện thì nói thẳng là không cải thiện. §124 dự liệu trường
 *     hợp đó ("Knowledge Auditor review"), nên giấu nó đi là làm hỏng chính
 *     vòng phản hồi mà mục này tồn tại để tạo ra.
 */

import type { Repositories } from '@pn/database';
import type { Department, Uuid } from '@pn/shared';
import { agentProfile } from '@pn/shared';

/** Dưới ngưỡng này thì mọi chênh lệch đều có thể là nhiễu. */
const MIN_SAMPLE = 5;

export interface MetricComparison {
  metric: string;
  label: string;
  before: number | null;
  after: number | null;
  sampleBefore: number;
  sampleAfter: number;
  /** Dương là tốt lên, âm là tệ đi, `null` là chưa đủ dữ liệu. */
  delta: number | null;
  verdict: string;
}

export interface KnowledgeImpact {
  itemId: Uuid;
  title: string;
  department: Department;
  activatedAt: string | null;
  metrics: MetricComparison[];
  /** `null` khi chưa đủ mẫu để nói gì. */
  improved: boolean | null;
  summary: string;
}

/** Tỷ lệ task xong mà không phải sửa lại — thước đo chất lượng trực tiếp nhất. */
function firstPassRate(tasks: Array<{ status: string; fixLoopCount: number }>): number | null {
  const done = tasks.filter((task) => task.status === 'DONE');
  if (done.length === 0) return null;
  return done.filter((task) => task.fixLoopCount === 0).length / done.length;
}

/** Số lỗi trung bình trên một task — §124 gọi là "Average bug/task". */
function bugsPerTask(taskCount: number, bugCount: number): number | null {
  return taskCount === 0 ? null : bugCount / taskCount;
}

function compare(
  metric: string,
  label: string,
  before: number | null,
  after: number | null,
  sampleBefore: number,
  sampleAfter: number,
  higherIsBetter: boolean,
): MetricComparison {
  if (
    before === null ||
    after === null ||
    sampleBefore < MIN_SAMPLE ||
    sampleAfter < MIN_SAMPLE
  ) {
    return {
      metric,
      label,
      before,
      after,
      sampleBefore,
      sampleAfter,
      delta: null,
      verdict: `Chưa đủ mẫu (cần ${MIN_SAMPLE} task mỗi bên, đang có ${sampleBefore} và ${sampleAfter}).`,
    };
  }

  const raw = after - before;
  const delta = higherIsBetter ? raw : -raw;

  return {
    metric,
    label,
    before,
    after,
    sampleBefore,
    sampleAfter,
    delta,
    verdict:
      delta > 0.05
        ? 'Tốt lên rõ rệt.'
        : delta < -0.05
          ? 'Tệ đi — cần xem lại gói kiến thức này.'
          : 'Gần như không đổi.',
  };
}

/**
 * §124 — đo tác động của MỘT gói kiến thức lên MỘT phòng ban.
 *
 * Mốc cắt là thời điểm gói được kích hoạt, lấy từ nhật ký kiến thức chứ không
 * lấy từ `updated_at`: `updated_at` đổi vì bất cứ lý do gì, còn nhật ký ghi
 * đúng lúc CEO bấm.
 */
export async function measureImpact(
  repos: Repositories,
  itemId: Uuid,
  department: Department,
): Promise<KnowledgeImpact> {
  const item = await repos.knowledgeItems.findById(itemId);
  const audit = await repos.knowledgeAudit.listForItem(itemId);
  const activation = audit.find((entry) => entry.action === 'KNOWLEDGE_ACTIVATED');
  const activatedAt = activation?.createdAt ?? null;

  const base: KnowledgeImpact = {
    itemId,
    title: item?.title ?? '(không còn)',
    department,
    activatedAt,
    metrics: [],
    improved: null,
    summary: '',
  };

  if (!activatedAt) {
    return { ...base, summary: 'Gói này chưa được kích hoạt nên chưa có gì để đo.' };
  }

  // Task của phòng ban = task giao cho vai trò thuộc phòng đó (`agentProfile`).
  const projects = await repos.projects.list({});
  const cutoff = Date.parse(activatedAt);

  const before: Array<{ status: string; fixLoopCount: number }> = [];
  const after: Array<{ status: string; fixLoopCount: number }> = [];
  let bugsBefore = 0;
  let bugsAfter = 0;

  for (const project of projects) {
    const [tasks, bugs] = await Promise.all([
      repos.tasks.listByProject(project.id),
      repos.bugs.listByProject(project.id),
    ]);

    for (const task of tasks) {
      if (!task.assignedRole) continue;
      if (agentProfile(task.assignedRole).department !== department) continue;

      const at = Date.parse(task.createdAt);
      const bucket = at < cutoff ? before : after;
      bucket.push({ status: task.status, fixLoopCount: task.fixLoopCount });
    }

    for (const bug of bugs) {
      if (Date.parse(bug.createdAt) < cutoff) bugsBefore += 1;
      else bugsAfter += 1;
    }
  }

  const metrics: MetricComparison[] = [
    compare(
      'first_pass_rate',
      'Tỷ lệ task xong ngay lần đầu',
      firstPassRate(before),
      firstPassRate(after),
      before.length,
      after.length,
      true,
    ),
    compare(
      'bugs_per_task',
      'Số lỗi trên mỗi task',
      bugsPerTask(before.length, bugsBefore),
      bugsPerTask(after.length, bugsAfter),
      before.length,
      after.length,
      false,
    ),
  ];

  const measurable = metrics.filter((metric) => metric.delta !== null);
  const improved =
    measurable.length === 0
      ? null
      : measurable.every((metric) => (metric.delta ?? 0) >= -0.05) &&
        measurable.some((metric) => (metric.delta ?? 0) > 0.05);

  // Ghi lại để lần sau còn so được với hôm nay (§124).
  for (const metric of measurable) {
    await repos.knowledgeMetrics
      .record({
        itemId,
        department,
        metric: metric.metric,
        valueBefore: metric.before,
        valueAfter: metric.after,
        sampleSize: metric.sampleBefore + metric.sampleAfter,
      })
      .catch(() => undefined);
  }

  return {
    ...base,
    metrics,
    improved,
    summary:
      improved === null
        ? `Chưa đủ dữ liệu để kết luận. Cần ít nhất ${MIN_SAMPLE} task mỗi bên mốc kích hoạt.`
        : improved
          ? 'Có cải thiện đo được sau khi kích hoạt gói kiến thức này.'
          : 'Không thấy cải thiện. §124 — nên đưa Knowledge Auditor xem lại gói này.',
  };
}
