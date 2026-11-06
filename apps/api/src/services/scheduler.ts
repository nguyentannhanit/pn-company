/**
 * P&N — Việc chạy theo lịch (§106, §131).
 *
 * §106 mở đầu bằng "Mặc định Knowledge Department chạy: DAILY". Không có bộ này
 * thì luồng khám phá chỉ chạy khi ai đó bấm nút, và "hằng ngày" chỉ là chữ.
 *
 * Cố tình không dùng thư viện cron: nhu cầu ở đây là "mỗi ngày một lần vào
 * khoảng giờ này", và một `setInterval` đọc được vẫn rẻ hơn một phụ thuộc mới
 * cùng cú pháp năm trường của nó.
 *
 * Mặc định TẮT. Một vòng khám phá tốn tiền model, nên nó phải là thứ người dùng
 * bật lên có ý thức, không phải thứ tự chạy sau khi cài xong (§132).
 */

import { formatDigest, runDiscovery } from './knowledge-pipeline.js';
import { sendTelegram, telegramTarget } from './notifier.js';
import type { AppContext } from '../context.js';

/** Kiểm mỗi 15 phút xem đã tới giờ chạy chưa. Đủ sát mà không bận rộn. */
const TICK_MS = 15 * 60_000;

export interface SchedulerOptions {
  /** Giờ trong ngày (0–23) theo múi giờ máy chủ. */
  hour: number;
  /** Chủ đề phòng ban đang cần, dùng cho độ liên quan (§102). */
  wantedTopics: string[];
  /** Có gửi digest qua Telegram sau mỗi vòng không (§107). */
  sendDigest: boolean;
}

/**
 * Bật lịch khám phá hằng ngày. Trả về hàm tắt.
 *
 * Chống chạy trùng theo ngày: tiến trình khởi động lại nhiều lần trong ngày là
 * chuyện thường, và mỗi lần chạy lại một vòng khám phá là tiêu tiền hai lần cho
 * cùng một ngày.
 */
export function startDailyDiscovery(
  context: AppContext,
  options: SchedulerOptions,
  log: (message: string) => void,
): () => void {
  let lastRunDay: string | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (running || lastRunDay === today || now.getHours() !== options.hour) return;

    const github = await context.github();
    if (!github) {
      // Chưa cấu hình GitHub thì không có gì để quét. Không đánh dấu đã chạy,
      // để hôm nay cấu hình xong thì vòng chạy vẫn diễn ra.
      log('bỏ qua vòng khám phá: chưa cấu hình GitHub');
      return;
    }

    running = true;
    lastRunDay = today;
    try {
      const report = await runDiscovery(context, github, {
        wantedTopics: options.wantedTopics,
      });
      log(
        `khám phá ${today}: quét ${report.found}, chờ duyệt ${report.promoted.length}, ` +
          `chi phí $${report.costUsd.toFixed(4)}`,
      );

      if (options.sendDigest) {
        const target = await telegramTarget(context, context.config.environment);
        if (target) await sendTelegram(target, formatDigest(report));
      }
    } catch (error) {
      log(`vòng khám phá lỗi: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  // `unref` để tiến trình vẫn thoát được khi có tín hiệu tắt, không bị timer giữ lại.
  timer.unref?.();

  log(`lịch khám phá kiến thức: mỗi ngày lúc ${options.hour}:00`);
  return () => clearInterval(timer);
}
