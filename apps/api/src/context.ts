/**
 * P&N — Bối cảnh ứng dụng: mọi dịch vụ dùng chung được dựng một lần ở đây.
 *
 * Route không tự tạo kết nối hay client; chúng nhận qua `AppContext`. Nhờ vậy
 * chỉ có một chỗ biết cách nối database, kho secret, provider AI và sandbox.
 */

import { AgentRegistry, coreAgents, webAgents } from '@pn/agents';
import { Database, createRepositories, type Repositories } from '@pn/database';
import { InMemoryEventBus, RedisEventBus, type EventBus } from '@pn/events';
import { GitHubClient } from '@pn/github';
import {
  ModelCatalog,
  ProviderRegistry,
  type LLMProvider,
} from '@pn/llm';
import { DockerSandboxDriver, LocalSandboxDriver, type SandboxDriver } from '@pn/sandbox';
import { AgentStateService, BullMqJobQueue, OrchestratorEngine } from '@pn/orchestrator';
import { SecretStore, parseMasterKey, secretRef } from '@pn/secrets';
import { branding, isCliProvider, type AiProviderId } from '@pn/shared';

import type { ApiConfig } from './config.js';
import { InProcessAgentGateway } from './services/agent-gateway.js';

import { AiGateway } from './services/ai-gateway.js';

export interface AppContext {
  config: ApiConfig;
  db: Database;
  repos: Repositories;
  secrets: SecretStore;
  events: EventBus;
  registry: ProviderRegistry;
  catalog: ModelCatalog;
  gateway: AiGateway;
  agentState: AgentStateService;
  /** Bộ agent đã đăng ký của giai đoạn hiện tại (§35). */
  agents: AgentRegistry;
  /** Engine chạy vòng sản xuất §4. */
  orchestrator: OrchestratorEngine;
  sandbox: SandboxDriver;
  /** §23, §74 — chỉ có khi chạy qua Redis; `null` nghĩa là API tự chạy agent. */
  jobQueue: BullMqJobQueue<{ taskId: string; projectId: string }> | null;
  /** Client GitHub chỉ tồn tại khi tích hợp đã được cấu hình (§59). */
  github: () => Promise<GitHubClient | null>;
  shutdown: () => Promise<void>;
}

export async function createContext(config: ApiConfig): Promise<AppContext> {
  const db = new Database({ connectionString: config.databaseUrl, ssl: config.databaseSsl });
  const repos = createRepositories(db);

  const secrets = new SecretStore({
    storage: repos.secretStorage,
    activeKey: parseMasterKey(config.masterKey),
    environment: config.environment,
  });

  // §21 — có Redis thì event ra khỏi tiến trình này được, nên worker chạy riêng
  // vẫn làm văn phòng 3D chuyển động. Không có thì bus trong bộ nhớ, và mọi thứ
  // chạy trong đúng tiến trình API.
  const events: EventBus = config.redisUrl
    ? new RedisEventBus({ redisUrl: config.redisUrl })
    : new InMemoryEventBus();
  const catalog = new ModelCatalog();
  const registry = new ProviderRegistry(catalog);

  const agentState = new AgentStateService(repos, events);
  const gateway = new AiGateway({ config, repos, registry, catalog, events });

  // §18 — driver chọn bằng cấu hình. Cả hai cùng một hợp đồng nên phần còn lại
  // của hệ thống không biết mình đang chạy trên cái nào; khác biệt duy nhất lộ
  // ra ngoài là `enforcement`, thứ System Health hiển thị nguyên văn (§89).
  const sandbox: SandboxDriver =
    config.sandboxDriver === 'docker'
      ? new DockerSandboxDriver({ root: config.sandboxRoot, image: config.sandboxImage })
      : new LocalSandboxDriver({ root: config.sandboxRoot });

  // §35 — chỉ đăng ký các agent đã có hiện thực. Vai trò của phase sau vẫn tồn
  // tại trong database (để văn phòng 3D hiện đủ phòng ban) nhưng chưa nhận việc.
  const agents = new AgentRegistry();
  for (const agent of [...coreAgents(), ...webAgents()]) agents.register(agent);

  // Giữ tham chiếu riêng để System Health hỏi được hàng đợi: bật Redis mà quên
  // chạy worker thì task nằm im, và đó là thứ phải nhìn thấy chứ không đoán (§74).
  const bullQueue = config.redisUrl ? new BullMqJobQueue({ redisUrl: config.redisUrl }) : null;

  const context: AppContext = {
    config,
    db,
    repos,
    secrets,
    events,
    registry,
    catalog,
    gateway,
    agentState,
    agents,
    orchestrator: new OrchestratorEngine({
      repos,
      events,
      agents,
      agentState,
      gateway: new InProcessAgentGateway(gateway),
      sandbox,
      github: async () => buildGitHubClient(context),
      runTimeoutMs: config.sandboxTimeoutMs,
      // §23 — có Redis thì API chỉ xếp việc, tiến trình worker gánh phần chạy.
      // Không có Redis thì hàng đợi nằm trong bộ nhớ và API tự chạy, y như cũ.
      ...(bullQueue ? { queue: () => bullQueue } : {}),
    }),
    sandbox,
    jobQueue: bullQueue,
    github: async () => buildGitHubClient(context),
    shutdown: async () => {
      // Đợi các task đang chạy kết thúc để không bỏ lại bản ghi run treo (§18).
      await context.orchestrator.drain().catch(() => undefined);
      await events.close();
      await db.close();
    },
  };

  await loadProviders(context);
  await loadRoutes(context);
  await loadModelPricing(context);

  return context;
}

