/** §15, §51, §52, §53, §80 — định tuyến, smart routing, fallback, cầu dao. */

import { describe, expect, it, vi } from 'vitest';

import { ModelCatalog } from './catalog.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { computeCost } from './cost.js';
import { ProviderNotConfiguredError } from './registry.js';
import { DEFAULT_RETRY_POLICY, ModelRouter, retryDelayMs, type RouteConfig } from './router.js';
import { LlmError, type GenerateResult, type LLMProvider } from './types.js';

function fakeResult(model: string): GenerateResult {
  return {
    provider: 'anthropic',
    model,
    text: 'ok',
    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0 },
    costUsd: 0,
    latencyMs: 1,
    stopReason: 'end_turn',
    requestId: 'req_1',
  };
}

function fakeProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: 'anthropic',
    displayName: 'fake',
    generate: vi.fn(async ({ model }) => fakeResult(model)),
    stream: vi.fn(),
    estimateCost: () => 0,
    listModels: vi.fn(async () => []),
    testConnection: vi.fn(),
    ...overrides,
  } as LLMProvider;
}

const ROUTE: RouteConfig = {
  agentRole: 'CTO_ORCHESTRATOR',
  tier: 'strong',
  provider: 'anthropic',
  model: 'claude-opus-5',
  fallbacks: [{ provider: 'openai', model: 'gpt-5' }],
};

describe('ModelRouter.resolve (§51, §52)', () => {
  it('chế độ custom tôn trọng đúng route đã cấu hình (§51 Custom)', () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'custom',
    });
    const decision = router.resolve('CTO_ORCHESTRATOR', { taskKind: 'summarization' });
    expect(decision.model).toBe('claude-opus-5');
    expect(decision.reason).toBe('custom route');
  });

  it('hạ vai trò hạng strong xuống hạng rẻ hơn cho việc cơ học (§52)', () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'balanced',
      smartRouting: true,
    });
    const decision = router.resolve('CTO_ORCHESTRATOR', { taskKind: 'classification' });
    expect(decision.tier).toBe('cheap');
    expect(decision.model).not.toBe('claude-opus-5');
  });

  it('giữ hạng strong cho việc rà soát kiến trúc (§52)', () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'balanced',
    });
    expect(router.resolve('CTO_ORCHESTRATOR', { taskKind: 'architecture_review' }).tier).toBe('strong');
  });

  it('hạ hạng khi ngân sách gần cạn (§52, §55)', () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'balanced',
      budgetRemainingUsd: () => 0.2,
    });
    expect(router.resolve('CTO_ORCHESTRATOR').tier).toBe('medium');
  });

  it('chế độ economy không bao giờ chọn hạng strong (§51 Economy)', () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'economy',
    });
    expect(router.resolve('CTO_ORCHESTRATOR').tier).not.toBe('strong');
  });
});

describe('ModelRouter.generate fallback (§53)', () => {
  it('chuyển sang provider kế tiếp khi gặp lỗi đáng retry và có ghi lại', async () => {
    const onFallback = vi.fn();
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'overloaded', 'upstream overloaded', 529);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      onFallback,
      sleep: async () => undefined,
    });

    const result = await router.generate('CTO_ORCHESTRATOR', {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.model).toBe('gpt-5');
    // §53 — "Phải log: Primary provider failed / Fallback provider selected / Reason".
    expect(onFallback).toHaveBeenCalledOnce();
    expect(onFallback.mock.calls[0]![0].reason).toContain('overloaded');
  });

  it('lỗi xác thực (key sai, đăng nhập CLI hết hạn): không thử lại, lùi sang dự phòng, né 30 phút', async () => {
    // Trước đây lỗi xác thực không chuyển hãng (§53: lỗi cấu hình). Với CLI gói thuê bao, phiên đăng nhập
    // hết hạn là chuyện thường — dự án không được kẹt; gateway nhắn CEO qua PROVIDER_ALERT nên không im lặng.
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    const onFallback = vi.fn();
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'auth', 'invalid key', 401);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      breaker,
      onFallback,
      sleep: async () => undefined,
    });

    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.model).toBe('gpt-5');
    expect(primary.generate).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0]![0].reason).toMatch(/^auth:/);
    now = 29 * 60_000;
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('open');
    now = 30 * 60_000;
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('half_open');
  });
});

