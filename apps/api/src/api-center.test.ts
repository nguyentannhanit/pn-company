/**
 * P&N — Kiểm chứng tiêu chí nghiệm thu API Center (§88) và các ràng buộc §89.
 *
 * Trọng tâm: "Không secret nào xuất hiện trong client bundle/log" (§88.17) và
 * "Phải có test xác nhận secret không xuất hiện trong API response" (§89).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { containsSecret } from '@pn/shared';

import { loadModelPricing } from './context.js';
import { seedRouting } from './routes/api-center.js';
import { createTestApp, leakyProvider, type TestHarness } from './test/fixtures.js';

const API_KEY = 'sk-ant-api03-BIMATKHONGDUOCLOabcdefghijklmnop0123456789';
// Cửa /internal/* đọc secret dịch vụ lúc đăng ký route, nên phải đặt trước khi dựng app.
process.env['PN_SERVICE_SECRET'] = 'bi-mat-test';

let harness: TestHarness;
let token: string;

beforeAll(async () => {
  harness = await createTestApp();
  token = await harness.loginAsCeo();
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
});

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('Thương hiệu (§150)', () => {
  it('endpoint /branding trả về tên P&N', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/branding' });
    const body = response.json() as { companyName: string; welcomeHeadline: string };
    expect(body.companyName).toBe('P&N');
    expect(body.welcomeHeadline).toBe('Welcome to P&N');
  });

  it('không có tên demo nào trong response', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/branding' });
    expect(response.body).not.toMatch(/AI Software Company|Demo Corp|Agent Company/i);
  });
});

describe('Xác thực (§20)', () => {
  it('chặn request chưa đăng nhập', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api-center/providers' });
    expect(response.statusCode).toBe(401);
  });

  it('bootstrap lần hai bị từ chối vì đã có tài khoản', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/auth/bootstrap',
      payload: { email: 'x@pn.test', password: 'mat-khau-du-manh-123', displayName: 'X' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('không trả password hash trong /auth/me', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/auth/me', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('scrypt$');
  });

  it('sai mật khẩu và sai email trả cùng một thông báo', async () => {
    const wrongPassword = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ceo@pn.test', password: 'sai-mat-khau-hoan-toan' },
    });
    const wrongEmail = await harness.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'khongtontai@pn.test', password: 'sai-mat-khau-hoan-toan' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongEmail.body).toBe(wrongPassword.body);
  });
});

describe('API Center — vòng đời API key (§88.1–88.6)', () => {
  it('§88.1 + §88.2 — nhập được key và key được lưu mã hoá', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/providers/anthropic',
      headers: auth(),
      payload: { apiKey: API_KEY, isEnabled: true, defaultModel: 'claude-opus-5' },
    });
    expect(response.statusCode).toBe(200);

    // Bản ghi trong kho secret không chứa plaintext.
    const stored = await harness.context.repos.secretStorage.get('ai:anthropic:development');
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain(API_KEY);
  });

  it('§88.3 — làm mới trang không trả về key thô', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api-center/providers',
      headers: auth(),
    });

    expect(response.body).not.toContain(API_KEY);
    expect(containsSecret(response.body)).toBe(false);

    const body = response.json() as { providers: Array<{ keyPreview: string; hasKey: boolean }> };
    const anthropic = body.providers[0]!;
    expect(anthropic.hasKey).toBe(true);
    expect(anthropic.keyPreview).toContain('…');
    expect(anthropic.keyPreview.length).toBeLessThan(API_KEY.length);
  });

  it('§88.3 — response cũng không rò `secretRef`', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api-center/providers',
      headers: auth(),
    });
    expect(response.body).not.toContain('secretRef');
  });

  it('§88.4 + §88.5 — Test Connection gọi thật và ghi lại trạng thái', async () => {
    // Nạp một provider giả lập trả lỗi CÓ CHỨA key, để kiểm tra cả redaction.
    harness.context.registry.register('anthropic', () => leakyProvider(API_KEY));
    harness.context.registry.configure('anthropic', { apiKey: API_KEY });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-center/providers/anthropic/test',
      headers: auth(),
    });

    const body = response.json() as { ok: boolean; error: string | null };
    expect(body.ok).toBe(false);

    // §89 — key nằm trong thông báo lỗi của provider vẫn không được lọt ra ngoài.
    expect(response.body).not.toContain(API_KEY);
    expect(containsSecret(response.body)).toBe(false);
  });

  it('§88.4 — chưa cấu hình key thì báo lỗi thật, không trả "ok" giả', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-center/providers/openai/test',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false });
  });

  it('§88.6 — tắt được provider', async () => {
    const response = await harness.app.inject({
      method: 'PATCH',
      url: '/api-center/providers/anthropic/enabled',
      headers: auth(),
      payload: { isEnabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(harness.context.registry.has('anthropic')).toBe(false);

    // Bật lại để các test sau dùng tiếp.
    harness.context.registry.register('anthropic', () => leakyProvider(API_KEY));
    harness.context.registry.configure('anthropic', { apiKey: API_KEY });
  });

  it('CLI gói thuê bao bật được không cần key; tắt thì rút client', async () => {
    const on = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/providers/codex',
      headers: auth(),
      payload: { isEnabled: true },
    });
    expect(on.statusCode).toBe(200);
    expect(harness.context.registry.has('codex')).toBe(true);

    const list = (await harness.app.inject({ method: 'GET', url: '/api-center/providers', headers: auth() })).json() as {
      providers: Array<{ provider: string; isEnabled: boolean; hasKey: boolean }>;
    };
    expect(list.providers.find((row) => row.provider === 'codex')).toMatchObject({ isEnabled: true, hasKey: false });

    const off = await harness.app.inject({
      method: 'PATCH',
      url: '/api-center/providers/codex/enabled',
      headers: auth(),
      payload: { isEnabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(harness.context.registry.has('codex')).toBe(false);
  });

  it('xoá hẳn key: gỡ khỏi kho secret, tắt hãng, rút client; xoá lần hai báo không có key', async () => {
    await harness.app.inject({
      method: 'PUT',
      url: '/api-center/providers/openai',
      headers: auth(),
      payload: { apiKey: 'sk-xoa-thu-1234567890', isEnabled: true },
    });
    harness.context.registry.register('openai', () => leakyProvider('sk-xoa-thu-1234567890'));
    harness.context.registry.configure('openai', { apiKey: 'sk-xoa-thu-1234567890' });

    const removed = await harness.app.inject({ method: 'DELETE', url: '/api-center/providers/openai', headers: auth() });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({ ok: true, provider: 'openai' });
    expect(await harness.context.repos.secretStorage.get('ai:openai:development')).toBeNull();
    expect(harness.context.registry.has('openai')).toBe(false);

    const list = (await harness.app.inject({ method: 'GET', url: '/api-center/providers', headers: auth() })).json() as {
      providers: Array<{ provider: string; keyPreview: string | null; isEnabled: boolean }>;
    };
    expect(list.providers.find((row) => row.provider === 'openai')).toMatchObject({ keyPreview: null, isEnabled: false });

    const again = await harness.app.inject({ method: 'DELETE', url: '/api-center/providers/openai', headers: auth() });
    expect(again.statusCode).toBe(404);
  });
});

describe('API Center — định tuyến model (§88.7–88.9)', () => {
  it('§50 — tạo bảng định tuyến từ model thật kể cả khi provider không có hạng mạnh', async () => {
    // Google chỉ còn cấp model hạng trung cho tài khoản mới; định tuyến vẫn phải
    // ra được, lấy hạng gần nhất thay vì báo "không có model strong".
    const result = await seedRouting(harness.context, 'google', [
      {
        id: 'gemini-3.6-flash',
        provider: 'google',
        displayName: 'Gemini 3.6 Flash',
        tier: 'medium',
        contextWindow: 1_000_000,
        maxOutputTokens: 65_536,
        pricing: null,
        pricingSource: 'discovered',
        pricingAsOf: null,
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      models: { strong: 'gemini-3.6-flash', medium: 'gemini-3.6-flash', cheap: 'gemini-3.6-flash' },
    });
  });

  it('§53 — bảng mặc định tự có dự phòng từ hãng khác đã kết nối', async () => {
    await seedRouting(harness.context, 'google');
    const routes = await harness.context.repos.routes.list(harness.context.config.environment);
    const cto = routes.find((route) => route.agentRole === 'CTO_ORCHESTRATOR');
    expect(cto?.provider).toBe('google');
    expect(cto?.fallbacks.some((target) => target.provider === 'anthropic')).toBe(true);
    expect(cto?.fallbacks.some((target) => target.provider === 'google')).toBe(false);
  });

  it('§50 — không có model nào thì nói thẳng, không tạo bảng rỗng', async () => {
    const result = await seedRouting(harness.context, 'google', []);
    expect(result.ok).toBe(false);
  });

  it('§88.8 — chọn được model theo từng agent', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/routing/CTO_ORCHESTRATOR',
      headers: auth(),
      payload: { tier: 'strong', provider: 'anthropic', model: 'claude-opus-5', mode: 'balanced' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('§88.9 — cấu hình được chuỗi fallback', async () => {
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/routing/QA',
      headers: auth(),
      payload: {
        tier: 'medium',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbacks: [{ provider: 'openai', model: 'gpt-5-mini' }],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { route: { fallbacks: unknown[] } };
    expect(body.route.fallbacks).toHaveLength(1);
  });

  it('§15 — trả về hạng model mặc định theo vai trò', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api-center/routing',
      headers: auth(),
    });
    const body = response.json() as { defaultTiers: Record<string, string> };
    expect(body.defaultTiers['CTO_ORCHESTRATOR']).toBe('strong');
    expect(body.defaultTiers['QA']).toBe('medium');
    expect(body.defaultTiers['GITHUB_SCOUT']).toBe('cheap');
  });
});

describe('API Center — tích hợp và sức khoẻ (§88.12–88.15)', () => {
  it('§88.13 — lưu cấu hình GitHub, token vào kho secret', async () => {
    const GITHUB_TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/integrations/GITHUB',
      headers: auth(),
      payload: {
        isEnabled: true,
        settings: { defaultOrg: 'pn-company' },
        secrets: { token: GITHUB_TOKEN },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(GITHUB_TOKEN);
    expect(containsSecret(response.body)).toBe(false);
    expect(response.json()).toMatchObject({ integration: { hasSecrets: true } });
  });

  it('§89 — Test Connection tích hợp chưa cấu hình thì nói thiếu gì, không giả lập', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api-center/integrations/SMTP/test',
      headers: auth(),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: 'Cần đủ máy chủ, tên đăng nhập và mật khẩu' });
  });

  it('§88.15 — System Health liệt kê từng phép kiểm tra', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/api-center/health',
      headers: auth(),
    });
    const body = response.json() as {
      checks: Array<{ id: string; ok: boolean }>;
      sandboxEnforcement: { networkPolicy: boolean };
    };
    expect(body.checks.map((check) => check.id)).toContain('database');
    expect(body.checks.map((check) => check.id)).toContain('ai_provider');
    // §89 — báo cáo trung thực: sandbox local không cưỡng chế được chính sách mạng.
    expect(body.sandboxEnforcement.networkPolicy).toBe(false);
  });

  it('§73 — setup wizard báo đúng bước nào đã xong', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/setup/status' });
    const body = response.json() as {
      welcome: string;
      steps: Array<{ id: string; done: boolean }>;
    };
    expect(body.welcome).toBe('Welcome to P&N');
    expect(body.steps.find((step) => step.id === 'account')?.done).toBe(true);
    expect(body.steps.find((step) => step.id === 'routing')?.done).toBe(true);
  });
});

describe('API Center — audit (§88.16, §71)', () => {
  it('mọi thay đổi cấu hình đều để lại dấu vết', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/audit', headers: auth() });
    const body = response.json() as { entries: Array<{ action: string; metadata: unknown }> };

    expect(body.entries.some((entry) => entry.action.includes('/api-center/providers'))).toBe(true);
  });

  it('§89 — audit không lưu giá trị của field nhạy cảm', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/audit', headers: auth() });
    expect(response.body).not.toContain(API_KEY);
    expect(containsSecret(response.body)).toBe(false);
  });
});

describe('Lỗi từ provider (§89)', () => {
  it('key nằm trong thông báo lỗi không lọt ra response của /ai/generate', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/ai/generate',
      headers: auth(),
      payload: {
        agentRole: 'CTO_ORCHESTRATOR',
        messages: [{ role: 'user', content: 'xin chào' }],
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain(API_KEY);
    expect(containsSecret(response.body)).toBe(false);
  });
});

describe('Cửa nội bộ cấp token (§69)', () => {
  it('bot nhận được bot token thật, không bị hook che secret biến thành [REDACTED]', async () => {
    const BOT_TOKEN = '8123456789:AAHtokenGiaChiDungTrongTest_0123456789ab';
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/integrations/TELEGRAM',
      headers: auth(),
      payload: {
        isEnabled: true,
        settings: { allowedChatIds: ['1'] },
        secrets: { botToken: BOT_TOKEN },
      },
    });
    expect(saved.statusCode).toBe(200);
    // Hook vẫn che token ở response cấu hình thường.
    expect(saved.body).not.toContain(BOT_TOKEN);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/telegram/bootstrap',
      headers: { 'x-pn-service-secret': 'bi-mat-test' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ botToken: BOT_TOKEN, allowedChatIds: ['1'] });
  });

  it('sai secret dịch vụ thì bị từ chối', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/telegram/bootstrap',
      headers: { 'x-pn-service-secret': 'sai' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Catalog nạp lại từ database (§49, §54)', () => {
  it('model discovery mang về vẫn còn trong catalog sau khi khởi động lại, kèm giá đã nhập', async () => {
    await harness.context.repos.models.upsertMany([
      {
        id: 'gpt-thu-nghiem',
        provider: 'openai',
        displayName: 'Thử nghiệm',
        tier: 'cheap',
        contextWindow: 1_000,
        maxOutputTokens: 100,
        inputPerMtok: 0.15,
        outputPerMtok: 0.6,
        cachedInputPerMtok: null,
        pricingSource: 'operator',
        pricingAsOf: null,
        isAvailable: true,
      },
    ]);
    expect(harness.context.catalog.get('gpt-thu-nghiem')).toBeUndefined();

    await loadModelPricing(harness.context);

    expect(harness.context.catalog.get('gpt-thu-nghiem')?.pricing).toMatchObject({
      inputPerMTok: 0.15,
      outputPerMTok: 0.6,
    });
  });
});

describe('Nhập giá muộn thì tiền đã tiêu được tính lại (§54)', () => {
  it('lượt gọi ghi null của id snapshot có ngày được tính theo giá alias', async () => {
    const { repos } = harness.context;
    await repos.models.upsertMany([
      {
        id: 'gpt-gia-muon',
        provider: 'openai',
        displayName: 'Giá muộn',
        tier: 'strong',
        contextWindow: 1_000,
        maxOutputTokens: 100,
        pricing: null,
        pricingSource: 'discovered',
        pricingAsOf: null,
      },
    ]);
    const record = await repos.costs.record({
      projectId: 'du-an-1',
      provider: 'openai',
      model: 'gpt-gia-muon-2025-08-07',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cachedTokens: 0,
      costUsd: null,
    });

    const response = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/models/gpt-gia-muon/pricing',
      headers: auth(),
      payload: { inputPerMtok: 1.25, outputPerMtok: 10, cachedInputPerMtok: 0.125 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ repricedCalls: 1 });
    const priced = (await repos.costs.listRecent()).find((row) => row['id'] === record['id']);
    expect(priced?.['costUsd']).toBe(2.25);
  });
});

describe('Duyệt phiếu "QA vẫn không đạt" là cho sửa thêm một vòng (§55)', () => {
  it('hai task đang chặn về TODO, QA đợi dev', async () => {
    const { repos } = harness.context;
    const project = await repos.projects.create({
      name: 'Ghi chú', slug: 'ghi-chu', goal: 'x', productType: 'WEB_APPLICATION', status: 'IN_PROGRESS', budgetUsd: 5,
    } as never);
    // Dev còn phụ thuộc một task chưa xong để advance không chạy gì trong test.
    const gate = await repos.tasks.create({ projectId: project.id, title: 'Cổng', description: '', priority: 'HIGH' } as never);
    const dev = await repos.tasks.create({
      projectId: project.id, title: 'Sửa engine', description: '', priority: 'HIGH',
      assignedRole: 'BACKEND_DEVELOPER', dependsOn: [gate.id],
    } as never);
    const qa = await repos.tasks.create({
      projectId: project.id, title: 'Kiểm thử', description: '', priority: 'HIGH', assignedRole: 'QA',
    } as never);
    await repos.tasks.setStatus(dev.id, 'BLOCKED');
    await repos.tasks.setStatus(qa.id, 'BLOCKED');
    const approval = await repos.approvals.create({
      kind: 'PROJECT_PLAN', title: 'QA vẫn không đạt sau nhiều vòng sửa', summary: 's',
      projectId: project.id, taskId: dev.id, context: { escalation: 'FIX_LOOP', qaTaskId: qa.id },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/approvals/${approval.id}/decide`,
      headers: auth(),
      payload: { decision: 'APPROVED' },
    });
    expect(response.statusCode).toBe(200);
    expect((await repos.tasks.findById(dev.id))?.status).toBe('TODO');
    expect((await repos.tasks.findById(qa.id))?.status).toBe('TODO');
    expect(await repos.tasks.dependencies(qa.id)).toContain(dev.id);
  });

  it('từ chối = chấp nhận hiện trạng: task code và task rà soát đều xong', async () => {
    const { repos } = harness.context;
    const project = await repos.projects.create({
      name: 'Ghi chú 2', slug: 'ghi-chu-2', goal: 'x', productType: 'WEB_APPLICATION', status: 'IN_PROGRESS', budgetUsd: 5,
    } as never);
    const gate = await repos.tasks.create({ projectId: project.id, title: 'Cổng', description: '', priority: 'HIGH' } as never);
    const dev = await repos.tasks.create({
      projectId: project.id, title: 'Engine', description: '', priority: 'HIGH',
      assignedRole: 'FRONTEND_DEVELOPER', dependsOn: [gate.id],
    } as never);
    const qa = await repos.tasks.create({
      projectId: project.id, title: 'QA', description: '', priority: 'HIGH', assignedRole: 'QA',
    } as never);
    const sec = await repos.tasks.create({
      projectId: project.id, title: 'Security', description: '', priority: 'HIGH', assignedRole: 'SECURITY',
    } as never);
    for (const task of [dev, qa, sec]) await repos.tasks.setStatus(task.id, 'BLOCKED');
    const approval = await repos.approvals.create({
      kind: 'PROJECT_PLAN', title: 'QA vẫn không đạt sau nhiều vòng sửa', summary: 's',
      projectId: project.id, taskId: dev.id, context: { escalation: 'FIX_LOOP', qaTaskIds: [qa.id, sec.id] },
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: `/approvals/${approval.id}/decide`,
      headers: auth(),
      payload: { decision: 'REJECTED', note: 'đủ tốt rồi' },
    });
    expect(response.statusCode).toBe(200);
    for (const task of [dev, qa, sec]) expect((await repos.tasks.findById(task.id))?.status).toBe('DONE');
  });
});

describe('Telegram — Chat ID trong allowlist tự gắn với CEO (§58)', () => {
  const service = { 'x-pn-service-secret': 'bi-mat-test' };

  it('lưu cấu hình xong là chat đầu tiên có phiên ngay, không cần bước gắn tài khoản', async () => {
    const saved = await harness.app.inject({
      method: 'PUT',
      url: '/api-center/integrations/TELEGRAM',
      headers: auth(),
      payload: { isEnabled: true, settings: { allowedChatIds: ['6077', '6088'] } },
    });
    expect(saved.statusCode).toBe(200);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/telegram/session',
      headers: service,
      payload: { telegramChatId: '6077' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { role: 'CEO' } });
    expect(String(response.json().token).length).toBeGreaterThan(20);
  });

  it('chat thứ hai trong danh sách được gắn lúc bot xin phiên, có ghi audit', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/telegram/session',
      headers: service,
      payload: { telegramChatId: '6088' },
    });
    expect(response.statusCode).toBe(200);
    expect(await harness.context.repos.users.findByTelegramChatId('6088')).toMatchObject({ role: 'CEO' });
    const audit = await harness.context.repos.audit.list();
    expect(audit.some((row) => row.action === 'TELEGRAM_LINKED' && row.actor === 'telegram:6088')).toBe(true);
  });

  it('chat ngoài danh sách vẫn bị từ chối, kèm hướng dẫn sửa', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/internal/telegram/session',
      headers: service,
      payload: { telegramChatId: '9999' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('9999');
    expect(response.json().error).toContain('Cài đặt');
    expect(await harness.context.repos.users.findByTelegramChatId('9999')).toBeNull();
  });
});
