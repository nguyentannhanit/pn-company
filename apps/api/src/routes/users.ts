/**
 * P&N — Tài khoản & phân quyền.
 *
 * CEO mời người vào công ty bằng link dùng một lần (hoặc mật khẩu tạm), gán một trong năm vai trò rồi chỉnh riêng
 * từng khu. Chỉ người có `users:manage` (thực tế: CEO) mới đổi được gì ở đây. Mọi thay đổi ghi nhật ký kèm "từ gì
 * sang gì" — vai trò và mức quyền không phải bí mật, còn mật khẩu và mã mời thì không bao giờ ghi.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { NO_PASSWORD } from '@pn/database';
import { AREA_LEVELS, ROLE_ACCESS, effectiveAccess, isHumanRole } from '@pn/permissions';
import { ACCESS_AREAS, HUMAN_ROLES, type AccessMap, type HumanRole, type User } from '@pn/shared';

import type { AppContext } from '../context.js';
import { hashPassword } from '../plugins/auth.js';
import { tunnelWebOrigin } from '../services/tunnel.js';
import { telegramLinkUrl } from '../services/telegram-identity.js';

/** Link mời sống 48 giờ. */
const INVITE_TTL_MS = 48 * 60 * 60_000;

const levelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const accessSchema = z.record(z.enum(ACCESS_AREAS), levelSchema).nullish();

const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(HUMAN_ROLES),
  access: accessSchema,
  // Gửi email cần nối SMTP — chưa có, nên chỉ nhận hai cách này.
  way: z.enum(['link', 'password']),
});

const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  role: z.enum(HUMAN_ROLES).optional(),
  access: accessSchema,
});

const idParam = z.object({ id: z.string().uuid() });

/** Mã mời gốc (đưa cho CEO một lần) và bản băm (lưu database). */
export const hashInvite = (token: string): string => createHash('sha256').update(token).digest('hex');
function newInvite(): { token: string; hash: string; expiresAt: Date } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashInvite(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
}

