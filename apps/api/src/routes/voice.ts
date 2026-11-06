/**
 * P&N — Giọng đọc của văn phòng qua Vbee. Người đã đăng nhập nào cũng nghe được thông báo văn
 * phòng, nên chỉ cần phiên hợp lệ; tốn credit thì đã có trần ký tự tháng và đệm câu lặp ở `services/voice.ts`.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { VoiceError, listVoices, speak, voiceStatus } from '../services/voice.js';

export async function voiceRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof VoiceError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };

  app.get('/voice/status', { preHandler: app.authenticate }, async (_request, reply) => reply.send(await voiceStatus(context)));

  /** Danh sách giọng của tài khoản Vbee cho ô chọn giọng ở trang Tích hợp (không tốn credit). */
  app.get('/voice/voices', { preHandler: [app.authenticate, app.requireCapability('settings:read')] }, async (_request, reply) => {
    try {
      return reply.send({ voices: await listVoices(context) });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(
    '/voice/speak',
    // Giới hạn riêng: một trang mở lâu chỉ đọc vài câu mỗi phút; hơn nữa là vòng lặp lỗi đang đốt credit.
    { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      // `wait`: nút "Nghe thử" chịu chờ lâu hơn thông báo văn phòng (lượt đầu sau lúc Vbee nghỉ có thể mất vài phút).
      const { text, wait } = z.object({ text: z.string().min(1).max(1000), wait: z.number().int().min(5).max(90).optional() }).parse(request.body);
      try {
        const audio = await speak(context, text, wait ? wait * 1000 : undefined);
        return reply.header('content-type', 'audio/mpeg').header('cache-control', 'private, max-age=86400').send(audio);
      } catch (error) {
        return fail(reply, error);
      }
    },
  );

  /**
   * Vbee bắt buộc có địa chỉ báo kết quả; P&N tự hỏi trạng thái nên chỉ cần trả 200. Không tin, không đọc nội dung
   * gửi tới — ai gọi vào đây cũng không làm thay đổi được gì.
   */
  app.post('/voice/vbee-callback', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) =>
    reply.send({ ok: true }),
  );
}
