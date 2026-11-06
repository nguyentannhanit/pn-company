/**
 * §4, §9, §18, §43.6 — kiểm chứng vòng sản xuất: phân rã task, chạy agent,
 * fix loop có giới hạn, và trạng thái agent luôn đi kèm event.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Agent, AgentContext, AgentOutcome } from '@pn/agents';
import { AgentRegistry } from '@pn/agents';
import type { Repositories } from '@pn/database';
import { InMemoryEventBus, type PnEvent } from '@pn/events';
import type { SandboxDriver } from '@pn/sandbox';
import { newId, type AgentRole, type Task, type Uuid } from '@pn/shared';

import { MAX_QUESTION_ROUNDS, REDO_MARKER, OrchestratorEngine, type AgentStateChanger, type OrchestratorDeps } from './engine.js';
import { MAX_FIX_LOOP_ITERATIONS } from './workflow.js';

/* -------------------------------------------------------------------------- */
/* Kho dữ liệu trong bộ nhớ                                                    */
/* -------------------------------------------------------------------------- */

interface Fake {
  repos: Repositories;
  /** §142 — đẩy vào đây để test agent có nhận được kiến thức phòng ban không. */
  knowledge: Array<{ title: string; body: string }>;
  tasks: Map<Uuid, Task>;
  deps: Map<Uuid, Set<Uuid>>;
  bugs: Array<Record<string, unknown>>;
  messages: Array<{ taskId: Uuid | null; author: string; content: string }>;
  approvals: Array<Record<string, unknown>>;
  gitEvents: Array<Record<string, unknown>>;
  runs: Map<Uuid, Record<string, unknown>>;
  /** Trạng thái dự án giả, để test thấy engine chuyển PLANNING → IN_PROGRESS → COMPLETED. */
  project: { status: string };
}

const ISO = (): string => new Date().toISOString();

function createFake(projectId: Uuid): Fake {
  const tasks = new Map<Uuid, Task>();
  const deps = new Map<Uuid, Set<Uuid>>();
  const bugs: Array<Record<string, unknown>> = [];
  const messages: Array<{ taskId: Uuid | null; author: string; content: string }> = [];
  const approvals: Array<Record<string, unknown>> = [];
  const gitEvents: Array<Record<string, unknown>> = [];
  const runs = new Map<Uuid, Record<string, unknown>>();
  const agents = new Map<string, { id: Uuid; role: string; state: string }>();
  const knowledge: Array<{ title: string; body: string }> = [];
  const project = { status: 'IN_PROGRESS' };

  const repos = {
    deployments: {
      async failOrphans() {
        return 0;
      },
    },
    projects: {
      async list() {
        return project.status === 'IN_PROGRESS' ? [{ id: projectId }] : [];
      },
      async findById() {
        return {
          id: projectId,
          name: 'Dự án thử',
          slug: 'du-an-thu',
          description: 'mô tả',
          productType: 'WEB_APPLICATION',
          repoFullName: null,
          defaultBranch: 'main',
          status: project.status,
          spentUsd: 0,
        };
      },
      async findBySlug() {
        return null;
      },
      async create(input: Record<string, unknown>) {
        return { id: projectId, ...input, defaultBranch: 'main' };
      },
      async updateStatus(_id: Uuid, status: string) {
        project.status = status;
      },
    },

    tasks: {
      async create(input: Record<string, unknown>) {
        const task = {
          id: newId(),
          projectId,
          title: String(input['title']),
          description: String(input['description'] ?? ''),
          status: 'TODO',
          priority: String(input['priority'] ?? 'MEDIUM'),
          assignedRole: (input['assignedRole'] as AgentRole | null) ?? null,
          assignedAgentId: null,
          parentTaskId: (input['parentTaskId'] as Uuid | null) ?? null,
          estimateMinutes: null,
          startedAt: null,
          completedAt: null,
          fixLoopCount: 0,
          stageId: (input['stageId'] as string | null) ?? null,
          createdAt: ISO(),
          updatedAt: ISO(),
        } as unknown as Task;
        tasks.set(task.id, task);
        deps.set(task.id, new Set((input['dependsOn'] as Uuid[]) ?? []));
        return task;
      },
      async addDependencies(id: Uuid, dependsOn: Uuid[]) {
        const set = deps.get(id) ?? new Set<Uuid>();
        for (const dependency of dependsOn) if (dependency !== id) set.add(dependency);
        deps.set(id, set);
      },
      async listByStage(_projectId: Uuid, stageId: string) {
        return [...tasks.values()].filter((task) => task.stageId === stageId);
      },
      async findById(id: Uuid) {
        return tasks.get(id) ?? null;
      },
      async listByProject() {
        return [...tasks.values()];
      },
      async listReady() {
        return [...tasks.values()].filter(
          (task) =>
            task.status === 'TODO' &&
            [...(deps.get(task.id) ?? [])].every((dep) => ['DONE', 'CANCELLED'].includes(tasks.get(dep)?.status ?? '')),
        );
      },
      async setStatus(id: Uuid, status: string) {
        const task = tasks.get(id)!;
        const updated = {
          ...task,
          status,
          startedAt: task.startedAt ?? (status === 'IN_PROGRESS' ? ISO() : null),
          completedAt: status === 'DONE' ? ISO() : task.completedAt,
        } as Task;
        tasks.set(id, updated);
        return updated;
      },
      async resetForRedo(id: Uuid) {
        const task = tasks.get(id)!;
        tasks.set(id, { ...task, status: 'TODO', fixLoopCount: 0, startedAt: null, completedAt: null } as Task);
      },
      async resetFixLoop(id: Uuid) {
        tasks.set(id, { ...tasks.get(id)!, fixLoopCount: 0 } as Task);
      },
      async requeueInProgress(exceptIds: Uuid[] = []) {
        if (project.status !== 'IN_PROGRESS') return [];
        const touched = new Set<Uuid>();
        for (const task of tasks.values()) {
          if (task.status !== 'IN_PROGRESS' || exceptIds.includes(task.id)) continue;
          tasks.set(task.id, { ...task, status: 'TODO' } as Task);
          touched.add(projectId);
        }
        return [...touched];
      },
      async delete(id: Uuid) {
        tasks.delete(id);
      },
      async incrementFixLoop(id: Uuid) {
        const task = tasks.get(id)!;
        const updated = { ...task, fixLoopCount: task.fixLoopCount + 1 } as Task;
        tasks.set(id, updated);
        return updated.fixLoopCount;
      },
      async dependencies(id: Uuid) {
        return [...(deps.get(id) ?? [])];
      },
      async assign() {},
      async countByStatus() {
        return {};
      },
    },

    agents: {
      async findByRole(role: string) {
        if (!agents.has(role)) agents.set(role, { id: newId(), role, state: 'idle' });
        return agents.get(role)!;
      },
      async setState(id: Uuid, state: string) {
        const agent = [...agents.values()].find((a) => a.id === id)!;
        agent.state = state;
        return agent;
      },
      async list() {
        return [...agents.values()];
      },
    },

    runs: {
      async create(input: Record<string, unknown>) {
        const run = { id: newId(), ...input, status: 'QUEUED' };
        runs.set(run.id, run);
        return run;
      },
      async markRunning(id: Uuid, workspace: string) {
        Object.assign(runs.get(id)!, { status: 'RUNNING', workspace });
      },
      async finish(id: Uuid, result: Record<string, unknown>) {
        Object.assign(runs.get(id)!, result);
      },
      async failOrphans(reason: string) {
        let count = 0;
        for (const run of runs.values()) {
          if (run['status'] !== 'QUEUED' && run['status'] !== 'RUNNING') continue;
          Object.assign(run, { status: 'FAILED', errorMessage: reason });
          count += 1;
        }
        return count;
      },
      async listByTask(taskId: Uuid) {
        // Như bản thật: mới nhất trước.
        return [...runs.values()].filter((run) => run['taskId'] === taskId).reverse();
      },
    },

    messages: {
      async append(input: Record<string, unknown>) {
        const message = {
          taskId: (input['taskId'] as Uuid) ?? null,
          author: String(input['author']),
          content: String(input['content']),
          createdAt: ISO(),
        };
        messages.push(message);
        return message;
      },
      async listByTask(taskId: Uuid) {
        return messages.filter((message) => message.taskId === taskId);
      },
    },

    bugs: {
      async create(input: Record<string, unknown>) {
        const bug = { id: newId(), status: 'OPEN', ...input };
        bugs.push(bug);
        return bug;
      },
      async upsertOpen(input: Record<string, unknown>) {
        const open = bugs.find(
          (bug) => String(bug['title']).toLowerCase() === String(input['title']).toLowerCase() && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'),
        );
        if (open) {
          Object.assign(open, { description: input['description'], severity: input['severity'], status: 'OPEN' });
          return { bug: open, created: false };
        }
        const bug = { id: newId(), status: 'OPEN', ...input };
        bugs.push(bug);
        return { bug, created: true };
      },
      async setStatus(id: Uuid, status: string) {
        const bug = bugs.find((item) => item['id'] === id);
        if (bug) bug['status'] = status;
      },
      async resolveByReporter(_projectId: Uuid, reporter: Uuid, status: string, keepTitles: string[] = []) {
        const keep = new Set(keepTitles.map((title) => title.toLowerCase()));
        const open = bugs.filter(
          (bug) =>
            bug['reportedByAgentId'] === reporter &&
            !keep.has(String(bug['title']).toLowerCase()) &&
            (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'),
        );
        for (const bug of open) bug['status'] = status;
        return open.length;
      },
      async waiveForTask(_projectId: Uuid, taskId: Uuid) {
        const open = bugs.filter((bug) => bug['taskId'] === taskId && (bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS'));
        for (const bug of open) bug['status'] = 'WONTFIX';
        return open.length;
      },
      async countOpen() {
        return bugs.filter((bug) => bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS').length;
      },
      async listByProject() {
        return bugs;
      },
    },

    approvals: {
      async create(input: Record<string, unknown>) {
        const approval = { id: newId(), status: 'PENDING', context: {}, ...input };
        approvals.push(approval);
        return approval;
      },
      async listPending() {
        return approvals.filter((approval) => approval['status'] === 'PENDING');
      },
      async mergeContext(id: Uuid, patch: Record<string, unknown>) {
        const approval = approvals.find((item) => item['id'] === id);
        if (approval) approval['context'] = { ...(approval['context'] as object), ...patch };
      },
      async findLatestForStage(_projectId: Uuid, stageId: string) {
        const matching = approvals.filter(
          (approval) =>
            (approval['context'] as { stageId?: string } | undefined)?.stageId === stageId &&
            approval['status'] !== 'EXPIRED',
        );
        return matching[matching.length - 1] ?? null;
      },
    },

    gitEvents: {
      async record(input: Record<string, unknown>) {
        gitEvents.push(input);
      },
    },

    // §142 — chưa có kiến thức nào được duyệt thì agent chạy bằng đúng prompt
    // vai trò. Đó là trạng thái bình thường của một công ty mới.
    knowledgeItems: {
      async activeForRole() {
        return knowledge;
      },
    },
  };

  return {
    repos: repos as unknown as Repositories,
    knowledge,
    tasks,
    deps,
    bugs,
    messages,
    approvals,
    gitEvents,
    runs,
    project,
  };
}

/** Bộ đổi trạng thái ghi lại lịch sử để test kiểm tra thứ tự (§9). */
function createStateChanger(): AgentStateChanger & { history: Array<[string, string]> } {
  const history: Array<[string, string]> = [];
  return {
    history,
    async transition(role, to) {
      history.push([role, to]);
      return { id: newId() };
    },
  };
}

/** Agent giả lập: trả về đúng kết quả được lập trình sẵn cho từng lượt gọi. */
function scriptedAgent(role: AgentRole, outcomes: AgentOutcome[]): Agent & { calls: number } {
  let calls = 0;
  return {
    calls,
    definition: {
      role,
      displayName: role,
      department: 'BACKEND',
      promptRole: 'BACKEND_DEVELOPER',
      defaultTaskKind: 'code',
      needsSandbox: false,
    },
    async run(_context: AgentContext) {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!;
      calls += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).calls = calls;
      return outcome;
    },
  } as Agent & { calls: number };
}

const noSandbox = {
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
    throw new Error('không dùng sandbox trong test này');
  },
  async healthCheck() {
    return { ok: true, detail: 'test' };
  },
} as unknown as SandboxDriver;

/** Sandbox trong bộ nhớ: mọi phiên cùng dự án dùng chung một bộ file (như workspace thật theo slug). */
function memorySandbox() {
  const files = new Map<string, string>();
  const driver = {
    ...noSandbox,
    async create() {
      return {
        runId: newId(),
        enforcement: noSandbox.enforcement,
        workspace: '/mem',
        async readFile(path: string) {
          const content = files.get(path);
          if (content === undefined) throw new Error('không có file');
          return content;
        },
        async writeFile(path: string, content: string) {
          files.set(path, content);
        },
        async listFiles() {
          return [...files.keys()];
        },
        async exec() {
          throw new Error('không chạy lệnh trong test này');
        },
        commandLog: () => [],
        async dispose() {},
      };
    },
  } as unknown as SandboxDriver;
  return { driver, files };
}

function buildEngine(
  fake: Fake,
  registry: AgentRegistry,
  options: { gateway?: OrchestratorDeps['gateway']; sandbox?: SandboxDriver; runTimeoutMs?: number } = {},
) {
  const events = new InMemoryEventBus();
  const captured: PnEvent[] = [];
  events.subscribe((event) => {
    captured.push(event);
  });
  const agentState = createStateChanger();

  const engine = new OrchestratorEngine({
    repos: fake.repos,
    events,
    agents: registry,
    agentState,
    gateway: options.gateway ?? { async generate() { throw new Error('agent giả lập không gọi model'); } },
    sandbox: options.sandbox ?? noSandbox,
    github: async () => null,
    ...(options.runTimeoutMs ? { runTimeoutMs: options.runTimeoutMs } : {}),
  });

  return { engine, events: captured, agentState };
}

/* -------------------------------------------------------------------------- */
/* Test                                                                        */
/* -------------------------------------------------------------------------- */

describe('OrchestratorEngine — chạy task (§4, §9)', () => {
  it('dự án đang "Lập kế hoạch" mà việc sau bước phân rã đã chạy thì chuyển sang đang làm', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    fake.project.status = 'PLANNING';
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('BACKEND_DEVELOPER', [{ status: 'completed', summary: 'xong', endState: 'completed' }]));
    const { engine } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId, title: 'Viết API', description: '', priority: 'MEDIUM', assignedRole: 'BACKEND_DEVELOPER', stageId: 'build',
    });
    await engine.runTask(task.id);
    expect(fake.project.status).toBe('IN_PROGRESS');
  });

  it('bước phân rã của CTO không tự bật dự án khi CEO chưa duyệt kế hoạch', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    fake.project.status = 'PLANNING';
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('CTO_ORCHESTRATOR', [{ status: 'completed', summary: 'xong', endState: 'completed' }]));
    const { engine } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId, title: 'Phân rã', description: '', priority: 'CRITICAL', assignedRole: 'CTO_ORCHESTRATOR', stageId: 'intake',
    });
    await engine.runTask(task.id);
    expect(fake.project.status).toBe('PLANNING');
  });

  it('kết quả thất bại giữ task và nhân viên bị chặn, không phát hoàn thành', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('BACKEND_DEVELOPER', [
      { status: 'failed', summary: 'Thiếu kết nối provider', endState: 'blocked' },
    ]));
    const { engine, events, agentState } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId, title: 'Viết API', description: '', priority: 'MEDIUM', assignedRole: 'BACKEND_DEVELOPER',
    });
    await engine.runTask(task.id);
    expect(fake.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(agentState.history.map(([, state]) => state)).toEqual(['working', 'blocked']);
    expect(events.map((event) => event.type)).toContain('TASK_FAILED');
    expect(events.map((event) => event.type)).not.toContain('TASK_COMPLETED');
    expect([...fake.runs.values()][0]?.['status']).toBe('FAILED');
  });

  it('đổi trạng thái agent working → idle và phát đủ event', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('BACKEND_DEVELOPER', [
        { status: 'completed', summary: 'đã viết xong', endState: 'completed' },
      ]),
    );

    const { engine, events, agentState } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId,
      title: 'Viết API',
      description: 'mô tả',
      priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER',
    });

    const outcome = await engine.runTask(task.id);

    expect(outcome?.status).toBe('completed');
    expect(fake.tasks.get(task.id)?.status).toBe('DONE');

    // §9 — trạng thái đi đúng đường và không kẹt ở "working".
    expect(agentState.history).toEqual([
      ['BACKEND_DEVELOPER', 'working'],
      ['BACKEND_DEVELOPER', 'idle'],
    ]);

    const types = events.map((event) => event.type);
    expect(types).toContain('AGENT_STARTED');
    expect(types).toContain('TASK_STARTED');
    expect(types).toContain('TASK_COMPLETED');
    expect(types).toContain('AGENT_STOPPED');
  });

  it('ghi bản ghi run cho mỗi lần chạy (§18)', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('BACKEND_DEVELOPER', [
        { status: 'completed', summary: 'xong', endState: 'completed' },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId,
      title: 'T',
      description: '',
      priority: 'MEDIUM',
      assignedRole: 'BACKEND_DEVELOPER',
    });

    await engine.runTask(task.id);

    const run = [...fake.runs.values()][0]!;
    expect(run['taskId']).toBe(task.id);
    expect(run['status']).toBe('SUCCEEDED');
  });

  it('chặn task khi vai trò chưa có hiện thực, nói rõ lý do', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());

    const task = await fake.repos.tasks.create({
      projectId,
      title: 'Thiết kế kiến trúc',
      description: '',
      priority: 'HIGH',
      assignedRole: 'SOLUTION_ARCHITECT',
    });

    expect(await engine.runTask(task.id)).toBeNull();
    expect(fake.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(fake.messages.some((m) => m.content.includes('SOLUTION_ARCHITECT'))).toBe(true);
  });

  it('agent ném lỗi thì task bị chặn và trạng thái về blocked, không kẹt working', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register({
      definition: {
        role: 'BACKEND_DEVELOPER',
        displayName: 'dev',
        department: 'BACKEND',
        promptRole: 'BACKEND_DEVELOPER',
        defaultTaskKind: 'code',
        needsSandbox: false,
      },
      async run() {
        throw new Error('provider sập');
      },
    });

    const { engine, agentState, events } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId,
      title: 'T',
      description: '',
      priority: 'MEDIUM',
      assignedRole: 'BACKEND_DEVELOPER',
    });

    await engine.runTask(task.id);

    expect(fake.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(agentState.history.map(([, state]) => state)).toEqual(['working', 'blocked']);
    expect(events.map((e) => e.type)).toContain('TASK_FAILED');
  });
});

