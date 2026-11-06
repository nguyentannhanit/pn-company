/**
 * P&N — Cổng realtime WebSocket (§21, §22).
 *
 * Dashboard mở một kết nối tới `/ws`, nhận ảnh chụp trạng thái ban đầu rồi nhận
 * tiếp mọi event của hệ thống. §9 nói animation 3D phải phản ánh dữ liệu thật —
 * đây là đường ống duy nhất mang dữ liệu đó lên frontend.
 */

import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';

import type { PnEvent } from '@pn/events';
import { isHumanRole } from '@pn/permissions';
import { redactDeep } from '@pn/shared';

import type { AppContext } from '../context.js';
import type { SessionPayload } from '../plugins/auth.js';

interface Client {
  socket: WebSocket;
  userId: string;
  /** Chỉ nhận event của một dự án; bỏ trống là nhận tất cả. */
  projectFilter: string | null;
}

export async function registerRealtime(app: FastifyInstance, context: AppContext): Promise<void> {
  await app.register(fastifyWebsocket);

  const clients = new Set<Client>();

  // Một subscriber duy nhất cho cả bus, rồi fan-out xuống từng socket.
  const unsubscribe = context.events.subscribe((event) => {
    broadcast(clients, event);
  });

  app.addHook('onClose', async () => {
    unsubscribe();
    for (const client of clients) client.socket.close();
    clients.clear();
  });

  app.get('/ws', { websocket: true }, async (socket, request) => {
    // WebSocket không gửi được header Authorization từ trình duyệt, nên token
    // đi qua query string. Token vẫn là JWT ký, hết hạn theo phiên như REST.
    const token = (request.query as { token?: string }).token;
    let session: SessionPayload;
    try {
      session = app.jwt.verify<SessionPayload>(token ?? '');
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Token không hợp lệ' }));
      socket.close();
      return;
    }
    // Người bị khoá, bị xoá hay đã "đăng xuất mọi thiết bị" thì không mở được luồng mới (giống REST).
    if (isHumanRole(session.role)) {
      const user = await context.repos.users.findById(session.sub);
      if (!user || !user.isActive || (session.ver ?? 0) !== (user.sessionVersion ?? 0)) {
        socket.send(JSON.stringify({ type: 'error', message: 'Phiên đã hết hiệu lực' }));
        socket.close();
        return;
      }
    }

    const client: Client = {
      socket,
      userId: session.sub,
      projectFilter: (request.query as { projectId?: string }).projectId ?? null,
    };
    clients.add(client);

    // Ảnh chụp ban đầu: nhân vật 3D phải hiện đúng trạng thái ngay khi mở trang.
    const [agents, approvals] = await Promise.all([
      context.agentState.snapshot(),
      context.repos.approvals.listPending(),
    ]);
    socket.send(
      JSON.stringify({
        type: 'snapshot',
        agents,
        pendingApprovals: approvals.length,
        serverTime: new Date().toISOString(),
      }),
    );

    socket.on('message', (raw: Buffer) => {
      // Giao thức tối giản: client chỉ được đổi bộ lọc dự án và gửi ping.
      try {
        const message = JSON.parse(raw.toString()) as { type?: string; projectId?: string | null };
        if (message.type === 'subscribe') {
          client.projectFilter = message.projectId ?? null;
        } else if (message.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
        }
      } catch {
        // Tin nhắn rác thì bỏ qua, không đóng kết nối của người dùng vì lỗi nhỏ.
      }
    });

    socket.on('close', () => {
      clients.delete(client);
    });
  });
}

/** Gửi event tới các client đang quan tâm; một socket lỗi không ảnh hưởng socket khác. */
function broadcast(clients: Set<Client>, event: PnEvent): void {
  // §89 — payload event vẫn đi qua redaction trước khi ra khỏi máy chủ.
  const payload = JSON.stringify({ type: 'event', event: redactDeep(event) });

  for (const client of clients) {
    if (client.projectFilter && event.projectId && event.projectId !== client.projectFilter) continue;
    if (client.socket.readyState !== 1) continue;
    try {
      client.socket.send(payload);
    } catch {
      clients.delete(client);
    }
  }
}