/**
 * Nạp client cho các provider AI đã cấu hình. Key được giải mã ở đây và chỉ
 * sống trong bộ nhớ của tiến trình API — không đi ra ngoài (§19, §89).
 */
export async function loadProviders(context: AppContext): Promise<AiProviderId[]> {
  const loaded: AiProviderId[] = [];
  const configured = await context.repos.providers.listReady(context.config.environment);

  for (const provider of configured) {
    // CLI gói thuê bao không cần key: bật là nạp. Với Claude, "key" là token dài hạn (không bắt buộc).
    const cli = isCliProvider(provider.provider);
    if (!provider.secretRef && !cli) continue;
    const apiKey = provider.secretRef ? await context.secrets.reveal(provider.secretRef).catch(() => null) : '';
    if (apiKey === null && !cli) continue;

    context.registry.configure(provider.provider, {
      apiKey: apiKey ?? '',
      baseUrl: provider.baseUrl,
      defaultModel: provider.defaultModel,
    });
    loaded.push(provider.provider);
  }
  return loaded;
}

/** Nạp bảng định tuyến từ database vào router (§50). */
export async function loadRoutes(context: AppContext): Promise<void> {
  const routes = await context.repos.routes.list(context.config.environment);
  context.gateway.setRoutes(
    routes.map((route) => ({
      agentRole: route.agentRole,
      tier: route.tier,
      provider: route.provider,
      model: route.model,
      fallbacks: route.fallbacks ?? [],
      maxOutputTokens: route.maxOutputTokens ?? null,
    })),
  );

  const mode = await context.repos.settings.get<string>('routing.mode');
  if (mode) context.gateway.setMode(mode as never);
  const smart = await context.repos.settings.get<boolean>('routing.smart');
  if (typeof smart === 'boolean') context.gateway.setSmartRouting(smart);
}

/**
 * Nạp bảng model từ database vào catalog trong bộ nhớ: model do discovery mang
 * về và giá do người vận hành nhập. Catalog khởi tạo chỉ có danh sách gốc, nên
 * không có bước này thì mỗi lần khởi động API, model đang định tuyến "biến mất"
 * khỏi catalog: giá đã nhập không gắn vào đâu và chi phí lại ghi null.
 */
export async function loadModelPricing(context: AppContext): Promise<void> {
  const models = await context.repos.models.list();
  context.catalog.upsert(
    models
      .filter((model) => !context.catalog.get(model.id))
      .map((model) => ({
        id: model.id,
        provider: model.provider,
        displayName: model.displayName,
        tier: model.tier,
        contextWindow: Number(model.contextWindow),
        maxOutputTokens: Number(model.maxOutputTokens),
        pricing: null,
        pricingSource: model.pricingSource,
        pricingAsOf: model.pricingAsOf,
      })),
  );
  for (const model of models) {
    if (model.inputPerMtok === null || model.outputPerMtok === null) continue;
    context.catalog.setPricing(model.id, {
      inputPerMTok: Number(model.inputPerMtok),
      outputPerMTok: Number(model.outputPerMtok),
      ...(model.cachedInputPerMtok !== null
        ? { cachedInputPerMTok: Number(model.cachedInputPerMtok) }
        : {}),
    });
  }
}

/** Dựng client GitHub từ cấu hình tích hợp đã lưu; chưa cấu hình thì trả null. */
async function buildGitHubClient(context: AppContext): Promise<GitHubClient | null> {
  const integration = await context.repos.integrations.find('GITHUB', context.config.environment);
  if (!integration || !integration.isEnabled) return null;

  const ref = secretRef.integration('GITHUB', 'token', context.config.environment);
  const token = await context.secrets.reveal(ref).catch(() => null);
  if (!token) return null;

  const settings = integration.settings as {
    defaultOrg?: string | null;
    protectedBranches?: string[];
  };

  return new GitHubClient({
    token,
    defaultOrg: settings.defaultOrg ?? null,
    ...(settings.protectedBranches ? { protectedBranches: settings.protectedBranches } : {}),
  });
}

/** Provider đang sẵn sàng phục vụ, dùng cho System Health (§74). */
export function readyProviders(registry: ProviderRegistry): Array<{ id: AiProviderId; provider: LLMProvider }> {
  return registry.configured().map((id) => ({ id, provider: registry.get(id) }));
}

export { branding };
