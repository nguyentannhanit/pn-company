/**
 * P&N — Cầu dao ngắt mạch (§80).
 *
 * Provider lỗi liên tục sẽ bị tạm loại khỏi vòng quay trong một khoảng nghỉ thay
 * vì bị gọi lại ở mọi request. Ba trạng thái: closed (bình thường), open (đang
 * ngắt), half_open (cho thử lại một lần).
 */

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Số lần lỗi liên tiếp trước khi ngắt mạch. */
  failureThreshold?: number;
  /** Mạch giữ trạng thái ngắt trong bao lâu, tính bằng ms. */
  cooldownMs?: number;
  /** Số lần thử thành công ở half_open trước khi đóng mạch lại. */
  successThreshold?: number;
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(readonly key: string, readonly retryAfterMs: number) {
    super(`Circuit open for "${key}", retry in ${Math.ceil(retryAfterMs / 1000)}s (spec §80)`);
    this.name = 'CircuitOpenError';
  }
}

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  successes: number;
  openedAt: number;
  /** Khoảng nghỉ riêng của lần ngắt này (khi `trip` có hẹn giờ); không có thì dùng mặc định. */
  cooldownMs?: number;
}

export class CircuitBreaker {
  readonly #entries = new Map<string, BreakerEntry>();
  readonly #failureThreshold: number;
  readonly #cooldownMs: number;
  readonly #successThreshold: number;
  readonly #now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.#failureThreshold = options.failureThreshold ?? 5;
    this.#cooldownMs = options.cooldownMs ?? 60_000;
    this.#successThreshold = options.successThreshold ?? 1;
    this.#now = options.now ?? (() => Date.now());
  }

  stateOf(key: string): BreakerState {
    const entry = this.#entries.get(key);
    if (!entry) return 'closed';
    if (entry.state === 'open' && this.#now() - entry.openedAt >= (entry.cooldownMs ?? this.#cooldownMs)) {
      entry.state = 'half_open';
      entry.successes = 0;
    }
    return entry.state;
  }

  /** Ném `CircuitOpenError` khi key đang bị ngắt mạch. */
  assertClosed(key: string): void {
    if (this.stateOf(key) === 'open') {
      const entry = this.#entries.get(key)!;
      throw new CircuitOpenError(key, (entry.cooldownMs ?? this.#cooldownMs) - (this.#now() - entry.openedAt));
    }
  }

  recordSuccess(key: string): void {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.state === 'half_open') {
      entry.successes += 1;
      if (entry.successes >= this.#successThreshold) this.#entries.delete(key);
      return;
    }
    this.#entries.delete(key);
  }

  recordFailure(key: string): void {
    const entry = this.#entries.get(key) ?? { state: 'closed' as BreakerState, failures: 0, successes: 0, openedAt: 0 };
    entry.failures += 1;
    if (entry.state === 'half_open' || entry.failures >= this.#failureThreshold) {
      entry.state = 'open';
      entry.openedAt = this.#now();
      entry.failures = 0;
      delete entry.cooldownMs;
    }
    this.#entries.set(key, entry);
  }

  /**
   * Ngắt ngay, không chờ đủ ngưỡng: model tự báo đang quá tải / hết lượt thì
   * người gọi sau đi thẳng sang dự phòng thay vì lần lượt thử lại rồi cùng thất bại.
   * Hết khoảng nghỉ vẫn cho thử lại một lần như mọi lần ngắt khác.
   */
  trip(key: string, cooldownMs = this.#cooldownMs): void {
    this.#entries.set(key, { state: 'open', failures: 0, successes: 0, openedAt: this.#now(), cooldownMs });
  }

  /** Ảnh chụp trạng thái cho dashboard sức khoẻ tích hợp (§68). */
  snapshot(): Array<{ key: string; state: BreakerState; openedAt: number; reopensAt: number }> {
    return [...this.#entries.entries()].map(([key, entry]) => ({
      key,
      state: this.stateOf(key),
      openedAt: entry.openedAt,
      // Lúc mạch hết nghỉ — trang Cài đặt hiện "dùng lại sau …" cho hãng vừa hết lượt.
      reopensAt: entry.openedAt + (entry.cooldownMs ?? this.#cooldownMs),
    }));
  }
}
