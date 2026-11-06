/**
 * P&N — Cửa nội bộ cho các tiến trình cùng hệ thống (Telegram bot, worker).
 *
 * Vì sao cần cửa riêng: tiến trình bot KHÔNG giữ `PN_MASTER_KEY`, nên nó không
 * tự giải mã được token Telegram. Nó xin API — nơi duy nhất có khoá chính —
 * bằng một secret dịch vụ dùng chung. Nhờ vậy khoá chính chỉ nằm ở một tiến
 * trình, đúng tinh thần §19 và §69.
 *
 * §58: bot không tự quyết quyền. Nó đổi `telegram_user_id` lấy một phiên đúng
 * vai trò của người đó; mọi hành động sau đó vẫn đi qua RBAC như dashboard.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { safeCompare, secretRef } from '@pn/secrets';

import type { AppContext } from '../context.js';
import { sessionFor, signSession } from '../plugins/auth.js';
import { createLoginCode } from '../services/login-codes.js';
import {
  consumeTelegramLinkCode,
  linkAllowlistedChat,
  telegramAllowedChatIds,
  telegramBotToken,
} from '../services/telegram-identity.js';
import { tunnelApiUrl, tunnelWebOrigin } from '../services/tunnel.js';

/**
 * Định danh cố định cho tiến trình dịch vụ. Không trỏ tới hàng nào trong bảng
 * `users` — dịch vụ không phải người, và nhật ký ghi nó dưới dạng `service:*`.
 */
const SERVICE_PRINCIPAL_ID = '00000000-0000-4000-8000-000000000001';

