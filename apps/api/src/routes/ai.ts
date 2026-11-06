/**
 * P&N — Cổng AI và báo cáo chi phí (§16, §29, §89).
 *
 * §89: đây là endpoint duy nhất mà phần còn lại của hệ thống (worker, agent,
 * Telegram bot) được phép dùng để gọi model. Frontend không bao giờ giữ key và
 * không bao giờ gọi thẳng provider.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { aiGenerateSchema } from '@pn/shared';

import type { AppContext } from '../context.js';
import { sendTelegram, telegramTarget } from '../services/notifier.js';
import { buildAcceptanceReport } from '../services/acceptance.js';
import { collectBrief, formatBrief } from '../services/daily-brief.js';
import { buildCeoReport, formatReportForTelegram } from '../services/report.js';
import { AUDIT_NOISE_ACTIONS } from './settings-center.js';

const TASK_KINDS = [
  'classification',
  'summarization',
  'formatting',
  'code',
  'architecture_review',
  'debugging',
  'general',
] as const;

export async function aiRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /** §89 — mọi request AI đi qua đây; cost được ghi trước khi trả kết quả. */
  app.post('/ai/generate', { preHandler: app.authenticate }, async (request, reply) => {
    const input = aiGenerateSchema.parse(request.body);
    const extra = z
      .object({ taskKind: z.enum(TASK_KINDS).optional(), agentId: z.string().uuid().optional() })
      .parse(request.body);

    // §71 — ghi đè model là hành động đáng chú ý, phải để lại dấu vết.
    if (input.overrideModel) {
      await context.repos.audit.record({
        actor: `user:${request.principal!.id}`,
        action: 'AI_MODEL_OVERRIDE',
        targetType: 'ai',
        targetId: input.overrideModel,
        metadata: { agentRole: input.agentRole, projectId: input.projectId ?? null },
        environment: context.config.environment,
      });
    }

    const result = await context.gateway.generate({
      agentRole: input.agentRole,
      messages: input.messages,
      ...(input.system ? { system: input.system } : {}),
      projectId: input.projectId ?? null,
      taskId: input.taskId ?? null,
      runId: input.runId ?? null,
      agentId: extra.agentId ?? null,
      ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(extra.taskKind ? { taskKind: extra.taskKind } : {}),
      ...(input.overrideModel ? { overrideModel: input.overrideModel } : {}),
      ...(input.avoidModels ? { avoidModels: input.avoidModels } : {}),
    });

    return reply.send({
      text: result.text,
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      stopReason: result.stopReason,
      routing: result.routing,
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Báo cáo CEO — §29                                                       */
  /* ---------------------------------------------------------------------- */

  app.get('/reports/ceo', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ report: await buildCeoReport(context.repos) });
  });

  /**
   * §149 — bảng nghiệm thu 30 mục, kiểm từ hệ thống đang chạy.
   *
   * Mục nào chưa làm thì trả `ok: false` kèm lý do, không tự nhận là đạt. Đây
   * là chỗ duy nhất trả lời được câu "hệ thống này còn thiếu gì" bằng dữ liệu.
   */
  /** Bản tin sức khoẻ công ty, cùng nội dung với bản tự gửi mỗi sáng. */
  app.get('/reports/brief', { preHandler: app.authenticate }, async (_request, reply) => {
    const input = await collectBrief(context);
    return reply.send({ text: formatBrief(input), input });
  });

  app.get('/reports/acceptance', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send(await buildAcceptanceReport(context));
  });

  /** §29 — "Có thể gửi Telegram". Cùng dữ liệu với bản trên màn hình. */
  app.post('/reports/ceo/telegram', { preHandler: app.authenticate }, async (_request, reply) => {
    const target = await telegramTarget(context, context.config.environment);
    if (!target) {
      return reply.code(400).send({
        error:
          'Chưa cấu hình Telegram, hoặc chưa có chat ID nào trong allowlist. ' +
          'Vào Cài đặt → Tích hợp để nhập.',
      });
    }

    const report = await buildCeoReport(context.repos);
    const errors: string[] = [];
    const delivered = await sendTelegram(target, formatReportForTelegram(report), (message) =>
      errors.push(message),
    );

    if (delivered === 0) {
      return reply.code(502).send({ error: `Không gửi được: ${errors.join('; ')}` });
    }
    return reply.send({ delivered, failed: errors });
  });

  /* ---------------------------------------------------------------------- */
  /* Chi phí — §16                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Đếm lại chi phí từ bây giờ (cho giai đoạn thử nghiệm). Lịch sử
   * lượt gọi giữ nguyên; dashboard, ngân sách và bản tin chỉ tính từ mốc này.
   */
  app.post('/cost/reset', { preHandler: [app.authenticate, app.requireCapability('budget:reset')] }, async (request, reply) => {
    const countFrom = await context.repos.costs.resetCount(request.principal!.email);
    return reply.send({ countFrom });
  });

  /** Bảng điều khiển chi phí: hôm nay, tháng này, và bóc tách theo 4 chiều. */
  app.get('/cost/summary', { preHandler: [app.authenticate, app.requireCapability('budget:read')] }, async (_request, reply) => {
    const [today, month, byProject, byAgent, byModel, byProvider, daily, countFrom] = await Promise.all([
      context.repos.costs.today(),
      context.repos.costs.thisMonth(),
      context.repos.costs.breakdown('project'),
      context.repos.costs.breakdown('agent'),
      context.repos.costs.breakdown('model'),
      context.repos.costs.breakdown('provider'),
      context.repos.costs.daily(30),
      context.repos.costs.countFrom(),
    ]);

    return reply.send({
      // Mốc "đếm lại chi phí" gần nhất; null là đếm từ đầu.
      countFrom,
      today,
      month,
      byProject,
      byAgent,
      byModel,
      byProvider,
      daily,
      // Nói rõ có bao nhiêu lần gọi chưa tính được tiền, thay vì im lặng báo thiếu.
      note:
        month.unpricedCalls > 0
          ? `${month.unpricedCalls} lần gọi dùng model chưa cấu hình giá — chưa tính vào tổng.`
          : null,
    });
  });

  app.get('/cost/records', { preHandler: [app.authenticate, app.requireCapability('budget:read')] }, async (request, reply) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(
      request.query,
    );
    return reply.send({ records: await context.repos.costs.listRecent(limit) });
  });

  /* ---------------------------------------------------------------------- */
  /* Nhật ký kiểm toán — §28                                                 */
  /* ---------------------------------------------------------------------- */

  app.get(
    '/audit',
    { preHandler: [app.authenticate, app.requireCapability('audit:read')] },
    async (request, reply) => {
      const query = z
        .object({
          targetType: z.string().max(64).optional(),
          targetId: z.string().max(64).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          // Trang Nhật ký bản 4: bỏ dòng bot lấy cấu hình mỗi 2 phút, và "Hiện thêm" đọc tiếp dòng cũ hơn.
          excludeNoise: z.enum(['true', 'false']).optional(),
          before: z.string().datetime({ offset: true }).optional(),
        })
        .parse(request.query);
      const { excludeNoise, ...filter } = query;
      return reply.send({
        entries: await context.repos.audit.list({ ...filter, ...(excludeNoise === 'true' ? { excludeActions: AUDIT_NOISE_ACTIONS } : {}) }),
      });
    },
  );
}
