/**
 * P&N — Xử lý lỗi và chống rò secret ở tầng HTTP (§19, §89).
 *
 * Hai việc file này bảo đảm:
 *   1. mọi response lỗi đều đi qua redaction, nên không có credential nào lọt ra
 *      ngoài kể cả khi provider trả lỗi có chứa key;
 *   2. mọi log của Fastify cũng đi qua redaction (§81, §82).
 */

import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';

import { ProtectedBranchError } from '@pn/github';
import { LlmError, NoRouteError, ProviderNotConfiguredError } from '@pn/llm';
import { PermissionDeniedError } from '@pn/permissions';
import { SecretDecryptionError } from '@pn/secrets';
import { redactDeep, redactText } from '@pn/shared';

import { BudgetExceededError } from '../services/ai-gateway.js';
import { InvalidStateTransitionError } from '@pn/orchestrator';

/** Ánh xạ lỗi nghiệp vụ sang mã HTTP đúng ngữ nghĩa. */
function statusFor(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (error instanceof PermissionDeniedError) return 403;
  if (error instanceof BudgetExceededError) return 402; // Payment Required — hết ngân sách
  if (error instanceof ProtectedBranchError) return 409;
  if (error instanceof InvalidStateTransitionError) return 409;
  if (error instanceof ProviderNotConfiguredError) return 503;
  if (error instanceof NoRouteError) return 503;
  if (error instanceof SecretDecryptionError) return 500;
  if (error instanceof LlmError) {
    if (error.kind === 'auth') return 502;
    if (error.kind === 'rate_limit') return 429;
    if (error.kind === 'invalid_request') return 400;
    return 502;
  }
  return 500;
}

/**
 * Danh sách tường minh các route được phép trả credential cho chính chủ.
 * Hai cửa `/internal/*` cấp token cho tiến trình cùng hệ thống đã xác thực bằng
 * service secret (§69): không miễn trừ thì bot nhận về chuỗi "[REDACTED]" thay
 * cho bot token và chết ngay ở getMe — đã xảy ra, còn Test Connection vẫn xanh
 * vì nó gọi Telegram từ trong API.
 */
const TOKEN_ISSUING_ROUTES = new Set([
  '/auth/login',
  '/auth/bootstrap',
  // Đổi mã một lần (link từ Telegram) lấy phiên — cũng phải trả token thật.
  '/auth/exchange',
  '/auth/telegram-webapp',
  '/internal/telegram/bootstrap',
  '/internal/telegram/session',
  '/internal/service/session',
  '/internal/github/config',
  // Vé xem sản phẩm cũng là JWT; bị che thì nút "Mở sản phẩm" dẫn tới trang 403.
  '/projects/:id/product-link',
  // Tài khoản & quyền: link mời, mật khẩu tạm, link nối bot — chỉ trả cho CEO một lần, bị che là vô dụng.
  '/auth/invite/accept',
  '/auth/telegram-link',
  '/users',
  '/users/:id/invite',
  '/users/:id/telegram-link',
]);

export const errorsPlugin = fp(async (app: FastifyInstance) => {
  /**
   * §88.17, §89 — lớp phòng thủ cuối: mọi response JSON đều được quét trước khi
   * rời máy chủ. Route có thể vô tình chuyển tiếp thông báo lỗi của provider có
   * chứa API key; hook này chặn đúng trường hợp đó, không phụ thuộc việc từng
   * route tự nhớ redact.
   */
  app.addHook('onSend', async (request, reply, payload) => {
    if (typeof payload !== 'string') return payload;
    // Hai endpoint này cố ý trả token phiên cho chính chủ nhân của nó; token là
    // JWT nên trông giống credential và sẽ bị quét nhầm nếu không miễn trừ.
    if (TOKEN_ISSUING_ROUTES.has(request.routeOptions?.url ?? '')) return payload;
    const contentType = reply.getHeader('content-type');
    if (typeof contentType !== 'string' || !contentType.includes('application/json')) return payload;

    const safe = redactText(payload);
    if (safe !== payload) reply.header('content-length', Buffer.byteLength(safe));
    return safe;
  });

  app.setErrorHandler(async (error: Error, request, reply) => {
    const status = statusFor(error);

    // Log đầy đủ ở phía server nhưng đã redact, để điều tra được mà không rò key.
    if (status >= 500) {
      request.log.error({ err: redactDeep(error), url: request.url }, 'request failed');
    } else {
      request.log.warn({ err: redactText(error.message), url: request.url }, 'request rejected');
    }

    if (error instanceof ZodError) {
      await reply.code(400).send({
        error: 'Dữ liệu gửi lên không hợp lệ',
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    const message =
      status >= 500 && !(error instanceof LlmError)
        ? 'Lỗi hệ thống. Xem log máy chủ để biết chi tiết.'
        : redactText(error.message);

    await reply.code(status).send({ error: message });
  });

  app.setNotFoundHandler(async (request, reply) => {
    await reply.code(404).send({ error: `Không có endpoint ${request.method} ${request.url}` });
  });
});
