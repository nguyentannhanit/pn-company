/**
 * Giọng Vbee cho văn phòng. Vbee được giả lập — test không gọi dịch vụ thật, không tốn credit.
 * Giữ ba điều: token không bao giờ ra trình duyệt, câu lặp không tốn credit lần hai, chạm trần tháng thì dừng đọc.
 * Gói Vbee của CEO không có kiểu Realtime nên đi đường Batch: gửi (async) → hỏi trạng thái → tải audioLink.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createTestApp, type TestHarness } from './test/fixtures.js';

const VBEE_TOKEN = 'vbee-token-bi-mat-khong-duoc-ra-trinh-duyet';
const cacheDir = mkdtempSync(join(tmpdir(), 'pn-voice-'));
let h: TestHarness;
let token: string;

beforeAll(async () => {
  process.env['PN_VOICE_CACHE_DIR'] = cacheDir;
  // Đọc sẵn chạy nền sẽ gọi Vbee giả hàng chục lần và làm sai số ký tự đếm — tắt trong bộ test.
  process.env['PN_VOICE_PREWARM'] = 'off';
  h = await createTestApp();
  token = await h.loginAsCeo();
});
afterAll(async () => {
  await h.app.close();
  await h.context.shutdown();
  rmSync(cacheDir, { recursive: true, force: true });
  delete process.env['PN_VOICE_CACHE_DIR'];
});
afterEach(() => vi.unstubAllGlobals());

const auth = () => ({ authorization: `Bearer ${token}` });
const speak = (text: string) => h.app.inject({ method: 'POST', url: '/voice/speak', headers: auth(), payload: { text } });

interface Call { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** Vbee giả theo đúng hành vi đo thật: POST trả requestId, lần hỏi đầu PROCESSING, lần sau COMPLETED kèm link mp3. */
function fakeVbee(): Call[] {
  const calls: Call[] = [];
  let polls = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url === 'https://api.vbee.vn/v1/tts') return Response.json({ requestId: 'req-1', status: 'PROCESSING' });
    if (url.includes('/v1/tts/requests/')) {
      polls += 1;
      return Response.json(polls < 2 ? { requestId: 'req-1', status: 'PROCESSING' } : { requestId: 'req-1', status: 'COMPLETED', audioLink: 'https://vbee.vn/s/req-1/abc' });
    }
    if (url.startsWith('https://vbee.vn/s/')) return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
    throw new Error(`gọi lạ: ${url}`);
  });
  return calls;
}

