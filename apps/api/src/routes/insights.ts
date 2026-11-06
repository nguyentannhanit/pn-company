/**
 * P&N — Số liệu cho màn hình quan sát: việc kẹt kèm lý do, thành tích từng
 * nhân viên, và số lần model từ chối vì hạn mức/quá tải.
 *
 * Mọi con số đọc từ bảng thật (`tasks`, `agent_runs`, `messages`,
 * `cost_records`); lý do lỗi đi qua `redactText` rồi mới dịch sang tiếng người
 * bằng `explainFailure`, vì lỗi nhà cung cấp có thể mang theo khoá API.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { explainFailure, redactText, type AgentRun, type Task } from '@pn/shared';

import type { AppContext } from '../context.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mốc thời gian từ kho có thể là Date hoặc chuỗi ISO tuỳ lớp mapper; quy về mili giây. */
const time = (value: unknown): number => new Date(value as string).getTime();

export async function insightsRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const { repos } = context;

  /**
   * Mọi việc kèm tên dự án. Mặc định chỉ dự án còn sống; `withArchived` cho số
   * "việc xong" của nhân viên — lưu trữ dự án không xoá thành tích đã làm.
   */
  const allTasks = async (withArchived = false): Promise<Array<Task & { projectName: string; archived: boolean }>> => {
    const projects = (await repos.projects.list()).filter((project) => withArchived || project.status !== 'ARCHIVED');
    const lists = await Promise.all(
      projects.map(async (project) =>
        (await repos.tasks.listByProject(project.id)).map((task) => ({
          ...task,
          projectName: project.name,
          archived: project.status === 'ARCHIVED',
        })),
      ),
    );
    return lists.flat();
  };

  /** Lần chạy mới nhất trước, bất kể kho trả theo thứ tự nào. */
  const newestFirst = (runs: AgentRun[]): AgentRun[] =>
    [...runs].sort((a, b) => time(b.createdAt) - time(a.createdAt));

  /**
   * Việc đang kẹt và vì sao — cho cờ đỏ trong văn phòng 3D, thẻ phòng, và nhóm
   * "kẹt vì cùng một lý do" ở tab Công việc.
   */
  app.get('/insights/blocked', { preHandler: app.authenticate }, async (_request, reply) => {
    const blocked = (await allTasks()).filter((task) => task.status === 'BLOCKED');
    const items = await Promise.all(
      blocked.map(async (task) => {
        const runs = newestFirst(await repos.runs.listByTask(task.id));
        const failed = runs.filter((run) => run.status === 'FAILED' || run.status === 'TIMEOUT');
        let raw = failed[0]?.errorMessage ?? null;
        if (!raw) {
          // Không có lần chạy lỗi (bị chặn vì phụ thuộc, chờ duyệt…) thì lấy tin hệ thống gần nhất.
          const messages = await repos.messages.listByTask(task.id);
          raw = [...messages].reverse().find((message) => message.role === 'system')?.content ?? null;
        }
        const reason = raw ? redactText(raw).slice(0, 600) : null;
        return {
          taskId: task.id,
          projectId: task.projectId,
          projectName: task.projectName,
          title: task.title,
          role: task.assignedRole,
          failedRuns: failed.length,
          since: failed[0]?.finishedAt ?? task.updatedAt,
          reason,
          explained: explainFailure(reason),
        };
      }),
    );
    return reply.send({ items });
  });

  /** Thành tích từng nhân viên: việc xong, lần chạy đạt/lỗi, tiền tiêu, lỗi gần nhất. */
  app.get('/insights/agents', { preHandler: [app.authenticate, app.requireCapability('agent:read')] }, async (_request, reply) => {
    const [agents, tasks, costs] = await Promise.all([
      repos.agents.list(),
      allTasks(true),
      repos.costs.breakdown('agent'),
    ]);
    const since = Date.now() - 30 * DAY_MS;
    const stats = await Promise.all(
      agents.map(async (agent) => {
        const runs = newestFirst(await repos.runs.listRecentByAgent(agent.id, 200)).filter(
          (run) => time(run.createdAt) >= since,
        );
        const failed = runs.filter((run) => run.status === 'FAILED' || run.status === 'TIMEOUT');
        const lastError = failed[0]?.errorMessage ? redactText(failed[0].errorMessage) : null;
        return {
          role: agent.role,
          done: tasks.filter((task) => task.assignedRole === agent.role && task.status === 'DONE').length,
          open: tasks.filter(
            (task) => task.assignedRole === agent.role && !task.archived && !['DONE', 'CANCELLED'].includes(task.status),
          ).length,
          succeeded: runs.filter((run) => run.status === 'SUCCEEDED').length,
          failed: failed.length,
          costUsd: costs.find((row) => row.key === agent.id)?.costUsd ?? 0,
          lastRunAt: runs[0]?.createdAt ?? null,
          lastError: lastError ? explainFailure(lastError).title : null,
        };
      }),
    );
    return reply.send({ agents: stats, windowDays: 30 });
  });

  /**
   * Số lần việc thất bại vì nhà cung cấp AI từ chối (hết lượt, hết tiền, quá
   * tải), theo model. Nhà cung cấp không cho biết hạn mức còn lại, nên đây là
   * số đo được thật chứ không phải "còn bao nhiêu lượt".
   */
  app.get('/insights/refusals', { preHandler: app.authenticate }, async (request, reply) => {
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(30).default(7) }).parse(request.query);
    const since = Date.now() - days * DAY_MS;
    const agents = await repos.agents.list();
    const counts = new Map<string, { provider: string | null; model: string | null; kind: string; count: number; last: string }>();
    const perDay = new Map<string, number>();
    for (const agent of agents) {
      for (const run of await repos.runs.listRecentByAgent(agent.id, 200)) {
        if (!run.errorMessage || time(run.createdAt) < since) continue;
        const explained = explainFailure(run.errorMessage);
        if (!['quota', 'credit', 'overloaded'].includes(explained.kind)) continue;
        const key = `${explained.provider}|${explained.model}|${explained.kind}`;
        const at = new Date(time(run.createdAt)).toISOString();
        const entry = counts.get(key) ?? { provider: explained.provider, model: explained.model, kind: explained.kind, count: 0, last: at };
        entry.count += 1;
        if (at > entry.last) entry.last = at;
        counts.set(key, entry);
        const day = at.slice(0, 10);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
    }
    const byModel = [...counts.values()].sort((a, b) => b.count - a.count);
    return reply.send({
      days,
      total: byModel.reduce((sum, entry) => sum + entry.count, 0),
      byModel,
      perDay: [...perDay.entries()].sort().map(([day, count]) => ({ day, count })),
    });
  });
}