describe('thử lại có giới hạn (§78, §79)', () => {
  it('thử lại trên chính model đó trước khi đổi provider', async () => {
    let calls = 0;
    const primary = fakeProvider({
      generate: vi.fn(async ({ model }) => {
        calls += 1;
        if (calls === 1) throw new LlmError('anthropic', 'rate_limit', 'quá nhanh', 429);
        return fakeResult(model);
      }),
    });
    const onFallback = vi.fn();

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => primary,
      routes: [ROUTE],
      mode: 'custom',
      onFallback,
      sleep: async () => undefined,
    });

    const result = await router.generate('CTO_ORCHESTRATOR', {
      messages: [{ role: 'user', content: 'hi' }],
    });

    // Một lần 429 thoáng qua không được đẩy sang provider khác — model đó vẫn
    // hoạt động bình thường, chỉ là đang bận.
    expect(result.model).toBe('claude-opus-5');
    expect(calls).toBe(2);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('hết số lần thử thì mới chuyển provider (§79 — không retry vô hạn)', async () => {
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'rate_limit', 'quá nhanh', 429);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      retry: { maxRetries: 2 },
      sleep: async () => undefined,
    });

    const result = await router.generate('CTO_ORCHESTRATOR', {
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(result.model).toBe('gpt-5');
    // Lần đầu + hai lần thử lại, rồi mới bỏ cuộc.
    expect(primary.generate).toHaveBeenCalledTimes(3);
  });

  it('lỗi không đáng thử lại thì không thử lại lần nào', async () => {
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'invalid_request', 'thiếu tham số', 400);
      }),
    });

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => primary,
      routes: [{ ...ROUTE, fallbacks: [] }],
      mode: 'custom',
      sleep: async () => undefined,
    });

    await expect(
      router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/thiếu tham số/);
    expect(primary.generate).toHaveBeenCalledOnce();
  });

  it('backoff tăng gấp đôi nhưng có trần — §78 cấm retry storm', () => {
    const policy = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 4000 };

    expect(retryDelayMs(policy, 0)).toBe(1000);
    expect(retryDelayMs(policy, 1)).toBe(2000);
    expect(retryDelayMs(policy, 2)).toBe(4000);
    expect(retryDelayMs(policy, 9)).toBe(4000);
  });

  it('tôn trọng retry-after của provider khi nó dài hơn backoff của ta', () => {
    const policy = { maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30_000 };

    expect(retryDelayMs(policy, 0, 5_000)).toBe(5_000);
    // Ngắn hơn backoff thì vẫn chờ đủ backoff, không gọi lại dồn dập.
    expect(retryDelayMs(policy, 3, 100)).toBe(8_000);
    // Header sai bét cũng không treo task hàng giờ.
    expect(retryDelayMs(policy, 0, 999_999)).toBe(30_000);
  });

  it('mặc định thử lại hai lần — đủ cho lỗi thoáng qua, không thành bão', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBe(2);
  });
});