describe('OrchestratorEngine — phân rã và phụ thuộc (§3.1, §4)', () => {
  it('tạo task đề xuất và nối đúng quan hệ phụ thuộc', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('CTO_ORCHESTRATOR', [
        {
          status: 'completed',
          summary: 'kế hoạch',
          endState: 'completed',
          proposedTasks: [
            { title: 'Dựng API', description: '...', assignedRole: 'BACKEND_DEVELOPER', priority: 'HIGH' },
            {
              title: 'Kiểm thử',
              description: '...',
              assignedRole: 'QA',
              priority: 'MEDIUM',
              dependsOnIndexes: [0],
            },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const planning = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: 'làm web',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
    });

    await engine.runTask(planning.id);

    const created = [...fake.tasks.values()].filter((task) => task.id !== planning.id);
    expect(created).toHaveLength(2);

    const qa = created.find((task) => task.assignedRole === 'QA')!;
    const dev = created.find((task) => task.assignedRole === 'BACKEND_DEVELOPER')!;
    expect([...(fake.deps.get(qa.id) ?? [])]).toEqual([dev.id]);
  });

  it('task phụ thuộc vào task ở stage sau thì được xếp vào stage đó — không có vòng chờ nhau', async () => {
    // CTO tự giao cho mình "gói trình CEO" phụ thuộc vào phân tích của BA. Nếu
    // task đó nằm ở stage intake (theo vai trò), vòng nối stage sẽ bắt BA phụ
    // thuộc ngược vào nó: hai bên chờ nhau và dự án đứng im không lỗi.
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('CTO_ORCHESTRATOR', [
        {
          status: 'completed',
          summary: 'kế hoạch',
          endState: 'completed',
          proposedTasks: [
            { title: 'Yêu cầu', description: '...', assignedRole: 'BUSINESS_ANALYST', priority: 'HIGH' },
            {
              title: 'Gói trình CEO',
              description: '...',
              assignedRole: 'CTO_ORCHESTRATOR',
              priority: 'MEDIUM',
              dependsOnIndexes: [0],
            },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const planning = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: 'làm web',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
    });
    await engine.runTask(planning.id);

    const analysis = [...fake.tasks.values()].find((task) => task.assignedRole === 'BUSINESS_ANALYST')!;
    const bundle = [...fake.tasks.values()].find((task) => task.title === 'Gói trình CEO')!;
    expect(bundle.stageId).toBe(analysis.stageId);
    expect([...(fake.deps.get(analysis.id) ?? [])]).not.toContain(bundle.id);
    expect([...(fake.deps.get(bundle.id) ?? [])]).toContain(analysis.id);
  });

  it('chỉ lần phân rã đầu tiên của CTO tạo task; agent khác đề xuất thì chỉ ghi vào trao đổi', async () => {
    // Một demo thật: PM, Web Lead, Designer đều đẻ thêm việc, việc đó chạy lại
    // đẻ tiếp — 15 task thành 166 trong 20 phút, model chưa có giá nên ngân
    // sách không chặn được.
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('PRODUCT_MANAGER', [
        {
          status: 'completed',
          summary: 'brief',
          endState: 'completed',
          proposedTasks: [
            { title: 'Thêm việc', description: '...', assignedRole: 'BUSINESS_ANALYST', priority: 'LOW' },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const brief = await fake.repos.tasks.create({
      projectId,
      title: 'Product brief',
      description: '',
      priority: 'MEDIUM',
      assignedRole: 'PRODUCT_MANAGER',
    });
    await engine.runTask(brief.id);

    expect([...fake.tasks.values()]).toHaveLength(1);
    expect(fake.messages.some((message) => message.content.includes('không được tạo thành task'))).toBe(true);
  });

  it('CTO phân rã lại khi kế hoạch đã có thì không tạo bộ task trùng', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('CTO_ORCHESTRATOR', [
        {
          status: 'completed',
          summary: 'kế hoạch',
          endState: 'completed',
          proposedTasks: [
            { title: 'Dựng API', description: '...', assignedRole: 'BACKEND_DEVELOPER', priority: 'HIGH' },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    await fake.repos.tasks.create({
      projectId,
      title: 'Việc đã có',
      description: '',
      priority: 'MEDIUM',
      assignedRole: 'BACKEND_DEVELOPER',
    });
    const planning = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
    });
    await engine.runTask(planning.id);

    expect([...fake.tasks.values()]).toHaveLength(2);
  });

  it('bỏ qua phụ thuộc trỏ tới task phía sau để không tạo vòng lặp', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('CTO_ORCHESTRATOR', [
        {
          status: 'completed',
          summary: 'kế hoạch',
          endState: 'completed',
          proposedTasks: [
            {
              title: 'A',
              description: '...',
              assignedRole: 'BACKEND_DEVELOPER',
              priority: 'HIGH',
              dependsOnIndexes: [1], // trỏ tới task chưa tồn tại
            },
            { title: 'B', description: '...', assignedRole: 'QA', priority: 'LOW' },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const planning = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
    });

    await engine.runTask(planning.id);

    const taskA = [...fake.tasks.values()].find((task) => task.title === 'A')!;
    expect([...(fake.deps.get(taskA.id) ?? [])]).toEqual([]);
  });

  it('advance chỉ xếp task đã hết bị chặn', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());

    const first = await fake.repos.tasks.create({
      projectId,
      title: 'A',
      description: '',
      priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER',
    });
    await fake.repos.tasks.create({
      projectId,
      title: 'B',
      description: '',
      priority: 'HIGH',
      assignedRole: 'QA',
      dependsOn: [first.id],
    });

    // B còn chờ A nên chỉ A được xếp.
    expect(await engine.advance(projectId)).toBe(1);
  });

  it('khởi động lại: lượt chạy mồ côi thành FAILED, task IN_PROGRESS được xếp chạy lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('BACKEND_DEVELOPER', [{ status: 'completed', summary: 'xong', artifacts: [] }]));
    const { engine } = buildEngine(fake, registry);

    const task = await fake.repos.tasks.create({ projectId, title: 'A', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(task.id, 'IN_PROGRESS');
    const run = await fake.repos.runs.create({ agentId: newId(), taskId: task.id, projectId });
    await fake.repos.runs.markRunning(run.id, '/tmp');

    expect(await engine.recover()).toEqual({ runs: 1, projects: [projectId], restaged: 0 });
    expect(fake.runs.get(run.id)).toMatchObject({ status: 'FAILED', errorMessage: expect.stringContaining('khởi động lại') });

    await engine.drain();
    expect(fake.tasks.get(task.id)?.status).toBe('DONE');
  });

  it('khởi động lại giữa lúc dựng staging: hệ thống dựng lại, không giao việc dựng cho agent viết code', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('DEVOPS', [{ status: 'completed', summary: 'xong', endState: 'completed' }]));
    const { engine } = buildEngine(fake, registry);
    const deployed: string[] = [];
    engine.useStagingDeployer(async (project) => {
      deployed.push(project.slug);
      return { status: 'SUCCESS', url: 'http://x/' };
    });
    const build = await fake.repos.tasks.create({ projectId, title: 'Dựng bản staging', description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId: 'staging' });
    await fake.repos.tasks.setStatus(build.id, 'IN_PROGRESS');

    expect(await engine.recover()).toMatchObject({ restaged: 1 });
    expect(deployed).toHaveLength(1);
    expect(fake.tasks.get(build.id)?.status).toBe('DONE');
    // Không có lượt agent nào chạy cho task dựng.
    expect([...fake.runs.values()].some((run) => run['taskId'] === build.id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Vòng tự chủ — §38, §147                                                     */
/* -------------------------------------------------------------------------- */

describe('OrchestratorEngine — agent thấy việc của nhau', () => {
  it('dev nhận được tóm tắt của Designer và các bước đã xong trước đó', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    let seen: AgentContext | null = null;
    registry.register({
      definition: {
        role: 'FRONTEND_DEVELOPER',
        displayName: 'FE',
        department: 'FRONTEND',
        promptRole: 'FRONTEND_DEVELOPER',
        defaultTaskKind: 'code',
        needsSandbox: false,
      },
      async run(context: AgentContext) {
        seen = context;
        return { status: 'completed', summary: 'xong', endState: 'completed' };
      },
    });
    const { engine } = buildEngine(fake, registry);

    const design = await fake.repos.tasks.create({
      projectId, title: 'Thiết kế UI', description: '', priority: 'HIGH', assignedRole: 'UIUX_DESIGNER',
    });
    await fake.repos.tasks.setStatus(design.id, 'DONE');
    await fake.repos.messages.append({
      projectId, taskId: design.id, author: 'UIUX_DESIGNER', role: 'assistant', content: 'Màu chủ đạo xanh, phím tròn.',
    });
    const dev = await fake.repos.tasks.create({
      projectId, title: 'Dựng giao diện', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER',
    });

    await engine.runTask(dev.id);

    expect(seen).not.toBeNull();
    expect(seen!.priorWork).toEqual([
      { role: 'UIUX_DESIGNER', title: 'Thiết kế UI', summary: 'Màu chủ đạo xanh, phím tròn.' },
    ]);
  });
});

describe('OrchestratorEngine — bàn giao giữa các phòng', () => {
  it('phòng lập kế hoạch đề xuất việc khi kế hoạch đã có: phòng sau vẫn đọc được kết quả thật, không phải dòng "Đề xuất N việc"', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register({
      ...scriptedAgent('UIUX_DESIGNER', [{
        status: 'completed',
        summary: 'Đặc tả màn hình chính, hộp thoại thêm lịch, cảnh báo đếm ngược.',
        proposedTasks: [{ title: 'Dựng màn hình chính', description: '...', assignedRole: 'FRONTEND_DEVELOPER', priority: 'HIGH' }],
        endState: 'completed',
      }]),
    });
    let seen: AgentContext | null = null;
    registry.register({
      definition: { role: 'FRONTEND_DEVELOPER', displayName: 'FE', department: 'FRONTEND', promptRole: 'FRONTEND_DEVELOPER', defaultTaskKind: 'code', needsSandbox: false },
      async run(context: AgentContext) {
        seen = context;
        return { status: 'completed', summary: 'xong', endState: 'completed' };
      },
    });
    const { engine } = buildEngine(fake, registry);
    // Kế hoạch đã có (đã có task của phòng khác CTO) nên đề xuất của Thiết kế không thành task.
    const design = await fake.repos.tasks.create({ projectId, title: 'Thiết kế UI', description: '', priority: 'HIGH', assignedRole: 'UIUX_DESIGNER' });
    await engine.runTask(design.id);
    const dev = await fake.repos.tasks.create({ projectId, title: 'Dựng giao diện', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER' });
    await engine.runTask(dev.id);

    expect(seen!.priorWork).toEqual([
      { role: 'UIUX_DESIGNER', title: 'Thiết kế UI', summary: 'Đặc tả màn hình chính, hộp thoại thêm lịch, cảnh báo đếm ngược.' },
    ]);
  });
});

describe('OrchestratorEngine — hỏi đáp nội bộ qua Phòng điều hành', () => {
  const question = {
    question: 'Tự bật máy lại từ tắt hẳn hay từ ngủ đông?',
    why: 'Windows không bật được máy đã tắt hẳn.',
    options: ['Ngủ đông rồi tự bật', 'Tắt hẳn, không tự bật'],
    recommended: 0,
    costImpact: false,
  };
  /** Model giả của Phòng điều hành: ghi lại lời nhắc, trả lời câu 0. */
  function ctoGateway(answer: string) {
    const prompts: string[] = [];
    return {
      prompts,
      gateway: {
        async generate(request: { messages: Array<{ content: string }> }) {
          prompts.push(request.messages.map((message) => message.content).join('\n'));
          return { text: JSON.stringify({ answers: [{ index: 0, answer, reason: 'Nền tảng chỉ cho đánh thức từ ngủ đông.' }] }), provider: 't', model: 't', costUsd: 0, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
        },
      } as unknown as OrchestratorDeps['gateway'],
    };
  }
  const asking = (costImpact = false) =>
    scriptedAgent('BUSINESS_ANALYST', [{ status: 'completed', summary: 'Có câu hỏi.', questions: [{ ...question, costImpact }], endState: 'completed' }]);

  it('câu hỏi thường: Phòng điều hành trả lời, ghi Sổ quyết định, phòng hỏi làm lại — không hỏi CEO', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(asking());
    registry.register(scriptedAgent('CTO_ORCHESTRATOR', [{ status: 'completed', summary: 'x', endState: 'completed' }]));
    const cto = ctoGateway('Ngủ đông rồi tự bật lúc giờ hẹn; tắt hẳn thì nói rõ không tự bật được.');
    const mem = memorySandbox();
    const { engine, agentState, events } = buildEngine(fake, registry, { gateway: cto.gateway, sandbox: mem.driver });
    const task = await fake.repos.tasks.create({ projectId, title: 'Yêu cầu chi tiết', description: '', priority: 'HIGH', assignedRole: 'BUSINESS_ANALYST' });

    await engine.runTask(task.id);

    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
    expect(cto.prompts[0]).toContain('Tự bật máy lại từ tắt hẳn hay từ ngủ đông?');
    expect(mem.files.get('docs/quyet-dinh.md')).toContain('Ngủ đông rồi tự bật lúc giờ hẹn');
    expect(fake.messages.some((message) => message.author === 'CTO_ORCHESTRATOR' && message.content.startsWith('Phòng điều hành trả lời'))).toBe(true);
    expect(agentState.history).toContainEqual(['CTO_ORCHESTRATOR', 'working']);
    expect(fake.approvals).toHaveLength(0);
    expect(events.some((event) => event.type === 'APPROVAL_REQUIRED')).toBe(false);
  });

  it(`hỏi quá ${MAX_QUESTION_ROUNDS} vòng thì lấy phương án phòng đề xuất, không gọi model nữa`, async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(asking());
    const mem = memorySandbox();
    const { engine } = buildEngine(fake, registry, { sandbox: mem.driver });
    const task = await fake.repos.tasks.create({ projectId, title: 'Yêu cầu chi tiết', description: '', priority: 'HIGH', assignedRole: 'BUSINESS_ANALYST' });
    for (let round = 0; round < MAX_QUESTION_ROUNDS; round += 1) {
      await fake.repos.messages.append({ projectId, taskId: task.id, author: 'CTO_ORCHESTRATOR', role: 'assistant', content: 'Phòng điều hành trả lời Phân tích: ...' });
    }

    await engine.runTask(task.id);

    expect(mem.files.get('docs/quyet-dinh.md')).toContain('**Phương án đề xuất quyết:** Ngủ đông rồi tự bật');
    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
  });

  it('câu hỏi có chi phí: lên CEO thành phiếu duyệt; CEO từ chối thì ghi phương án không tốn tiền và phòng làm lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(asking(true));
    const mem = memorySandbox();
    const { engine, events } = buildEngine(fake, registry, { sandbox: mem.driver });
    const task = await fake.repos.tasks.create({ projectId, title: 'Yêu cầu chi tiết', description: '', priority: 'HIGH', assignedRole: 'BUSINESS_ANALYST' });

    await engine.runTask(task.id);

    expect(fake.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(fake.approvals[0]).toMatchObject({ kind: 'BUDGET_INCREASE' });
    expect(events.some((event) => event.type === 'APPROVAL_REQUIRED')).toBe(true);

    const answered = await engine.answerCostQuestion(fake.approvals[0] as never, false);
    expect(answered).toBe(true);
    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
    expect(mem.files.get('docs/quyet-dinh.md')).toContain('**CEO quyết:** Tắt hẳn, không tự bật');
  });

  it('phiếu duyệt thường không phải câu hỏi chi phí thì answerCostQuestion bỏ qua', async () => {
    const fake = createFake(newId());
    const { engine } = buildEngine(fake, new AgentRegistry());
    expect(await engine.answerCostQuestion({ taskId: newId(), projectId: null, context: { escalation: 'FIX_LOOP' } }, true)).toBe(false);
  });
});

describe('OrchestratorEngine — làm lại dự án', () => {
  it('làm lại từ bước Phân tích: bước trước giữ nguyên, bước sau về chưa làm, task dựng staging bị xoá, tài liệu bước trước được giữ', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());
    const make = async (stageId: string, role: AgentRole, title = stageId) => {
      const task = await fake.repos.tasks.create({ projectId, title, description: '', priority: 'HIGH', assignedRole: role, stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
      return task;
    };
    const intake = await make('intake', 'CTO_ORCHESTRATOR');
    const product = await make('product', 'PRODUCT_MANAGER');
    const analysis = await make('analysis', 'BUSINESS_ANALYST');
    const build = await make('build', 'FRONTEND_DEVELOPER');
    await fake.repos.tasks.incrementFixLoop(build.id);
    const staging = await make('staging', 'DEVOPS', 'Dựng bản staging');
    fake.project.status = 'COMPLETED';

    const result = await engine.redoProject(projectId, 'analysis');

    expect(fake.tasks.get(intake.id)?.status).toBe('DONE');
    expect(fake.tasks.get(product.id)?.status).toBe('DONE');
    expect(fake.tasks.get(analysis.id)?.status).toBe('TODO');
    expect(fake.tasks.get(build.id)).toMatchObject({ status: 'TODO', fixLoopCount: 0 });
    expect(fake.tasks.has(staging.id)).toBe(false);
    expect(result).toMatchObject({ reset: 2, removed: 1, redoesBuild: true });
    expect(result.keepDocs).toContain('docs/quyet-dinh.md');
    expect(result.keepDocs).toContain('docs/pham-vi.md');
    expect(result.keepDocs).not.toContain('docs/yeu-cau.md');
    expect(fake.project.status).toBe('IN_PROGRESS');
  });

  it('agent làm lại chỉ thấy trao đổi từ dấu làm lại trở đi, không bị kết quả cũ đánh lừa', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    let seen: AgentContext | null = null;
    registry.register({
      definition: { role: 'BUSINESS_ANALYST', displayName: 'BA', department: 'BUSINESS_ANALYSIS', promptRole: 'BUSINESS_ANALYST', defaultTaskKind: 'general', needsSandbox: false },
      async run(context: AgentContext) {
        seen = context;
        return { status: 'completed', summary: 'xong', endState: 'completed' };
      },
    });
    const { engine } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({ projectId, title: 'Yêu cầu', description: '', priority: 'HIGH', assignedRole: 'BUSINESS_ANALYST', stageId: 'analysis' });
    await fake.repos.messages.append({ projectId, taskId: task.id, author: 'BUSINESS_ANALYST', role: 'assistant', content: 'Bản cũ: đã xong hết.' });
    await fake.repos.tasks.setStatus(task.id, 'DONE');

    await engine.redoProject(projectId, 'analysis');
    await engine.runTask(task.id);

    expect(seen!.history[0]!.content.startsWith(REDO_MARKER)).toBe(true);
    expect(seen!.history.some((entry) => entry.content === 'Bản cũ: đã xong hết.')).toBe(false);
  });

  it('bước không có trong quy trình thì báo lỗi', async () => {
    const fake = createFake(newId());
    const { engine } = buildEngine(fake, new AgentRegistry());
    await expect(engine.redoProject(newId(), 'khong-co')).rejects.toThrow(/không có trong quy trình/);
  });
});

describe('OrchestratorEngine — vòng tự chủ (§38)', () => {
  /** Đăng ký agent rỗng cho một loạt vai trò, đủ để engine chịu mở stage. */
  function registryFor(roles: AgentRole[]): AgentRegistry {
    const registry = new AgentRegistry();
    for (const role of roles) {
      registry.register(
        scriptedAgent(role, [{ status: 'completed', summary: 'xong', endState: 'completed' }]),
      );
    }
    return registry;
  }

  it('hết việc thì tự mở stage kế tiếp, không đợi CEO bấm', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['CTO_ORCHESTRATOR', 'PRODUCT_MANAGER']));

    // Stage đầu tiên xong hẳn.
    const intake = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: 'intake',
    });
    await fake.repos.tasks.setStatus(intake.id, 'DONE');

    await engine.advance(projectId);

    const product = [...fake.tasks.values()].filter((task) => task.stageId === 'product');
    expect(product).toHaveLength(1);
    expect(product[0]!.assignedRole).toBe('PRODUCT_MANAGER');
  });

  it('mở bù một stage thì việc có sẵn ở stage sau phải đợi nó (Bảo mật chạy song song Kiểm thử)', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['QA', 'SECURITY']));
    const build = await fake.repos.tasks.create({ projectId, title: 'Viết mã', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER', stageId: 'build' });
    for (const stageId of ['intake', 'product', 'analysis', 'architecture', 'design']) {
      const task = await fake.repos.tasks.create({ projectId, title: stageId, description: '', priority: 'HIGH', assignedRole: 'QA', stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
    }
    await fake.repos.tasks.setStatus(build.id, 'DONE');
    // CTO lập kế hoạch có việc Bảo mật nhưng không có việc Kiểm thử.
    const security = await fake.repos.tasks.create({
      projectId, title: 'Rà bảo mật', description: '', priority: 'HIGH', assignedRole: 'SECURITY', stageId: 'security', dependsOn: [build.id],
    });

    await engine.advance(projectId);

    const qa = [...fake.tasks.values()].find((task) => task.stageId === 'qa');
    expect(qa).toBeDefined();
    expect(await fake.repos.tasks.dependencies(security.id)).toContain(qa!.id);
  });

  it('stage staging do hệ thống dựng: xong thì task DONE, không giao agent DevOps', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine, events, agentState } = buildEngine(fake, registryFor(['DEVOPS']));
    const calls: string[] = [];
    engine.useStagingDeployer(async (project) => {
      calls.push(project.slug);
      return { status: 'SUCCESS', url: 'http://x/product/p/?v=t', file: 'D:/ws/dist/ghi-chu.exe' };
    });
    for (const stageId of ['intake', 'product', 'analysis', 'architecture', 'design', 'build', 'qa', 'security', 'red_team', 'devops']) {
      const task = await fake.repos.tasks.create({ projectId, title: stageId, description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
    }

    await engine.advance(projectId);

    const staging = [...fake.tasks.values()].filter((task) => task.stageId === 'staging');
    expect(calls).toHaveLength(1);
    expect(staging.map((task) => [task.title, task.status])).toEqual([['Dựng bản staging', 'DONE']]);
    // Lúc dựng thì DevOps ngồi làm trên văn phòng 3D, dựng xong thì về rảnh ("11/12 không phòng nào hoạt động").
    expect(agentState.history).toEqual([['DEVOPS', 'working'], ['DEVOPS', 'idle']]);
    // Hết việc sau bước tự động cuối: dự án hoàn thành và báo CEO.
    expect(fake.project.status).toBe('COMPLETED');
    expect(events.find((event) => event.type === 'PROJECT_MILESTONE' && event.payload.stageId === 'staging')?.payload.title).toMatch(/^Dự án hoàn thành/);
    // Bàn giao: link xem + file .exe đi cùng để Telegram gửi thẳng cho CEO.
    expect(events.find((event) => event.type === 'PROJECT_DELIVERED')?.payload).toMatchObject({ url: 'http://x/product/p/?v=t', file: 'D:/ws/dist/ghi-chu.exe' });
    expect(events.some((event) => event.type === 'TASK_CREATED' && event.payload.title === 'Deploy staging')).toBe(false);
  });

  it('mở stage kế tiếp thì báo mốc của stage vừa xong: thiết kế xong → mốc "Thiết kế giao diện xong"', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine, events } = buildEngine(fake, registryFor(['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER', 'MOBILE_DEVELOPER']));
    for (const stageId of ['intake', 'product', 'analysis', 'architecture', 'design']) {
      const task = await fake.repos.tasks.create({ projectId, title: `việc ${stageId}`, description: '', priority: 'HIGH', assignedRole: 'UIUX_DESIGNER', stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
    }

    await engine.advance(projectId);

    const milestone = events.find((event) => event.type === 'PROJECT_MILESTONE');
    expect(milestone?.payload).toMatchObject({ stageId: 'design', title: 'Thiết kế giao diện xong', detail: 'việc design' });
  });

  it('dựng hỏng thì giao DevOps sửa, sửa xong thì tự dựng lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['DEVOPS']));
    let attempt = 0;
    engine.useStagingDeployer(async () => {
      attempt += 1;
      return attempt === 1 ? { status: 'FAILED', reason: 'vite build lỗi' } : { status: 'SUCCESS', url: 'http://x/' };
    });
    for (const stageId of ['intake', 'product', 'analysis', 'architecture', 'design', 'build', 'qa', 'security', 'red_team', 'devops']) {
      const task = await fake.repos.tasks.create({ projectId, title: stageId, description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
    }

    await engine.advance(projectId);
    let staging = [...fake.tasks.values()].filter((task) => task.stageId === 'staging');
    const build = staging.find((task) => task.title === 'Dựng bản staging')!;
    const fix = staging.find((task) => task.title === 'Sửa để staging dựng được')!;
    expect(build.status).toBe('BLOCKED');
    expect(fix.assignedRole).toBe('DEVOPS');
    expect(fix.description).toContain('vite build lỗi');

    // DevOps sửa xong → advance → dựng lại thành công.
    await fake.repos.tasks.setStatus(fix.id, 'DONE');
    await engine.advance(projectId);
    staging = [...fake.tasks.values()].filter((task) => task.stageId === 'staging');
    expect(attempt).toBe(2);
    expect(staging.find((task) => task.title === 'Dựng bản staging')?.status).toBe('DONE');
  });

  it('nút Dựng bản thử hỏng → cùng vòng sửa: task dựng BLOCKED, DevOps sửa xong thì tự dựng lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['DEVOPS']));
    let attempt = 0;
    engine.useStagingDeployer(async () => {
      attempt += 1;
      return attempt === 1 ? { status: 'FAILED', reason: 'exports is not defined' } : { status: 'SUCCESS', url: 'http://x/' };
    });

    expect(await engine.buildStaging(projectId)).toBe('started');
    for (let i = 0; i < 50 && engine.isBuildingStaging(projectId); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    let staging = [...fake.tasks.values()].filter((task) => task.stageId === 'staging');
    const build = staging.find((task) => task.title === 'Dựng bản staging')!;
    const fix = staging.find((task) => task.title === 'Sửa để staging dựng được')!;
    expect(build.status).toBe('BLOCKED');
    expect(fix.description).toContain('exports is not defined');

    await fake.repos.tasks.setStatus(fix.id, 'DONE');
    await engine.advance(projectId);
    staging = [...fake.tasks.values()].filter((task) => task.stageId === 'staging');
    expect(attempt).toBe(2);
    expect(staging.find((task) => task.title === 'Dựng bản staging')?.status).toBe('DONE');
  });

  it('dựng xong thì việc "sửa để dựng được" còn treo bị bỏ và dự án hoàn thành (kẹt "Đang chạy")', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine, events } = buildEngine(fake, registryFor(['DEVOPS']));
    engine.useStagingDeployer(async () => ({ status: 'SUCCESS', url: 'http://x/' }));
    const fix = await fake.repos.tasks.create({ projectId, title: 'Sửa để staging dựng được', description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId: 'staging' });

    expect(await engine.buildStaging(projectId)).toBe('started');
    for (let i = 0; i < 50 && engine.isBuildingStaging(projectId); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    expect(fake.tasks.get(fix.id)?.status).toBe('CANCELLED');
    expect(fake.project.status).toBe('COMPLETED');
    expect(events.some((event) => event.type === 'PROJECT_DELIVERED')).toBe(true);
  });

  it('dự án đã xong hết việc, đã dựng, không còn lỗi mà vẫn ghi "Đang chạy" thì lần đẩy kế tiếp chốt hoàn thành', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine, events } = buildEngine(fake, registryFor(['DEVOPS']));
    for (const [stageId, title] of [['build', 'Viết mã'], ['staging', 'Dựng bản staging'], ['staging', 'Sửa để staging dựng được']] as const) {
      const task = await fake.repos.tasks.create({ projectId, title, description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId });
      await fake.repos.tasks.setStatus(task.id, 'DONE');
    }
    fake.project.status = 'IN_PROGRESS';

    await engine.advance(projectId);

    expect(fake.project.status).toBe('COMPLETED');
    expect(events.filter((event) => event.type === 'PROJECT_DELIVERED')).toHaveLength(1);
    // Chốt một lần: đẩy tiếp không báo lại.
    await engine.advance(projectId);
    expect(events.filter((event) => event.type === 'PROJECT_DELIVERED')).toHaveLength(1);
  });

  it('KHÔNG tự mở stage production — §147 giữ nó lại cho người', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const workflowRoles: AgentRole[] = [
      'CTO_ORCHESTRATOR',
      'PRODUCT_MANAGER',
      'BUSINESS_ANALYST',
      'SOLUTION_ARCHITECT',
      'UIUX_DESIGNER',
      'FRONTEND_DEVELOPER',
      'BACKEND_DEVELOPER',
      'MOBILE_DEVELOPER',
      'QA',
      'SECURITY',
      'RED_TEAM',
      'DEVOPS',
    ];
    const { engine } = buildEngine(fake, registryFor(workflowRoles));

    // Cho mọi stage tự chủ chạy hết: gọi advance nhiều lần, mỗi lần mở một stage
    // rồi đánh dấu xong, cho tới khi không còn stage nào mở thêm.
    for (let round = 0; round < 30; round += 1) {
      const before = fake.tasks.size;
      await engine.advance(projectId);
      for (const task of fake.tasks.values()) {
        if (task.status !== 'DONE') await fake.repos.tasks.setStatus(task.id, 'DONE');
      }
      if (fake.tasks.size === before) break;
    }

    const stages = new Set([...fake.tasks.values()].map((task) => task.stageId));
    expect(stages).toContain('staging');
    expect(stages).not.toContain('production');
  });

  it('không mở lại stage đã có task — không tạo trùng', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['CTO_ORCHESTRATOR', 'PRODUCT_MANAGER']));

    const intake = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: 'intake',
    });
    await fake.repos.tasks.setStatus(intake.id, 'DONE');

    await engine.advance(projectId);
    const after = fake.tasks.size;
    await engine.advance(projectId);

    expect(fake.tasks.size).toBe(after);
  });

  it('stage trước chưa xong thì không mở stage sau', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, registryFor(['CTO_ORCHESTRATOR', 'PRODUCT_MANAGER']));

    // Task intake còn TODO — pipeline chưa được phép nhảy qua.
    await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: 'intake',
    });

    await engine.advance(projectId);

    expect([...fake.tasks.values()].some((task) => task.stageId === 'product')).toBe(false);
  });

  it('vai trò chưa có agent thì không mở stage cho nó — đừng tạo task nằm chặn', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    // Không đăng ký PRODUCT_MANAGER.
    const { engine } = buildEngine(fake, registryFor(['CTO_ORCHESTRATOR']));

    const intake = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: 'intake',
    });
    await fake.repos.tasks.setStatus(intake.id, 'DONE');

    await engine.advance(projectId);

    expect([...fake.tasks.values()].some((task) => task.stageId === 'product')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Kiến thức phòng ban vào tới agent — §142                                    */
/* -------------------------------------------------------------------------- */

describe('OrchestratorEngine — kiến thức phòng ban (§142)', () => {
  /** Agent ghi lại ngữ cảnh nó nhận được, để test soi vào. */
  function recordingAgent(role: AgentRole): Agent & { seen: AgentContext | null } {
    const agent = {
      seen: null as AgentContext | null,
      definition: {
        role,
        displayName: role,
        department: 'BACKEND',
        promptRole: role,
        defaultTaskKind: 'general',
        needsSandbox: false,
      },
      async run(context: AgentContext) {
        agent.seen = context;
        return { status: 'completed', summary: 'xong', endState: 'completed' } as AgentOutcome;
      },
    };
    return agent as Agent & { seen: AgentContext | null };
  }

  async function runWith(knowledge: Array<{ title: string; body: string }>) {
    const projectId = newId();
    const fake = createFake(projectId);
    fake.knowledge.push(...knowledge);

    const agent = recordingAgent('BACKEND_DEVELOPER');
    const registry = new AgentRegistry();
    registry.register(agent);

    const { engine } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({
      projectId,
      title: 'Viết API',
      description: '',
      priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER',
    });
    await engine.runTask(task.id);
    return agent;
  }

  it('chưa có kiến thức nào thì agent chạy bằng đúng prompt vai trò', async () => {
    const agent = await runWith([]);
    expect(agent.seen?.knowledge).toEqual([]);
  });

  it('kiến thức đã kích hoạt cho vai trò được đưa vào ngữ cảnh lần chạy', async () => {
    const agent = await runWith([
      { title: 'Tối ưu ảnh', body: 'Dùng AVIF, đặt sẵn width và height.' },
    ]);

    expect(agent.seen?.knowledge).toHaveLength(1);
    expect(agent.seen?.knowledge[0]!.title).toBe('Tối ưu ảnh');
  });
});

/* -------------------------------------------------------------------------- */
/* Cổng duyệt theo stage — §4, §20, §27, §38                                   */
/* -------------------------------------------------------------------------- */

describe('OrchestratorEngine — cổng duyệt stage', () => {
  /** Task thuộc stage `production` — stage bắt buộc CEO duyệt trong §20 và §38. */
  async function setupProductionTask() {
    const projectId = newId();
    const fake = createFake(projectId);
    const built = buildEngine(fake, new AgentRegistry());
    const task = await fake.repos.tasks.create({
      projectId,
      title: 'Deploy production',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'DEVOPS',
      stageId: 'production',
    });
    return { projectId, fake, task, ...built };
  }

  it('không xếp task của stage cần duyệt khi CEO chưa duyệt', async () => {
    const { engine, projectId } = await setupProductionTask();
    expect(await engine.advance(projectId)).toBe(0);
  });

  it('tạo phiếu duyệt PRODUCTION_DEPLOY kèm stage, và chỉ tạo một lần', async () => {
    const { engine, projectId, fake, events } = await setupProductionTask();

    await engine.advance(projectId);
    await engine.advance(projectId);

    expect(fake.approvals).toHaveLength(1);
    expect(fake.approvals[0]!['kind']).toBe('PRODUCTION_DEPLOY');
    expect(fake.approvals[0]!['context']).toEqual({ stageId: 'production' });
    expect(events.filter((event) => event.type === 'APPROVAL_REQUIRED')).toHaveLength(1);
  });

  it('CEO duyệt rồi thì task chạy được', async () => {
    const { engine, projectId, fake } = await setupProductionTask();

    await engine.advance(projectId);
    fake.approvals[0]!['status'] = 'APPROVED';

    expect(await engine.advance(projectId)).toBe(1);
  });

  it('CEO từ chối thì task bị chặn hẳn, không hỏi lại vòng vô tận', async () => {
    const { engine, projectId, fake, task } = await setupProductionTask();

    await engine.advance(projectId);
    fake.approvals[0]!['status'] = 'REJECTED';

    expect(await engine.advance(projectId)).toBe(0);
    expect(fake.tasks.get(task.id)!.status).toBe('BLOCKED');
    expect(fake.approvals).toHaveLength(1);
  });

  it('stage không cần duyệt thì chạy thẳng', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());
    await fake.repos.tasks.create({
      projectId,
      title: 'Viết API',
      description: '',
      priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER',
      stageId: 'build',
    });

    expect(await engine.advance(projectId)).toBe(1);
    expect(fake.approvals).toHaveLength(0);
  });

  it('task CTO đề xuất được gắn stage và nối thứ tự pipeline (§4, §92)', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('CTO_ORCHESTRATOR', [
        {
          status: 'completed',
          summary: 'kế hoạch',
          endState: 'completed',
          // Cố tình đặt QA TRƯỚC dev và không khai dependsOnIndexes: thứ tự phải
          // đến từ pipeline chứ không đến từ việc CTO xếp đúng thứ tự.
          proposedTasks: [
            { title: 'Kiểm thử', description: '', assignedRole: 'QA', priority: 'HIGH' },
            { title: 'Dựng API', description: '', assignedRole: 'BACKEND_DEVELOPER', priority: 'HIGH' },
          ],
        },
      ]),
    );

    const { engine } = buildEngine(fake, registry);
    const planning = await fake.repos.tasks.create({
      projectId,
      title: 'Phân rã',
      description: '',
      priority: 'CRITICAL',
      assignedRole: 'CTO_ORCHESTRATOR',
      stageId: 'intake',
    });
    await engine.runTask(planning.id);

    const qa = [...fake.tasks.values()].find((task) => task.assignedRole === 'QA')!;
    const dev = [...fake.tasks.values()].find((task) => task.assignedRole === 'BACKEND_DEVELOPER')!;

    expect(qa.stageId).toBe('qa');
    expect(dev.stageId).toBe('build');
    // QA phải chờ cả task code lẫn task lập kế hoạch của các stage trước.
    expect([...(fake.deps.get(qa.id) ?? [])]).toContain(dev.id);
    expect([...(fake.deps.get(dev.id) ?? [])]).toContain(planning.id);
  });
});

