/**
 * P&N — Điều khiển vòng sản xuất (§3.1, §4, §43).
 *
 * Đây là cửa mà Telegram bot và dashboard dùng để giao việc cho công ty.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { isHalted } from '@pn/orchestrator';
import { PRODUCT_TYPES } from '@pn/shared';

import type { AppContext } from '../context.js';
import { estimatePlanCost } from '../services/estimate.js';

const idParam = z.object({ id: z.string().uuid() });

const intakeSchema = z.object({
  goal: z.string().min(5).max(20_000),
  productType: z.enum(PRODUCT_TYPES).default('WEB_APPLICATION'),
  name: z.string().min(2).max(120).optional(),
  budgetUsd: z.number().positive().max(100_000).optional(),
  repoFullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'định dạng phải là owner/repo')
    .nullish(),
  /** §26 — false thì lập kế hoạch xong dừng lại chờ CEO duyệt. */
  autoStart: z.boolean().default(true),
  /**
   * true: trả lời ngay khi dự án đã tạo, CTO lập kế hoạch nền; trang theo dõi qua GET /projects/:id/plan.
   * Trình duyệt đi qua đường hầm Cloudflare bị cắt sau 100 giây, còn CTO chạy qua gói Claude mất vài phút.
   */
  background: z.boolean().default(false),
});

