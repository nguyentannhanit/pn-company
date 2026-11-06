/**
 * P&N — Bộ chạy migration.
 *
 * Migration là các file SQL thuần, chạy theo thứ tự tên file, mỗi file trong một
 * transaction, và được ghi lại ở bảng `schema_migrations` kèm checksum. File đã
 * áp dụng mà bị sửa sẽ báo lỗi cứng — schema lệch nhau âm thầm chính là thứ làm
 * hỏng production.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from './pool.js';

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

const MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

export function migrationsDir(): string {
  // dist/migrate.js -> ../migrations (vị trí tương đối giống hệt khi chạy thẳng
  // file TypeScript từ src/), resolve theo cách chạy được trên mọi hệ điều hành.
  return fileURLToPath(new URL('../migrations/', import.meta.url));
}

export async function loadMigrations(dir = migrationsDir()): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

export async function migrate(db: Database, dir = migrationsDir()): Promise<MigrationResult> {
  await db.query(MIGRATIONS_TABLE);

  const files = await loadMigrations(dir);
  const applied = await db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const appliedByName = new Map(applied.map((row) => [row.name, row.checksum]));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const file of files) {
    const existing = appliedByName.get(file.name);
    if (existing) {
      if (existing !== file.checksum) {
        throw new Error(
          `Migration ${file.name} was modified after being applied ` +
            `(expected checksum ${existing}, got ${file.checksum}). ` +
            'Create a new migration instead of editing an applied one.',
        );
      }
      result.skipped.push(file.name);
      continue;
    }

    await db.transaction(async (client) => {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        file.name,
        file.checksum,
      ]);
    });
    result.applied.push(file.name);
  }

  return result;
}

export interface MigrationStatus {
  name: string;
  appliedAt: string | null;
  drifted: boolean;
}

export async function status(db: Database, dir = migrationsDir()): Promise<MigrationStatus[]> {
  await db.query(MIGRATIONS_TABLE);
  const files = await loadMigrations(dir);
  const applied = await db.query<{ name: string; checksum: string; applied_at: Date }>(
    'SELECT name, checksum, applied_at FROM schema_migrations',
  );
  const byName = new Map(applied.map((row) => [row.name, row]));

  return files.map((file) => {
    const row = byName.get(file.name);
    return {
      name: file.name,
      appliedAt: row ? row.applied_at.toISOString() : null,
      drifted: row ? row.checksum !== file.checksum : false,
    };
  });
}
