/**
 * P&N — CLI thao tác database.
 *
 *   npm run db:migrate   áp dụng các migration còn thiếu
 *   npm run db:status    xem migration nào đã chạy / bị lệch checksum
 */

import { describeDatabaseError } from './errors.js';
import { migrate, status } from './migrate.js';
import { Database } from './pool.js';

function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error(
      'DATABASE_URL chưa được đặt.\n' +
        '→ Sao chép .env.example thành .env rồi điền chuỗi kết nối PostgreSQL.\n' +
        '  Xem hướng dẫn đầy đủ trong SETUP.md.',
    );
    process.exit(1);
  }
  if (url.includes('<MAT_KHAU>')) {
    console.error(
      'DATABASE_URL vẫn còn chỗ trống <MAT_KHAU> trong .env.\n' +
        '→ Thay bằng mật khẩu PostgreSQL anh đặt lúc cài đặt (xem SETUP.md bước 2).',
    );
    process.exit(1);
  }
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  const databaseUrl = requireDatabaseUrl();
  const db = new Database({
    connectionString: databaseUrl,
    ssl: process.env['DATABASE_SSL'] === 'true',
  });

  try {
    if (command === 'migrate') {
      const result = await migrate(db);
      for (const name of result.applied) console.log(`đã áp dụng  ${name}`);
      for (const name of result.skipped) console.log(`bỏ qua      ${name}`);
      console.log(
        `\n${result.applied.length} migration mới, ${result.skipped.length} đã có sẵn từ trước.`,
      );
    } else if (command === 'status') {
      const rows = await status(db);
      for (const row of rows) {
        const state = row.drifted ? 'LỆCH   ' : row.appliedAt ? 'đã chạy' : 'chờ    ';
        console.log(`${state}  ${row.name}${row.appliedAt ? `  (${row.appliedAt})` : ''}`);
      }
      const pending = rows.filter((row) => !row.appliedAt).length;
      if (pending > 0) console.log(`\n${pending} migration chưa chạy. Chạy: npm run db:migrate`);
    } else {
      console.error(`Không có lệnh "${command}". Dùng "migrate" hoặc "status".`);
      process.exitCode = 1;
    }
  } catch (error) {
    // Không dùng error.message trực tiếp: AggregateError của Node có message rỗng.
    console.error(`Không thao tác được với database: ${describeDatabaseError(error, databaseUrl)}`);
    process.exitCode = 1;
  } finally {
    await db.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(describeDatabaseError(error));
  process.exit(1);
});