describe('OrchestratorEngine — fix loop (§4, §43.6)', () => {
  /** Dựng sẵn một task code đã xong và một task QA để kịch bản fix loop chạy. */
  async function setupQaScenario(qaOutcome: AgentOutcome) {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('QA', [qaOutcome]));

    const built = buildEngine(fake, registry);

    const devTask = await fake.repos.tasks.create({
      projectId,
      title: 'Viết API',
      description: '',
      priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER',
    });
    await fake.repos.tasks.setStatus(devTask.id, 'DONE');

    const qaTask = await fake.repos.tasks.create({
      projectId,
      title: 'Kiểm thử API',
      description: '',
      priority: 'HIGH',
      assignedRole: 'QA',
    });

    return { ...built, fake, projectId, devTask, qaTask };
  }

  it('QA báo lỗi thì tạo bug, trả task code về TODO và tăng vòng sửa', async () => {
    const { engine, fake, devTask, qaTask, events } = await setupQaScenario({
      status: 'completed',
      summary: 'Không đạt',
      endState: 'alert',
      reportedBugs: [{ title: 'Test đỏ', description: 'assert sai', severity: 'HIGH' }],
    });

    await engine.runTask(qaTask.id);

    expect(fake.bugs).toHaveLength(1);
    expect(fake.tasks.get(devTask.id)?.status).toBe('TODO');
    expect(fake.tasks.get(devTask.id)?.fixLoopCount).toBe(1);
    // QA cũng quay về TODO để kiểm lại sau khi dev sửa — và phải đợi dev,
    // không thì QA kiểm bản chưa sửa và đốt thêm một vòng.
    expect(fake.tasks.get(qaTask.id)?.status).toBe('TODO');
    expect(await fake.repos.tasks.dependencies(qaTask.id)).toContain(devTask.id);
    expect(events.map((event) => event.type)).toContain('BUG_CREATED');
  });

  it('nội dung lỗi được ghi vào hội thoại của task code để dev đọc lại', async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Không đạt',
      endState: 'alert',
      reportedBugs: [{ title: 'Thiếu validate email', description: 'nhập rác vẫn qua', severity: 'MEDIUM' }],
    });

    await engine.runTask(qaTask.id);

    const devMessages = fake.messages.filter((message) => message.taskId === devTask.id);
    expect(devMessages.some((message) => message.content.includes('Thiếu validate email'))).toBe(true);
  });

  it(`quá ${MAX_FIX_LOOP_ITERATIONS} vòng thì escalate lên CEO thay vì lặp vô hạn (§55)`, async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Vẫn không đạt',
      endState: 'alert',
      reportedBugs: [{ title: 'Test đỏ', description: 'vẫn sai', severity: 'HIGH' }],
    });

    // Đã sửa đủ số vòng cho phép; lần QA này là lần vượt trần.
    for (let i = 0; i < MAX_FIX_LOOP_ITERATIONS; i += 1) {
      await fake.repos.tasks.incrementFixLoop(devTask.id);
    }

    await engine.runTask(qaTask.id);

    expect(fake.tasks.get(devTask.id)?.status).toBe('BLOCKED');
    expect(fake.approvals).toHaveLength(1);
    expect(String(fake.approvals[0]!['summary'])).toContain('Duyệt = cho đội sửa thêm');
    expect(fake.approvals[0]!['context']).toEqual({ escalation: 'FIX_LOOP', qaTaskIds: [qaTask.id] });

    // CEO duyệt = cho sửa thêm một vòng: cả hai task về TODO, QA đợi dev.
    const resumed = await engine.resumeFixLoop({
      taskId: devTask.id,
      context: fake.approvals[0]!['context'] as Record<string, unknown>,
    });
    expect(resumed).toBe(true);
    expect(fake.tasks.get(devTask.id)?.status).toBe('TODO');
    expect(fake.tasks.get(qaTask.id)?.status).toBe('TODO');
    expect(await fake.repos.tasks.dependencies(qaTask.id)).toContain(devTask.id);
    expect(fake.messages.some((message) => message.content.includes('sửa thêm một vòng'))).toBe(true);
  });

  it('quá 3 vòng mà lỗi đang giảm thì Phòng điều hành tự cho sửa thêm, không hỏi CEO; tới trần 6 vòng thì hỏi', async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Vẫn rớt nhưng ít lỗi hơn',
      endState: 'alert',
      reportedBugs: [{ title: 'Còn một lỗi', description: 'x', severity: 'HIGH' }],
    });
    const qaAgent = await fake.repos.agents.findByRole('QA');
    for (let i = 0; i < MAX_FIX_LOOP_ITERATIONS; i += 1) await fake.repos.tasks.incrementFixLoop(devTask.id);
    // Vòng trước QA nêu 3 lỗi, vòng này còn 1.
    for (const title of ['Lỗi A', 'Lỗi B', 'Lỗi C']) {
      await fake.repos.bugs.create({ projectId: devTask.projectId, taskId: devTask.id, title, description: '', severity: 'HIGH', reportedByAgentId: qaAgent!.id });
    }

    await engine.runTask(qaTask.id);

    expect(fake.approvals).toHaveLength(0);
    expect(fake.tasks.get(devTask.id)?.status).toBe('TODO');
    expect(fake.messages.some((message) => message.taskId === devTask.id && message.content.includes('Phòng điều hành cho sửa thêm'))).toBe(true);
  });

  it('đã tới trần cứng 6 vòng thì hỏi CEO dù lỗi còn giảm', async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Rớt',
      endState: 'alert',
      reportedBugs: [{ title: 'Còn một lỗi', description: 'x', severity: 'HIGH' }],
    });
    const qaAgent = await fake.repos.agents.findByRole('QA');
    for (let i = 0; i < 6; i += 1) await fake.repos.tasks.incrementFixLoop(devTask.id);
    for (const title of ['Lỗi A', 'Lỗi B']) {
      await fake.repos.bugs.create({ projectId: devTask.projectId, taskId: devTask.id, title, description: '', severity: 'HIGH', reportedByAgentId: qaAgent!.id });
    }

    await engine.runTask(qaTask.id);

    expect(fake.approvals).toHaveLength(1);
  });

  it('lỗi không giảm sau 3 vòng thì vẫn hỏi CEO', async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Rớt',
      endState: 'alert',
      reportedBugs: [{ title: 'Lỗi A', description: 'x', severity: 'HIGH' }, { title: 'Lỗi B', description: 'y', severity: 'HIGH' }],
    });
    const qaAgent = await fake.repos.agents.findByRole('QA');
    for (let i = 0; i < MAX_FIX_LOOP_ITERATIONS; i += 1) await fake.repos.tasks.incrementFixLoop(devTask.id);
    for (const title of ['Lỗi A', 'Lỗi B']) {
      await fake.repos.bugs.create({ projectId: devTask.projectId, taskId: devTask.id, title, description: '', severity: 'HIGH', reportedByAgentId: qaAgent!.id });
    }

    await engine.runTask(qaTask.id);

    expect(fake.approvals).toHaveLength(1);
    expect(fake.tasks.get(devTask.id)?.status).toBe('BLOCKED');
  });

  it('reviewer thứ hai chấm rớt cùng task thì gộp vào phiếu đang chờ, không tạo phiếu mới', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    const rejection: AgentOutcome = {
      status: 'completed',
      summary: 'Không đạt',
      endState: 'alert',
      reportedBugs: [{ title: 'Chậm', description: 'quá 100ms', severity: 'HIGH' }],
    };
    registry.register(scriptedAgent('QA', [rejection, rejection]));
    const { engine } = buildEngine(fake, registry);

    const devTask = await fake.repos.tasks.create({
      projectId, title: 'Viết engine', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER',
    });
    await fake.repos.tasks.setStatus(devTask.id, 'DONE');
    const qa1 = await fake.repos.tasks.create({ projectId, title: 'QA 1', description: '', priority: 'HIGH', assignedRole: 'QA' });
    const qa2 = await fake.repos.tasks.create({ projectId, title: 'QA 2', description: '', priority: 'HIGH', assignedRole: 'QA' });
    for (let i = 0; i < MAX_FIX_LOOP_ITERATIONS; i += 1) await fake.repos.tasks.incrementFixLoop(devTask.id);

    await engine.runTask(qa1.id);
    await engine.runTask(qa2.id);

    expect(fake.approvals).toHaveLength(1);
    expect(fake.approvals[0]!['context']).toEqual({ escalation: 'FIX_LOOP', qaTaskIds: [qa1.id, qa2.id] });
    expect(fake.tasks.get(qa2.id)?.status).toBe('BLOCKED');

    // Từ chối = chấp nhận hiện trạng: cả ba task xong, dự án đi tiếp.
    const waived = await engine.waiveFixLoop({
      taskId: devTask.id,
      context: fake.approvals[0]!['context'] as Record<string, unknown>,
    });
    expect(waived).toBe(true);
    expect(fake.tasks.get(devTask.id)?.status).toBe('DONE');
    expect(fake.tasks.get(qa1.id)?.status).toBe('DONE');
    expect(fake.tasks.get(qa2.id)?.status).toBe('DONE');
    expect(fake.messages.some((message) => message.content.includes('chấp nhận hiện trạng'))).toBe(true);
  });

  it('phiếu không phải leo thang fix loop thì resumeFixLoop không đụng vào task nào', async () => {
    const { engine, fake, devTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Đạt',
      endState: 'completed',
      reportedBugs: [],
    });
    expect(await engine.resumeFixLoop({ taskId: devTask.id, context: { stageId: 'production' } })).toBe(false);
    expect(fake.tasks.get(devTask.id)?.status).toBe('DONE');
  });

  it('vòng khép kín: rớt → lỗi gắn vào task code, sửa → lỗi đang xử lý, QA đạt → lỗi VERIFIED, không chèn trùng', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    const bug = { title: 'Nút Cộng không cộng', description: '1+1 ra 11', severity: 'HIGH' as const };
    registry.register(
      scriptedAgent('QA', [
        { status: 'completed', summary: 'Rớt', endState: 'alert', reportedBugs: [bug] },
        { status: 'completed', summary: 'Vẫn rớt', endState: 'alert', reportedBugs: [{ ...bug, description: 'vẫn ra 11' }] },
        { status: 'completed', summary: 'Đạt', endState: 'completed', reportedBugs: [] },
      ]),
    );
    registry.register(scriptedAgent('FRONTEND_DEVELOPER', [{ status: 'completed', summary: 'đã sửa', endState: 'idle' }]));
    const { engine } = buildEngine(fake, registry);

    const dev = await fake.repos.tasks.create({ projectId, title: 'Viết máy tính', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(dev.id, 'DONE');
    const qa = await fake.repos.tasks.create({ projectId, title: 'Kiểm thử', description: '', priority: 'HIGH', assignedRole: 'QA' });

    await engine.runTask(qa.id);
    expect(fake.bugs).toHaveLength(1);
    expect(fake.bugs[0]).toMatchObject({ taskId: dev.id, status: 'IN_PROGRESS' });

    await engine.runTask(dev.id);
    await engine.runTask(qa.id);
    // Cùng tiêu đề → cập nhật mô tả, vẫn một dòng.
    expect(fake.bugs).toHaveLength(1);
    expect(fake.bugs[0]).toMatchObject({ description: 'vẫn ra 11', status: 'IN_PROGRESS' });

    await engine.runTask(dev.id);
    await engine.runTask(qa.id);
    expect(fake.bugs[0]?.['status']).toBe('VERIFIED');
    expect(fake.tasks.get(qa.id)?.status).toBe('DONE');
    expect(fake.messages.some((message) => message.content.includes('đóng lỗi'))).toBe(true);
  });

  it('CEO duyệt sửa thêm thì đếm vòng về 0; từ chối thì lỗi mở thành WONTFIX', async () => {
    const { engine, fake, devTask, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Vẫn không đạt',
      endState: 'alert',
      reportedBugs: [{ title: 'Test đỏ', description: 'vẫn sai', severity: 'HIGH' }],
    });
    for (let i = 0; i < MAX_FIX_LOOP_ITERATIONS; i += 1) await fake.repos.tasks.incrementFixLoop(devTask.id);
    await engine.runTask(qaTask.id);
    const context = fake.approvals[0]!['context'] as Record<string, unknown>;

    await engine.resumeFixLoop({ taskId: devTask.id, context });
    expect(fake.tasks.get(devTask.id)?.fixLoopCount).toBe(0);

    await engine.waiveFixLoop({ taskId: devTask.id, context });
    expect(fake.bugs[0]?.['status']).toBe('WONTFIX');
    expect(fake.messages.some((message) => message.content.includes('1 lỗi còn mở được đánh dấu bỏ qua'))).toBe(true);
  });

  it('QA đạt thì task hoàn tất và không tạo bug nào', async () => {
    const { engine, fake, qaTask } = await setupQaScenario({
      status: 'completed',
      summary: 'Đạt',
      endState: 'completed',
      reportedBugs: [],
    });

    await engine.runTask(qaTask.id);

    expect(fake.bugs).toHaveLength(0);
    expect(fake.tasks.get(qaTask.id)?.status).toBe('DONE');
  });

  it('lỗi nêu file giao cho đúng phòng sở hữu file, không đổ hết cho task code xong gần nhất', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('QA', [
        {
          status: 'completed',
          summary: 'Không đạt',
          endState: 'alert',
          reportedBugs: [
            { title: 'Dựng thất bại', description: 'lỗi cú pháp src/renderer/app.ts:23', severity: 'HIGH' },
            { title: 'npm test đỏ', description: 'src/main/storage.ts lệch kiểu với validate', severity: 'HIGH' },
            { title: 'Giao diện: trang chỉ có 2 nút bấm', description: 'thiếu màn hình chính', severity: 'HIGH' },
          ],
        },
      ]),
    );
    const { engine } = buildEngine(fake, registry);

    const frontend = await fake.repos.tasks.create({ projectId, title: 'Giao diện (renderer)', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(frontend.id, 'DONE');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Backend xong SAU — cách cũ đổ mọi lỗi cho Backend.
    const backend = await fake.repos.tasks.create({ projectId, title: 'Tiến trình chính', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(backend.id, 'DONE');
    const qa = await fake.repos.tasks.create({ projectId, title: 'Kiểm thử', description: '', priority: 'HIGH', assignedRole: 'QA' });

    await engine.runTask(qa.id);

    expect(fake.bugs.find((bug) => bug['title'] === 'Dựng thất bại')?.['taskId']).toBe(frontend.id);
    expect(fake.bugs.find((bug) => bug['title'] === 'npm test đỏ')?.['taskId']).toBe(backend.id);
    expect(fake.bugs.find((bug) => bug['title'] === 'Giao diện: trang chỉ có 2 nút bấm')?.['taskId']).toBe(frontend.id);
    expect(fake.tasks.get(frontend.id)?.status).toBe('TODO');
    expect(fake.tasks.get(backend.id)?.status).toBe('TODO');
    expect(await fake.repos.tasks.dependencies(qa.id)).toEqual(expect.arrayContaining([frontend.id, backend.id]));
    expect(fake.messages.some((message) => message.taskId === frontend.id && message.content.includes('app.ts'))).toBe(true);
    expect(fake.messages.some((message) => message.taskId === backend.id && message.content.includes('app.ts'))).toBe(false);
  });

  it('nhiều việc cùng phòng: lỗi về đúng việc có "Phạm vi tệp" chứa tệp bị lỗi', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('QA', [
        {
          status: 'completed', summary: 'Rớt', endState: 'alert',
          reportedBugs: [{ title: 'Màn chơi vỡ', description: 'src/renderer/ui/screen-quiz.ts:40 nút không bấm được', severity: 'HIGH' }],
        },
      ]),
    );
    const { engine } = buildEngine(fake, registry);
    const screens = await fake.repos.tasks.create({
      projectId, title: 'Các màn hình', description: 'Mục tiêu…\nPhạm vi tệp: src/renderer/ui/, src/renderer/app.ts', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER',
    });
    await fake.repos.tasks.setStatus(screens.id, 'DONE');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const logic = await fake.repos.tasks.create({
      projectId, title: 'Logic trò chơi', description: 'Phạm vi tệp: src/renderer/game/', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER',
    });
    await fake.repos.tasks.setStatus(logic.id, 'DONE');
    const qa = await fake.repos.tasks.create({ projectId, title: 'Kiểm thử', description: '', priority: 'HIGH', assignedRole: 'QA' });

    await engine.runTask(qa.id);

    expect(fake.bugs[0]?.['taskId']).toBe(screens.id);
    expect(fake.tasks.get(screens.id)?.status).toBe('TODO');
    expect(fake.tasks.get(logic.id)?.status).toBe('DONE');
  });

  it('lượt rà soát mới thay danh sách lỗi cũ của cùng người rà, không cộng dồn', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('SECURITY', [
        {
          status: 'completed', summary: 'Rớt', endState: 'alert',
          reportedBugs: [
            { title: 'Thiếu src/main.ts', description: 'không rà được', severity: 'HIGH' },
            { title: 'CSP lỏng', description: 'index.html', severity: 'MEDIUM' },
          ],
        },
        {
          status: 'completed', summary: 'Rớt', endState: 'alert',
          reportedBugs: [{ title: 'Csp lỏng', description: 'vẫn lỏng', severity: 'MEDIUM' }],
        },
      ]),
    );
    const { engine } = buildEngine(fake, registry);
    const dev = await fake.repos.tasks.create({ projectId, title: 'Viết app', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(dev.id, 'DONE');
    const review = await fake.repos.tasks.create({ projectId, title: 'Rà bảo mật', description: '', priority: 'HIGH', assignedRole: 'SECURITY' });

    await engine.runTask(review.id);
    await fake.repos.tasks.setStatus(dev.id, 'DONE');
    await engine.runTask(review.id);

    const open = fake.bugs.filter((bug) => bug['status'] === 'OPEN' || bug['status'] === 'IN_PROGRESS');
    expect(open.map((bug) => bug['title'])).toEqual(['CSP lỏng']);
    expect(fake.bugs.find((bug) => bug['title'] === 'Thiếu src/main.ts')?.['status']).toBe('VERIFIED');
  });
});

