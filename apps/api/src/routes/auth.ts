/**
 * P&N — Đăng nhập, phiên làm việc và tài khoản (§20, §73).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { capabilitiesOf, effectiveAccess, isHumanRole } from '@pn/permissions';
import { loginSchema, branding } from '@pn/shared';

import type { AppContext } from '../context.js';
import { hashPassword, sessionFor, verifyPassword } from '../plugins/auth.js';
import { consumeLoginCode } from '../services/login-codes.js';
import {
  linkAllowlistedChat,
  telegramAllowedChatIds,
  telegramBotToken,
  telegramLinkUrl,
} from '../services/telegram-identity.js';
import { verifyInitData } from '../services/telegram-webapp.js';
import { hashInvite } from './users.js';

const bootstrapSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  displayName: z.string().min(1).max(120),
  telegramChatId: z.string().max(64).nullish(),
});

const newPassword = z.string().min(8, 'Mật khẩu cần ít nhất 8 ký tự').max(200);
const INVITE_GONE = { error: 'Link mời đã hết hạn hoặc đã dùng. Nhờ CEO tạo link mới ở Cài đặt → Tài khoản & quyền.' };

export async function authRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  /**
   * §73 — lần chạy đầu tiên chưa có tài khoản nào. Endpoint này cho phép tạo
   * tài khoản CEO đầu tiên, và tự khoá lại ngay khi đã có người dùng.
   */
  app.post('/auth/bootstrap', async (request, reply) => {
    if ((await context.repos.users.count()) > 0) {
      return reply.code(409).send({
        error: 'Hệ thống đã có tài khoản. Dùng /auth/login để đăng nhập.',
      });
    }

    const input = bootstrapSchema.parse(request.body);
    const user = await context.repos.users.create({
      email: input.email,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName,
      role: 'CEO',
      telegramChatId: input.telegramChatId ?? null,
    });

    await context.repos.audit.record({
      actor: `user:${user.id}`,
      action: 'BOOTSTRAP_CEO',
      targetType: 'users',
      targetId: user.id,
      environment: context.config.environment,
    });

    return reply.code(201).send({
      user,
      token: sessionFor(app, user),
      welcome: branding.welcomeHeadline,
    });
  });

  app.post('/auth/login', async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const user = await context.repos.users.findByEmailWithSecret(input.email);

    // Cùng một thông báo cho email sai và mật khẩu sai, để không lộ email nào tồn tại.
    const invalid = { error: 'Email hoặc mật khẩu không đúng' };
    if (!user || !user.isActive) return reply.code(401).send(invalid);
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      return reply.code(401).send(invalid);
    }

    await context.repos.users.touchLogin(user.id);

    const { passwordHash: _passwordHash, ...safeUser } = user;
    return reply.send({
      user: safeUser,
      token: sessionFor(app, user),
      company: branding.companyName,
      // Mật khẩu tạm: trang đăng nhập bắt đặt mật khẩu mới; API cũng chặn mọi việc khác tới lúc đó.
      mustChangePassword: user.mustChangePassword,
    });
  });

  /** Trang nhận lời mời hỏi tên và email để người được mời biết mình đang đặt mật khẩu cho tài khoản nào. */
  app.get('/auth/invite/:token', async (request, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(request.params);
    const user = await context.repos.users.findByInviteHash(hashInvite(token));
    if (!user || !user.isActive) return reply.code(404).send(INVITE_GONE);
    return reply.send({ displayName: user.displayName, email: user.email, role: user.role, expiresAt: user.inviteExpiresAt });
  });

  /** Nhận lời mời (hoặc link đặt lại mật khẩu): đặt mật khẩu, link hết hiệu lực, vào công ty luôn. */
  app.post('/auth/invite/accept', async (request, reply) => {
    const input = z.object({ token: z.string().min(20).max(100), password: newPassword }).parse(request.body);
    const found = await context.repos.users.findByInviteHash(hashInvite(input.token));
    if (!found || !found.isActive) return reply.code(404).send(INVITE_GONE);
    const user = await context.repos.users.setPassword(found.id, await hashPassword(input.password));
    await context.repos.users.touchLogin(found.id);
    app.forgetUser(found.id);
    await context.repos.audit.record({
      actor: `user:${found.id}`,
      action: 'INVITE_ACCEPTED',
      targetType: 'users',
      targetId: found.id,
      environment: context.config.environment,
    });
    return reply.send({ user, token: sessionFor(app, user!), company: branding.companyName });
  });

  /** Đổi mật khẩu (bắt buộc sau mật khẩu tạm). Cần mật khẩu hiện tại để máy bị bỏ quên không đổi được. */
  app.post('/auth/password', { preHandler: app.authenticate }, async (request, reply) => {
    const input = z.object({ currentPassword: z.string().min(1).max(200), password: newPassword }).parse(request.body);
    const user = await context.repos.users.findByEmailWithSecret(request.principal!.email);
    if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      return reply.code(400).send({ error: 'Mật khẩu hiện tại không đúng.' });
    }
    if (input.password === input.currentPassword) {
      return reply.code(400).send({ error: 'Mật khẩu mới phải khác mật khẩu cũ.' });
    }
    await context.repos.users.setPassword(user.id, await hashPassword(input.password));
    app.forgetUser(user.id);
    await context.repos.audit.record({
      actor: `user:${user.id}`,
      action: 'PASSWORD_CHANGED',
      targetType: 'users',
      targetId: user.id,
      environment: context.config.environment,
    });
    return reply.send({ ok: true });
  });

  /** Tự nối bot Telegram cho chính mình (sau khi nhận lời mời) — link 30 phút, bấm Start là xong. */
  app.post('/auth/telegram-link', { preHandler: app.authenticate }, async (request, reply) => {
    const link = await telegramLinkUrl(context, request.principal!.id);
    if (!link) return reply.code(409).send({ error: 'Công ty chưa nối bot Telegram.' });
    return reply.send(link);
  });

  /** Đổi mã một lần (từ link Telegram) lấy phiên; mã sai hay hết hạn đều một câu trả lời. */
  app.post('/auth/exchange', async (request, reply) => {
    const { code } = z.object({ code: z.string().min(10).max(200) }).parse(request.body);
    const userId = consumeLoginCode(code);
    const user = userId ? await context.repos.users.findById(userId) : null;
    if (!user || !user.isActive) {
      return reply
        .code(401)
        .send({ error: 'Link đăng nhập đã hết hạn hoặc đã dùng. Gõ /dashboard trong Telegram để lấy link mới.' });
    }
    await context.repos.users.touchLogin(user.id);
    return reply.send({
      user,
      token: sessionFor(app, user),
      company: branding.companyName,
    });
  });

  /**
   * §58 — mở dashboard từ nút "Mở P&N" trong bot. Telegram ký `initData` bằng bot
   * token; chữ ký đúng + chat nằm trong allowlist thì cấp phiên đúng vai trò đó.
   */
  app.post('/auth/telegram-webapp', async (request, reply) => {
    const { initData } = z.object({ initData: z.string().min(10).max(4096) }).parse(request.body);
    const refuse = { error: 'Không xác thực được phiên Telegram. Mở lại bằng nút trong bot.' };

    const botToken = await telegramBotToken(context);
    if (!botToken) return reply.code(401).send(refuse);

    const check = verifyInitData(initData, botToken);
    if (!check.ok) {
      // Ghi lý do (không ghi chuỗi gốc): từng có lúc nút mở được nhưng bị từ chối, không
      // có lý do thì chỉ còn cách đoán.
      app.log.warn({ msg: '[telegram-webapp] từ chối', reason: check.reason, ...check.detail });
      return reply.code(401).send(refuse);
    }

    const allowed = await telegramAllowedChatIds(context);
    if (!allowed.includes(check.identity.telegramUserId)) {
      app.log.warn({ msg: '[telegram-webapp] từ chối', reason: 'chat ngoài allowlist', chatId: check.identity.telegramUserId, allowed });
      return reply.code(403).send(refuse);
    }

    const user =
      (await context.repos.users.findByTelegramChatId(check.identity.telegramUserId)) ??
      (await linkAllowlistedChat(context, check.identity.telegramUserId));
    if (!user || !user.isActive) {
      app.log.warn({ msg: '[telegram-webapp] từ chối', reason: 'chat chưa gắn tài khoản', chatId: check.identity.telegramUserId });
      return reply.code(403).send(refuse);
    }

    app.log.info({ msg: '[telegram-webapp] đăng nhập', variant: check.variant });
    await context.repos.users.touchLogin(user.id);
    await context.repos.audit.record({
      actor: `telegram:${check.identity.telegramUserId}`,
      action: 'TELEGRAM_WEBAPP_LOGIN',
      targetType: 'users',
      targetId: user.id,
      environment: context.config.environment,
    });

    return reply.send({
      user,
      token: sessionFor(app, user),
      company: branding.companyName,
    });
  });

  /** Người đang đăng nhập + mức theo khu + quyền kỹ thuật, để giao diện ẩn nút không bấm được (quyền thật vẫn do API). */
  app.get('/auth/me', { preHandler: app.authenticate }, async (request, reply) => {
    const user = await context.repos.users.findById(request.principal!.id);
    if (!user) return reply.code(404).send({ error: 'Không tìm thấy người dùng' });
    return reply.send({
      user,
      access: isHumanRole(user.role) ? effectiveAccess(user.role, user.access) : null,
      capabilities: [...capabilitiesOf(request.principal!)],
    });
  });
}
