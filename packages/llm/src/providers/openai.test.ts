/** Adapter OpenAI: lọc model hội thoại, và thăm dò không xin 1 token với model suy luận. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ModelCatalog } from '../catalog.js';
import { OpenAiProvider } from './openai.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Dựng provider với fetch giả và ghi lại body đã gửi. */
function provider(handler: (url: string, init?: RequestInit) => Response): OpenAiProvider {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)),
  );
  return new OpenAiProvider({ apiKey: 'k', catalog: new ModelCatalog() });
}

afterEach(() => vi.unstubAllGlobals());

describe('OpenAiProvider', () => {
  it('listModels bỏ embedding, giọng nói, ảnh; model lạ thì đoán hạng theo tên', async () => {
    const openai = provider(() =>
      json({
        data: [
          { id: 'gpt-5' },
          { id: 'gpt-5-nano' },
          { id: 'text-embedding-3-small' },
          { id: 'whisper-1' },
          { id: 'gpt-image-1' },
        ],
      }),
    );
    const models = await openai.listModels();
    expect(models.map((m) => m.id)).toEqual(['gpt-5', 'gpt-5-nano']);
    expect(models.map((m) => m.tier)).toEqual(['strong', 'cheap']);
  });

  it('testConnection ping model rẻ có thật với mức nghĩ thấp nhất và đủ token', async () => {
    let sent: Record<string, unknown> | null = null;
    const openai = provider((url, init) => {
      if (url.endsWith('/models')) return json({ data: [{ id: 'gpt-5-mini' }] });
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ model: 'gpt-5-mini-2026-08-01', choices: [] });
    });
    const result = await openai.testConnection();
    expect(result.ok).toBe(true);
    expect(sent).toMatchObject({
      model: 'gpt-5-mini',
      reasoning_effort: 'minimal',
      max_completion_tokens: 256,
    });
  });

  it('429 hết tiền là quota, 429 gọi nhanh là rate_limit kèm retry-after, 503 là quá tải', async () => {
    const ask = (openai: OpenAiProvider): Promise<unknown> =>
      openai.generate({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });

    await expect(ask(provider(() => json({ error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 429))))
      .rejects.toMatchObject({ kind: 'quota', status: 429 });

    const busy = provider(() => new Response('{"error":{"message":"Rate limit reached"}}', { status: 429, headers: { 'retry-after': '7' } }));
    await expect(ask(busy)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 7000 });

    await expect(ask(provider(() => json({ error: { message: 'overloaded' } }, 503)))).rejects.toMatchObject({ kind: 'overloaded' });
  });

  it('key sai thì báo auth ở bước hỏi danh sách', async () => {
    const openai = provider(() => json({ error: { message: 'Incorrect API key' } }, 401));
    const result = await openai.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^auth:/);
  });
});
