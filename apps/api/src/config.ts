/**
 * P&N — Cấu hình tiến trình API, đọc một lần lúc khởi động.
 *
 * §19: file này chỉ đọc những gì bắt buộc phải nằm ở tầng hạ tầng — chuỗi kết
 * nối và khoá chính. API key của provider AI và của các tích hợp KHÔNG đọc từ
 * đây; chúng nằm mã hoá trong database và đi qua kho secret (§69).
 */

import type { Environment } from '@pn/shared';

export interface ApiConfig {
  nodeEnv: string;
  environment: Environment;
  port: number;
  host: string;
  publicUrl: string;
  webUrl: string;
  /** Mọi origin được phép gọi API từ trình duyệt: web local, web trên Vercel, đường hầm. */
  webOrigins: string[];
  /** Origin dùng cho link gửi ra ngoài (Telegram): đường hầm nếu có, không thì web local. */
  webLinkOrigin: string;
  databaseUrl: string;
  databaseSsl: boolean;
  masterKey: string;
  jwtSecret: string;
  sessionTtlHours: number;
  sandboxRoot: string;
  sandboxTimeoutMs: number;
  /** §18 — 'local' hoặc 'docker'. Docker cô lập RAM/CPU/mạng thật. */
  sandboxDriver: 'local' | 'docker';
  sandboxImage: string;
  /**
   * §21, §23 — có Redis thì event đi qua pub/sub và việc xếp vào BullMQ, nên
   * tiến trình worker chạy được. Không có thì mọi thứ chạy trong tiến trình API,
   * đúng như từ trước tới nay.
   */
  redisUrl: string | null;
  /**
   * §106, §131 — lịch khám phá kiến thức. Mặc định TẮT vì mỗi vòng tốn tiền
   * model; nó phải là thứ người dùng bật lên có ý thức (§132).
   */
  knowledgeDiscovery: { enabled: boolean; hour: number; topics: string[]; sendDigest: boolean };
  /** Bản tin sức khoẻ mỗi sáng qua Telegram; giờ tính theo múi giờ của CEO. */
  dailyBrief: { enabled: boolean; hour: number; timeZone: string };
  defaultProjectBudgetUsd: number;
  budgetWarnThreshold: number;
  budgetHardStop: boolean;
}

class ConfigError extends Error {
  constructor(missing: string[]) {
    super(
      `Thiếu biến môi trường bắt buộc: ${missing.join(', ')}. ` +
        'Sao chép .env.example thành .env rồi điền vào.',
    );
    this.name = 'ConfigError';
  }
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Kiểm tra hết một lượt rồi mới báo, để người dùng không phải chạy lại nhiều lần.
  const missing: string[] = [];
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) {
      missing.push(key);
      return '';
    }
    return value;
  };

  const databaseUrl = required('DATABASE_URL');
  const masterKey = required('PN_MASTER_KEY');
  const jwtSecret = required('JWT_SECRET');

  if (missing.length > 0) throw new ConfigError(missing);

  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const environment: Environment =
    nodeEnv === 'production' ? 'production' : nodeEnv === 'staging' ? 'staging' : 'development';

  return {
    nodeEnv,
    environment,
    port: num(env['API_PORT'], 4000),
    host: env['API_HOST'] ?? '0.0.0.0',
    publicUrl: env['API_PUBLIC_URL'] ?? 'http://localhost:4000',
    webUrl: env['WEB_PUBLIC_URL'] ?? 'http://localhost:3000',
    webLinkOrigin: (env['WEB_TUNNEL_ORIGIN'] || env['WEB_PUBLIC_URL'] || 'http://localhost:3000').replace(/\/+$/, ''),
    webOrigins: [
      env['WEB_PUBLIC_URL'] ?? 'http://localhost:3000',
      ...(env['WEB_EXTRA_ORIGINS'] ?? '').split(','),
      env['WEB_TUNNEL_ORIGIN'] ?? '',
    ]
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin, index, list) => origin !== '' && list.indexOf(origin) === index),
    databaseUrl,
    databaseSsl: env['DATABASE_SSL'] === 'true',
    masterKey,
    jwtSecret,
    sessionTtlHours: num(env['SESSION_TTL_HOURS'], 12),
    sandboxRoot: env['SANDBOX_ROOT'] ?? './workspaces',
    // Trần cho CẢ một lượt agent (nhiều lần gọi model + lệnh sandbox). 10 phút từng cắt ngang Opus đang
    // viết cả ứng dụng Electron — 30 phút mới đủ cho việc lập trình dài.
    sandboxTimeoutMs: num(env['SANDBOX_TIMEOUT_MS'], 1_800_000),
    // Mặc định 'local' vì nó chạy được ở mọi máy. Máy nào có Docker thì đặt
    // SANDBOX_DRIVER=docker để có thêm giới hạn RAM/CPU và cắt mạng thật.
    sandboxDriver: env['SANDBOX_DRIVER'] === 'docker' ? 'docker' : 'local',
    sandboxImage: env['SANDBOX_IMAGE'] ?? 'node:22-bookworm-slim',
    redisUrl: env['REDIS_URL'] && env['REDIS_URL'].length > 0 ? env['REDIS_URL'] : null,
    knowledgeDiscovery: {
      enabled: env['KNOWLEDGE_DISCOVERY'] === 'daily',
      hour: Math.min(23, Math.max(0, num(env['KNOWLEDGE_DISCOVERY_HOUR'], 7))),
      topics: (env['KNOWLEDGE_TOPICS'] ?? '')
        .split(',')
        .map((topic) => topic.trim())
        .filter(Boolean),
      sendDigest: env['KNOWLEDGE_DIGEST_TELEGRAM'] === 'true',
    },
    dailyBrief: {
      enabled: env['PN_DAILY_BRIEF'] !== 'off',
      hour: Math.min(23, Math.max(0, num(env['PN_DAILY_BRIEF_HOUR'], 8))),
      timeZone: env['PN_TIMEZONE'] ?? 'Asia/Ho_Chi_Minh',
    },
    defaultProjectBudgetUsd: num(env['DEFAULT_PROJECT_BUDGET_USD'], 20),
    budgetWarnThreshold: num(env['BUDGET_WARN_THRESHOLD'], 0.8),
    budgetHardStop: env['BUDGET_HARD_STOP'] !== 'false',
  };
}