/** Mật khẩu tạm dễ đọc qua điện thoại: bỏ các ký tự dễ nhầm (0/O, 1/l/I). */
function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) out += alphabet[randomInt(alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

/** Chỉ giữ các khu khác vai trò (đã hạ về nấc hợp lệ); không khác gì thì null = "theo đúng vai trò". */
function normalizeAccess(role: HumanRole, wanted: Partial<AccessMap> | null | undefined): Partial<AccessMap> | null {
  if (!wanted || role === 'CEO') return null;
  const effective = effectiveAccess(role, wanted);
  const diff: Partial<AccessMap> = {};
  for (const area of ACCESS_AREAS) if (effective[area] !== ROLE_ACCESS[role][area]) diff[area] = effective[area];
  return Object.keys(diff).length > 0 ? diff : null;
}

/** Tình trạng hiện trên thẻ: khoá / chờ nhận lời mời (chưa từng vào) / đang dùng. */
function statusOf(user: User): 'locked' | 'invited' | 'active' {
  if (!user.isActive) return 'locked';
  if (user.inviteExpiresAt && !user.lastLoginAt) return 'invited';
  return 'active';
}

/** Hình dạng gửi về trình duyệt: không có mã mời, không có chat id — chỉ "đã nối" hay chưa. */
function view(user: User): Record<string, unknown> {
  const role = isHumanRole(user.role) ? user.role : 'VIEWER';
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: statusOf(user),
    access: effectiveAccess(role, user.access),
    customized: normalizeAccess(role, user.access) !== null,
    telegramLinked: Boolean(user.telegramChatId),
    mustChangePassword: user.mustChangePassword,
    inviteExpiresAt: user.inviteExpiresAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export async function userRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const env = context.config.environment;
  const read = { preHandler: [app.authenticate, app.requireCapability('users:read')] };
  const manage = { preHandler: [app.authenticate, app.requireCapability('users:manage')] };
  const inviteUrl = (token: string): string => `${tunnelWebOrigin() ?? context.config.webLinkOrigin}/login?invite=${token}`;

  const record = (request: FastifyRequest, action: string, targetId: string, metadata?: Record<string, unknown>): Promise<unknown> =>
    context.repos.audit.record({
      actor: `user:${request.principal!.id}`,
      action,
      targetType: 'users',
      targetId,
      ...(metadata ? { metadata } : {}),
      environment: env,
    });

  /** Người đích; trả lời 404 thay cho handler nếu không có. */
  const target = async (request: FastifyRequest, reply: FastifyReply): Promise<User | null> => {
    const { id } = idParam.parse(request.params);
    const user = await context.repos.users.findById(id);
    if (!user || !isHumanRole(user.role)) {
      await reply.code(404).send({ error: 'Không tìm thấy tài khoản này.' });
      return null;
    }
    return user;
  };

  /** Công ty luôn còn ít nhất một CEO đang dùng: chặn khoá, xoá, hạ quyền CEO cuối cùng. */
  const lastCeo = async (user: User): Promise<boolean> => {
    if (user.role !== 'CEO' || !user.isActive) return false;
    const others = (await context.repos.users.list()).filter((u) => u.role === 'CEO' && u.isActive && u.id !== user.id);
    return others.length === 0;
  };
  const LAST_CEO = { error: 'Đây là CEO cuối cùng của công ty — thêm một CEO khác trước rồi mới làm được việc này.' };
  const SELF = { error: 'Không tự khoá hay tự xoá tài khoản đang dùng. Nhờ một CEO khác làm.' };

  app.get('/users', read, async (_request, reply) => {
    const users = (await context.repos.users.list()).filter((user) => isHumanRole(user.role));
    return reply.send({ users: users.map(view) });
  });

  app.post('/users', manage, async (request, reply) => {
    const input = createSchema.parse(request.body);
    if (await context.repos.users.findByEmailWithSecret(input.email)) {
      return reply.code(409).send({ error: `Email ${input.email} đã có tài khoản.` });
    }
    const invite = input.way === 'link' ? newInvite() : null;
    const password = input.way === 'password' ? tempPassword() : null;
    const user = await context.repos.users.createInvited({
      email: input.email,
      displayName: input.displayName,
      role: input.role,
      access: normalizeAccess(input.role, input.access),
      passwordHash: password ? await hashPassword(password) : NO_PASSWORD,
      mustChangePassword: Boolean(password),
      inviteTokenHash: invite?.hash ?? null,
      inviteExpiresAt: invite?.expiresAt ?? null,
      createdBy: request.principal!.id,
    });
    await record(request, 'USER_CREATED', user.id, { role: user.role, access: user.access, way: input.way });
    return reply.code(201).send({
      user: view(user),
      ...(invite ? { inviteUrl: inviteUrl(invite.token) } : {}),
      // Mật khẩu tạm chỉ đi qua đúng một câu trả lời này; database giữ bản băm.
      ...(password ? { tempPassword: password } : {}),
    });
  });

  app.patch('/users/:id', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    const input = updateSchema.parse(request.body);
    const role = input.role ?? (user.role as HumanRole);
    if (role !== 'CEO' && (await lastCeo(user))) return reply.code(409).send(LAST_CEO);
    // Đổi vai trò mà không gửi quyền riêng: bỏ phần chỉnh riêng cũ, theo đúng vai trò mới.
    const access = input.access !== undefined ? normalizeAccess(role, input.access) : input.role ? null : undefined;
    const updated = await context.repos.users.updateProfile(user.id, {
      ...(input.role ? { role: input.role } : {}),
      ...(access !== undefined ? { access } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });
    app.forgetUser(user.id);
    await record(request, 'USER_UPDATED', user.id, {
      from: { role: user.role, access: user.access },
      to: { role: updated!.role, access: updated!.access },
    });
    return reply.send({ user: view(updated!) });
  });

  app.post('/users/:id/lock', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    if (user.id === request.principal!.id) return reply.code(409).send(SELF);
    if (await lastCeo(user)) return reply.code(409).send(LAST_CEO);
    const updated = await context.repos.users.setActive(user.id, false);
    app.forgetUser(user.id);
    await record(request, 'USER_LOCKED', user.id);
    return reply.send({ user: view(updated!) });
  });

  app.post('/users/:id/unlock', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    const updated = await context.repos.users.setActive(user.id, true);
    app.forgetUser(user.id);
    await record(request, 'USER_UNLOCKED', user.id);
    return reply.send({ user: view(updated!) });
  });

  app.post('/users/:id/logout-all', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    await context.repos.users.revokeSessions(user.id);
    app.forgetUser(user.id);
    await record(request, 'USER_SESSIONS_REVOKED', user.id);
    return reply.send({ ok: true });
  });

  /** Link mới: mời lại (chưa nhận) hoặc đặt lại mật khẩu (mật khẩu cũ vẫn dùng tới khi đặt mật khẩu mới). */
  app.post('/users/:id/invite', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    const invite = newInvite();
    await context.repos.users.setInvite(user.id, invite.hash, invite.expiresAt);
    app.forgetUser(user.id);
    await record(request, statusOf(user) === 'invited' ? 'USER_REINVITED' : 'USER_PASSWORD_RESET_LINK', user.id);
    return reply.send({ inviteUrl: inviteUrl(invite.token), expiresAt: invite.expiresAt.toISOString() });
  });

  app.delete('/users/:id', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    if (user.id === request.principal!.id) return reply.code(409).send(SELF);
    if (await lastCeo(user)) return reply.code(409).send(LAST_CEO);
    // Dự án người này tạo chuyển sang người đang xoá — dự án không được mồ côi người phụ trách.
    await context.repos.users.remove(user.id, request.principal!.id);
    app.forgetUser(user.id);
    await record(request, 'USER_DELETED', user.id, { email: user.email, role: user.role });
    return reply.send({ ok: true });
  });

  /** Link mở bot Telegram có sẵn mã nối cho người này (30 phút, dùng một lần). */
  app.post('/users/:id/telegram-link', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    const link = await telegramLinkUrl(context, user.id);
    if (!link) return reply.code(409).send({ error: 'Chưa nối bot Telegram cho công ty (Cài đặt → Tích hợp → Telegram).' });
    await record(request, 'TELEGRAM_LINK_ISSUED', user.id);
    return reply.send(link);
  });

  app.delete('/users/:id/telegram', manage, async (request, reply) => {
    const user = await target(request, reply);
    if (!user) return reply;
    await context.repos.users.unlinkTelegram(user.id);
    await record(request, 'TELEGRAM_UNLINKED', user.id);
    return reply.send({ user: view({ ...user, telegramChatId: null }) });
  });

  /** Nấc dùng được của từng khu và mức mặc định của năm vai trò — trang Tài khoản dựng bảng từ đây, không tự chép. */
  app.get('/users/roles', read, async (_request, reply) => {
    return reply.send({ areas: ACCESS_AREAS, levels: AREA_LEVELS, roles: ROLE_ACCESS });
  });
}