describe('Hàng đợi (§23)', () => {
  it('chạy nối tiếp các job cùng một dự án', async () => {
    const order: string[] = [];
    const { InMemoryJobQueue } = await import('./queue.js');
    const queue = new InMemoryJobQueue<string>(async (payload) => {
      order.push(`start:${payload}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${payload}`);
    });

    await queue.enqueue({ key: 'p1', payload: 'a' });
    await queue.enqueue({ key: 'p1', payload: 'b' });
    await queue.drain();

    // Không đan xen: b chỉ bắt đầu sau khi a kết thúc.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('một job lỗi không làm dừng job kế tiếp', async () => {
    const done: string[] = [];
    const onError = vi.fn();
    const { InMemoryJobQueue } = await import('./queue.js');
    const queue = new InMemoryJobQueue<string>(async (payload) => {
      if (payload === 'bad') throw new Error('hỏng');
      done.push(payload);
    }, onError);

    await queue.enqueue({ key: 'p1', payload: 'bad' });
    await queue.enqueue({ key: 'p1', payload: 'good' });
    await queue.drain();

    expect(done).toEqual(['good']);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('lượt hết giờ và nút Chạy lại', () => {
  /** Agent chỉ dừng khi lượt hết giờ — như lượt lập trình quá dài cho một lượt. */
  function hangingAgent(role: AgentRole): Agent & { calls: number } {
    const agent = {
      calls: 0,
      definition: {
        role,
        displayName: role,
        department: 'BACKEND',
        promptRole: 'BACKEND_DEVELOPER',
        defaultTaskKind: 'code',
        needsSandbox: false,
      },
      async run(context: AgentContext): Promise<AgentOutcome> {
        agent.calls += 1;
        return new Promise<AgentOutcome>((_resolve, reject) => {
          context.signal?.addEventListener('abort', () => reject(new Error('bị giết giữa chừng')), { once: true });
        });
      },
    };
    return agent as unknown as Agent & { calls: number };
  }

  it('hết giờ thì tự chạy tiếp 2 lần, lần thứ 3 mới chặn và báo CEO một lần', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    const agent = hangingAgent('BACKEND_DEVELOPER');
    registry.register(agent);
    const { engine, events } = buildEngine(fake, registry, { runTimeoutMs: 10 });
    const task = await fake.repos.tasks.create({ projectId, title: 'Lõi Electron', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(task.id, 'BLOCKED');

    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'queued' });
    await engine.drain();

    expect(agent.calls).toBe(3);
    const runs = [...fake.runs.values()].filter((run) => run['taskId'] === task.id);
    expect(runs.map((run) => run['status'])).toEqual(['TIMEOUT', 'TIMEOUT', 'TIMEOUT']);
    expect(String(runs[0]!['errorMessage'])).toContain('Hết giờ');
    expect(fake.tasks.get(task.id)?.status).toBe('BLOCKED');
    expect(events.filter((event) => event.type === 'TASK_FAILED')).toHaveLength(1);
    expect(fake.messages.filter((message) => message.taskId === task.id).map((message) => message.content)).toEqual([
      expect.stringContaining('Tự chạy tiếp phần còn lại (lần 1/2)'),
      expect.stringContaining('(lần 2/2)'),
      expect.stringContaining('Đã tự chạy tiếp 2 lần vẫn chưa xong'),
    ]);
  });

  it('Chạy lại: việc chuyển "đang làm" ngay, nhân viên hết "kẹt", bấm lần nữa không xếp trùng, việc đã xong thì từ chối', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    const agent = scriptedAgent('BACKEND_DEVELOPER', [{ status: 'completed', summary: 'xong', endState: 'completed' }]);
    registry.register(agent);
    const { engine, agentState } = buildEngine(fake, registry);
    const task = await fake.repos.tasks.create({ projectId, title: 'Lõi Electron', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(task.id, 'BLOCKED');
    const row = await fake.repos.agents.findByRole('BACKEND_DEVELOPER');
    await fake.repos.agents.setState(row!.id, 'blocked', {});

    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'queued', task: { status: 'IN_PROGRESS' } });
    expect(agentState.history).toContainEqual(['BACKEND_DEVELOPER', 'idle']);
    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'running' });

    await engine.drain();
    expect(agent.calls).toBe(1);
    expect(fake.tasks.get(task.id)?.status).toBe('DONE');
    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'done' });
    expect(await engine.retryTask(newId())).toEqual({ status: 'not_found' });
  });
});