export async function internalRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const serviceSecret = process.env['PN_SERVICE_SECRET'] ?? '';

  /** So sánh secret theo thời gian hằng số; chưa cấu hình thì khoá toàn bộ cửa. */
  const authorised = (header: string | undefined): boolean =>
    serviceSecret.length > 0 && typeof header === 'string' && safeCompare(header, serviceSecret);

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/internal/')) return;
    if (!authorised(request.headers['x-pn-service-secret'] as string | undefined)) {
      await reply.code(403).send({ error: 'Sai secret dịch vụ hoặc chưa cấu hình PN_SERVICE_SECRET' });
    }
  });

  /**
   * Bot lấy token và allowlist lúc khởi động. Trả về token thật nên đây là ngoại
   * lệ duy nhất của quy tắc "không trả secret" — người nhận là tiến trình cùng
   * hệ thống, đã xác thực, và lần lấy được ghi audit (§71).
   */
  app.post('/internal/telegram/bootstrap', async (request, reply) => {
    const env = context.config.environment;
    const integration = await context.repos.integrations.find('TELEGRAM', env);

    if (!integration || !integration.isEnabled) {
      return reply.code(404).send({ error: 'Chưa cấu hình tích hợp Telegram trong API Center' });
    }

    const botToken = await telegramBotToken(context);
    if (!botToken) {
      return reply.code(404).send({ error: 'Chưa lưu bot token trong API Center' });
    }

    await context.repos.audit.record({
      actor: 'system',
      action: 'TELEGRAM_BOOTSTRAP',
      targetType: 'integrations',
      targetId: 'TELEGRAM',
      metadata: { ip: request.ip },
      environment: env,
    });

    return reply.send({
      botToken,
      // Danh sách tay + chat của mọi người đã tự nối bot; bot hỏi lại mỗi 2 phút nên khoá ai là người đó rơi ra.
      allowedChatIds: await telegramAllowedChatIds(context),
      apiPublicUrl: tunnelApiUrl() ?? context.config.publicUrl,
      webPublicUrl: tunnelWebOrigin() ?? context.config.webLinkOrigin,
      company: 'P&N',
    });
  });

  /**
   * §23, §89 — phiên cho tiến trình worker.
   *
   * Worker chạy agent nên nó cần gọi `/ai/generate`, mà endpoint đó đòi một
   * phiên đã xác thực.
   *
   * Phiên cấp ở đây mang vai trò `AGENT`, không phải `SYSTEM`. `SYSTEM` có toàn
   * quyền — kể cả `approval:decide` — và một token như thế nằm trong tiến trình
   * worker là đúng thứ §20 và §83 cấm. Worker chỉ cần được xác thực để gọi
   * gateway; mọi thao tác dữ liệu khác nó làm thẳng qua database.
   *
   * Cửa này đã nằm sau `PN_SERVICE_SECRET` như mọi endpoint `/internal/*`.
   */
  app.post('/internal/service/session', async (request, reply) => {
    const { name } = z
      .object({ name: z.string().min(1).max(64).default('worker') })
      .parse(request.body ?? {});

    await context.repos.audit.record({
      actor: `service:${name}`,
      action: 'SERVICE_SESSION_ISSUED',
      targetType: 'services',
      targetId: name,
      metadata: { ip: request.ip },
      environment: context.config.environment,
    });

    return reply.send({
      token: signSession(app, {
        sub: SERVICE_PRINCIPAL_ID,
        email: `${name}@service.pn.local`,
        role: 'AGENT',
      }),
    });
  });

  /**
   * §17, §23 — worker cần token GitHub để commit, nhưng không giữ master key.
   *
   * Cùng ngoại lệ có kiểm soát như `/internal/telegram/bootstrap`: người nhận là
   * tiến trình cùng hệ thống, đã xác thực bằng service secret, và lần lấy được
   * ghi audit (§71).
   */
  app.post('/internal/github/config', async (request, reply) => {
    const env = context.config.environment;
    const integration = await context.repos.integrations.find('GITHUB', env);
    if (!integration || !integration.isEnabled) {
      return reply.code(404).send({ error: 'Chưa cấu hình tích hợp GitHub trong API Center' });
    }

    const token = await context.secrets
      .reveal(secretRef.integration('GITHUB', 'token', env))
      .catch(() => null);
    if (!token) return reply.code(404).send({ error: 'Chưa lưu GitHub token trong API Center' });

    await context.repos.audit.record({
      actor: 'service:worker',
      action: 'GITHUB_CONFIG_FETCHED',
      targetType: 'integrations',
      targetId: 'GITHUB',
      metadata: { ip: request.ip },
      environment: env,
    });

    const settings = integration.settings as {
      defaultOrg?: string | null;
      protectedBranches?: string[];
    };

    return reply.send({
      token,
      defaultOrg: settings.defaultOrg ?? null,
      protectedBranches: settings.protectedBranches ?? [],
    });
  });

  /**
   * §58 — đổi một `telegram_user_id` lấy phiên của đúng người dùng đó.
   * Không có trong allowlist thì không có phiên, không có quyền gì.
   */
  app.post('/internal/telegram/session', async (request, reply) => {
    const { telegramChatId } = z
      .object({ telegramChatId: z.string().min(1).max(64) })
      .parse(request.body);

    const user =
      (await context.repos.users.findByTelegramChatId(telegramChatId)) ??
      (await linkAllowlistedChat(context, telegramChatId));
    if (!user || !user.isActive) {
      await context.repos.audit.record({
        actor: `telegram:${telegramChatId}`,
        action: 'TELEGRAM_ACCESS_DENIED',
        targetType: 'users',
        targetId: telegramChatId,
        environment: context.config.environment,
      });
      return reply.code(403).send({
        error:
          `Chat ${telegramChatId} chưa gắn với tài khoản nào trong P&N. Vào Cài đặt → Tích hợp → ` +
          'Telegram trên dashboard, thêm Chat ID này vào danh sách rồi bấm Lưu.',
      });
    }

    return reply.send({
      token: sessionFor(app, user),
      user: { id: user.id, displayName: user.displayName, role: user.role },
    });
  });

  /**
   * Người được mời bấm link t.me/...?start=link_<mã>: bot chuyển mã + chat id vào đây. Mã đúng thì chat này gắn với
   * đúng người đó — từ đây bot trả lời họ theo quyền của họ, không phải quyền CEO.
   */
  app.post('/internal/telegram/link', async (request, reply) => {
    const { code, telegramChatId } = z
      .object({ code: z.string().min(10).max(64), telegramChatId: z.string().min(1).max(64) })
      .parse(request.body);
    const userId = consumeTelegramLinkCode(code);
    const found = userId ? await context.repos.users.findById(userId) : null;
    if (!found || !found.isActive) {
      return reply.code(404).send({ error: 'Link nối bot đã hết hạn hoặc đã dùng. Nhờ CEO tạo link mới.' });
    }
    const user = await context.repos.users.linkTelegramChat(found.id, telegramChatId);
    await context.repos.audit.record({
      actor: `telegram:${telegramChatId}`,
      action: 'TELEGRAM_LINKED',
      targetType: 'users',
      targetId: user.id,
      environment: context.config.environment,
    });
    return reply.send({ user: { id: user.id, displayName: user.displayName, role: user.role } });
  });

  /**
   * Link "Mở dashboard" cho điện thoại: mã một lần, sống 2 phút, đổi thành phiên
   * ở /auth/exchange. Chat phải nằm trong allowlist như mọi lệnh khác.
   */
  app.post('/internal/telegram/login-link', async (request, reply) => {
    const { telegramChatId } = z
      .object({ telegramChatId: z.string().min(1).max(64) })
      .parse(request.body);
    const user =
      (await context.repos.users.findByTelegramChatId(telegramChatId)) ??
      (await linkAllowlistedChat(context, telegramChatId));
    if (!user || !user.isActive) {
      return reply.code(403).send({ error: `Chat ${telegramChatId} chưa gắn với tài khoản nào trong P&N.` });
    }
    const { code, expiresInSeconds } = createLoginCode(user.id);
    await context.repos.audit.record({
      actor: `telegram:${telegramChatId}`,
      action: 'LOGIN_LINK_ISSUED',
      targetType: 'users',
      targetId: user.id,
      environment: context.config.environment,
    });
    const origin = tunnelWebOrigin() ?? context.config.webLinkOrigin;
    return reply.send({ url: `${origin}/login?code=${code}`, expiresInSeconds });
  });
}
