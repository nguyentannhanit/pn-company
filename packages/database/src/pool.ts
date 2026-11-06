/**
 * P&N — Pool kết nối PostgreSQL (§14, §61).
 */

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';

import { describeDatabaseError } from './errors.js';

export interface DatabaseConfig {
  connectionString: string;
  ssl?: boolean;
  max?: number;
  /** Lỗi nhanh thay vì để request treo chờ pool đã cạn. */
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
}

export class Database {
  readonly #pool: Pool;
  readonly #connectionString: string;

  constructor(config: DatabaseConfig) {
    this.#connectionString = config.connectionString;
    // statement_timeout đặt ngay trong chuỗi kết nối chứ không chạy `SET` ở sự
    // kiện 'connect': handler đó không await được, nên câu SET chạy song song với
    // câu truy vấn đầu tiên — vừa có thể chưa kịp áp dụng, vừa làm pg cảnh báo
    // "client is already executing a query". Truyền qua `options` thì server áp
    // dụng ngay lúc bắt tay, trước mọi truy vấn.
    const statementTimeout = config.statementTimeoutMs ?? 30_000;
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.max ?? 10,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 10_000,
      options: `-c statement_timeout=${statementTimeout}`,
      ...(config.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    };
    this.#pool = new Pool(poolConfig);

    // Lỗi ở client đang rảnh không được làm sập tiến trình.
    this.#pool.on('error', (error) => {
      console.error('[database] lỗi ở kết nối rảnh:', describeDatabaseError(error));
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const result = await this.#pool.query<T>(text, params);
    return result.rows;
  }

  async one<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<T | null> {
    const rows = await this.query<T>(text, params);
    return rows[0] ?? null;
  }

  /** Chạy `fn` trong một transaction, có lỗi thì rollback. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
    const startedAt = Date.now();
    try {
      await this.#pool.query('SELECT 1');
      return { ok: true, latencyMs: Date.now() - startedAt, error: null };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        // AggregateError của Node có message rỗng nên phải diễn giải lại.
        error: describeDatabaseError(error, this.#connectionString),
      };
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
