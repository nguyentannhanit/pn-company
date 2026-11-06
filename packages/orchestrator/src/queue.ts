/**
 * P&N — Hàng đợi công việc cho agent run (§23).
 *
 * Spec đề xuất BullMQ + Redis. Phase 1 chạy được mà không cần Redis nhờ bản
 * in-process dưới đây; interface giữ nguyên nên đổi sang BullMQ ở Phase 2 chỉ là
 * thay một hiện thực.
 *
 * Điểm quan trọng không phải là Redis mà là **thứ tự**: các run của cùng một dự
 * án phải nối tiếp nhau, vì chúng thao tác trên cùng một cây thư mục làm việc.
 * Dự án khác nhau thì chạy song song bình thường.
 */

export interface QueuedJob<T> {
  /** Khoá tuần tự — job cùng khoá chạy nối tiếp. Thường là id dự án. */
  key: string;
  payload: T;
}

export interface JobQueue<T> {
  enqueue(job: QueuedJob<T>): Promise<void>;
  /** Số job đang chờ, dùng cho dashboard và test. */
  size(): number;
  /** Đợi cho tới khi mọi job hiện có chạy xong. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export type JobHandler<T> = (payload: T) => Promise<void>;

/**
 * Hàng đợi trong bộ nhớ, tuần tự theo khoá.
 *
 * Job lỗi không làm dừng hàng đợi — lỗi được đưa cho `onError` và job kế tiếp
 * vẫn chạy, vì một task hỏng không được phép làm treo cả công ty.
 */
export class InMemoryJobQueue<T> implements JobQueue<T> {
  readonly #chains = new Map<string, Promise<void>>();
  #pending = 0;
  #closed = false;

  constructor(
    private readonly handler: JobHandler<T>,
    private readonly onError: (error: unknown, payload: T) => void = (error) => {
      console.error('[queue] job lỗi:', error);
    },
  ) {}

  async enqueue(job: QueuedJob<T>): Promise<void> {
    if (this.#closed) throw new Error('Hàng đợi đã đóng');

    this.#pending += 1;
    const previous = this.#chains.get(job.key) ?? Promise.resolve();

    const next = previous
      .then(() => this.handler(job.payload))
      .catch((error: unknown) => {
        this.onError(error, job.payload);
      })
      .finally(() => {
        this.#pending -= 1;
        // Dọn khoá khi chuỗi này đã là chuỗi cuối, tránh Map phình theo thời gian.
        if (this.#chains.get(job.key) === next) this.#chains.delete(job.key);
      });

    this.#chains.set(job.key, next);
  }

  size(): number {
    return this.#pending;
  }

  async drain(): Promise<void> {
    // Lặp lại vì một job có thể xếp thêm job mới (ví dụ fix loop).
    while (this.#chains.size > 0) {
      await Promise.all([...this.#chains.values()]);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.drain();
  }
}