describe('né model đang nghẽn', () => {
  it('model quá tải sau khi thử hết lượt thì người gọi sau đi thẳng sang dự phòng', async () => {
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('google', 'server', 'Gemini 503: overloaded', 503);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });

    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      sleep: async () => undefined,
    });
    const ask = (): Promise<GenerateResult> =>
      router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] });

    expect((await ask()).model).toBe('gpt-5');
    expect((await ask()).model).toBe('gpt-5');
    // Người đầu thử 3 lần rồi mới chuyển; người thứ hai không gọi model đang nghẽn nữa.
    expect(primary.generate).toHaveBeenCalledTimes(3);
  });

  it('hết credit: không thử lại, chuyển hãng ngay, né hãng đó 6 giờ', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ now: () => now });
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'quota', 'Anthropic 429: credit_balance too low', 429);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });
    const fallbacks: string[] = [];
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      breaker,
      sleep: async () => undefined,
      onFallback: (event) => fallbacks.push(event.reason),
    });

    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.model).toBe('gpt-5');
    expect(primary.generate).toHaveBeenCalledTimes(1);
    expect(fallbacks[0]).toMatch(/^quota:/);
    now = 5 * 60 * 60_000;
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('open');
    now = 6 * 60 * 60_000;
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('half_open');
  });

  it('hãng đã xoá key mà vẫn nằm trong chuỗi thì đi thẳng sang dự phòng, không chặn việc', async () => {
    const secondary = fakeProvider({ id: 'openai' });
    const breaker = new CircuitBreaker();
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => {
        if (id === 'anthropic') throw new ProviderNotConfiguredError('anthropic');
        return secondary;
      },
      routes: [ROUTE],
      mode: 'custom',
      breaker,
      sleep: async () => undefined,
    });
    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] });
    expect(result.model).toBe('gpt-5');
    // Không phải model hỏng: không ghi vào cầu dao.
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('closed');
  });

  it('lỗi không phải do bận (sai tham số) thì không né cả công ty', async () => {
    const breaker = new CircuitBreaker();
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'invalid_request', 'thiếu tham số', 400);
      }),
    });
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => primary,
      routes: [ROUTE],
      mode: 'custom',
      breaker,
      sleep: async () => undefined,
    });
    await expect(router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow();
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('closed');
  });

  it('ngắt tức thì có hẹn giờ riêng, hết giờ thì cho thử lại', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ cooldownMs: 1000, now: () => now });
    breaker.trip('google:gemini-3.7-flash', 5000);
    expect(breaker.stateOf('google:gemini-3.7-flash')).toBe('open');
    now = 4999;
    expect(breaker.stateOf('google:gemini-3.7-flash')).toBe('open');
    now = 5000;
    expect(breaker.stateOf('google:gemini-3.7-flash')).toBe('half_open');
  });
});

describe('CircuitBreaker (§80)', () => {
  it('ngắt mạch khi quá ngưỡng và phục hồi sau khoảng nghỉ', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, now: () => now });

    breaker.recordFailure('anthropic:claude-opus-5');
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('closed');

    breaker.recordFailure('anthropic:claude-opus-5');
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('open');
    expect(() => breaker.assertClosed('anthropic:claude-opus-5')).toThrow(/§80/);

    now = 1001;
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('half_open');
    breaker.recordSuccess('anthropic:claude-opus-5');
    expect(breaker.stateOf('anthropic:claude-opus-5')).toBe('closed');
  });
});

describe('ModelRouter.generate — avoid (model trả lời hỏng lượt trước)', () => {
  it('bỏ qua model đã né, đi thẳng sang dự phòng dù model chính không báo lỗi', async () => {
    const generate = vi.fn(async ({ model }: { model: string }) => fakeResult(model));
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider({ generate } as Partial<LLMProvider>),
      routes: [{ ...ROUTE, tier: 'strong' }],
      mode: 'custom',
    });
    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'x' }] }, {}, [
      { provider: 'anthropic', model: 'claude-opus-5' },
    ]);
    expect(result.model).toBe('gpt-5');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('né hết mà không còn ai thì vẫn thử chuỗi gốc thay vì báo hết route', async () => {
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => fakeProvider(),
      routes: [ROUTE],
      mode: 'custom',
    });
    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'x' }] }, {}, [
      { provider: 'anthropic', model: 'claude-opus-5' },
      { provider: 'openai', model: 'gpt-5' },
    ]);
    expect(result.model).toBe('claude-opus-5');
  });
});

describe('cost (§16)', () => {
  const catalog = new ModelCatalog();

  it('tính đúng giá cho model có trong danh mục', () => {
    // Claude Opus 5: $5 / triệu token vào, $25 / triệu token ra.
    const cost = computeCost(catalog, 'claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedTokens: 0,
    });
    expect(cost).toBe(30);
  });

  it('model chưa có giá thì trả null, không phải 0 (§16, §89)', () => {
    expect(
      computeCost(catalog, 'gpt-5', { inputTokens: 1000, outputTokens: 1000, cachedTokens: 0 }),
    ).toBeNull();
  });

  it('token cache được tính theo đơn giá đọc cache', () => {
    const cost = computeCost(catalog, 'claude-opus-5', {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 1_000_000,
    });
    expect(cost).toBe(0.5);
  });
});