export async function orchestratorRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /**
   * §3.1 — CEO giao một mục tiêu, CTO tạo dự án và phân rã task ngay trong
   * request này để CEO nhận được kế hoạch, rồi phần còn lại chạy nền.
   */
  app.post(
    '/orchestrator/intake',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const input = intakeSchema.parse(request.body);

      // Kiểm tra điều kiện TRƯỚC khi tạo dự án. Không có bước này thì hệ thống
      // vẫn tạo dự án, agent chạy rồi chết, và lỗi nằm khuất trong luồng tin
      // nhắn của task — người dùng chỉ thấy "chẳng có gì xảy ra". Thà từ chối
      // ngay kèm chỉ dẫn còn hơn để lại một dự án chết trong danh sách.
      const blocker = await findIntakeBlocker(context);
      if (blocker) return reply.code(409).send(blocker);

      const intakeRequest = {
        goal: input.goal,
        productType: input.productType,
        requestedByUserId: request.principal!.id,
        ...(input.name ? { name: input.name } : {}),
        ...(input.budgetUsd ? { budgetUsd: input.budgetUsd } : {}),
        repoFullName: input.repoFullName ?? null,
        autoStart: input.autoStart,
      };

      if (input.background) {
        const opened = await context.orchestrator.openIntake(intakeRequest);
        // CTO lập kế hoạch sau khi đã trả lời; lỗi ghi log — task phân rã tự báo BLOCKED kèm lý do.
        void context.orchestrator
          .planIntake(opened.projectId, opened.planningTaskId, input.autoStart)
          .catch((error: unknown) => app.log.error({ err: error, projectId: opened.projectId }, 'CTO lập kế hoạch nền lỗi'));
        const project = await context.repos.projects.findById(opened.projectId);
        return reply.code(202).send({ project, planning: true, planningTaskId: opened.planningTaskId });
      }

      const result = await context.orchestrator.intake(intakeRequest);

      const project = await context.repos.projects.findById(result.projectId);
      const tasks = await context.repos.tasks.listByProject(result.projectId);

      // §26 — ước tính đi kèm kế hoạch, vì CEO duyệt dựa trên cả hai.
      const estimate = await estimatePlanCost(
        context,
        tasks.flatMap((task) => (task.assignedRole ? [task.assignedRole] : [])),
        context.config.environment,
      );

      return reply.code(201).send({
        project,
        tasks,
        plan: result.summary,
        estimate,
        queued: context.orchestrator.queueSize(),
      });
    },
  );

  /**
   * Kế hoạch của một dự án: CTO còn đang phân rã hay đã xong, nội dung kế hoạch, các task và ước tính chi
   * phí. Trang Phòng điều hành hỏi lại endpoint này tới khi `planning` = false, và dự án đứng ở PLANNING
   * (chờ duyệt) hiện lại được nút Duyệt dù CEO đã tắt trang giữa chừng.
   */
  app.get(
    '/projects/:id/plan',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });

      const tasks = await context.repos.tasks.listByProject(id);
      const planningTask = tasks.find((task) => task.assignedRole === 'CTO_ORCHESTRATOR');
      // CEO dừng lúc CTO đang phân rã thì việc phân rã về chờ làm — không tính là "đang lập", kẻo trang chờ mãi.
      const halted = isHalted(project.status);
      const planning = planningTask && !halted ? planningTask.status === 'TODO' || planningTask.status === 'IN_PROGRESS' : false;
      const messages = planningTask ? await context.repos.messages.listByTask(planningTask.id) : [];
      const plan = [...messages].reverse().find((message) => message.author === 'CTO_ORCHESTRATOR' && message.role === 'assistant');
      const failure = planningTask?.status === 'BLOCKED' ? [...messages].reverse().find((message) => message.role === 'system') : undefined;
      const work = tasks.filter((task) => task.assignedRole && task.assignedRole !== 'CTO_ORCHESTRATOR');
      const estimate = await estimatePlanCost(
        context,
        work.flatMap((task) => (task.assignedRole ? [task.assignedRole] : [])),
        context.config.environment,
      );

      return reply.send({
        project,
        tasks,
        planning,
        plan: plan?.content ?? null,
        failed: halted && !plan
          ? 'Đã dừng lập kế hoạch.'
          : (failure?.content ?? (planningTask?.status === 'BLOCKED' ? 'CTO không lập được kế hoạch.' : null)),
        estimate,
      });
    },
  );

  /**
   * §26 — CEO duyệt kế hoạch: dự án chuyển sang chạy thật.
   *
   * Tách khỏi `/advance` vì đây là lần đầu tiên dự án được phép tiêu tiền, và
   * §71 muốn thấy rõ ai là người bật công tắc đó.
   */
  app.post(
    '/projects/:id/approve-plan',
    { preHandler: [app.authenticate, app.requireCapability('project:write')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });

      if (project.status !== 'PLANNING') {
        return reply.code(409).send({
          error: `Dự án đang ở trạng thái ${project.status}, không phải đang chờ duyệt kế hoạch.`,
        });
      }

      await context.repos.projects.updateStatus(id, 'IN_PROGRESS');
      const queued = await context.orchestrator.advance(id);

      return reply.send({ queued, queueSize: context.orchestrator.queueSize() });
    },
  );

  /** Đẩy dự án tiến thêm: xếp vào hàng đợi mọi task vừa hết bị chặn (§4). */
  app.post(
    '/projects/:id/advance',
    { preHandler: [app.authenticate, app.requireCapability('task:assign')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });

      if (project.status === 'PAUSED') {
        return reply.code(409).send({ error: 'Dự án đang dừng. Bấm "Tiếp tục" để chạy lại.' });
      }
      // §55 — dự án đang bị tạm dừng vì ngân sách thì không được chạy tiếp.
      if (project.status === 'PAUSED_BUDGET') {
        return reply.code(402).send({
          error: 'Dự án đang tạm dừng do chạm trần ngân sách. Tăng ngân sách rồi thử lại (§55).',
        });
      }

      const queued = await context.orchestrator.advance(id);
      return reply.send({ queued, queueSize: context.orchestrator.queueSize() });
    },
  );

  /** Chạy lại đúng một task — dùng khi CEO muốn thử lại một bước đã hỏng. */
  app.post(
    '/tasks/:id/run',
    { preHandler: [app.authenticate, app.requireCapability('task:assign')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // Xếp vào hàng đợi của dự án rồi trả lời ngay (một lượt mất nhiều phút; đường hầm cắt request chờ quá 100 giây).
      // Việc đã xong thì không chạy lại (lần trước ra hai bản kế hoạch); đang chạy / đang chờ lượt thì không xếp trùng.
      const result = await context.orchestrator.retryTask(id);
      if (result.status === 'not_found') return reply.code(404).send({ error: 'Không tìm thấy task' });
      if (result.status === 'done') return reply.code(409).send({ error: 'Việc này đã xong rồi, không chạy lại.' });
      if (result.status === 'running') {
        return reply.code(409).send({ error: 'Việc này đang chạy hoặc đang chờ tới lượt, không cần bấm lại.' });
      }
      if (result.status === 'paused') {
        return reply.code(409).send({ error: 'Dự án đang dừng. Bấm "Tiếp tục" ở trang dự án để chạy lại.' });
      }
      return reply.code(202).send({ queued: true, task: result.task });
    },
  );

  /**
   * Dừng riêng một việc: `pause` cắt lượt đang chạy và giữ tiến độ, bấm "Tiếp tục" (chạy lại) để làm nối;
   * `cancel` bỏ hẳn việc, dự án đi tiếp phần còn lại.
   */
  app.post(
    '/tasks/:id/stop',
    { preHandler: [app.authenticate, app.requireCapability('task:assign')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { mode } = z.object({ mode: z.enum(['pause', 'cancel']).default('pause') }).parse(request.body ?? {});
      const result = await context.orchestrator.stopTask(id, mode);
      if (result.status === 'not_found') return reply.code(404).send({ error: 'Không tìm thấy task' });
      if (result.status === 'done') return reply.code(409).send({ error: 'Việc này đã xong, không có gì để dừng.' });
      return reply.send({ ok: true, task: result.task });
    },
  );

  /**
   * Dừng dự án (trước đây phải tắt CLI/API bằng tay): cắt ngay các lượt đang chạy và bản dựng, không nhận
   * việc mới. `pause` (mặc định): tiến độ và tệp đã viết giữ nguyên để "Tiếp tục" làm nối. `cancel` — dừng hẳn: không có
   * Tiếp tục, mã giữ nguyên, làm tiếp bằng "Làm lại dự án". Nhật ký kiểm toán tự ghi (POST).
   */
  app.post(
    '/projects/:id/stop',
    { preHandler: [app.authenticate, app.requireCapability('task:assign')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { mode } = z.object({ mode: z.enum(['pause', 'cancel']).default('pause') }).parse(request.body ?? {});
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });
      if (project.status === 'CANCELLED' || (project.status === 'PAUSED' && mode === 'pause')) {
        return reply.send({ ok: true, aborted: 0, reset: 0 });
      }
      if (project.status === 'COMPLETED' || project.status === 'ARCHIVED') {
        return reply.code(409).send({ error: 'Dự án đã xong hoặc đã lưu trữ, không có gì để dừng.' });
      }
      const result = await context.orchestrator.stopProject(id, mode);
      await context.events.publish(
        'PROJECT_PAUSED',
        { projectId: id, aborted: result.aborted, by: request.principal!.email, cancelled: mode === 'cancel' },
        { projectId: id },
      );
      return reply.send({ ok: true, ...result });
    },
  );

  /** Tiếp tục dự án đã dừng: xếp lại việc, việc dở làm nối từ tiến độ đã lưu. */
  app.post(
    '/projects/:id/resume',
    { preHandler: [app.authenticate, app.requireCapability('task:assign')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const project = await context.repos.projects.findById(id);
      if (!project) return reply.code(404).send({ error: 'Không tìm thấy dự án' });
      if (project.status === 'CANCELLED') {
        return reply.code(409).send({ error: 'Dự án đã dừng hẳn. Bấm "Làm lại dự án" để làm tiếp từ mã đang có.' });
      }
      if (project.status !== 'PAUSED') return reply.code(409).send({ error: 'Dự án không ở trạng thái dừng.' });
      const queued = await context.orchestrator.resumeProject(id);
      await context.events.publish('PROJECT_RESUMED', { projectId: id, queued, by: request.principal!.email }, { projectId: id });
      return reply.send({ ok: true, queued });
    },
  );

  /** Trạng thái hàng đợi, hiển thị ở KPI bar (§24). */
  app.get('/orchestrator/status', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({
      queueSize: context.orchestrator.queueSize(),
      // §35 — nói rõ vai trò nào đã nhận việc được, vai trò nào còn chờ phase sau.
      implementedRoles: context.agents.roles(),
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Kiểm tra điều kiện trước khi nhận việc                                      */
/* -------------------------------------------------------------------------- */

interface IntakeBlocker {
  error: string;
  /** Bước cụ thể người dùng cần làm, để giao diện dẫn thẳng tới đó. */
  fix: string;
  fixPath: string;
}

/**
 * Trả về lý do KHÔNG thể nhận việc, hoặc `null` nếu mọi thứ sẵn sàng.
 *
 * Thứ tự kiểm tra đi theo đúng thứ tự người dùng phải làm, nên thông báo luôn
 * chỉ vào bước gần nhất còn thiếu chứ không liệt kê tất cả.
 */
async function findIntakeBlocker(context: AppContext): Promise<IntakeBlocker | null> {
  const env = context.config.environment;

  if (context.registry.configured().length === 0) {
    return {
      error: 'Chưa cấu hình nhà cung cấp AI nào, nên không có agent nào làm việc được.',
      fix: 'Vào Cài đặt → AI Providers, dán API key rồi bấm Test Connection.',
      fixPath: '/settings',
    };
  }

  const routes = await context.repos.routes.list(env);
  if (routes.length === 0) {
    return {
      error: 'Chưa có bảng định tuyến model cho agent.',
      fix: 'Vào Cài đặt → Định tuyến model, bấm "Tạo bảng định tuyến mặc định".',
      fixPath: '/settings',
    };
  }

  // Route có tồn tại nhưng trỏ tới provider chưa nạp được (ví dụ key đã bị xoá)
  // thì cũng chết như không có route, chỉ khác thông báo.
  const cto = routes.find((route) => route.agentRole === 'CTO_ORCHESTRATOR');
  if (!cto) {
    return {
      error: 'Chưa có định tuyến cho vai trò CTO — đây là agent nhận việc đầu tiên.',
      fix: 'Vào Cài đặt → Định tuyến model và tạo lại bảng mặc định.',
      fixPath: '/settings',
    };
  }
  if (!context.registry.has(cto.provider)) {
    return {
      error: `Định tuyến đang trỏ tới ${cto.provider} nhưng provider đó chưa sẵn sàng (thiếu key hoặc đã bị tắt).`,
      fix: 'Vào Cài đặt → AI Providers, cấu hình lại key rồi Test Connection.',
      fixPath: '/settings',
    };
  }

  return null;
}
