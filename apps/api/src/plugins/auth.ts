/**
 * P&N — Xác thực và phân quyền (§20, §83).
 *
 * Mật khẩu băm bằng scrypt của Node — không thêm phụ thuộc, và scrypt là hàm
 * chống brute-force được thiết kế cho đúng việc này. Phiên đăng nhập dùng JWT
 * ký bằng `JWT_SECRET`.
 *
 * Mọi route (trừ danh sách công khai) đều phải qua `authenticate`, và route nào
 * đụng tới hành động nhạy cảm thì thêm `requireCapability` (§20).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { assertCan, effectiveAccess, isHumanRole, type Capability, type Principal } from '@pn/permissions';
import type { RbacRole, User, Uuid } from '@pn/shared';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEY_LENGTH = 64;

/** Nội dung token phiên. Cố tình gọn — mọi thứ khác tra lại từ database. */
export interface SessionPayload {
  sub: Uuid;
  email: string;
  role: RbacRole;
  /** Số phiên của người dùng lúc cấp token; lệch với database là token đã bị thu hồi (khoá, đăng xuất mọi thiết bị). */
  ver?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Người gọi đã xác thực; `undefined` trên route công khai. */
    principal?: Principal & { id: Uuid; email: string };
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireCapability: (
      capability: Capability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Quên bản đệm của một người ngay (vừa đổi quyền, khoá, xoá) thay vì đợi hết 5 giây. */
    forgetUser: (id: Uuid) => void;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: SessionPayload;
    user: SessionPayload;
  }
}

/* -------------------------------------------------------------------------- */
/* Băm mật khẩu                                                                */
/* -------------------------------------------------------------------------- */

/** Trả về chuỗi `scrypt$<salt-base64>$<hash-base64>` để lưu vào database. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_LENGTH);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** So khớp mật khẩu bằng phép so sánh thời gian hằng số. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, salt, expected.length);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                      */
/* -------------------------------------------------------------------------- */

export interface AuthPluginOptions {
  jwtSecret: string;
  sessionTtlHours: number;
  /** Tra người dùng theo id cho mỗi yêu cầu (có đệm) — để khoá, đổi quyền, đăng xuất mọi thiết bị có hiệu lực ngay. */
  loadUser: (id: Uuid) => Promise<User | null>;
}

/** Đệm tra người dùng: một trang mở ra gọi chục API cùng lúc, không cần chục lần hỏi database. */
const USER_CACHE_MS = 5_000;

/** Đường còn mở cho người đang dùng mật khẩu tạm. */
const MUST_CHANGE_ALLOWED = new Set(['/auth/me', '/auth/password']);

export const authPlugin = fp<AuthPluginOptions>(async (app: FastifyInstance, options) => {
  await app.register(fastifyJwt, {
    secret: options.jwtSecret,
    sign: { expiresIn: `${options.sessionTtlHours}h` },
  });

  const cache = new Map<Uuid, { at: number; user: User | null }>();
  const lookup = async (id: Uuid): Promise<User | null> => {
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < USER_CACHE_MS) return hit.user;
    const user = await options.loadUser(id);
    cache.set(id, { at: Date.now(), user });
    return user;
  };
  app.decorate('forgetUser', (id: Uuid) => void cache.delete(id));

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    // Không tiết lộ lý do cụ thể để không giúp kẻ dò tìm.
    const refuse = async (): Promise<void> => {
      await reply.code(401).send({ error: 'Chưa đăng nhập hoặc phiên đã hết hạn' });
    };
    let payload: SessionPayload;
    try {
      payload = await request.jwtVerify<SessionPayload>();
    } catch {
      await refuse();
      return;
    }
    // Tiến trình (worker, dịch vụ) không phải người: không có hàng trong bảng users, giữ đúng vai trò trong token.
    if (!isHumanRole(payload.role)) {
      request.principal = { id: payload.sub, email: payload.email, role: payload.role };
      return;
    }
    // Người: vai trò và quyền lấy từ database, không tin token — đổi quyền có hiệu lực ngay, token cũ không nâng quyền được.
    const user = await lookup(payload.sub);
    if (!user || !user.isActive || (payload.ver ?? 0) !== (user.sessionVersion ?? 0) || !isHumanRole(user.role)) {
      await refuse();
      return;
    }
    // Còn mật khẩu tạm: chỉ được xem mình là ai và đặt mật khẩu mới — mật khẩu tạm đã đi qua tin nhắn, coi như lộ.
    if (user.mustChangePassword && !MUST_CHANGE_ALLOWED.has(request.routeOptions.url ?? '')) {
      await reply.code(403).send({ error: 'Đặt mật khẩu mới trước khi dùng công ty.' });
      return;
    }
    request.principal = { id: user.id, email: user.email, role: user.role, access: effectiveAccess(user.role, user.access) };
  });

  app.decorate(
    'requireCapability',
    (capability: Capability) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.principal) {
        await reply.code(401).send({ error: 'Chưa đăng nhập' });
        return;
      }
      try {
        assertCan(request.principal, capability);
      } catch (error) {
        await reply.code(403).send({
          error: error instanceof Error ? error.message : 'Không đủ quyền',
          capability,
        });
      }
    },
  );
});

/** Ký token phiên cho một người dùng vừa đăng nhập. */
export function signSession(app: FastifyInstance, payload: SessionPayload): string {
  return app.jwt.sign(payload);
}

/** Token phiên cho đúng một người (kèm số phiên hiện tại). */
export function sessionFor(app: FastifyInstance, user: Pick<User, 'id' | 'email' | 'role' | 'sessionVersion'>): string {
  return signSession(app, { sub: user.id, email: user.email, role: user.role, ver: user.sessionVersion ?? 0 });
}