describe('giọng Vbee', () => {
  it('chưa nối thì báo rõ để trình duyệt quay về giọng máy', async () => {
    const response = await speak('Phòng máy chủ vừa xong việc.');
    expect(response.statusCode).toBe(409);
    expect((await h.app.inject({ method: 'GET', url: '/voice/status', headers: auth() })).json()).toMatchObject({ enabled: false });
  });

  it('đã nối: gửi Vbee kiểu Batch, chờ xong, trả mp3; token không lọt ra; câu lặp dùng đệm', async () => {
    const saved = await h.app.inject({
      method: 'PUT',
      url: '/api-center/integrations/VOICE',
      headers: auth(),
      payload: { isEnabled: true, settings: { appId: 'app-123', monthlyChars: '0.060', speed: '1,25' }, secrets: { token: VBEE_TOKEN } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(VBEE_TOKEN);

    const calls = fakeVbee();
    const first = await speak('Phòng máy chủ vừa xong việc.');
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('audio/mpeg');
    expect(first.body).not.toContain(VBEE_TOKEN);
    // '0.060' đọc là 60 ký tự (dấu chấm phân cách nghìn), '1,25' là tốc độ 1.25.
    expect(calls[0]).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${VBEE_TOKEN}`, 'App-Id': 'app-123' },
      body: { text: 'Phòng máy chủ vừa xong việc.', mode: 'async', voiceCode: 'hn_female_ngochuyen_full_48k-fhg', speed: 1.25 },
    });
    expect(String(calls[0]!.body!['webhookUrl'])).toMatch(/\/voice\/vbee-callback$/);

    const before = calls.length;
    expect((await speak('Phòng máy chủ vừa xong việc.')).statusCode).toBe(200);
    expect(calls).toHaveLength(before);

    const status = (await h.app.inject({ method: 'GET', url: '/voice/status', headers: auth() })).json() as { usedChars: number };
    expect(status.usedChars).toBe('Phòng máy chủ vừa xong việc.'.length);
  });

  it('chạm trần ký tự tháng thì dừng gọi Vbee', async () => {
    const calls = fakeVbee();
    const response = await speak('Phòng kiểm thử đang kẹt, anh xem giúp nhé, việc này cần anh quyết.');
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: expect.stringContaining('hạn mức') });
    expect(calls).toHaveLength(0);
  });

  it('chỗ nhận báo của Vbee trả 200 mà không cần đăng nhập, và không làm thay đổi gì', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/voice/vbee-callback', payload: { requestId: 'x', status: 'COMPLETED' } });
    expect(response.statusCode).toBe(200);
  });
});

describe('câu văn phòng đọc sẵn', () => {
  it('mọi câu đều cố định, không có mã kỹ thuật, và ngắn đủ để đọc sẵn rẻ', async () => {
    const { allOfficeLines, officeLine } = await import('@pn/shared');
    const lines = allOfficeLines();
    expect(lines.length).toBeGreaterThan(40);
    expect(lines.every((line) => !/[A-Z]{2,}_[A-Z]/.test(line))).toBe(true);
    expect(lines.reduce((sum, line) => sum + line.length, 0)).toBeLessThan(2500);
    expect(officeLine('done', 'BACKEND')).toBe('Phòng máy chủ vừa xong việc.');
    expect(officeLine('done', 'SOCIAL_MEDIA_KHONG_CO')).toBeNull();
  });
});

describe('giọng bị Vbee từ chối', () => {
  it('giọng CEO chọn bị từ chối qua API thì tự đọc bằng giọng mặc định, và báo để chọn giọng khác', async () => {
    await h.app.inject({
      method: 'PUT',
      url: '/api-center/integrations/VOICE',
      headers: auth(),
      payload: { isEnabled: true, settings: { appId: 'app-123', voiceCode: 'hn_male_minhquan_yt_24k-pre', monthlyChars: '100000' } },
    });
    const bodies: Array<Record<string, unknown>> = [];
    let polls = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url === 'https://api.vbee.vn/v1/tts') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        bodies.push(body);
        // Như Vbee thật với gói của CEO: giọng "Pro" → 400 BAD_REQUEST.
        if (body['voiceCode'] === 'hn_male_minhquan_yt_24k-pre') return Response.json({ error: { code: 'BAD_REQUEST', message: 'Bad Request' } }, { status: 400 });
        return Response.json({ requestId: 'req-2', status: 'PROCESSING' });
      }
      if (url.includes('/v1/tts/requests/')) return Response.json(++polls > 0 ? { status: 'COMPLETED', audioLink: 'https://vbee.vn/s/req-2/x' } : {});
      return new Response(new Uint8Array([0x49, 0x44, 0x33, 9]));
    });

    const response = await speak('Phòng vận hành vừa xong việc.');
    expect(response.statusCode).toBe(200);
    expect(bodies.map((body) => body['voiceCode'])).toEqual(['hn_male_minhquan_yt_24k-pre', 'hn_female_ngochuyen_full_48k-fhg']);
    const status = (await h.app.inject({ method: 'GET', url: '/voice/status', headers: auth() })).json();
    expect(status).toMatchObject({ rejectedVoice: 'hn_male_minhquan_yt_24k-pre', voiceCode: 'hn_female_ngochuyen_full_48k-fhg' });
  });
});
