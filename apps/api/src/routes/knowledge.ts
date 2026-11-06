/**
 * P&N — Knowledge & R&D trên API (§98–§130).
 *
 * Ràng buộc chi phối cả file: §108 — không gói kiến thức nào tới được agent
 * trước khi CEO duyệt. Endpoint kích hoạt vì thế đòi `approval:decide`, thứ mà
 * AGENT không bao giờ có (§20), và nó ghi nhật ký riêng cho kiến thức (§149.29).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { buildSystemPrompt, type PromptRole } from '@pn/agents';
import { grantXp, levelForXp, levelProgress } from '@pn/knowledge';
import { GovernanceDeniedError, assertGovernance } from '@pn/permissions';
import { AGENT_ROLES, DEPARTMENTS, agentProfile } from '@pn/shared';

import type { AppContext } from '../context.js';
import { EvaluationStopped, evaluateKnowledge } from '../services/knowledge-evaluation.js';
import { measureImpact } from '../services/knowledge-metrics.js';
import { formatDigest, runDiscovery } from '../services/knowledge-pipeline.js';
import { sendTelegram, telegramTarget } from '../services/notifier.js';

const idParam = z.object({ id: z.string().uuid() });

export async function knowledgeRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /* ---------------------------------------------------------------------- */
  /* Đọc — ai đăng nhập cũng xem được                                        */
  /* ---------------------------------------------------------------------- */

  app.get('/knowledge/items', { preHandler: app.authenticate }, async (request, reply) => {
    const query = z
      .object({
        status: z
          .enum(['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'DEPRECATED', 'ROLLED_BACK', 'REJECTED'])
          .optional(),
      })
      .parse(request.query);

    const items = await context.repos.knowledgeItems.list(
      query.status ? { status: query.status } : {},
    );
    return reply.send({ items });
  });

  app.get('/knowledge/items/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const item = await context.repos.knowledgeItems.findById(id);
    if (!item) return reply.code(404).send({ error: 'Không tìm thấy gói kiến thức' });

    const [versions, reviews, audit] = await Promise.all([
      context.repos.knowledgeItems.versions(id),
      context.repos.knowledgeReviews.listForItem(id),
      context.repos.knowledgeAudit.listForItem(id),
    ]);
    return reply.send({ item, versions, reviews, audit });
  });

  app.get('/knowledge/candidates', { preHandler: app.authenticate }, async (request, reply) => {
    const query = z
      .object({
        stage: z
          .enum(['DISCOVERED', 'SCREENED', 'EVALUATED', 'PROMOTED', 'REJECTED'])
          .default('SCREENED'),
      })
      .parse(request.query);

    const [candidates, counts] = await Promise.all([
      context.repos.knowledgeCandidates.listByStage(query.stage),
      context.repos.knowledgeCandidates.countByStage(),
    ]);
    return reply.send({ candidates, counts });
  });

  /** §102 — repo đã chấm điểm, xếp theo điểm chứ không theo sao. */
  app.get('/knowledge/repos', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ repos: await context.repos.githubRepos.topScored(30) });
  });

  app.get('/knowledge/radar', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ entries: await context.repos.technologyRadar.list() });
  });

  /** §104 — danh mục kỹ năng; `isActive` nghĩa là gói mang nó đã được duyệt. */
  app.get('/knowledge/skills', { preHandler: app.authenticate }, async (_request, reply) => {
    return reply.send({ skills: await context.repos.skills.list() });
  });

  /**
   * §111 — cấp độ từng phòng ban. Trả về đủ 13 phòng kể cả phòng chưa có XP nào,
   * để màn hình không bị "thiếu phòng" và người đọc thấy được ai đang đứng yên.
   */
  app.get('/knowledge/levels', { preHandler: app.authenticate }, async (_request, reply) => {
    const stored = await context.repos.departmentLevels.list();
    const byDepartment = new Map(stored.map((row) => [row.department, row]));

    const levels = DEPARTMENTS.map((department) => {
      const row = byDepartment.get(department);
      return {
        department,
        ...levelProgress(row?.totalXp ?? 0),
        leveledUpAt: row?.leveledUpAt ?? null,
      };
    }).sort((a, b) => b.totalXp - a.totalXp);

    return reply.send({ levels });
  });

  /* ---------------------------------------------------------------------- */
  /* Chạy vòng khám phá — §106                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Tốn tiền model nên đòi quyền ghi cài đặt, và mặc định chỉ biên tập 3 ứng
   * viên mỗi vòng (§132).
   */
  // Việc tri thức đang chạy (tìm kiếm, chạy thử) — nút Dừng trên trang Tri thức cắt đúng việc này.
  const running = new Map<string, AbortController>();

  /** Dừng một lượt tìm kiếm hoặc chạy thử đang chạy; không có gì đang chạy thì báo rõ. */
  const stopRunning = (key: string) => {
    const controller = running.get(key);
    if (!controller) return { code: 409, body: { error: 'Không có việc nào đang chạy để dừng.' } };
    controller.abort();
    return { code: 200, body: { ok: true } };
  };

  app.post(
    '/knowledge/discover/stop',
    { preHandler: [app.authenticate, app.requireCapability('knowledge:discover')] },
    async (_request, reply) => {
      const result = stopRunning('discover');
      return reply.code(result.code).send(result.body);
    },
  );

  app.post(
    '/knowledge/discover',
    // Khu "Nhân sự AI" nấc Toàn quyền — trước đây mượn quyền cài đặt.
    { preHandler: [app.authenticate, app.requireCapability('knowledge:discover')] },
    async (request, reply) => {
      const input = z
        .object({
          queries: z.array(z.string().min(3).max(200)).max(5).optional(),
          wantedTopics: z.array(z.string().min(1).max(50)).max(10).optional(),
          maxCurated: z.number().int().min(1).max(10).optional(),
          sendDigest: z.boolean().default(false),
        })
        .parse(request.body ?? {});

      const github = await context.github();
      if (!github) {
        return reply.code(400).send({
          error: 'Chưa cấu hình GitHub — GitHub Scout không tìm được gì.',
          fix: 'Vào Cài đặt → Tích hợp, nhập GitHub token rồi bấm Test Connection.',
          fixPath: '/settings/integrations',
        });
      }

      if (running.has('discover')) return reply.code(409).send({ error: 'Đang có một lượt tìm kiếm chạy. Bấm Dừng nếu muốn chạy lại.' });
      const controller = new AbortController();
      running.set('discover', controller);
      let report: Awaited<ReturnType<typeof runDiscovery>>;
      try {
        report = await runDiscovery(context, github, {
          ...(input.queries ? { queries: input.queries } : {}),
          ...(input.wantedTopics ? { wantedTopics: input.wantedTopics } : {}),
          ...(input.maxCurated ? { maxCurated: input.maxCurated } : {}),
          signal: controller.signal,
        });
      } finally {
        running.delete('discover');
      }

      // §107 — bản tóm tắt gửi CEO qua Telegram, nếu người dùng muốn.
      let digestSent = 0;
      if (input.sendDigest) {
        const target = await telegramTarget(context, context.config.environment);
        if (target) digestSent = await sendTelegram(target, formatDigest(report));
      }

      return reply.send({ report, digestSent });
    },
  );

  /* ---------------------------------------------------------------------- */
  /* Chạy thử trong sandbox — §116                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * §116 — chạy cùng một bài toán hai lần, có và không có kiến thức, rồi so.
   * Tốn hai lượt gọi model nên nó là một hành động tường minh, không tự chạy.
   */
  app.post(
    '/knowledge/items/:id/evaluate/stop',
    { preHandler: [app.authenticate, app.requireCapability('knowledge:evaluate')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = stopRunning(`evaluate:${id}`);
      return reply.code(result.code).send(result.body);
    },
  );

  app.post(
    '/knowledge/items/:id/evaluate',
    { preHandler: [app.authenticate, app.requireCapability('knowledge:evaluate')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const item = await context.repos.knowledgeItems.findById(id);
      if (!item) return reply.code(404).send({ error: 'Không tìm thấy gói kiến thức' });

      const key = `evaluate:${id}`;
      if (running.has(key)) return reply.code(409).send({ error: 'Gói này đang được chạy thử. Bấm Dừng nếu muốn chạy lại.' });
      const controller = new AbortController();
      running.set(key, controller);
      let result: Awaited<ReturnType<typeof evaluateKnowledge>>;
      try {
        result = await evaluateKnowledge(context, item, controller.signal);
      } catch (error) {
        if (error instanceof EvaluationStopped) return reply.code(409).send({ error: error.message });
        throw error;
      } finally {
        running.delete(key);
      }

      await context.repos.knowledgeReviews.recordEvaluation({
        itemId: id,
        score: result.score,
        passed: result.passed,
        report: {
          baseline: result.baseline,
          withKnowledge: result.withKnowledge,
          verdict: result.verdict,
        },
      });
      await context.repos.knowledgeAudit.record({
        actor: `user:${request.principal!.id}`,
        action: result.passed ? 'KNOWLEDGE_EVALUATION_PASSED' : 'KNOWLEDGE_EVALUATION_FAILED',
        itemId: id,
        metadata: { score: result.score },
      });
      await context.events.publish(
        'KNOWLEDGE_EVALUATED',
        { itemId: id, score: result.score },
        { actor: `user:${request.principal!.id}` },
      );

      return reply.send({ result });
    },
  );

  /**
   * §124 — gói kiến thức này có cải thiện gì đo được không.
   *
   * Không tốn tiền model: nó chỉ đọc lịch sử task và bug hai bên mốc kích hoạt.
   */
  app.get('/knowledge/items/:id/impact', { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { department } = z.object({ department: z.enum(DEPARTMENTS) }).parse(request.query);

    return reply.send({ impact: await measureImpact(context.repos, id, department) });
  });

  /* ---------------------------------------------------------------------- */
  /* Kích hoạt và quay lui — §108, §113, §115, §142                          */
  /* ---------------------------------------------------------------------- */

  /**
   * §108, §113 — CEO duyệt xong thì Department Trainer gắn kiến thức vào phòng
   * ban và vai trò, rồi mới chuyển sang ACTIVE. Đây là bước duy nhất làm cho
   * kiến thức chạm tới prompt của agent (§142).
   */
  app.post(
    '/knowledge/items/:id/activate',
    { preHandler: [app.authenticate, app.requireCapability('approval:decide')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = z
        .object({
          departments: z.array(z.enum(DEPARTMENTS)).min(1).max(13),
          roles: z.array(z.enum(AGENT_ROLES)).max(26).optional(),
          /**
           * §116 — kích hoạt mà chưa chạy thử là bỏ qua một cổng. Cho phép, vì
           * chạy thử tốn tiền và có lúc CEO đã tự đọc kỹ, nhưng phải nói ra
           * tường minh và nó được ghi vào nhật ký.
           */
          acknowledgeNoEvaluation: z.boolean().default(false),
        })
        .parse(request.body);

      const item = await context.repos.knowledgeItems.findById(id);
      if (!item) return reply.code(404).send({ error: 'Không tìm thấy gói kiến thức' });

      /* §147.3 — kích hoạt kiến thức lấy từ ngoài là một hành động tự sửa. Nó
         phải đi qua đúng một cổng, và cổng đó là `checkGovernance`, không phải
         một chuỗi if rải rác. Đến đây nghĩa là RBAC đã cho qua; governance kiểm
         thêm hai điều RBAC không biết: đã có người ký chưa, và đã rà soát chưa. */
      const reviews = await context.repos.knowledgeReviews.listForItem(id);
      const security = reviews.find((review) => review.kind === 'security');

      try {
        assertGovernance({
          action: 'knowledge:activate',
          actorRole: request.principal!.role,
          hasHumanApproval: true, // chính request này LÀ quyết định của người
          securityReviewed: security?.passed === true,
        });
      } catch (error) {
        if (error instanceof GovernanceDeniedError) {
          return reply.code(409).send({ error: error.message, spec: error.verdict.spec });
        }
        throw error;
      }

      /* §116 — "Nếu tệ hơn baseline: DO NOT ACTIVATE". Đánh giá đã chạy mà
         không đạt thì chặn hẳn, không có đường vòng: CEO bỏ qua được bước CHƯA
         chạy, nhưng không bỏ qua được một kết quả đã nói là tệ hơn. */
      const evaluations = await context.repos.knowledgeReviews.listEvaluations(id);
      const latest = evaluations[0];

      if (latest && !latest.passed) {
        return reply.code(409).send({
          error:
            `Chạy thử trong sandbox cho kết quả ${latest.score}/100 — tệ hơn hoặc ngang ` +
            'baseline. §116 không cho kích hoạt.',
          spec: '§116',
        });
      }
      if (!latest && !input.acknowledgeNoEvaluation) {
        return reply.code(428).send({
          error: 'Gói này chưa chạy thử trong sandbox (§116).',
          fix: 'Bấm "Chạy thử" để đo, hoặc xác nhận kích hoạt mà không đo.',
          needsAcknowledge: true,
        });
      }

      // Không có `roles` thì suy ra từ phòng ban: mọi vai trò thuộc phòng đó.
      const roles =
        input.roles && input.roles.length > 0
          ? input.roles
          : AGENT_ROLES.filter((role) => input.departments.includes(agentProfile(role).department));

      for (const department of input.departments) {
        await context.repos.knowledgeItems.attachToDepartment(id, department);
      }
      for (const role of roles) {
        await context.repos.knowledgeItems.bindToRole(id, role);
      }
      await context.repos.knowledgeItems.setStatus(id, 'ACTIVE');
      // §104 — kỹ năng của gói này giờ mới thật sự nằm trong năng lực công ty.
      await context.repos.skills.activateForItem(id);

      /* §114 — "Version thay đổi khi ... knowledge mới được activate". Ghi lại
         chính xác vai trò đó đang chạy bằng prompt nào và kiến thức nào, để
         sau này còn dựng lại được "hôm đó nó chạy bằng cái gì". */
      for (const role of roles) {
        const active = await context.repos.knowledgeItems.activeForRole(role, 50);
        const profile = await context.repos.agentProfiles.createVersion({
          agentRole: role,
          systemPrompt: buildSystemPrompt(
            role as PromptRole,
            active.map((entry) => ({ title: entry.title, body: entry.body })),
          ),
          knowledgeIds: active.map((entry) => entry.id),
        });

        await context.events.publish(
          'AGENT_PROFILE_UPGRADED',
          { agentRole: role, fromVersion: profile.version - 1, toVersion: profile.version },
          { actor: `user:${request.principal!.id}` },
        );
      }

      // §112 — phòng ban nhận kiến thức mới thì được XP, kèm bằng chứng.
      for (const department of input.departments) {
        const grant = grantXp(
          department,
          'knowledge_approved',
          `Kích hoạt gói kiến thức "${item.title}".`,
          { itemId: id },
        );
        const result = await context.repos.departmentLevels.addXp({ ...grant, levelForXp });

        await context.events.publish(
          'DEPARTMENT_XP_GAINED',
          { department, xp: grant.amount, total: result.totalXp },
          { actor: `user:${request.principal!.id}` },
        );
        // §128 — lên cấp là sự kiện nhìn thấy được trong văn phòng 3D.
        if (result.leveledUp) {
          await context.events.publish(
            'DEPARTMENT_LEVEL_UP',
            { department, level: result.level },
            { actor: `user:${request.principal!.id}` },
          );
        }

        await context.events.publish(
          'KNOWLEDGE_ACTIVATED',
          { itemId: id, department },
          { actor: `user:${request.principal!.id}` },
        );
      }

      await context.repos.knowledgeAudit.record({
        actor: `user:${request.principal!.id}`,
        action: 'KNOWLEDGE_ACTIVATED',
        itemId: id,
        metadata: {
          departments: input.departments,
          roles,
          evaluationScore: latest?.score ?? null,
          skippedEvaluation: !latest,
        },
      });

      return reply.send({ ok: true, departments: input.departments, roles });
    },
  );

  /** §122 — ngừng dùng một gói kiến thức mà vẫn giữ lịch sử. */
  app.post(
    '/knowledge/items/:id/deprecate',
    { preHandler: [app.authenticate, app.requireCapability('approval:decide')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { reason } = z.object({ reason: z.string().min(5).max(1000) }).parse(request.body);

      await context.repos.knowledgeItems.setStatus(id, 'DEPRECATED');
      await context.repos.knowledgeAudit.record({
        actor: `user:${request.principal!.id}`,
        action: 'KNOWLEDGE_DEPRECATED',
        itemId: id,
        metadata: { reason },
      });
      await context.events.publish(
        'KNOWLEDGE_DEPRECATED',
        { itemId: id, reason },
        { actor: `user:${request.principal!.id}` },
      );
      return reply.send({ ok: true });
    },
  );

  /** §115 — quay lui về một phiên bản cũ; lịch sử giữ nguyên. */
  app.post(
    '/knowledge/items/:id/rollback',
    { preHandler: [app.authenticate, app.requireCapability('approval:decide')] },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { version } = z.object({ version: z.number().int().min(1) }).parse(request.body);

      const ok = await context.repos.knowledgeItems.rollback(id, version);
      if (!ok) return reply.code(404).send({ error: `Không có phiên bản ${version}` });

      await context.repos.knowledgeAudit.record({
        actor: `user:${request.principal!.id}`,
        action: 'KNOWLEDGE_ROLLED_BACK',
        itemId: id,
        metadata: { version },
      });
      return reply.send({ ok: true, version });
    },
  );
}