describe('tự chạy lại việc kẹt vì lỗi tạm của nguồn AI', () => {
  async function blockedWith(fake: ReturnType<typeof createFake>, projectId: Uuid, error: string, minutesAgo: number) {
    const task = await fake.repos.tasks.create({ projectId, title: 'Viết API', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(task.id, 'BLOCKED');
    const run = await fake.repos.runs.create({ taskId: task.id, projectId, agentId: newId() });
    await fake.repos.runs.finish(run.id, {
      status: 'FAILED',
      errorMessage: error,
      finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    } as never);
    return task;
  }

  it('nguồn AI chưa cấu hình / hết lượt thì tự chạy lại sau 10 phút, tối đa 3 lần; lỗi mã và lỗi mới thì không', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(scriptedAgent('BACKEND_DEVELOPER', [{ status: 'failed', summary: 'vẫn lỗi', endState: 'blocked' }]));
    const { engine } = buildEngine(fake, registry);
    const config = await blockedWith(fake, projectId, 'AI provider "claude-code" is not configured (spec §47)', 30);
    const code = await blockedWith(fake, projectId, 'npm run build thất bại (exit 2): SyntaxError', 30);
    const fresh = await blockedWith(fake, projectId, 'Gemini 503: high demand', 2);

    expect(await engine.autoRetryBlocked()).toBe(1);
    expect(fake.tasks.get(config.id)?.status).toBe('IN_PROGRESS');
    expect(fake.tasks.get(code.id)?.status).toBe('BLOCKED');
    expect(fake.tasks.get(fresh.id)?.status).toBe('BLOCKED');
    expect(fake.messages.some((message) => message.taskId === config.id && message.content.includes('Tự chạy lại (lần 1/3)'))).toBe(true);

    // Nguồn vừa chạy lại được (CEO bấm Kiểm tra thành công): không đợi 10 phút.
    expect(await engine.autoRetryBlocked({ minAgeMs: 0 })).toBe(1);
    expect(fake.tasks.get(fresh.id)?.status).toBe('IN_PROGRESS');

    // Đủ 3 lần trong ngày thì thôi, để CEO xem.
    for (let i = 0; i < 3; i += 1) {
      await engine.drain();
      await fake.repos.tasks.setStatus(config.id, 'BLOCKED');
      const run = await fake.repos.runs.create({ taskId: config.id, projectId, agentId: newId() });
      await fake.repos.runs.finish(run.id, { status: 'FAILED', errorMessage: 'AI provider "claude-code" is not configured', finishedAt: ISO() } as never);
      await engine.autoRetryBlocked({ minAgeMs: 0 });
    }
    expect(fake.messages.filter((message) => message.taskId === config.id && message.content.startsWith('↻ Tự chạy lại'))).toHaveLength(3);
  });

  it('dự án đang dừng thì không tự chạy lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());
    await blockedWith(fake, projectId, 'Gemini 429 quota', 30);
    fake.project.status = 'PAUSED';
    expect(await engine.autoRetryBlocked()).toBe(0);
  });
});

