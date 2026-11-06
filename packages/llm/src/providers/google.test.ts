/** Adapter Google: Test Connection không ghi cứng tên model — hỏi danh sách thật rồi mới ping. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelCatalog } from '../catalog.js';
import { GoogleProvider } from './google.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Dựng provider với fetch giả; mỗi test tự mô tả Google trả gì. */
function provider(handler: (url: string) => Response): GoogleProvider {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => handler(String(url))));
  return new GoogleProvider({ apiKey: 'k', catalog: new ModelCatalog() });
}

afterEach(() => vi.unstubAllGlobals());

describe('GoogleProvider', () => {
  it('listModels chỉ giữ model sinh nội dung và đoán hạng theo tên', async () => {
    const google = provider(() =>
      json({
        models: [
          { name: 'models/gemini-3.6-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    const models = await google.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-3.6-pro', 'gemini-3.6-flash']);
    expect(models.map((m) => m.tier)).toEqual(['strong', 'medium']);
  });

  it('testConnection ping bằng model còn sống, không phải tên ghi cứng đã ngừng', async () => {
    const calls: string[] = [];
    const google = provider((url) => {
      calls.push(url);
      if (url.endsWith('/models')) {
        return json({
          models: [{ name: 'models/gemini-3.6-flash', supportedGenerationMethods: ['generateContent'] }],
        });
      }
      return json({ modelVersion: 'gemini-3.6-flash-001' });
    });
    const result = await google.testConnection();
    expect(result.ok).toBe(true);
    expect(result.model).toBe('gemini-3.6-flash-001');
    expect(calls[1]).toContain('/models/gemini-3.6-flash:generateContent');
  });

  it('key sai thì báo auth ngay ở bước hỏi danh sách, không ping tiếp', async () => {
    const google = provider(() => json({ error: { message: 'API key not valid' } }, 401));
    const result = await google.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^auth:/);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('GoogleProvider phân loại 429', () => {
  it('hạn mức theo phút là rate_limit kèm thời gian chờ trong thân; hạn mức theo ngày là quota', async () => {
    const { geminiRetryDelayMs } = await import('./google.js');
    expect(geminiRetryDelayMs('{"retryDelay": "33s"}')).toBe(33_000);
    expect(geminiRetryDelayMs('Please retry in 12.4s.')).toBe(12_400);
    expect(geminiRetryDelayMs('không có')).toBeUndefined();

    const ask = (google: GoogleProvider): Promise<unknown> =>
      google.generate({ model: 'gemini-3.6-flash', messages: [{ role: 'user', content: 'hi' }] });
    const perMinute = provider(() =>
      json({ error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests. Please retry in 21s.', details: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] } }, 429),
    );
    await expect(ask(perMinute)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 21_000 });
    const perDay = provider(() =>
      json({ error: { code: 429, message: 'You exceeded your current quota.', details: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] } }, 429),
    );
    await expect(ask(perDay)).rejects.toMatchObject({ kind: 'quota' });
  });
});
