/**
 * P&N — Dự án, task và lỗi (§12, §13, §92).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import {
  createBugSchema,
  createProjectSchema,
  createTaskSchema,
  slugify,
  updateTaskStatusSchema,
  BUG_STATUSES,
  PROJECT_STATUSES,
} from '@pn/shared';

import { workflowFor } from '@pn/orchestrator';
import { stageNeedsHuman } from '@pn/permissions';

import type { AppContext } from '../context.js';
import { archiveWorkspace, removeWorkspace } from '../services/project-admin.js';

const idParam = z.object({ id: z.string().uuid() });

export async function projectRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /* Dự án                                                                   */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/projects',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const input = createProjectSchema.parse(request.body);

      // Slug phải duy nhất vì nó dùng làm tên branch và tên repo.
      let slug = slugify(input.name);
      for (let suffix = 2; await context.repos.projects.findBySlug(slug); suffix += 1) {
        slug = `${slugify(input.name)}-${suffix}`;
      }

      const project = await context.repos.projects.create({
        name: input.name,
        slug,
        description: input.description,
        productType: input.productType,
        ownerId: request.principal!.id,
        repoFullName: input.repoFullName ?? null,
        budgetUsd: input.budgetUsd,
      });

      await context.events.publish(
        'PROJECT_CREATED',
        { projectId: project.id, name: project.name, productType: project.productType },
        { projectId: project.id, actor: `user:${request.principal!.id}` },
      );

      return reply.code(201).send({ project });
    },
  );

  app.get('/projects', { preHandler: [app.authenticate, app.requireCapability('project:read')] }, async (request, reply) => {
    const query = z.object({ status: z.enum(PROJECT_STATUSES).optional() }).parse(request.query);
    const projects = await context.repos.projects.list(query.status ? { status: query.status } : {});

    // Kèm luôn tình hình task. Thiếu nó thì danh sách dự án chỉ là mấy cái tên:
    // một dự án có task đang bị chặn trông y hệt một dự án chạy tốt, và CEO
    // phải bấm vào từng cái mới biết chỗ nào đang tắc.
    const withTasks = await Promise.all(
      projects.map(async (project) => ({
        ...project,
        taskCounts: await context.repos.tasks.countByStatus(project.id),
      })),
    );

    return reply.send({ projects: withTasks });
  });

  /** §12 — trang chi tiết dự án cần cả task, bug, deploy, chi phí trong một lần gọi. */
  app.get('/projects/:id', { preHandler: [app.authenticate, app.requireCapability('project:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = await context.repos.projects.findById(id);
    if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });

    const [tasks, bugs, deployments, cost, budget, taskCounts, gitEvents] = await Promise.all([
      context.repos.tasks.listByProject(id),
      context.repos.bugs.listByProject(id),
      context.repos.deployments.listByProject(id, 10),
      context.repos.costs.forProject(id),
      context.repos.budgets.projectStatus(id),
      context.repos.tasks.countByStatus(id),
      context.repos.gitEvents.listByProject(id, 20),
    ]);

    return reply.send({ project, tasks, bugs, deployments, cost, budget, taskCounts, gitEvents });
  });

  app.patch(
    '/projects/:id/status',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { status } = z.object({ status: z.enum(PROJECT_STATUSES) }).parse(request.body);
      // Dừng / tiếp tục phải qua bộ điều phối (cắt lượt đang chạy, xếp lại việc) — chỉ đổi nhãn thì việc vẫn chạy.
      const current = await context.repos.projects.findById(id);
      if (status === 'PAUSED') await context.orchestrator.stopProject(id);
      else if (status === 'CANCELLED') await context.orchestrator.stopProject(id, 'cancel');
      else if (status === 'ARCHIVED') {
        // Cất dự án đi mà còn lượt đang chạy thì cắt trước — trước đây chỉ đổi nhãn, agent vẫn chạy tiếp.
        await context.orchestrator.stopProject(id, 'cancel');
        await context.repos.projects.updateStatus(id, status);
      } else if (current?.status === 'PAUSED' && status === 'IN_PROGRESS') await context.orchestrator.resumeProject(id);
      else await context.repos.projects.updateStatus(id, status);
      return reply.send({ ok: true, status });
    },
  );

  /** Các bước quy trình của dự án — cho nút "Làm lại dự án" chọn bước bắt đầu. */
  app.get('/projects/:id/stages', { preHandler: [app.authenticate, app.requireCapability('project:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = await context.repos.projects.findById(id);
    if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });
    return reply.send({
      stages: workflowFor(project.productType)
        .filter((stage) => !stageNeedsHuman(stage.id))
        .map((stage) => ({ id: stage.id, description: stage.description })),
    });
  });

  /**
   * Làm lại dự án từ một bước. Làm lại cả bước Lập trình thì
   * mã cũ được cất sang `_luu/` trước, tài liệu các bước giữ nguyên được chép lại.
   */
  app.post(
    '/projects/:id/redo',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { fromStage } = z.object({ fromStage: z.string().min(1) }).parse(request.body);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });
      const tasks = await context.repos.tasks.listByProject(id);
      if (tasks.some((task) => task.status === 'IN_PROGRESS')) {
        return reply.code(409).send({ error: 'Dự án đang có việc chạy dở. Đợi việc đó xong rồi bấm làm lại.' });
      }

      const result = await context.orchestrator.redoProject(id, fromStage);
      const archived = result.redoesBuild
        ? await archiveWorkspace(context.config.sandboxRoot, project.slug, result.keepDocs)
        : null;
      const queued = await context.orchestrator.advance(id);
      return reply.send({ reset: result.reset, removed: result.removed, archived, queued });
    },
  );

  /** Xoá hẳn một dự án: dữ liệu, chi phí, nhật ký chạy, mã nguồn, bản cất, ảnh sản phẩm — không giữ lại gì. */
  app.delete(
    '/projects/:id',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });
      const tasks = await context.repos.tasks.listByProject(id);
      if (tasks.some((task) => task.status === 'IN_PROGRESS')) {
        return reply.code(409).send({ error: 'Dự án đang có việc chạy dở. Đợi việc đó xong rồi hãy xoá.' });
      }
      await context.repos.projects.delete(id);
      await removeWorkspace(context.config.sandboxRoot, project.slug);
      return reply.send({ deleted: true, name: project.name });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Task — §13                                                              */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/tasks',
    { preHandler: [app.authenticate, app.requireCapability('task:write')] },
    async (request, reply) => {
      const input = createTaskSchema.parse(request.body);
      const task = await context.repos.tasks.create({
        projectId: input.projectId,
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignedRole: input.assignedRole ?? null,
        parentTaskId: input.parentTaskId ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        dependsOn: input.dependsOn,
      });

      await context.events.publish(
        'TASK_CREATED',
        // CEO giao thẳng, không phải agent nào chuyển giao — nên `fromRole` rỗng.
        { taskId: task.id, title: task.title, assignedRole: task.assignedRole, fromRole: null, priority: task.priority },
        { projectId: task.projectId, taskId: task.id, actor: `user:${request.principal!.id}` },
      );

      return reply.code(201).send({ task });
    },
  );

  app.get('/projects/:id/tasks', { preHandler: [app.authenticate, app.requireCapability('task:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send({ tasks: await context.repos.tasks.listByProject(id) });
  });

  app.get('/tasks/:id', { preHandler: [app.authenticate, app.requireCapability('task:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const task = await context.repos.tasks.findById(id);
    if (!task) return reply.code(404).send({ error: 'Không tìm thấy task' });

    const [runs, messages, dependencies] = await Promise.all([
      context.repos.runs.listByTask(id),
      context.repos.messages.listByTask(id),
      context.repos.tasks.dependencies(id),
    ]);
    return reply.send({ task, runs, messages, dependencies });
  });

  app.patch(
    '/tasks/:id/status',
    { preHandler: [app.authenticate, app.requireCapability('task:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { status, note } = updateTaskStatusSchema.parse(request.body);

      // Tạm dừng / bỏ việc phải cắt lượt đang chạy, không chỉ đổi nhãn.
      if (status === 'PAUSED' || status === 'CANCELLED') {
        await context.orchestrator.stopTask(id, status === 'CANCELLED' ? 'cancel' : 'pause');
      }
      const task = await context.repos.tasks.setStatus(id, status);
      if (note) {
        await context.repos.messages.append({
          projectId: task.projectId,
          taskId: task.id,
          author: request.principal!.email,
          role: 'user',
          content: note,
        });
      }

      // Phát event tương ứng để dashboard và nhân vật 3D phản ứng (§9, §21).
      if (status === 'IN_PROGRESS' && task.assignedRole) {
        await context.events.publish(
          'TASK_STARTED',
          { taskId: task.id, agentRole: task.assignedRole },
          { projectId: task.projectId, taskId: task.id },
        );
      } else if (status === 'DONE') {
        const durationMs = task.startedAt
          ? Date.parse(task.completedAt ?? new Date().toISOString()) - Date.parse(task.startedAt)
          : 0;
        await context.events.publish(
          'TASK_COMPLETED',
          { taskId: task.id, durationMs, agentRole: task.assignedRole },
          { projectId: task.projectId, taskId: task.id },
        );
      }

      return reply.send({ task });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Lỗi                                                                     */
  /* ---------------------------------------------------------------------- */

  app.post(
    '/bugs',
    { preHandler: [app.authenticate, app.requireCapability('bug:write')] },
    async (request, reply) => {
      const input = createBugSchema.parse(request.body);
      const bug = await context.repos.bugs.create({
        projectId: input.projectId,
        taskId: input.taskId ?? null,
        title: input.title,
        description: input.description,
        severity: input.severity,
      });

      await context.events.publish(
        'BUG_CREATED',
        { bugId: bug.id, severity: bug.severity, title: bug.title, fromRole: null, toRole: null },
        { projectId: bug.projectId, taskId: bug.taskId },
      );

      return reply.code(201).send({ bug });
    },
  );

  app.get('/projects/:id/bugs', { preHandler: [app.authenticate, app.requireCapability('bug:read')] }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const query = z.object({ status: z.enum(BUG_STATUSES).optional() }).parse(request.query);
    return reply.send({ bugs: await context.repos.bugs.listByProject(id, query.status) });
  });

  app.patch(
    '/bugs/:id/status',
    { preHandler: [app.authenticate, app.requireCapability('bug:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { status } = z.object({ status: z.enum(BUG_STATUSES) }).parse(request.body);
      await context.repos.bugs.setStatus(id, status);
      return reply.send({ ok: true, status });
    },
  );
}