describe('OrchestratorEngine — dừng dự án', () => {
  /** Agent viết 2/5 tệp rồi "gọi model" treo tới khi bị huỷ — như lượt CLI dài bị CEO bấm Dừng giữa chừng. */
  function hangingDev(): Agent & { calls: number; started: Promise<void> } {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const agent = {
      calls: 0,
      started,
      definition: {
        role: 'BACKEND_DEVELOPER' as AgentRole,
        displayName: 'Backend',
        department: 'BACKEND',
        promptRole: 'BACKEND_DEVELOPER',
        defaultTaskKind: 'code',
        needsSandbox: true,
      },
      async run(context: AgentContext): Promise<AgentOutcome> {
        agent.calls += 1;
        if (agent.calls > 1) return { status: 'completed', summary: 'viết nốt', endState: 'completed' };
        await context.sandbox!.writeFile(
          `.pn/tien-do/${context.taskId}.json`,
          JSON.stringify({ taskId: context.taskId, fixLoopCount: 0, plan: { files: [1, 2, 3, 4, 5] }, done: ['a', 'b'] }),
        );
        markStarted();
        return new Promise<AgentOutcome>((_resolve, reject) => {
          context.signal!.addEventListener('abort', () => reject(new Error('aborted')));
        });
      },
    };
    return agent as unknown as Agent & { calls: number; started: Promise<void> };
  }

  async function setup() {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    const dev = hangingDev();
    registry.register(dev);
    const { engine, events } = buildEngine(fake, registry, { sandbox: memorySandbox().driver });
    const task = await fake.repos.tasks.create({ projectId, title: 'Viết API', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER', stageId: 'build' });
    return { projectId, fake, dev, engine, events, task };
  }

  it('cắt ngay lượt đang chạy: việc về chờ làm, lượt ghi đã huỷ, không báo lỗi, lịch sử ghi dừng ở đâu', async () => {
    const { projectId, fake, dev, engine, events, task } = await setup();
    await engine.advance(projectId);
    await dev.started;

    expect(await engine.stopProject(projectId)).toMatchObject({ aborted: 1 });
    await engine.drain();

    expect(fake.project.status).toBe('PAUSED');
    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
    expect([...fake.runs.values()][0]).toMatchObject({ status: 'CANCELLED' });
    expect(events.some((event) => event.type === 'TASK_FAILED')).toBe(false);
    expect(fake.messages.at(-1)?.content).toContain('Đã viết xong 2/5 tệp');
    // Đang dừng thì không xếp gì, kể cả "chạy lại" từng việc.
    expect(await engine.advance(projectId)).toBe(0);
    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'paused' });
    expect(dev.calls).toBe(1);
  });

  it('việc đã xếp hàng nhưng chưa tới lượt: không chạy nữa', async () => {
    const { projectId, fake, dev, engine, task } = await setup();
    await fake.repos.tasks.setStatus(task.id, 'IN_PROGRESS');
    await engine.stopProject(projectId);
    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
    expect(await engine.runTask(task.id)).toBeNull();
    expect(dev.calls).toBe(0);
  });

  it('tiếp tục: dự án chạy lại, việc dở làm nối tới xong', async () => {
    const { projectId, fake, dev, engine, task } = await setup();
    await engine.advance(projectId);
    await dev.started;
    await engine.stopProject(projectId);
    await engine.drain();

    expect(await engine.resumeProject(projectId)).toBe(1);
    await engine.drain();
    expect(fake.project.status).not.toBe('PAUSED');
    expect(fake.tasks.get(task.id)?.status).toBe('DONE');
    expect(dev.calls).toBe(2);
  });

  it('dừng hẳn dự án: cắt lượt, dự án CANCELLED, không tự chạy tiếp', async () => {
    const { projectId, fake, dev, engine, task } = await setup();
    await engine.advance(projectId);
    await dev.started;

    await engine.stopProject(projectId, 'cancel');
    await engine.drain();

    expect(fake.project.status).toBe('CANCELLED');
    expect(fake.tasks.get(task.id)?.status).toBe('TODO');
    expect(await engine.advance(projectId)).toBe(0);
    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'paused' });
  });

  it('tạm dừng riêng một việc: lượt bị cắt, việc PAUSED, dự án vẫn chạy; bấm Tiếp tục thì làm nối', async () => {
    const { projectId, fake, dev, engine, events, task } = await setup();
    await engine.advance(projectId);
    await dev.started;

    expect(await engine.stopTask(task.id, 'pause')).toMatchObject({ status: 'stopped' });
    await engine.drain();

    expect(fake.tasks.get(task.id)?.status).toBe('PAUSED');
    expect(fake.project.status).toBe('IN_PROGRESS');
    expect([...fake.runs.values()][0]).toMatchObject({ status: 'CANCELLED' });
    expect(fake.messages.at(-1)?.content).toContain('CEO tạm dừng việc này');
    expect(events.some((event) => event.type === 'TASK_FAILED')).toBe(false);
    // advance không tự chạy lại việc đang tạm dừng.
    expect(await engine.advance(projectId)).toBe(0);

    expect(await engine.retryTask(task.id)).toMatchObject({ status: 'queued' });
    await engine.drain();
    expect(fake.tasks.get(task.id)?.status).toBe('DONE');
  });

  it('dừng hẳn một việc: việc CANCELLED, việc phía sau không đợi nó nữa', async () => {
    const { projectId, fake, dev, engine, task } = await setup();
    const next = await fake.repos.tasks.create({
      projectId, title: 'Viết tiếp', description: '', priority: 'HIGH', assignedRole: 'BACKEND_DEVELOPER', stageId: 'build', dependsOn: [task.id],
    });
    await engine.advance(projectId);
    await dev.started;

    await engine.stopTask(task.id, 'cancel');
    await engine.drain();

    expect(fake.tasks.get(task.id)?.status).toBe('CANCELLED');
    // Hàng đợi tự đẩy dự án tiếp: việc phía sau chạy luôn tới xong.
    expect(fake.tasks.get(next.id)?.status).toBe('DONE');
  });

  it('việc tạm dừng lúc còn trong hàng đợi thì không chạy', async () => {
    const { fake, dev, engine, task } = await setup();
    await fake.repos.tasks.setStatus(task.id, 'IN_PROGRESS');
    await engine.stopTask(task.id, 'pause');
    expect(await engine.runTask(task.id)).toBeNull();
    expect(dev.calls).toBe(0);
  });
});

