/**
 * P&N — Dựng ứng dụng Fastify: plugin, route, realtime.
 *
 * Tách khỏi `index.ts` để test tích hợp dựng được app mà không mở cổng mạng.
 */

import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';

import { branding, redactDeep } from '@pn/shared';

import type { AppContext } from './context.js';
import { auditPlugin } from './plugins/audit.js';
import { authPlugin } from './plugins/auth.js';
import { errorsPlugin } from './plugins/errors.js';
import { registerRealtime } from './realtime/ws.js';
import { agentRoutes } from './routes/agents.js';
import { aiRoutes } from './routes/ai.js';
import { apiCenterRoutes } from './routes/api-center.js';
import { settingsCenterRoutes } from './routes/settings-center.js';
import { authRoutes } from './routes/auth.js';
import { insightsRoutes } from './routes/insights.js';
import { internalRoutes } from './routes/internal.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { orchestratorRoutes } from './routes/orchestrator.js';
import { projectRoutes } from './routes/projects.js';
import { assistantRoutes } from './routes/assistant.js';
import { productRoutes, productViewUrl } from './routes/product.js';
import { userRoutes } from './routes/users.js';
import { voiceRoutes } from './routes/voice.js';
import { runLocalStagingDeploy } from './services/local-deploy.js';
import { startApprovalReminders } from './services/approval-reminder.js';
import { registerNotifier } from './services/notifier.js';
import { tunnelApiUrl, tunnelWebOrigin } from './services/tunnel.js';
import { startDailyBrief } from './services/daily-brief.js';
import { startDailyDiscovery } from './services/scheduler.js';
import { seedAgents, seedDefaultBudget } from './services/seed.js';

