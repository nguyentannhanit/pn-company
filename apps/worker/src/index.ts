/**
 * P&N — Tiến trình worker (§18, §23).
 *
 * Nó nhận việc từ BullMQ và chạy agent trong sandbox. Tách khỏi API vì một lượt
 * agent chạy có thể mất vài phút và ăn nhiều RAM; để trong API thì một dự án
 * nặng làm chậm cả dashboard.
 *
 * Ba ranh giới được giữ nguyên như khi mọi thứ nằm trong một tiến trình:
 *   - KHÔNG giữ `PN_MASTER_KEY`. Token GitHub xin từ API qua `/internal/*`,
 *     đúng cách tiến trình Telegram bot vẫn làm (§19, §69).
 *   - KHÔNG gọi thẳng provider. Mọi lượt gọi model đi qua `/ai/generate` nên
 *     ngân sách, định tuyến và `cost_records` vẫn được áp như cũ (§89).
 *   - Event đi qua Redis pub/sub, nên văn phòng 3D vẫn thấy agent chuyển động
 *     dù việc chạy ở tiến trình khác (§21, §22).
 */

import { AgentRegistry, HttpAgentGateway, coreAgents, webAgents } from '@pn/agents';
import { Database, createRepositories } from '@pn/database';
import { RedisEventBus } from '@pn/events';
import { GitHubClient } from '@pn/github';
import { AGENT_RUN_QUEUE, AgentStateService, OrchestratorEngine, startBullMqWorker } from '@pn/orchestrator';
import { DockerSandboxDriver, LocalSandboxDriver, type SandboxDriver } from '@pn/sandbox';
import { branding } from '@pn/shared';

interface WorkerConfig {
  apiUrl: string;
  serviceSecret: string;
  redisUrl: string;
  databaseUrl: string;
  databaseSsl: boolean;
  sandboxRoot: string;
  sandboxDriver: 'local' | 'docker';
  sandboxImage: string;
}

/** Đọc cấu hình. Thiếu thứ bắt buộc thì dừng ngay kèm tên biến còn thiếu. */
function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const missing: string[] = [];
  const need = (key: string): string => {
    const value = env[key];
    if (!value) missing.push(key);
    return value ?? '';
  };

  const config: WorkerConfig = {
    apiUrl: env['API_PUBLIC_URL'] ?? 'http://127.0.0.1:4000',
    serviceSecret: need('PN_SERVICE_SECRET'),
    redisUrl: need('REDIS_URL'),
    databaseUrl: need('DATABASE_URL'),
    databaseSsl: env['DATABASE_SSL'] === 'true',
    sandboxRoot: env['SANDBOX_ROOT'] ?? './workspaces',
    sandboxDriver: env['SANDBOX_DRIVER'] === 'docker' ? 'docker' : 'local',
    sandboxImage: env['SANDBOX_IMAGE'] ?? 'node:22-bookworm-slim',
  };

  if (missing.length > 0) {
    throw new Error(
      `Worker thiếu biến môi trường: ${missing.join(', ')}. ` +
        'Chúng phải giống hệt giá trị của tiến trình API.',
    );
  }
  return config;
}

/** Xin phiên dịch vụ từ API. Đây là thứ duy nhất worker cần trước khi chạy. */
async function requestServiceToken(config: WorkerConfig): Promise<string> {
  const response = await fetch(`${config.apiUrl}/internal/service/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-pn-service-secret': config.serviceSecret,
    },
    body: JSON.stringify({ name: 'worker' }),
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      `Không lấy được phiên dịch vụ từ API (${response.status}): ${body.error ?? 'không rõ lý do'}`,
    );
  }
  return String(((await response.json()) as { token: string }).token);
}

/**
 * Lấy cấu hình GitHub từ API. Chưa cấu hình thì trả `null` — dự án không có repo
 * vẫn chạy được, chỉ là code nằm lại trong sandbox.
 */
async function buildGitHubClient(
  config: WorkerConfig,
  log: (message: string) => void,
): Promise<GitHubClient | null> {
  const response = await fetch(`${config.apiUrl}/internal/github/config`, {
    method: 'POST',
    headers: { 'x-pn-service-secret': config.serviceSecret },
  }).catch(() => null);

  if (!response || !response.ok) {
    log('chưa cấu hình GitHub — agent vẫn viết mã, chỉ không commit lên repo');
    return null;
  }

  const body = (await response.json()) as {
    token: string;
    defaultOrg: string | null;
    protectedBranches: string[];
  };

  return new GitHubClient({
    token: body.token,
    defaultOrg: body.defaultOrg,
    ...(body.protectedBranches.length > 0 ? { protectedBranches: body.protectedBranches } : {}),
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = (message: string): void => console.log(`[worker] ${message}`);

  const token = await requestServiceToken(config);
  log('đã lấy phiên dịch vụ từ API');

  const db = new Database({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  const repos = createRepositories(db);
  const events = new RedisEventBus({ redisUrl: config.redisUrl });

  const sandbox: SandboxDriver =
    config.sandboxDriver === 'docker'
      ? new DockerSandboxDriver({ root: config.sandboxRoot, image: config.sandboxImage })
      : new LocalSandboxDriver({ root: config.sandboxRoot });

  const health = await sandbox.healthCheck();
  log(`sandbox ${sandbox.id}: ${health.ok ? 'sẵn sàng' : 'CHƯA SẴN SÀNG'} — ${health.detail}`);
  if (!health.ok) throw new Error('Sandbox không dùng được, worker dừng.');

  const agents = new AgentRegistry();
  for (const agent of [...coreAgents(), ...webAgents()]) agents.register(agent);

  // Engine ở worker KHÔNG có hàng đợi riêng: nó chỉ chạy task được đưa tới.
  // Việc xếp hàng do tiến trình API làm, qua cùng một hàng đợi Redis.
  const engine = new OrchestratorEngine({
    repos,
    events,
    agents,
    agentState: new AgentStateService(repos, events),
    gateway: new HttpAgentGateway({ baseUrl: config.apiUrl, token }),
    sandbox,
    github: () => buildGitHubClient(config, log),
  });

  const worker = startBullMqWorker<{ taskId: string; projectId: string }>({
    redisUrl: config.redisUrl,
    queueName: AGENT_RUN_QUEUE,
    handler: async ({ taskId, projectId }) => {
      log(`chạy task ${taskId}`);
      await engine.runTask(taskId);
      await engine.advance(projectId);
    },
    onError: (error, payload) => {
      log(`task ${payload?.taskId ?? '?'} lỗi: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    log(`nhận ${signal}, đang tắt…`);
    await worker.close();
    await events.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log(`${branding.companyName} worker đang chờ việc trên hàng đợi ${AGENT_RUN_QUEUE}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
