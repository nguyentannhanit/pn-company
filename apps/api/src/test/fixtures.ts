/**
 * P&N — Test double cho tầng dữ liệu.
 *
 * Máy build không có PostgreSQL, nhưng §89 vẫn bắt buộc phải có test chứng minh
 * secret không lọt ra API response. Bộ giả lập này thay đúng phần database, giữ
 * nguyên toàn bộ code thật của route, plugin, gateway, redaction và kho secret —
 * nên thứ được kiểm chứng vẫn là hành vi thật của hệ thống.
 */

import type { Repositories } from '@pn/database';
import { InMemoryEventBus } from '@pn/events';
import { ModelCatalog, ProviderRegistry, type LLMProvider } from '@pn/llm';
import { AgentRegistry, coreAgents, webAgents } from '@pn/agents';
import { AgentStateService, OrchestratorEngine } from '@pn/orchestrator';
import { InMemorySecretStorage, SecretStore, generateMasterKey, parseMasterKey } from '@pn/secrets';
import { agentProfile, newId, type Agent, type Uuid } from '@pn/shared';

import { buildApp } from '../app.js';
import { loadConfig, type ApiConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { InProcessAgentGateway } from '../services/agent-gateway.js';

import { AiGateway } from '../services/ai-gateway.js';

/* -------------------------------------------------------------------------- */
/* Cấu hình test                                                               */
/* -------------------------------------------------------------------------- */

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://test/test',
    PN_MASTER_KEY: generateMasterKey(),
    JWT_SECRET: 'test-jwt-secret-khong-dung-that',
    WEB_PUBLIC_URL: 'http://localhost:3000',
  } as NodeJS.ProcessEnv);
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* Kho dữ liệu trong bộ nhớ                                                    */
/* -------------------------------------------------------------------------- */

interface Store {
  users: Map<string, Record<string, unknown>>;
  agents: Map<string, Agent>;
  providers: Map<string, Record<string, unknown>>;
  models: Map<string, Record<string, unknown>>;
  routes: Map<string, Record<string, unknown>>;
  integrations: Map<string, Record<string, unknown>>;
  settings: Map<string, unknown>;
  audit: Array<Record<string, unknown>>;
  costs: Array<Record<string, unknown>>;
  requestLogs: Array<Record<string, unknown>>;
  budgets: Array<Record<string, unknown>>;
  projects: Map<string, Record<string, unknown>>;
  approvals: Map<string, Record<string, unknown>>;
  tasks: Map<string, Record<string, unknown>>;
  taskDeps: Map<string, string[]>;
  runs: Map<string, Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
  deployments: Map<string, Record<string, unknown>>;
}

function emptyStore(): Store {
  return {
    users: new Map(),
    agents: new Map(),
    providers: new Map(),
    models: new Map(),
    routes: new Map(),
    integrations: new Map(),
    settings: new Map(),
    audit: [],
    costs: [],
    requestLogs: [],
    budgets: [],
    projects: new Map(),
    approvals: new Map(),
    tasks: new Map(),
    taskDeps: new Map(),
    runs: new Map(),
    messages: [],
    deployments: new Map(),
  };
}

const now = (): string => new Date().toISOString();

/**
 * Dựng bộ repository giả. Chỉ hiện thực những phương thức mà các route đang test
 * thật sự gọi; phần còn lại để nguyên và sẽ báo lỗi rõ nếu ai đó gọi tới.
 */