describe('lượt chạy hết giờ (lượt 30 phút kéo thành 62 phút)', () => {
  it('provider bị giết vì hết giờ báo "timeout": không thử lại, không chuyển hãng, ném "aborted"', async () => {
    const controller = new AbortController();
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        controller.abort();
        throw new LlmError('anthropic', 'timeout', 'tiến trình bị giết');
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });
    const onFallback = vi.fn();
    const failures: unknown[] = [];
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      onFallback,
      sleep: async () => undefined,
    });

    await expect(
      router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }, {}, [], (failure) =>
        failures.push(failure),
      ),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(primary.generate).toHaveBeenCalledOnce();
    expect(secondary.generate).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
  });

  it('đã hết giờ từ trước thì không mở lời gọi nào', async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = fakeProvider();
    const router = new ModelRouter({ catalog: new ModelCatalog(), getProvider: () => primary, routes: [ROUTE], mode: 'custom' });

    await expect(
      router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(primary.generate).not.toHaveBeenCalled();
  });

  it('hết giờ trong lúc chờ backoff: lần thử lại kế tiếp không được mở', async () => {
    const controller = new AbortController();
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'rate_limit', 'quá nhanh', 429);
      }),
    });
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: () => primary,
      routes: [{ ...ROUTE, fallbacks: [] }],
      mode: 'custom',
      sleep: async () => controller.abort(),
    });

    await expect(
      router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' });
    expect(primary.generate).toHaveBeenCalledOnce();
  });

  it('mỗi lần gọi hỏng trong chuỗi thử lại / chuyển hãng đều được báo ra, đúng hãng và model', async () => {
    const primary = fakeProvider({
      generate: vi.fn(async () => {
        throw new LlmError('anthropic', 'overloaded', 'bận', 529);
      }),
    });
    const secondary = fakeProvider({ id: 'openai' });
    const failures: Array<{ target: { provider: string; model: string }; retry: number }> = [];
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'anthropic' ? primary : secondary),
      routes: [ROUTE],
      mode: 'custom',
      sleep: async () => undefined,
    });

    const result = await router.generate('CTO_ORCHESTRATOR', { messages: [{ role: 'user', content: 'hi' }] }, {}, [], (failure) =>
      failures.push(failure),
    );
    expect(result.model).toBe('gpt-5');
    expect(failures.map((failure) => `${failure.target.provider}/${failure.target.model}#${failure.retry}`)).toEqual([
      'anthropic/claude-opus-5#0',
      'anthropic/claude-opus-5#1',
      'anthropic/claude-opus-5#2',
    ]);
  });
});

describe('mức suy nghĩ khi gọi Claude qua gói', () => {
  it('CLI nhận mức theo vai: CTO "high", dev "medium"; hãng khác không bị gắn', async () => {
    const cli = fakeProvider({ id: 'claude-code' });
    const api = fakeProvider();
    const router = new ModelRouter({
      catalog: new ModelCatalog(),
      getProvider: (id) => (id === 'claude-code' ? cli : api),
      routes: [
        { ...ROUTE, provider: 'claude-code', model: 'opus', fallbacks: [] },
        { ...ROUTE, agentRole: 'BACKEND_DEVELOPER', provider: 'claude-code', model: 'opus', fallbacks: [] },
        { ...ROUTE, agentRole: 'QA', fallbacks: [] },
      ],
      mode: 'custom',
    });
    const ask = { messages: [{ role: 'user' as const, content: 'hi' }] };

    await router.generate('CTO_ORCHESTRATOR', ask);
    await router.generate('BACKEND_DEVELOPER', ask);
    await router.generate('QA', ask);
    expect(vi.mocked(cli.generate).mock.calls.map(([request]) => request.effort)).toEqual(['high', 'medium']);
    expect(vi.mocked(api.generate).mock.calls[0]![0].effort).toBeUndefined();
  });
});
