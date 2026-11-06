/**
 * P&N — Điểm khởi động tiến trình API.
 */

import { migrate } from '@pn/database';
import { branding } from '@pn/shared';

import { buildApp, prepare } from './app.js';
import { loadConfig } from './config.js';
import { createContext } from './context.js';
import { prewarmOfficeLines } from './services/voice.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const context = await createContext(config);

  // Chạy migration lúc khởi động: một môi trường mới chỉ cần `npm start` là dùng
  // được, không phải nhớ thêm bước riêng.
  const migration = await migrate(context.db);
  if (migration.applied.length > 0) {
    console.log(`[db] đã áp dụng ${migration.applied.length} migration: ${migration.applied.join(', ')}`);
  }

  await prepare(context);
  const app = await buildApp(context);

  // Đóng kết nối gọn gàng để không bỏ lại transaction treo khi deploy.
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[api] nhận ${signal}, đang tắt…`);
    await app.close();
    await context.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
  // Lượt chạy bị cắt ngang lúc tắt: chốt thất bại, xếp lại task, dựng lại staging dở. Chạy SAU buildApp (bộ dựng
  // staging đăng ký ở đó) và chạy nền: dựng lại .exe mất vài phút, không được chặn API lên.
  void context.orchestrator
    .recover()
    .then((result) => console.log(`[recover] ${result.runs} lượt bị cắt, ${result.projects.length} dự án đẩy tiếp, dựng lại ${result.restaged} staging`))
    .catch((error: unknown) => console.error('[recover] lỗi:', error));
  // Việc kẹt vì lỗi tạm của nguồn AI (hết lượt, quá tải, đăng nhập lại…) tự chạy lại — quét 5 phút một lần.
  setInterval(() => {
    void context.orchestrator
      .autoRetryBlocked()
      .then((queued) => queued > 0 && console.log(`[tự chạy lại] ${queued} việc kẹt vì lỗi tạm của nguồn AI`))
      .catch((error: unknown) => console.error('[tự chạy lại] lỗi:', error));
  }, 5 * 60_000).unref();
  // Giọng Vbee: đọc sẵn các câu thông báo văn phòng còn thiếu trong đệm (chạy nền, câu có rồi thì không tốn gì).
  void prewarmOfficeLines(context, (message) => console.log(message)).catch((error: unknown) => console.error('[voice] lỗi đọc sẵn:', error));
  console.log(
    `${branding.companyName} API đang chạy tại ${config.publicUrl} (${config.environment}) — ${branding.companyTagline}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