describe('Dựng staging dừng được', () => {
  /** Bộ dựng giả treo tới khi bị huỷ — như npm install + electron-builder mất vài phút. */
  function hangingDeployer() {
    let calls = 0;
    const deployer = async (_project: unknown, signal?: AbortSignal) => {
      calls += 1;
      return new Promise<{ status: 'CANCELLED' }>((resolve) => {
        signal?.addEventListener('abort', () => resolve({ status: 'CANCELLED' }), { once: true });
      });
    };
    return { deployer, calls: () => calls };
  }

  async function settle(engine: OrchestratorEngine, projectId: Uuid): Promise<void> {
    for (let i = 0; i < 50 && engine.isBuildingStaging(projectId); i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  }

  it('nút Dựng bản thử: một bản mỗi dự án, bấm lần nữa báo đang dựng, nút Dừng cắt được và không đánh dấu hoàn thành', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());
    const hanging = hangingDeployer();
    engine.useStagingDeployer(hanging.deployer);

    expect(await engine.buildStaging(projectId)).toBe('started');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await engine.buildStaging(projectId)).toBe('running');
    expect(hanging.calls()).toBe(1);

    const build = [...fake.tasks.values()].find((task) => task.title === 'Dựng bản staging')!;
    await engine.stopTask(build.id, 'pause');
    await settle(engine, projectId);

    expect(fake.tasks.get(build.id)?.status).toBe('PAUSED');
    expect(fake.project.status).not.toBe('COMPLETED');
    expect(fake.messages.at(-1)?.content).toContain('dựng lại từ đầu');
  });

  it('dừng dự án cũng cắt bản dựng đang chạy; Tiếp tục thì dựng lại', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const { engine } = buildEngine(fake, new AgentRegistry());
    const hanging = hangingDeployer();
    engine.useStagingDeployer(hanging.deployer);

    await engine.buildStaging(projectId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await engine.stopProject(projectId)).toMatchObject({ aborted: 1 });
    await settle(engine, projectId);
    const build = [...fake.tasks.values()].find((task) => task.title === 'Dựng bản staging')!;
    expect(fake.tasks.get(build.id)?.status).toBe('PAUSED');
    expect(await engine.buildStaging(projectId)).toBe('halted');

    await engine.resumeProject(projectId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(hanging.calls()).toBe(2);
    await engine.stopTask(build.id, 'cancel');
    await settle(engine, projectId);
    expect(fake.tasks.get(build.id)?.status).toBe('CANCELLED');
  });

  it('người rà soát mở lại mã thì bỏ bước staging của mã cũ', async () => {
    const projectId = newId();
    const fake = createFake(projectId);
    const registry = new AgentRegistry();
    registry.register(
      scriptedAgent('QA', [
        { status: 'completed', summary: 'Rớt', endState: 'alert', reportedBugs: [{ title: 'Test đỏ', description: 'x', severity: 'HIGH' }] },
      ]),
    );
    const { engine } = buildEngine(fake, registry);
    const dev = await fake.repos.tasks.create({ projectId, title: 'Viết app', description: '', priority: 'HIGH', assignedRole: 'FRONTEND_DEVELOPER' });
    await fake.repos.tasks.setStatus(dev.id, 'DONE');
    const qa = await fake.repos.tasks.create({ projectId, title: 'Kiểm thử', description: '', priority: 'HIGH', assignedRole: 'QA' });
    await fake.repos.tasks.create({ projectId, title: 'Dựng bản staging', description: '', priority: 'HIGH', assignedRole: 'DEVOPS', stageId: 'staging' });

    await engine.runTask(qa.id);

    expect([...fake.tasks.values()].some((task) => task.stageId === 'staging')).toBe(false);
  });
});
