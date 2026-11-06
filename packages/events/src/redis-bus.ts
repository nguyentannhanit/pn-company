/**
 * P&N — Event bus qua Redis pub/sub (§21, §22).
 *
 * Lý do tồn tại: khi worker chạy ở tiến trình riêng, event nó phát ra phải tới
 * được WebSocket của dashboard. Với bus trong bộ nhớ thì không — văn phòng 3D
 * đứng im trong khi công ty vẫn đang làm việc, và §9 nói animation phải phản
 * ánh dữ liệu thật.
 *
 * Mỗi tiến trình cần hai kết nối: một để publish, một để subscribe. Đó là ràng
 * buộc của Redis — kết nối đã vào chế độ subscribe thì không chạy lệnh khác được.
 *
 * Handler cục bộ vẫn nhận event do chính tiến trình này phát, không phải đợi
 * vòng qua Redis: bộ gửi thông báo và WebSocket phải chạy ngay cả khi Redis
 * chớp tắt một nhịp.
 */

import { Redis } from 'ioredis';

import { buildEvent, type EventBus, type EventHandler, type PublishOptions } from './bus.js';
import type { EventPayloads, EventType, PnEvent } from './types.js';

const CHANNEL = 'pn:events';

export interface RedisEventBusOptions {
  redisUrl: string;
  channel?: string;
  onError?: (error: unknown, event: PnEvent | null) => void;
}

export class RedisEventBus implements EventBus {
  readonly #publisher: Redis;
  readonly #subscriber: Redis;
  readonly #channel: string;
  readonly #handlers = new Set<{ handler: EventHandler; types: ReadonlySet<EventType> | null }>();
  readonly #onError: (error: unknown, event: PnEvent | null) => void;
  /** Id event do chính tiến trình này phát, để không xử lý hai lần. */
  readonly #ownEventIds = new Set<string>();

  constructor(options: RedisEventBusOptions) {
    this.#channel = options.channel ?? CHANNEL;
    this.#onError =
      options.onError ??
      ((error, event) => {
        console.error(`[events] lỗi khi xử lý ${event?.type ?? 'không rõ'}:`, error);
      });

    this.#publisher = new Redis(options.redisUrl);
    this.#subscriber = new Redis(options.redisUrl);

    // Redis rớt kết nối là chuyện thường; ioredis tự nối lại. Ghi ra để người
    // vận hành thấy, nhưng không làm chết tiến trình.
    this.#publisher.on('error', (error) => this.#onError(error, null));
    this.#subscriber.on('error', (error) => this.#onError(error, null));

    void this.#subscriber.subscribe(this.#channel);
    this.#subscriber.on('message', (_channel, message) => {
      let event: PnEvent;
      try {
        event = JSON.parse(message) as PnEvent;
      } catch (error) {
        this.#onError(error, null);
        return;
      }

      // Bỏ qua event của chính mình — nó đã được giao cho handler lúc publish.
      if (this.#ownEventIds.delete(event.id)) return;
      void this.#dispatch(event);
    });
  }

  async publish<T extends EventType>(
    type: T,
    payload: EventPayloads[T],
    options: PublishOptions = {},
  ): Promise<PnEvent> {
    const event = buildEvent(type, payload, options);

    // Giao cho handler cục bộ trước, rồi mới ra Redis: Redis hỏng thì tiến trình
    // này vẫn hoạt động đúng như khi chưa có Redis.
    await this.#dispatch(event);

    this.#ownEventIds.add(event.id);
    try {
      await this.#publisher.publish(this.#channel, JSON.stringify(event));
    } catch (error) {
      this.#ownEventIds.delete(event.id);
      this.#onError(error, event);
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
    await this.#subscriber.quit().catch(() => undefined);
    await this.#publisher.quit().catch(() => undefined);
  }

  async #dispatch(event: PnEvent): Promise<void> {
    for (const entry of this.#handlers) {
      if (entry.types && !entry.types.has(event.type)) continue;
      try {
        await entry.handler(event);
      } catch (error) {
        this.#onError(error, event);
      }
    }
  }
}
