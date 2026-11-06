/**
 * P&N — Ghi nhật ký kiểm toán tự động (§28, §71).
 *
 * §71 yêu cầu mọi thay đổi cấu hình API phải được audit. Thay vì trông chờ từng
 * route tự nhớ gọi, plugin này bắt mọi request làm thay đổi dữ liệu
 * (POST/PUT/PATCH/DELETE) và ghi lại một dòng.
 *
 * Body request KHÔNG được ghi nguyên vẹn — nó có thể chứa API key người dùng vừa
 * dán vào. Chỉ ghi danh sách tên field, đã lọc bỏ tên nhạy cảm (§89).
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

import type { Repositories } from '@pn/database';
import type { Environment } from '@pn/shared';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Route không cần audit vì gọi liên tục và không đổi dữ liệu nghiệp vụ. */
// Vbee gọi báo kết quả đọc giọng mỗi câu — không phải thao tác của người, ghi vào nhật ký chỉ thêm nhiễu.
const SKIP_PATHS = ['/health', '/ready', '/auth/login', '/voice/vbee-callback'];

export interface AuditPluginOptions {
  repos: Repositories;
  environment: Environment;
}

export const auditPlugin = fp<AuditPluginOptions>(async (app: FastifyInstance, options) => {
  app.addHook('onResponse', async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;
    if (SKIP_PATHS.some((path) => request.url.startsWith(path))) return;
    // Request bị từ chối ở tầng xác thực thì không phải "hành động", bỏ qua.
    if (reply.statusCode === 401) return;

    const actor = request.principal ? `user:${request.principal.id}` : 'anonymous';
    const target = describeTarget(request.url);

    await options.repos.audit
      .record({
        actor,
        action: `${request.method} ${routeTemplate(request)}`,
        targetType: target.type,
        targetId: target.id,
        metadata: {
          statusCode: reply.statusCode,
          // Chỉ tên field, không giá trị — tránh ghi key người dùng vừa nhập.
          fields: fieldNames(request.body),
        },
        ipAddress: request.ip,
        environment: options.environment,
      })
      .catch((error: unknown) => {
        // Audit hỏng không được làm hỏng request đã phục vụ xong.
        request.log.error({ err: error }, 'không ghi được audit log');
      });
  });
});

/** Lấy mẫu route (có `:id`) thay vì URL cụ thể, để log gom nhóm được. */
function routeTemplate(request: { routeOptions?: { url?: string }; url: string }): string {
  return request.routeOptions?.url ?? request.url.split('?')[0] ?? request.url;
}

/** Đoán loại và id đối tượng từ đường dẫn, ví dụ `/projects/<uuid>/tasks`. */
function describeTarget(url: string): { type: string; id: string | null } {
  const segments = url.split('?')[0]!.split('/').filter(Boolean);
  const type = segments[0] ?? 'unknown';
  const uuid = segments.find((segment) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment),
  );
  return { type, id: uuid ?? null };
}

/** Danh sách tên field, đã bỏ những tên nhạy cảm. */
function fieldNames(body: unknown): string[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const sensitive = /(pass|secret|token|key|credential)/i;
  return Object.keys(body as Record<string, unknown>).filter((key) => !sensitive.test(key));
}
