/**
 * P&N — Agent, phê duyệt và triển khai (§11, §27, §38, §62).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { STAGING_BUILD_TITLE } from '@pn/orchestrator';
import { AGENT_CAPABILITIES } from '@pn/permissions';
import {
  agentStateUpdateSchema,
  approvalDecisionSchema,
  createApprovalSchema,
  createDeploymentSchema,
  AGENT_ROLES,
} from '@pn/shared';

import type { AppContext } from '../context.js';
import { agentJob } from '../services/agent-job.js';

const idParam = z.object({ id: z.string().uuid() });
const roleParam = z.object({ role: z.enum(AGENT_ROLES) });

export async function agentRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /* Agent — §11                                                             */
  /* ---------------------------------------------------------------------- */

  app.get('/agents', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ agents: await context.repos.agents.list() });
  });

  /** §11 — panel chi tiết agent: trạng thái, task đang làm, lịch sử chạy, quyền. */
  app.get('/agents/:role', { preHandler: [app.authenticate, app.requireCapability('agent:read')] }, async (request, reply) => {
    const { role } = roleParam.parse(request.params);
    const agent = await context.repos.agents.findByRole(role);
    if (!agent) return reply.code(404).send({ error: `Chưa có agent vai trò ${role}` });

    const [runs, currentTask, route] = await Promise.all([
      context.repos.runs.listRecentByAgent(agent.id, 20),
      agent.currentTaskId ? context.repos.tasks.findById(agent.currentTaskId) : Promise.resolve(null),
      context.repos.routes.find(role, context.config.environment),
    ]);

    return reply.send({
      agent,
      runs,
      currentTask,
      route,
      capabilities: AGENT_CAPABILITIES[role],
      // Thẻ "Mô tả công việc": đọc từ chính bản chỉ dẫn agent đang làm theo + quy trình sản xuất.
      job: agentJob(role, context.agents),
    });
  });

  /**
   * §9 — đổi trạng thái agent. Chỉ vai trò điều khiển được agent mới gọi được,
   * và mọi thay đổi đều phát event nên nhân vật 3D luôn khớp dữ liệu thật.
   */
  app.patch(
    '/agents/:role/state',
    { preHandler: [app.authenticate, app.requireCapability('agent:control')] },
    async (request, reply) => {
      const { role } = roleParam.parse(request.params);
      const input = agentStateUpdateSchema.parse(request.body);

      const agent = await context.agentState.transition(role, input.state, {
        taskId: input.currentTaskId ?? null,
        projectId: input.currentProjectId ?? null,
      });
      return reply.send({ agent });
    },
  );

  app.patch(
    '/agents/:role/enabled',
    { preHandler: [app.authenticate, app.requireCapability('agent:control')] },
    async (request, reply) => {
      const { role } = roleParam.parse(request.params);
      const { isEnabled } = z.object({ isEnabled: z.boolean() }).parse(request.body);

      const agent = await context.repos.agents.findByRole(role);
      if (!agent) return reply.code(404).send({ error: `Chưa có agent vai trò ${role}` });

      await context.repos.agents.setEnabled(agent.id, isEnabled);
      return reply.send({ ok: true, role, isEnabled });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Phê duyệt — §27                                                         */
  /* ---------------------------------------------------------------------- */

  app.get('/approvals', { preHandler: [app.authenticate, app.requireCapability('approval:read')] }, async (_request, reply) => {
    return reply.send({ approvals: await context.repos.approvals.listPending() });
  });

  app.post(
    '/approvals',
    { preHandler: [app.authenticate, app.requireCapability('approval:request')] },
    async (request, reply) => {
      const input = createApprovalSchema.parse(request.body);
      const approval = await context.repos.approvals.create({
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        projectId: input.projectId ?? null,
        taskId: input.taskId ?? null,
        context: input.context,
        expiresInMinutes: input.expiresInMinutes ?? null,
      });

      await context.events.publish(
        'APPROVAL_REQUIRED',
        { approvalId: approval.id, kind: approval.kind, title: approval.title },
        { projectId: approval.projectId, taskId: approval.taskId },
      );

      return reply.code(201).send({ approval });
    },
  );

  /** Quyết định của CEO. `approval:decide` là quyền agent không bao giờ có (§20). */
  app.post(
    '/approvals/:id/decide',
    { preHandler: [app.authenticate, app.requireCapability('approval:decide')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = approvalDecisionSchema.parse(request.body);

      const approval = await context.repos.approvals.decide(
        id,
        input.decision,
        request.principal!.id,
        input.note,
      );
      if (!approval) {
        return reply.code(409).send({ error: 'Yêu cầu này đã được quyết định hoặc đã hết hạn' });
      }

      await context.events.publish(
        input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
        input.decision === 'APPROVED'
          ? { approvalId: approval.id, decidedBy: request.principal!.email }
          : {
              approvalId: approval.id,
              decidedBy: request.principal!.email,
              note: input.note ?? null,
            },
        { projectId: approval.projectId, taskId: approval.taskId },
      );

      // Duyệt xong thì dự án phải tự chạy tiếp. Trước đây không ai gọi advance
      // sau khi duyệt, nên CEO duyệt trên Telegram rồi vẫn phải mở dashboard bấm
      // "Chạy tiếp" — đúng thứ Telegram sinh ra để tránh. Dự án đang tạm dừng vì
      // ngân sách thì không (§55).
      let queued = 0;
      if (approval.projectId) {
        // Câu hỏi chi phí của một phòng: duyệt hay từ chối đều là câu trả lời,
        // phòng đó làm lại theo quyết định nên dự án luôn đi tiếp.
        const answered = await context.orchestrator.answerCostQuestion(approval, input.decision === 'APPROVED');
        // Phiếu "QA vẫn không đạt": duyệt là cho sửa thêm một vòng (mở khoá các
        // task đang chặn rồi advance); từ chối là chấp nhận hiện trạng và đi tiếp.
        const goOn =
          answered ||
          (input.decision === 'APPROVED'
            ? (await context.orchestrator.resumeFixLoop(approval), true)
            : await context.orchestrator.waiveFixLoop(approval));
        const project = await context.repos.projects.findById(approval.projectId);
        if (goOn && project && project.status !== 'PAUSED_BUDGET') {
          queued = await context.orchestrator.advance(approval.projectId);
        }
      }

      return reply.send({ approval, queued });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Triển khai — §38, §62                                                   */
  /* ---------------------------------------------------------------------- */

  app.get('/deployments', { preHandler: [app.authenticate, app.requireCapability('deploy:read')] }, async (_request, reply) => {
    return reply.send({ deployments: await context.repos.deployments.listRecent() });
  });

  /**
   * §20, §38 — deploy production luôn phải qua cổng kiểm soát. Nếu chưa có phê
   * duyệt được chấp thuận, API tự tạo yêu cầu phê duyệt và trả về 202 thay vì
   * triển khai. Ràng buộc này cũng được database bảo vệ ở tầng dưới.
   */
  app.post(
    '/deployments',
    { preHandler: [app.authenticate, app.requireCapability('deploy:staging')] },
    async (request, reply) => {
      const input = createDeploymentSchema.parse(request.body);

      // Bản thử đi qua bộ điều phối: một bản dựng mỗi dự án, dừng được, hỏng thì DevOps sửa rồi tự dựng lại (§38, §144).
      if (input.environment === 'STAGING') {
        const state = await context.orchestrator.buildStaging(input.projectId);
        if (state === 'not_found') return reply.code(404).send({ error: 'Không tìm thấy dự án' });
        if (state === 'running') return reply.code(409).send({ error: 'Dự án này đang dựng bản thử. Bấm Dừng nếu muốn dựng lại từ đầu.' });
        if (state === 'halted') return reply.code(409).send({ error: 'Dự án đang dừng. Bấm Tiếp tục ở trang dự án trước khi dựng.' });
        if (state === 'unavailable') return reply.code(503).send({ error: 'Máy chủ chưa cắm bộ dựng bản thử.' });
        return reply.code(202).send({ status: 'STARTED' });
      }

      if (input.environment === 'PRODUCTION') {
        const approvalId = z
          .object({ approvalId: z.string().uuid().optional() })
          .parse(request.body).approvalId;

        const approval = approvalId ? await context.repos.approvals.findById(approvalId) : null;

        if (!approval || approval.status !== 'APPROVED') {
          const pending = await context.repos.approvals.create({
            kind: 'PRODUCTION_DEPLOY',
            title: 'Duyệt triển khai production',
            summary: `Yêu cầu deploy production cho dự án ${input.projectId}`,
            projectId: input.projectId,
            context: { commitSha: input.commitSha ?? null },
          });

          await context.events.publish(
            'APPROVAL_REQUIRED',
            { approvalId: pending.id, kind: pending.kind, title: pending.title },
            { projectId: input.projectId },
          );

          return reply.code(202).send({
            status: 'AWAITING_APPROVAL',
            approval: pending,
            message: 'Deploy production cần CEO duyệt trước (spec §20, §38).',
          });
        }
      }

      const deployment = await context.repos.deployments.create({
        projectId: input.projectId,
        environment: input.environment,
        commitSha: input.commitSha ?? null,
        approvalId: (request.body as { approvalId?: string }).approvalId ?? null,
      });

      await context.events.publish(
        'DEPLOY_STARTED',
        { deploymentId: deployment.id, environment: deployment.environment },
        { projectId: deployment.projectId },
      );

      return reply.code(201).send({ deployment });
    },
  );

  /** Nút Dừng cạnh bản thử đang dựng: cắt npm/electron-builder ngay, bấm Dựng bản thử để dựng lại từ đầu. */
  app.post(
    '/projects/:id/staging/stop',
    { preHandler: [app.authenticate, app.requireCapability('deploy:staging')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      if (!context.orchestrator.isBuildingStaging(id)) {
        return reply.code(409).send({ error: 'Dự án này không có bản thử nào đang dựng.' });
      }
      const build = (await context.repos.tasks.listByStage(id, 'staging')).find((task) => task.title === STAGING_BUILD_TITLE);
      if (!build) return reply.code(409).send({ error: 'Dự án này không có bản thử nào đang dựng.' });
      await context.orchestrator.stopTask(build.id, 'pause');
      return reply.send({ ok: true });
    },
  );

  app.patch(
    '/deployments/:id/status',
    { preHandler: [app.authenticate, app.requireCapability('deploy:staging')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = z
        .object({
          status: z.enum(['IN_PROGRESS', 'SUCCESS', 'FAILED', 'ROLLED_BACK']),
          url: z.string().url().nullish(),
          logExcerpt: z.string().max(20_000).nullish(),
        })
        .parse(request.body);

      await context.repos.deployments.setStatus(id, input.status, {
        url: input.url ?? null,
        logExcerpt: input.logExcerpt ?? null,
      });

      const deployment = await context.repos.deployments.findById(id);
      if (!deployment) return reply.code(404).send({ error: 'Không tìm thấy bản triển khai' });

      if (input.status === 'SUCCESS') {
        await context.events.publish(
          'DEPLOY_SUCCESS',
          {
            deploymentId: deployment.id,
            environment: deployment.environment,
            url: deployment.url,
          },
          { projectId: deployment.projectId },
        );
      } else if (input.status === 'FAILED') {
        await context.events.publish(
          'DEPLOY_FAILED',
          {
            deploymentId: deployment.id,
            environment: deployment.environment,
            reason: input.logExcerpt ?? 'không rõ nguyên nhân',
          },
          { projectId: deployment.projectId },
        );
      }

      return reply.send({ deployment });
    },
  );
}