function createFakeRepositories(store: Store): Repositories {
  const bugs: Array<Record<string, unknown>> = [];
  const secretStorage = new InMemorySecretStorage();

  const repos = {
    secretStorage,

    users: {
      async count() {
        return store.users.size;
      },
      async create(input: Record<string, unknown>) {
        const user = {
          id: newId(),
          email: input['email'],
          displayName: input['displayName'],
          role: input['role'],
          telegramChatId: input['telegramChatId'] ?? null,
          isActive: true,
          lastLoginAt: null,
          access: null,
          mustChangePassword: false,
          inviteExpiresAt: null,
          sessionVersion: 0,
          createdAt: now(),
          updatedAt: now(),
          passwordHash: input['passwordHash'],
        };
        store.users.set(user.id, user);
        return user;
      },
      // Tài khoản & quyền: bản giả đủ cho các route mời, khoá, đổi quyền.
      async createInvited(input: Record<string, unknown>) {
        const user = {
          id: newId(),
          email: input['email'],
          displayName: input['displayName'],
          role: input['role'],
          telegramChatId: null,
          isActive: true,
          lastLoginAt: null,
          access: input['access'] ?? null,
          mustChangePassword: input['mustChangePassword'],
          inviteExpiresAt: input['inviteExpiresAt'] ? (input['inviteExpiresAt'] as Date).toISOString() : null,
          inviteTokenHash: input['inviteTokenHash'],
          sessionVersion: 0,
          createdAt: now(),
          updatedAt: now(),
          passwordHash: input['passwordHash'],
        };
        store.users.set(user.id, user);
        const { passwordHash: _hash, inviteTokenHash: _invite, ...safe } = user;
        return safe;
      },
      async updateProfile(id: string, input: Record<string, unknown>) {
        const user = store.users.get(id);
        if (!user) return null;
        for (const key of ['role', 'access', 'displayName']) if (input[key] !== undefined) user[key] = input[key];
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async setActive(id: string, active: boolean) {
        const user = store.users.get(id);
        if (!user) return null;
        user['isActive'] = active;
        if (!active) user['sessionVersion'] = Number(user['sessionVersion'] ?? 0) + 1;
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async revokeSessions(id: string) {
        const user = store.users.get(id)!;
        user['sessionVersion'] = Number(user['sessionVersion'] ?? 0) + 1;
      },
      async setInvite(id: string, hash: string | null, expiresAt: Date | null) {
        const user = store.users.get(id)!;
        user['inviteTokenHash'] = hash;
        user['inviteExpiresAt'] = expiresAt ? expiresAt.toISOString() : null;
      },
      async findByInviteHash(hash: string) {
        const user = [...store.users.values()].find(
          (item) => item['inviteTokenHash'] === hash && Date.parse(String(item['inviteExpiresAt'])) > Date.now(),
        );
        if (!user) return null;
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async setPassword(id: string, passwordHash: string) {
        const user = store.users.get(id)!;
        Object.assign(user, { passwordHash, mustChangePassword: false, inviteTokenHash: null, inviteExpiresAt: null });
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async unlinkTelegram(id: string) {
        store.users.get(id)!['telegramChatId'] = null;
      },
      async remove(id: string) {
        store.users.delete(id);
      },
      async findByEmailWithSecret(email: string) {
        return (
          [...store.users.values()].find(
            (user) => String(user['email']).toLowerCase() === email.toLowerCase(),
          ) ?? null
        );
      },
      async findById(id: string) {
        const user = store.users.get(id);
        if (!user) return null;
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async list() {
        return [...store.users.values()].map(({ passwordHash: _hash, ...safe }) => safe);
      },
      async touchLogin(id: string) {
        const user = store.users.get(id);
        if (user) user['lastLoginAt'] = now();
      },
      async findByTelegramChatId(chatId: string) {
        const user = [...store.users.values()].find((item) => item['telegramChatId'] === chatId);
        if (!user) return null;
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
      async linkTelegramChat(id: string, chatId: string) {
        for (const user of store.users.values()) {
          if (user['telegramChatId'] === chatId && user['id'] !== id) user['telegramChatId'] = null;
        }
        const user = store.users.get(id)!;
        user['telegramChatId'] = chatId;
        const { passwordHash: _hash, ...safe } = user;
        return safe;
      },
    },

    agents: {
      async upsert(input: { role: string; displayName: string; department: string }) {
        const existing = store.agents.get(input.role);
        const agent = {
          ...(existing ?? {
            id: newId(),
            state: 'idle',
            currentTaskId: null,
            currentProjectId: null,
            isEnabled: true,
            profileVersion: 1,
            xp: 0,
            stateChangedAt: now(),
            createdAt: now(),
            updatedAt: now(),
          }),
          role: input.role,
          displayName: input.displayName,
          department: input.department,
        } as Agent;
        store.agents.set(input.role, agent);
        return agent;
      },
      async findByRole(role: string) {
        return store.agents.get(role) ?? null;
      },
      async findById(id: string) {
        return [...store.agents.values()].find((agent) => agent.id === id) ?? null;
      },
      async list() {
        return [...store.agents.values()];
      },
      async setState(id: string, state: string, ctx: Record<string, unknown>) {
        const agent = [...store.agents.values()].find((a) => a.id === id)!;
        const updated = {
          ...agent,
          state,
          currentTaskId: (ctx['taskId'] as Uuid) ?? null,
          currentProjectId: (ctx['projectId'] as Uuid) ?? null,
          stateChangedAt: now(),
        } as Agent;
        store.agents.set(agent.role, updated);
        return updated;
      },
      async setEnabled() {},
      async addXp() {},
    },

    providers: {
      async upsert(input: Record<string, unknown>) {
        const key = `${String(input['provider'])}:${String(input['environment'])}`;
        const existing = store.providers.get(key);
        const saved = {
          id: (existing?.['id'] as string) ?? newId(),
          status: existing?.['status'] ?? 'NOT_CONFIGURED',
          lastTestedAt: existing?.['lastTestedAt'] ?? null,
          lastError: existing?.['lastError'] ?? null,
          ...input,
          keyPreview: input['keyPreview'] ?? existing?.['keyPreview'] ?? null,
          secretRef: input['secretRef'] ?? existing?.['secretRef'] ?? null,
          createdAt: existing?.['createdAt'] ?? now(),
          updatedAt: now(),
        };
        store.providers.set(key, saved);
        return saved;
      },
      async recordTest(provider: string, environment: string, result: Record<string, unknown>) {
        const key = `${provider}:${environment}`;
        const existing = store.providers.get(key);
        if (!existing) return;
        existing['status'] = result['ok'] ? 'CONNECTED' : 'ERROR';
        existing['lastTestedAt'] = now();
        existing['lastError'] = result['error'] ?? null;
      },
      async setEnabled(provider: string, environment: string, isEnabled: boolean) {
        const existing = store.providers.get(`${provider}:${environment}`);
        if (existing) existing['isEnabled'] = isEnabled;
      },
      async clearKey(provider: string, environment: string) {
        const existing = store.providers.get(`${provider}:${environment}`);
        if (!existing) return null;
        Object.assign(existing, { secretRef: null, keyPreview: null, isEnabled: false, status: 'NOT_CONFIGURED', lastError: null, lastTestedAt: null });
        return existing;
      },
      async find(provider: string, environment: string) {
        return store.providers.get(`${provider}:${environment}`) ?? null;
      },
      async list(environment: string) {
        return [...store.providers.values()].filter((p) => p['environment'] === environment);
      },
      async listReady(environment: string) {
        return [...store.providers.values()].filter(
          (p) => p['environment'] === environment && p['isEnabled'] && (p['secretRef'] || p['provider'] === 'claude-code' || p['provider'] === 'codex'),
        );
      },
    },

    models: {
      async upsertMany(models: Array<Record<string, unknown>>) {
        for (const model of models) store.models.set(String(model['id']), model);
      },
      async setPricing(id: string, pricing: Record<string, unknown>) {
        const model = store.models.get(id);
        if (model) Object.assign(model, pricing, { pricingSource: 'operator' });
      },
      async list(provider?: string) {
        const all = [...store.models.values()];
        return provider ? all.filter((m) => m['provider'] === provider) : all;
      },
    },

    routes: {
      async upsert(input: Record<string, unknown>) {
        const key = `${String(input['agentRole'])}:${String(input['environment'])}`;
        const saved = { id: newId(), ...input, createdAt: now(), updatedAt: now() };
        store.routes.set(key, saved);
        return saved;
      },
      async list(environment: string) {
        return [...store.routes.values()].filter((r) => r['environment'] === environment);
      },
      async find(agentRole: string, environment: string) {
        return store.routes.get(`${agentRole}:${environment}`) ?? null;
      },
    },

    integrations: {
      async upsert(input: Record<string, unknown>) {
        const key = `${String(input['kind'])}:${String(input['environment'])}`;
        const existing = store.integrations.get(key);
        const saved = {
          id: (existing?.['id'] as string) ?? newId(),
          status: existing?.['status'] ?? 'NOT_CONFIGURED',
          lastTestedAt: null,
          lastError: null,
          ...input,
          createdAt: existing?.['createdAt'] ?? now(),
          updatedAt: now(),
        };
        store.integrations.set(key, saved);
        return saved;
      },
      async recordTest(kind: string, environment: string, result: Record<string, unknown>) {
        const existing = store.integrations.get(`${kind}:${environment}`);
        if (existing) {
          existing['status'] = result['ok'] ? 'CONNECTED' : 'ERROR';
          existing['lastError'] = result['error'] ?? null;
        }
      },
      async find(kind: string, environment: string) {
        return store.integrations.get(`${kind}:${environment}`) ?? null;
      },
      async list(environment: string) {
        return [...store.integrations.values()].filter((i) => i['environment'] === environment);
      },
    },

    settings: {
      async get(key: string) {
        return store.settings.get(key) ?? null;
      },
      async set(key: string, value: unknown) {
        store.settings.set(key, value);
      },
      async all() {
        return Object.fromEntries(store.settings);
      },
    },

    audit: {
      async record(entry: Record<string, unknown>) {
        store.audit.push({ ...entry, createdAt: now() });
      },
      async list(filter: { excludeActions?: string[]; limit?: number } = {}) {
        const skip = new Set(filter.excludeActions ?? []);
        return [...store.audit].reverse().filter((row) => !skip.has(String(row['action']))).slice(0, filter.limit ?? 100);
      },
      // Bản giả của thống kê nhật ký: đủ để route trả đúng dạng dữ liệu.
      async stats(_days: number, noiseActions: string[]) {
        const noise = store.audit.filter((row) => noiseActions.includes(String(row['action']))).length;
        return {
          total: store.audit.length,
          noise,
          since: null,
          days: [],
          errors: { clientErrors: 0, serverErrors: 0 },
          actors: { ceo: store.audit.filter((row) => String(row['actor']).startsWith('user:')).length, telegram: 0 },
          monthActions: {},
        };
      },
    },

    costs: {
      async record(entry: Record<string, unknown>) {
        const saved = { id: newId(), ...entry, createdAt: now() };
        store.costs.push(saved);
        return saved;
      },
      async today() {
        return summarise(store.costs);
      },
      async thisMonth() {
        return summarise(store.costs);
      },
      async forProject(projectId: string) {
        return summarise(store.costs.filter((c) => c['projectId'] === projectId));
      },
      async breakdown() {
        return [];
      },
      async daily() {
        return [];
      },
      async listRecent() {
        return [...store.costs].reverse();
      },
      async byRole() {
        return [];
      },
      async monthOverview() {
        const total = summarise(store.costs);
        return { monthStart: now(), costUsd: total.costUsd, calls: total.calls, daily: [], byProvider: [], byRole: [], unassigned: { costUsd: 0, calls: 0 } };
      },
      async projectTotals() {
        return [];
      },
      async countFrom() {
        return null;
      },
      async repriceUnpriced(
        modelId: string,
        pricing: { inputPerMtok: number; outputPerMtok: number; cachedInputPerMtok?: number | null },
      ) {
        const byProject = new Map<string | null, { costUsd: number; calls: number }>();
        const snapshot = new RegExp(`^${modelId}-\\d{4}-\\d{2}-\\d{2}$`);
        for (const record of store.costs) {
          const model = String(record['model']);
          if (record['costUsd'] !== null || (model !== modelId && !snapshot.test(model))) continue;
          const cost =
            (Number(record['inputTokens']) * pricing.inputPerMtok +
              Number(record['outputTokens']) * pricing.outputPerMtok +
              Number(record['cachedTokens']) * (pricing.cachedInputPerMtok ?? pricing.inputPerMtok)) /
            1_000_000;
          record['costUsd'] = Math.round(cost * 1e6) / 1e6;
          const key = (record['projectId'] as string | null) ?? null;
          const current = byProject.get(key) ?? { costUsd: 0, calls: 0 };
          byProject.set(key, { costUsd: current.costUsd + cost, calls: current.calls + 1 });
        }
        return [...byProject.entries()].map(([projectId, row]) => ({ projectId, ...row }));
      },
    },

    budgets: {
      async upsert(policy: Record<string, unknown>) {
        store.budgets.push(policy);
      },
      async list() {
        return store.budgets;
      },
      async projectStatus() {
        return null;
      },
      async globalStatus() {
        return null;
      },
    },

    requestLogs: {
      async record(entry: Record<string, unknown>) {
        store.requestLogs.push(entry);
      },
      async health() {
        return [];
      },
      // Gộp lượt gọi theo vai trò / hãng từ các bản ghi đã lưu (bản giả bỏ qua mốc thời gian).
      async byRole() {
        const map = new Map<string, { role: string; calls: number; ok: number; avgLatencyMs: number | null }>();
        for (const row of store.requestLogs) {
          const role = row['agentRole'] as string | null;
          if (!role) continue;
          const item = map.get(role) ?? { role, calls: 0, ok: 0, avgLatencyMs: null };
          item.calls += 1;
          if (row['ok']) item.ok += 1;
          map.set(role, item);
        }
        return [...map.values()];
      },
      async byProvider() {
        const map = new Map<string, { provider: string; calls: number; ok: number; avgLatencyMs: number | null }>();
        for (const row of store.requestLogs) {
          const provider = String(row['provider']);
          const item = map.get(provider) ?? { provider, calls: 0, ok: 0, avgLatencyMs: null };
          item.calls += 1;
          if (row['ok']) item.ok += 1;
          map.set(provider, item);
        }
        return [...map.values()];
      },
      async errorKinds() {
        return [];
      },
    },

    projects: {
      async create(input: Record<string, unknown>) {
        const project = {
          id: newId(),
          status: 'DRAFT',
          spentUsd: 0,
          defaultBranch: 'main',
          startedAt: null,
          completedAt: null,
          ...input,
          createdAt: now(),
          updatedAt: now(),
        };
        store.projects.set(project.id, project);
        return project;
      },
      async findById(id: string) {
        return store.projects.get(id) ?? null;
      },
      async findBySlug(slug: string) {
        return [...store.projects.values()].find((p) => p['slug'] === slug) ?? null;
      },
      async list() {
        return [...store.projects.values()];
      },
      async updateStatus(id: string, status: string) {
        const project = store.projects.get(id);
        if (project) project['status'] = status;
      },
      async setRepo() {},
      async addSpend() {
        return { spentUsd: 0, budgetUsd: 0 };
      },
    },

    approvals: {
      async create(input: Record<string, unknown>) {
        const approval = {
          id: newId(),
          status: 'PENDING',
          decidedByUserId: null,
          decidedAt: null,
          decisionNote: null,
          expiresAt: null,
          ...input,
          createdAt: now(),
          updatedAt: now(),
        };
        store.approvals.set(approval.id, approval);
        return approval;
      },
      async findById(id: string) {
        return store.approvals.get(id) ?? null;
      },
      async listPending() {
        return [...store.approvals.values()].filter((a) => a['status'] === 'PENDING');
      },
      async mergeContext(id: string, patch: Record<string, unknown>) {
        const approval = store.approvals.get(id);
        if (approval) approval['context'] = { ...(approval['context'] as object), ...patch };
      },
      async decide(id: string, decision: string, userId: string, note?: string) {
        const approval = store.approvals.get(id);
        if (!approval || approval['status'] !== 'PENDING') return null;
        Object.assign(approval, {
          status: decision,
          decidedByUserId: userId,
          decidedAt: now(),
          decisionNote: note ?? null,
        });
        return approval;
      },
      async expireOverdue() {
        return 0;
      },
    },

    // Các repository còn lại chưa được route nào trong bộ test này chạm tới.
    tasks: {
      async create(input: Record<string, unknown>) {
        const { dependsOn, ...rest } = input;
        const task: Record<string, unknown> = {
          id: newId(),
          status: 'TODO',
          assignedRole: null,
          assignedAgentId: null,
          parentTaskId: null,
          estimateMinutes: null,
          startedAt: null,
          completedAt: null,
          fixLoopCount: 0,
          ...rest,
          createdAt: now(),
          updatedAt: now(),
        };
        store.tasks.set(String(task['id']), task);
        store.taskDeps.set(String(task['id']), (dependsOn as string[] | undefined) ?? []);
        return task;
      },
      async findById(id: string) {
        return store.tasks.get(id) ?? null;
      },
      async listByProject(projectId: string) {
        return [...store.tasks.values()].filter((task) => task['projectId'] === projectId);
      },
      async listReady(projectId: string) {
        return [...store.tasks.values()].filter(
          (task) =>
            task['projectId'] === projectId &&
            task['status'] === 'TODO' &&
            (store.taskDeps.get(String(task['id'])) ?? []).every(
              (dep) => store.tasks.get(dep)?.['status'] === 'DONE',
            ),
        );
      },
      async setStatus(id: string, status: string) {
        const task = store.tasks.get(id);
        if (task) task['status'] = status;
        return task;
      },
      async requeueInProgress(exceptIds: string[] = []) {
        const projects = new Set<string>();
        for (const task of store.tasks.values()) {
          if (task['status'] !== 'IN_PROGRESS' || exceptIds.includes(String(task['id']))) continue;
          if (store.projects.get(String(task['projectId']))?.['status'] !== 'IN_PROGRESS') continue;
          task['status'] = 'TODO';
          projects.add(String(task['projectId']));
        }
        return [...projects];
      },
      async assign(id: string, agentId: string, role: string) {
        const task = store.tasks.get(id);
        if (task) Object.assign(task, { assignedAgentId: agentId, assignedRole: role });
      },
      async resetFixLoop(id: string) {
        const task = store.tasks.get(id);
        if (task) task['fixLoopCount'] = 0;
      },
      async incrementFixLoop(id: string) {
        const task = store.tasks.get(id);
        if (!task) return 0;
        task['fixLoopCount'] = Number(task['fixLoopCount'] ?? 0) + 1;
        return task['fixLoopCount'] as number;
      },
      async dependencies(taskId: string) {
        return store.taskDeps.get(taskId) ?? [];
      },
      async addDependencies(taskId: string, dependsOn: string[]) {
        const current = store.taskDeps.get(taskId) ?? [];
        store.taskDeps.set(taskId, [
          ...new Set([...current, ...dependsOn.filter((dep) => dep !== taskId)]),
        ]);
      },
      async listByStage(projectId: string, stageId: string) {
        return [...store.tasks.values()].filter(
          (task) => task['projectId'] === projectId && task['stageId'] === stageId,
        );
      },
      async countByStatus(projectId: string) {
        const counts: Record<string, number> = {};
        for (const task of store.tasks.values()) {
          if (task['projectId'] !== projectId) continue;
          const status = String(task['status']);
          counts[status] = (counts[status] ?? 0) + 1;
        }
        return counts;
      },
    },

    // §142 — test API chạy với công ty chưa học được gì; agent dùng đúng prompt vai trò.
    knowledgeItems: {
      async activeForRole() {
        return [];
      },
    },

    runs: {
      async create(input: Record<string, unknown>) {
        const run = { id: newId(), status: 'QUEUED', ...input, createdAt: now() };
        store.runs.set(run.id, run);
        return run;
      },
      async markRunning(id: string, workspace: string) {
        const run = store.runs.get(id);
        if (run) Object.assign(run, { status: 'RUNNING', workspace });
      },
      async finish(id: string, result: Record<string, unknown>) {
        const run = store.runs.get(id);
        if (run) Object.assign(run, result, { finishedAt: now() });
      },
      async failOrphans(reason: string) {
        let count = 0;
        for (const run of store.runs.values()) {
          if (run['status'] !== 'QUEUED' && run['status'] !== 'RUNNING') continue;
          Object.assign(run, { status: 'FAILED', errorMessage: reason, finishedAt: now() });
          count += 1;
        }
        return count;
      },
      async listByTask(taskId: string) {
        return [...store.runs.values()].filter((run) => run['taskId'] === taskId);
      },
      async listRecentByAgent(agentId: string) {
        return [...store.runs.values()].filter((run) => run['agentId'] === agentId);
      },
    },

    messages: {
      async append(input: Record<string, unknown>) {
        const message = { id: newId(), ...input, createdAt: now() };
        store.messages.push(message);
        return message;
      },
      async listByTask(taskId: string) {
        return store.messages.filter((message) => message['taskId'] === taskId);
      },
    },

    // Lỗi: đủ cho vòng sửa khép kín — gộp trùng, đóng theo người báo, bỏ qua theo task.
    bugs: {
      async create(input: Record<string, unknown>) {
        const bug = { id: newId(), status: 'OPEN', ...input, createdAt: now() };
        bugs.push(bug);
        return bug;
      },
      async upsertOpen(input: Record<string, unknown>) {
        const open = bugs.find((bug) => bug['projectId'] === input['projectId'] && bug['title'] === input['title'] && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'));
        if (open) {
          Object.assign(open, { description: input['description'], severity: input['severity'], status: 'OPEN' });
          return { bug: open, created: false };
        }
        const bug = { id: newId(), status: 'OPEN', ...input, createdAt: now() };
        bugs.push(bug);
        return { bug, created: true };
      },
      async setStatus(id: string, status: string) {
        const bug = bugs.find((item) => item['id'] === id);
        if (bug) bug['status'] = status;
      },
      async resolveByReporter(projectId: string, reporter: string, status: string) {
        const open = bugs.filter((bug) => bug['projectId'] === projectId && bug['reportedByAgentId'] === reporter && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'));
        for (const bug of open) bug['status'] = status;
        return open.length;
      },
      async waiveForTask(projectId: string, taskId: string) {
        const open = bugs.filter((bug) => bug['projectId'] === projectId && bug['taskId'] === taskId && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'));
        for (const bug of open) bug['status'] = 'WONTFIX';
        return open.length;
      },
      async countOpen(projectId: string) {
        return bugs.filter((bug) => bug['projectId'] === projectId && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS')).length;
      },
      async listByProject(projectId: string, status?: string) {
        return bugs.filter((bug) => bug['projectId'] === projectId && (!status || bug['status'] === status));
      },
      async findById(id: string) {
        return bugs.find((bug) => bug['id'] === id) ?? null;
      },
    },
    deployments: {
      async failOrphans() {
        let count = 0;
        for (const row of store.deployments.values()) {
          if (row['status'] !== 'IN_PROGRESS') continue;
          row['status'] = 'FAILED';
          count += 1;
        }
        return count;
      },
      async create(input: Record<string, unknown>) {
        const row = { id: newId(), status: 'PENDING', url: null, logExcerpt: null, commitSha: null, approvalId: null, startedAt: null, finishedAt: null, ...input, createdAt: now(), updatedAt: now() };
        store.deployments.set(row.id, row);
        return row;
      },
      async setStatus(id: string, status: string, extra: { url?: string | null; logExcerpt?: string | null } = {}) {
        const row = store.deployments.get(id);
        if (row) Object.assign(row, { status, url: extra.url ?? row['url'], logExcerpt: extra.logExcerpt ?? row['logExcerpt'] });
      },
      async findById(id: string) {
        return store.deployments.get(id) ?? null;
      },
      async listByProject(projectId: string) {
        return [...store.deployments.values()].filter((row) => row['projectId'] === projectId);
      },
      async listRecent(limit = 50) {
        return [...store.deployments.values()].reverse().slice(0, limit);
      },
    },
    notifications: notImplemented('notifications'),
    gitEvents: notImplemented('gitEvents'),
  };

  return repos as unknown as Repositories;
}

function summarise(rows: Array<Record<string, unknown>>): Record<string, number> {
  return {
    costUsd: rows.reduce((sum, row) => sum + Number(row['costUsd'] ?? 0), 0),
    inputTokens: rows.reduce((sum, row) => sum + Number(row['inputTokens'] ?? 0), 0),
    outputTokens: rows.reduce((sum, row) => sum + Number(row['outputTokens'] ?? 0), 0),
    cachedTokens: 0,
    calls: rows.length,
    unpricedCalls: rows.filter((row) => row['costUsd'] === null).length,
  };
}

/** Bẫy rõ ràng nếu test vô tình gọi vào phần chưa giả lập. */
function notImplemented(name: string): Record<string, never> {
  return new Proxy({} as Record<string, never>, {
    get(_target, method) {
      throw new Error(`Repository "${name}.${String(method)}" chưa được giả lập trong test`);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Provider giả lập                                                            */
/* -------------------------------------------------------------------------- */

/** Provider trả lỗi có chứa API key — dùng để chứng minh redaction hoạt động. */
export function leakyProvider(apiKey: string): LLMProvider {
  return {
    id: 'anthropic',
    displayName: 'Anthropic (giả lập)',
    async generate() {
      throw new Error(`upstream rejected key ${apiKey}`);
    },
    async *stream() {},
    estimateCost: () => null,
    async listModels() {
      return [];
    },
    async testConnection() {
      return {
        ok: false,
        latencyMs: 1,
        model: null,
        error: `invalid api key: ${apiKey}`,
        checkedAt: now(),
      };
    },
  } as unknown as LLMProvider;
}

/**
 * Provider chạy được: Test Connection thành công và `generate` trả về JSON hợp
 * lệ cho bước phân rã của CTO. Dùng để kiểm tra đường đi thuận lợi.
 */
export function workingProvider(): LLMProvider {
  return {
    id: 'anthropic',
    displayName: 'Anthropic (giả lập chạy được)',
    async generate() {
      return {
        text: JSON.stringify({
          projectName: 'Dự án thử',
          summary: 'Kế hoạch thử nghiệm',
          tasks: [{ title: 'Dựng khung', description: 'Tạo khung dự án', role: 'DEVELOPER' }],
        }),
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        usage: { inputTokens: 10, outputTokens: 10 },
        finishReason: 'stop',
      };
    },
    async *stream() {},
    estimateCost: () => 0,
    async listModels() {
      return [{ id: 'claude-sonnet-5', displayName: 'Sonnet 5' }];
    },
    async testConnection() {
      return { ok: true, latencyMs: 1, model: 'claude-sonnet-5', error: null, checkedAt: now() };
    },
  } as unknown as LLMProvider;
}

/* -------------------------------------------------------------------------- */
/* Dựng ứng dụng test                                                          */
/* -------------------------------------------------------------------------- */

export interface TestHarness {
  app: Awaited<ReturnType<typeof buildApp>>;
  context: AppContext;
  store: Store;
  /** Đăng nhập nhanh với vai trò CEO, trả về token. */
  loginAsCeo: () => Promise<string>;
}

export async function createTestApp(overrides: Partial<ApiConfig> = {}): Promise<TestHarness> {
  const config = testConfig(overrides);
  const store = emptyStore();
  const repos = createFakeRepositories(store);

  const events = new InMemoryEventBus();
  const catalog = new ModelCatalog();
  const registry = new ProviderRegistry(catalog);
  const secrets = new SecretStore({
    storage: repos.secretStorage,
    activeKey: parseMasterKey(config.masterKey),
    environment: config.environment,
  });

  const gateway = new AiGateway({ config, repos, registry, catalog, events });
  const agentState = new AgentStateService(repos, events);
  const agents = new AgentRegistry();
  for (const agent of [...coreAgents(), ...webAgents()]) agents.register(agent);

  const sandboxDouble = {
    id: 'local',
    enforcement: {
      workspaceIsolation: true,
      timeout: true,
      commandAllowList: true,
      envAllowList: true,
      memoryLimit: false,
      networkPolicy: false,
      note: 'test',
    },
    async create() {
      throw new Error('sandbox không dùng trong bộ test này');
    },
    async healthCheck() {
      return { ok: true, detail: 'test' };
    },
  } as unknown as AppContext['sandbox'];

  const context: AppContext = {
    config,
    db: {
      async healthCheck() {
        return { ok: true, latencyMs: 1, error: null };
      },
      async close() {},
    } as unknown as AppContext['db'],
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
      sandbox: sandboxDouble,
      github: async () => null,
    }),
    sandbox: sandboxDouble,
    // Test chạy không Redis: hàng đợi nằm trong bộ nhớ, API tự chạy agent.
    jobQueue: null,
    github: async () => null,
    shutdown: async () => {
      await events.close();
    },
  };

  // Tạo sẵn agent để route /agents có dữ liệu, dùng đúng hàm seed thật.
  for (const role of ['CTO_ORCHESTRATOR', 'QA'] as const) {
    const profile = agentProfile(role);
    await repos.agents.upsert({ role, ...profile });
  }

  const app = await buildApp(context);
  await app.ready();

  return {
    app,
    context,
    store,
    loginAsCeo: async () => {
      await app.inject({
        method: 'POST',
        url: '/auth/bootstrap',
        payload: {
          email: 'ceo@pn.test',
          password: 'mat-khau-du-manh-123',
          displayName: 'CEO P&N',
        },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'ceo@pn.test', password: 'mat-khau-du-manh-123' },
      });
      return (login.json() as { token: string }).token;
    },
  };
}
