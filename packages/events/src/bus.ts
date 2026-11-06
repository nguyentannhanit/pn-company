/**
 * P&N — Event bus (§21, §22).
 *
 * API là bên publish; WebSocket gateway, worker và bộ gửi thông báo Telegram là
 * bên subscribe. Bản in-memory chỉ dùng cho phát triển cục bộ và test — bản
 * production cắm cùng interface này vào Redis pub/sub để nhiều tiến trình
 * (api, worker, telegram-bot) dùng chung một luồng event.
 */

import { newId } from '@pn/shared';

import type { EventActor, EventPayloads, EventType, PnEvent } from './types.js';

export interface PublishOptions {
  actor?: EventActor;
  projectId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
}

export type EventHandler = (event: PnEvent) => void | Promise<void>;

export interface EventBus {
  publish<T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    options?: PublishOptions,
  ): Promise<PnEvent>;

  /** Đăng ký theo loại event cụ thể; bỏ trống `types` nghĩa là nhận tất cả. */
  subscribe(handler: EventHandler, types?: readonly EventType[]): () => void;

  close(): Promise<void>;
}

export function buildEvent<T extends EventType>(
  type: T,
  payload: EventPayloads[T],
  options: PublishOptions = {},
  now: () => string = () => new Date().toISOString(),
): PnEvent {
  return {
    id: newId(),
    type,
    ts: now(),
    actor: options.actor ?? 'system',
    projectId: options.projectId ?? null,
    taskId: options.taskId ?? null,
    agentId: options.agentId ?? null,
    payload,
  } as PnEvent;
}

/**
 * Bus chạy trong một tiến trình. Lỗi của handler được cô lập: một subscriber
 * hỏng không được làm chết các subscriber khác hay bên publish (§22 — dashboard
 * rớt socket thì vòng sản xuất vẫn phải chạy tiếp).
 */
export class InMemoryEventBus implements EventBus {
  #handlers = new Set<{ handler: EventHandler; types: ReadonlySet<EventType> | null }>();
  #onError: (error: unknown, event: PnEvent) => void;

  constructor(onError?: (error: unknown, event: PnEvent) => void) {
    this.#onError =
      onError ??
      ((error, event) => {
        console.error(`[events] handler failed for ${event.type}:`, error);
      });
  }

  async publish<T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    options: PublishOptions = {},
  ): Promise<PnEvent> {
    const event = buildEvent(type, payload, options);
    for (const entry of this.#handlers) {
      if (entry.types && !entry.types.has(event.type)) continue;
      try {
        await entry.handler(event);
      } catch (error) {
        this.#onError(error, event);
      }
    }
    return event;
  }

  subscribe(handler: EventHandler, types?: readonly EventType[]): () => void {
    const entry = { handler, types: types ? new Set(types) : null };
    this.#handlers.add(entry);
    return () => {
      this.#handlers.delete(entry);
    };
  }

  async close(): Promise<void> {
    this.#handlers.clear();
  }
}
