/**
 * P&N — Hàng đợi qua Redis bằng BullMQ (§23).
 *
 * Cùng hợp đồng `JobQueue` với bản in-process, nên engine không biết mình đang
 * chạy trên cái nào. Khác biệt thật nằm ở chỗ: job sống trong Redis nên tiến
 * trình API có thể chết mà công việc không mất, và tiến trình worker chạy tách
 * rời có thể gánh phần nặng thay cho API.
 *
 * **Thứ tự** là ràng buộc quan trọng nhất, không phải Redis: các run của cùng
 * một dự án thao tác trên cùng cây thư mục nên phải nối tiếp nhau. BullMQ bản
 * mã nguồn mở không có hàng đợi theo nhóm, nên worker chạy `concurrency: 1`.
 * Đánh đổi được nói thẳng ra: hai dự án khác nhau cũng không chạy song song
 * nữa. Đó là cái giá cho việc không bao giờ có hai agent cùng ghi vào một thư
 * mục — một lỗi rất khó lần ra khi nó xảy ra.
 */

import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

import type { JobHandler, JobQueue, QueuedJob } from './queue.js';

export const AGENT_RUN_QUEUE = 'pn-agent-runs';

export interface BullMqQueueOptions {
  /** `redis://host:port`. Cùng chuỗi cho cả API lẫn worker. */
  redisUrl: string;
  queueName?: string;
  /** Số lần thử lại một job trước khi bỏ cuộc. */
  attempts?: number;
}

function connection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.password ? { password: url.password } : {}),
    ...(url.username ? { username: url.username } : {}),
    // BullMQ yêu cầu tắt giới hạn số lần thử lại của ioredis cho tiến trình worker.
    maxRetriesPerRequest: null,
  };
}

/**
 * Bên GỬI: chỉ xếp job vào Redis, không chạy gì cả. Dùng ở tiến trình API.
 *
 * `drain()` ở đây đợi hàng đợi rỗng theo số liệu Redis chứ không đợi promise
 * cục bộ, vì job có thể do tiến trình khác xử lý.
 */
export class BullMqJobQueue<T> implements JobQueue<T> {
  readonly #queue: Queue;
  readonly #attempts: number;
  #enqueued = 0;

  constructor(options: BullMqQueueOptions) {
    this.#queue = new Queue(options.queueName ?? AGENT_RUN_QUEUE, {
      connection: connection(options.redisUrl),
    });
    this.#attempts = options.attempts ?? 1;
  }

  async enqueue(job: QueuedJob<T>): Promise<void> {
    this.#enqueued += 1;
    await this.#queue.add('run', job, {
      attempts: this.#attempts,
      // Giữ lại một ít lịch sử để xem được job vừa chạy, nhưng không giữ mãi.
      removeOnComplete: 100,
      removeOnFail: 500,
    });
  }

  /**
   * Số job đã xếp mà chưa biết chắc đã xong. Đây là con số của riêng tiến trình
   * này; `pendingInRedis()` mới là con số thật của cả hệ thống.
   */
  size(): number {
    return this.#enqueued;
  }

  /** Số job đang chờ hoặc đang chạy trong Redis, gồm cả của tiến trình khác. */
  async pendingInRedis(): Promise<number> {
    const counts = await this.#queue.getJobCounts('waiting', 'active', 'delayed');
    return (counts['waiting'] ?? 0) + (counts['active'] ?? 0) + (counts['delayed'] ?? 0);
  }

  /**
   * §74 — có Redis nghĩa là API chỉ xếp việc; không tiến trình worker nào chạy
   * thì task nằm im mãi mà không có lỗi nào phát ra. Đây là cách duy nhất nhìn
   * thấy tình trạng đó.
   */
  async health(): Promise<{ ok: boolean; workers: number; pending: number; detail: string }> {
    try {
      const [workers, pending] = await Promise.all([
        this.#queue.getWorkers(),
        this.pendingInRedis(),
      ]);

      if (workers.length === 0) {
        return {
          ok: false,
          workers: 0,
          pending,
          detail:
            `REDIS_URL đang bật nên API chỉ xếp việc, nhưng không có tiến trình worker nào ` +
            `đang chạy — ${pending} việc sẽ nằm im. Chạy "npm run dev:worker", hoặc bỏ ` +
            `REDIS_URL để API tự chạy agent như trước.`,
        };
      }
      return {
        ok: true,
        workers: workers.length,
        pending,
        detail: `${workers.length} worker đang nhận việc, ${pending} việc trong hàng đợi.`,
      };
    } catch (error) {
      return {
        ok: false,
        workers: 0,
        pending: 0,
        detail: `Không hỏi được Redis: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async drain(): Promise<void> {
    // Hỏi lại Redis cho tới khi không còn gì. Có giới hạn vòng lặp để một job
    // kẹt không làm treo lệnh tắt tiến trình.
    for (let attempt = 0; attempt < 600; attempt += 1) {
      if ((await this.pendingInRedis()) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async close(): Promise<void> {
    await this.#queue.close();
  }
}

/**
 * Bên NHẬN: chạy ở tiến trình worker. Trả về hàm đóng để tắt cho gọn.
 *
 * Job lỗi không làm dừng worker — lỗi đi vào `onError` và job kế tiếp vẫn chạy,
 * vì một task hỏng không được phép làm treo cả công ty.
 */
export function startBullMqWorker<T>(
  options: BullMqQueueOptions & {
    handler: JobHandler<T>;
    onError?: (error: unknown, payload: T | null) => void;
  },
): { close: () => Promise<void> } {
  const worker = new Worker<QueuedJob<T>>(
    options.queueName ?? AGENT_RUN_QUEUE,
    async (job: Job<QueuedJob<T>>) => {
      await options.handler(job.data.payload);
    },
    {
      connection: connection(options.redisUrl),
      // Xem chú thích đầu file: 1 là để cùng dự án không bao giờ chạy chồng nhau.
      concurrency: 1,
    },
  );

  worker.on('failed', (job, error) => {
    options.onError?.(error, job?.data.payload ?? null);
  });

  return { close: () => worker.close() };
}