export async function buildApp(context: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: context.config.nodeEnv === 'production' ? 'info' : 'debug',
      // §82, §89 — log không được mang theo secret; mọi object đi qua redaction.
      serializers: {
        // §19, §82 — CHỈ ghi phần đường dẫn, bỏ hẳn query string. WebSocket
        // nhận token phiên qua `?token=...` (trình duyệt không gửi được header
        // Authorization khi mở socket), nên ghi nguyên URL là ghi thẳng token
        // đăng nhập vào log.
        req: (request) => ({
          method: request.method,
          url: request.url.split('?')[0],
          ip: request.ip,
        }),
        err: (error) => redactDeep({ type: error.name, message: error.message, stack: error.stack ?? '' }),
      },
    },
    // Body lớn nhất 5MB — đủ cho artifact văn bản, chặn tải file khổng lồ vào API.
    bodyLimit: 5 * 1024 * 1024,
    // Sau đường hầm Cloudflare, IP thật nằm trong X-Forwarded-For; không tin proxy
    // thì rate limit gộp mọi người vào một IP của đường hầm.
    trustProxy: true,
  });

  // Cho phép đủ các method mà route dùng (PUT provider, PATCH enable, DELETE…).
  await app.register(fastifyCors, {
    // Địa chỉ đường hầm đổi khi mở lại, nên hỏi lúc có request thay vì chốt lúc khởi động.
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const allowed = [...context.config.webOrigins, tunnelWebOrigin()].filter(Boolean);
      callback(null, allowed.includes(origin.replace(/\/+$/, '')));
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
    credentials: true,
  });

  // §78 — chặn dò mật khẩu và lạm dụng cổng AI.
  await app.register(fastifyRateLimit, {
    max: 600,
    timeWindow: '1 minute',
  });

  await app.register(errorsPlugin);
  await app.register(authPlugin, {
    jwtSecret: context.config.jwtSecret,
    sessionTtlHours: context.config.sessionTtlHours,
    loadUser: (id) => context.repos.users.findById(id),
  });
  await app.register(auditPlugin, {
    repos: context.repos,
    environment: context.config.environment,
  });

  /* -------------------------------------------------------------------- */
  /* Endpoint công khai                                                    */
  /* -------------------------------------------------------------------- */

  /** Kiểm tra tiến trình còn sống — không chạm database để luôn trả lời nhanh. */
  app.get('/health', async () => ({
    ok: true,
    company: branding.companyName,
    environment: context.config.environment,
    at: new Date().toISOString(),
  }));

  /** Sẵn sàng nhận traffic hay chưa — có chạm database. */
  app.get('/ready', async (_request, reply) => {
    const db = await context.db.healthCheck();
    return reply.code(db.ok ? 200 : 503).send({ ok: db.ok, database: db });
  });

  /** §150 — brand đọc từ một nơi duy nhất; frontend lấy về từ đây. */
  app.get('/branding', async () => ({
    companyName: branding.companyName,
    companyShortName: branding.companyShortName,
    tagline: branding.companyTagline,
    taglineVi: branding.companyTaglineVi,
    productName: branding.productName,
    logo: branding.logo,
    welcomeHeadline: branding.welcomeHeadline,
  }));

  /* -------------------------------------------------------------------- */
  /* Route nghiệp vụ                                                       */
  /* -------------------------------------------------------------------- */

  await app.register(async (instance) => authRoutes(instance, context));
  await app.register(async (instance) => projectRoutes(instance, context));
  await app.register(async (instance) => agentRoutes(instance, context));
  await app.register(async (instance) => productRoutes(instance, context));
  await app.register(async (instance) => assistantRoutes(instance, context));
  await app.register(async (instance) => aiRoutes(instance, context));
  await app.register(async (instance) => apiCenterRoutes(instance, context));
  await app.register(async (instance) => settingsCenterRoutes(instance, context));
  await app.register(async (instance) => orchestratorRoutes(instance, context));
  await app.register(async (instance) => internalRoutes(instance, context));
  await app.register(async (instance) => knowledgeRoutes(instance, context));
  await app.register(async (instance) => insightsRoutes(instance, context));
  await app.register(async (instance) => userRoutes(instance, context));
  await app.register(async (instance) => voiceRoutes(instance, context));

  await registerRealtime(app, context);

  // §144 — stage staging do hệ thống dựng: engine gọi về đây, API tạo bản ghi
  // triển khai rồi chạy bộ dựng tại chỗ; xong thì CEO nhận link kèm vé xem.
  context.orchestrator.useStagingDeployer(async (project, signal) => {
    const deployment = await context.repos.deployments.create({
      projectId: project.id,
      environment: 'STAGING',
    });
    await context.events.publish(
      'DEPLOY_STARTED',
      { deploymentId: deployment.id, environment: 'STAGING' },
      { projectId: project.id },
    );
    return runLocalStagingDeploy(
      {
        sandbox: context.sandbox,
        deployments: context.repos.deployments,
        events: context.events,
        publicUrl: tunnelApiUrl() ?? context.config.publicUrl,
        viewUrl: (slug) => productViewUrl(app, context, slug),
      },
      deployment,
      project,
      signal,
    );
  });

  // §55 — cảnh báo ngân sách và phiếu duyệt đẩy thẳng ra Telegram. Không có nó
  // thì event vẫn phát nhưng chỉ nằm trong log, và người dùng không ngồi trước
  // dashboard cả ngày để nhìn thấy.
  const stopNotifier = registerNotifier(context.events, context, (message) =>
    app.log.info({ msg: message }),
  );
  app.addHook('onClose', async () => stopNotifier());

  // Phiếu chi phí / phát hành còn treo thì nhắc CEO mỗi giờ.
  const stopReminders = startApprovalReminders(context, (message) => app.log.info({ msg: message }));
  app.addHook('onClose', async () => stopReminders());

  // §106 — "Mặc định Knowledge Department chạy: DAILY". Mặc định tắt vì mỗi vòng
  // tốn tiền model; bật bằng KNOWLEDGE_DISCOVERY=daily.
  if (context.config.knowledgeDiscovery.enabled) {
    const stopDiscovery = startDailyDiscovery(
      context,
      {
        hour: context.config.knowledgeDiscovery.hour,
        wantedTopics: context.config.knowledgeDiscovery.topics,
        sendDigest: context.config.knowledgeDiscovery.sendDigest,
      },
      (message) => app.log.info({ msg: `[knowledge] ${message}` }),
    );
    app.addHook('onClose', async () => stopDiscovery());
  }

  // Bản tin sáng: mỗi ngày một lần, nói model còn chạy không, từ ngoài vào được
  // không, tiền, dự án, việc CEO cần làm. Tắt bằng PN_DAILY_BRIEF=off.
  if (context.config.dailyBrief.enabled) {
    const stopBrief = startDailyBrief(context, (message) => app.log.info({ msg: `[brief] ${message}` }));
    app.addHook('onClose', async () => stopBrief());
  }

  return app;
}

/** Chuẩn bị dữ liệu nền trước khi phục vụ request đầu tiên. */
export async function prepare(context: AppContext): Promise<void> {
  await seedAgents(context.repos);
  await seedDefaultBudget(
    context.repos,
    context.config.defaultProjectBudgetUsd,
    context.config.budgetWarnThreshold,
    context.config.budgetHardStop,
  );
  // Sau khi khởi động lại, không agent nào còn đang thật sự chạy — đưa hết về idle
  // để nhân vật 3D không đứng "working" vĩnh viễn (§9).
  await context.agentState.resetAll();
}
