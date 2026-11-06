/**
 * P&N — Bản tin sức khoẻ công ty mỗi sáng qua Telegram.
 *
 * Lý do có nó: OpenAI hết tiền mà mãi sau mới biết, vì không ai
 * nhìn dashboard mỗi ngày. Mỗi sáng bot trả lời năm câu: model còn chạy không,
 * từ ngoài vào được không, đã tiêu bao nhiêu, dự án tới đâu, cần CEO làm gì.
 * Kiểm tra model là gọi thật (vài token) chứ không đọc trạng thái cũ.
 */

import { sendTelegram, telegramTarget } from './notifier.js';
import { buildCeoReport, type CeoReport } from './report.js';
import { tunnelApiUrl, tunnelWebOrigin } from './tunnel.js';
import type { AppContext } from '../context.js';

export interface ProviderCheck {
  provider: string;
  routes: number;
  ok: boolean;
  error: string | null;
}

export interface BriefInput {
  day: string;
  providers: ProviderCheck[];
  publicApi: { url: string | null; ok: boolean };
  publicWeb: { url: string | null; ok: boolean };
  report: CeoReport;
}

/** Ngày và giờ hiện tại theo múi giờ của CEO, không theo múi giờ máy chủ. */
export function localClock(now: Date, timeZone: string): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now);
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return { day: `${pick('year')}-${pick('month')}-${pick('day')}`, hour: Number(pick('hour')) % 24 };
}

const money = (value: number): string => `$${value.toFixed(2)}`;
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Dựng nội dung bản tin (HTML Telegram). Tách riêng để test không cần máy chủ. */
export function formatBrief(input: BriefInput): string {
  const lines: string[] = [`<b>P&amp;N — bản tin sáng ${input.day}</b>`, ''];

  const broken = input.providers.filter((p) => !p.ok);
  if (input.providers.length === 0) {
    lines.push('🤖 Model: <b>chưa định tuyến vai trò nào</b> — công ty không chạy được.');
  } else if (broken.length === 0) {
    lines.push(`🤖 Model: ổn (${input.providers.map((p) => `${p.provider} ${p.routes} tuyến`).join(', ')}).`);
  } else {
    for (const p of broken) {
      lines.push(`🤖 Model: <b>${esc(p.provider)} hỏng</b> — ${p.routes} tuyến đang trỏ vào đó. ${esc((p.error ?? '').slice(0, 140))}`);
    }
  }

  if (!input.publicApi.url || !input.publicWeb.url) {
    lines.push('🌐 Từ ngoài: <b>chưa có đường hầm</b>.');
  } else if (input.publicApi.ok && input.publicWeb.ok) {
    lines.push('🌐 Từ ngoài: vào được (bấm "Mở P&amp;N" trong bot).');
  } else {
    lines.push(`🌐 Từ ngoài: <b>hỏng</b> (API ${input.publicApi.ok ? 'ok' : 'chết'}, web ${input.publicWeb.ok ? 'ok' : 'chết'}) — bộ canh sẽ mở lại.`);
  }

  const { costs, tasks, bugs, projects, risks, nextActions } = input.report;
  lines.push(
    `💰 Tiền: hôm nay ${money(costs.todayUsd)} · tháng ${money(costs.monthUsd)}` +
      (costs.unpricedCalls > 0 ? ` · ${costs.unpricedCalls} lượt chưa tính giá` : ''),
  );

  const active = projects.filter((p) => !['ARCHIVED', 'COMPLETED', 'CANCELLED'].includes(p.status));
  lines.push('');
  if (active.length === 0) {
    lines.push('📁 Dự án: không có dự án nào đang chạy.');
  } else {
    lines.push(`📁 Dự án đang chạy (${active.length}):`);
    for (const p of active.slice(0, 5)) {
      lines.push(
        `• ${esc(p.name.slice(0, 48))} — ${p.done}/${p.total} việc` +
          (p.blocked > 0 ? `, <b>${p.blocked} bị chặn</b>` : '') +
          `, ${money(p.spentUsd)}/${money(p.budgetUsd)}`,
      );
    }
    if (active.length > 5) lines.push(`• … và ${active.length - 5} dự án nữa`);
  }
  lines.push(`⛔ Việc bị chặn: ${tasks.blocked} · 🐞 Lỗi mở: ${bugs.open}${bugs.critical > 0 ? ` (${bugs.critical} nghiêm trọng)` : ''}`);

  if (risks.length > 0) {
    lines.push('', '⚠️ Rủi ro:');
    for (const risk of risks.slice(0, 3)) lines.push(`• ${esc(risk)}`);
  }
  if (nextActions.length > 0) {
    lines.push('', '👉 Cần anh:');
    for (const action of nextActions.slice(0, 3)) lines.push(`• ${esc(action)}`);
  }
  return lines.join('\n');
}

async function reachable(url: string | null, path: string): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  }
}

/** Gom số liệu thật: gọi thử từng provider đang được định tuyến, hỏi đường hầm, dựng báo cáo CEO. */
export async function collectBrief(context: AppContext, now = new Date()): Promise<BriefInput> {
  const env = context.config.environment;
  const routes = await context.repos.routes.list(env);
  const counts = new Map<string, number>();
  for (const route of routes) counts.set(route.provider, (counts.get(route.provider) ?? 0) + 1);

  const providers: ProviderCheck[] = [];
  for (const [provider, count] of counts) {
    if (!context.registry.has(provider as never)) {
      providers.push({ provider, routes: count, ok: false, error: 'chưa cấu hình API key' });
      continue;
    }
    const result = await context.registry
      .get(provider as never)
      .testConnection()
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    providers.push({ provider, routes: count, ok: result.ok, error: result.ok ? null : (result.error ?? 'không rõ') });
  }

  const apiUrl = tunnelApiUrl();
  const webUrl = tunnelWebOrigin();
  const [apiOk, webOk] = await Promise.all([reachable(apiUrl, '/health'), reachable(webUrl, '/login')]);

  return {
    day: localClock(now, context.config.dailyBrief.timeZone).day,
    providers,
    publicApi: { url: apiUrl, ok: apiOk },
    publicWeb: { url: webUrl, ok: webOk },
    report: await buildCeoReport(context.repos),
  };
}

/** Kiểm mỗi 5 phút; tới giờ của CEO thì gửi, mỗi ngày đúng một lần. Trả về hàm tắt. */
export function startDailyBrief(context: AppContext, log: (message: string) => void): () => void {
  const { hour, timeZone } = context.config.dailyBrief;
  let lastSentDay: string | null = null;
  let running = false;

  const tick = async (): Promise<void> => {
    const clock = localClock(new Date(), timeZone);
    if (running || lastSentDay === clock.day || clock.hour !== hour) return;
    running = true;
    try {
      const target = await telegramTarget(context, context.config.environment);
      if (!target) {
        log('bản tin sáng: chưa cấu hình Telegram, bỏ qua');
        lastSentDay = clock.day;
        return;
      }
      const text = formatBrief(await collectBrief(context));
      const delivered = await sendTelegram(target, text, (message) => log(`bản tin sáng lỗi gửi: ${message}`));
      lastSentDay = clock.day;
      log(`bản tin sáng ${clock.day}: gửi ${delivered} chat`);
    } catch (error) {
      log(`bản tin sáng lỗi: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), 5 * 60_000);
  timer.unref?.();
  log(`bản tin sáng: mỗi ngày lúc ${hour}:00 (${timeZone})`);
  return () => clearInterval(timer);
}
