/**
 * P&N — Giọng đọc Vbee cho văn phòng: giọng máy của trình duyệt nghe "đơ".
 *
 * API là trạm chuyển: trình duyệt gửi câu cần đọc, API gọi Vbee bằng token trong kho bí mật rồi trả file mp3 — trình
 * duyệt không bao giờ thấy token. Vbee trừ vào credit mua trước (hết credit thì Vbee từ chối, không tự trừ thẻ); phía
 * P&N thêm một trần ký tự mỗi tháng do CEO đặt để credit không cạn bất ngờ. Lỗi gì thì trình duyệt quay về giọng máy.
 *
 * Cách gọi Vbee (đã thử thật với tài khoản Vbee):
 *   - Kiểu "Realtime" (mode sync, trả âm thanh ngay) KHÔNG có trong gói của CEO — Vbee trả "This feature is not
 *     supported in user package". Nên dùng kiểu "Batch": POST https://api.vbee.vn/v1/tts { mode: "async", webhookUrl,
 *     text, voiceCode, … } → requestId; hỏi GET /v1/tts/requests/{id} tới khi COMPLETED → tải `audioLink`.
 *     Đo được: lượt đầu (Vbee khởi động) ~3–4 phút, các lượt sau ~7 giây.
 *   - Vì có thể chậm, câu đã đọc được lưu đệm cả trong bộ nhớ lẫn ra đĩa (`logs/voice-cache`): câu lặp ("Phòng máy chủ
 *     vừa xong việc.") phát ngay, không tốn credit, kể cả sau khi API khởi động lại. Lượt đọc quá lâu thì trình duyệt
 *     dùng giọng máy cho câu đó nhưng API vẫn chờ lấy file về đệm cho lần sau.
 *   - Danh sách giọng: GET https://vbee.vn/api/public/v1/voices?voiceOwnership=VBEE… (bắt buộc có voiceOwnership — tài
 *     liệu ghi là tuỳ chọn nhưng thiếu thì Vbee trả 400). Hỏi danh sách không tốn credit.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { secretRef } from '@pn/secrets';
import { allOfficeLines } from '@pn/shared';

import type { AppContext } from '../context.js';
import { tunnelApiUrl } from './tunnel.js';

const TTS_URL = 'https://api.vbee.vn/v1/tts';
const VOICES_URL = 'https://vbee.vn/api/public/v1/voices?voiceOwnership=VBEE&language_code=vi-VN&limit=100';
/** Giọng mặc định: HN - Ngọc Huyền (có trong danh sách giọng của tài khoản CEO). */
export const DEFAULT_VOICE = 'hn_female_ngochuyen_full_48k-fhg';
/** Thông báo văn phòng là câu ngắn; cắt ở đây để một lỗi không đốt nhiều credit. */
const MAX_TEXT = 300;
/** Trần mặc định mỗi tháng khi CEO chưa đặt — vài trăm câu thông báo ngắn. */
const DEFAULT_MONTHLY_CHARS = 20_000;
const USAGE_KEY = 'voice.usage';
const CACHE_MAX = 200;
/** Trình duyệt chờ tối đa chừng này; quá thì dùng giọng máy cho câu này, API vẫn chờ tiếp để đệm. */
const WAIT_MS = 25_000;
/** Chờ Vbee đọc xong tối đa (lượt đầu sau lúc Vbee nghỉ đo được ~4 phút). */
const JOB_MS = 6 * 60_000;
const POLL_MS = 1_500;

export interface VoiceSettings {
  appId?: string | null;
  voiceCode?: string | null;
  speed?: string | number | null;
  monthlyChars?: string | number | null;
}

export interface VbeeVoice {
  code: string;
  name: string;
  gender: string;
  demo: string | null;
  /** Hệ số credit (giọng "2.0", "nâng cao" tốn gấp 2–3 lần). */
  creditFactor: number;
}

export class VoiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** `voice-rejected`: Vbee không nhận giọng này qua API với gói hiện tại. */
    readonly reason: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Giọng Vbee từ chối qua API (thử thật: Minh Quân Pro, Ngọc Huyền 2.0 bị "Bad Request" với gói đang dùng, còn Mạnh
 * Dũng 2.0 thì được — không có quy luật để lọc trước). Gặp một lần thì nhớ lại và dùng tạm giọng mặc định để văn phòng
 * không im lặng; trang Tích hợp báo cho CEO chọn giọng khác.
 */
const rejectedVoices = new Set<string>();

/** Lưu lại cấu hình Giọng nói thì thử lại mọi giọng (CEO có thể vừa nâng gói Vbee). */
export function forgetRejectedVoices(): void {
  rejectedVoices.clear();
}

/** Đệm trong bộ nhớ; Map giữ thứ tự chèn nên xoá phần tử đầu là bỏ cái cũ nhất. */
const memory = new Map<string, Buffer>();
/** Câu đang chờ Vbee đọc — hai trang cùng hỏi một câu thì chỉ gửi Vbee một lần. */
const pending = new Map<string, Promise<Buffer>>();
let voicesCache: { at: number; key: string; voices: VbeeVoice[] } | null = null;

const cacheDir = (): string => process.env['PN_VOICE_CACHE_DIR'] ?? resolve('logs', 'voice-cache');
const monthKey = (): string => new Date().toISOString().slice(0, 7);
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
/** Ô nhập kiểu Việt: "0,9" là 0.9 (tốc độ); "20.000" là hai mươi nghìn (số ký tự) — không để thành 20. */
const decimalOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
const countOr = (value: unknown, fallback: number): number => {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

interface Loaded {
  appId: string;
  token: string;
  /** Giọng thật sự dùng (giọng CEO chọn, hoặc giọng mặc định nếu giọng đó bị Vbee từ chối). */
  voice: string;
  /** Giọng CEO chọn trong cài đặt. */
  chosen: string;
  speed: number;
  limit: number;
}

/** Cấu hình đang dùng; null khi chưa nối hoặc đang tắt. */
async function loadVoice(context: AppContext): Promise<Loaded | null> {
  const env = context.config.environment;
  const row = await context.repos.integrations.find('VOICE', env);
  if (!row?.isEnabled) return null;
  const settings = (row.settings ?? {}) as VoiceSettings;
  const token = await context.secrets.reveal(secretRef.integration('VOICE', 'token', env)).catch(() => null);
  const appId = settings.appId?.trim();
  if (!token || !appId) return null;
  const chosen = settings.voiceCode?.trim() || DEFAULT_VOICE;
  return {
    appId,
    token,
    chosen,
    voice: rejectedVoices.has(chosen) ? DEFAULT_VOICE : chosen,
    speed: Math.round(Math.min(1.9, Math.max(0.25, decimalOr(settings.speed, 1))) * 100) / 100,
    limit: countOr(settings.monthlyChars, DEFAULT_MONTHLY_CHARS),
  };
}

const headers = (voice: Pick<Loaded, 'appId' | 'token'>): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${voice.token}`,
  'App-Id': voice.appId,
});

async function usage(context: AppContext): Promise<{ month: string; chars: number }> {
  const saved = await context.repos.settings.get<{ month: string; chars: number }>(USAGE_KEY);
  return saved?.month === monthKey() ? saved : { month: monthKey(), chars: 0 };
}

/** Trạng thái cho trình duyệt: có dùng giọng Vbee không, đã dùng bao nhiêu ký tự tháng này. */
export async function voiceStatus(context: AppContext): Promise<{
  enabled: boolean;
  voiceCode: string | null;
  rejectedVoice: string | null;
  usedChars: number;
  limitChars: number | null;
}> {
  const voice = await loadVoice(context);
  const used = await usage(context);
  return {
    enabled: Boolean(voice),
    voiceCode: voice?.voice ?? null,
    rejectedVoice: voice && voice.voice !== voice.chosen ? voice.chosen : null,
    usedChars: used.chars,
    limitChars: voice?.limit ?? null,
  };
}

/** Danh sách giọng tiếng Việt của tài khoản (đệm 10 phút). Dùng cho ô chọn giọng và nút Kiểm tra kết nối. */
export async function listVoices(context: AppContext, loaded?: Pick<Loaded, 'appId' | 'token'> | null): Promise<VbeeVoice[]> {
  const voice = loaded ?? (await loadVoice(context));
  if (!voice) throw new VoiceError(409, 'Chưa nối giọng Vbee (Cài đặt → Tích hợp → Giọng nói)');
  const key = `${voice.appId}|${voice.token.slice(-12)}`;
  if (voicesCache?.key === key && Date.now() - voicesCache.at < 10 * 60_000) return voicesCache.voices;
  const response = await fetch(VOICES_URL, { headers: headers(voice), signal: AbortSignal.timeout(15_000) });
  const body = (await response.json().catch(() => null)) as
    | { status?: number; error_message?: string; details?: unknown; result?: { voices?: Array<{ code: string; name: string; gender: string; demo?: string; credit_factor?: number }> } }
    | null;
  if (!response.ok || body?.status !== 1) {
    throw new VoiceError(502, `Vbee từ chối (HTTP ${response.status})${body?.error_message ? `: ${body.error_message}` : ''}`);
  }
  const voices = (body.result?.voices ?? []).map((item) => ({
    code: item.code,
    name: item.name,
    gender: item.gender,
    demo: item.demo ?? null,
    creditFactor: item.credit_factor ?? 1,
  }));
  voicesCache = { at: Date.now(), key, voices };
  return voices;
}

/** Gửi Vbee đọc (kiểu Batch), chờ xong rồi tải file. */
async function synthesize(context: AppContext, voice: Loaded, text: string): Promise<Buffer> {
  // Vbee bắt buộc có webhookUrl; P&N không cần nội dung Vbee gửi về (tự hỏi trạng thái), chỉ cần địa chỉ trả 200.
  const base = tunnelApiUrl() ?? context.config.publicUrl;
  const submit = await fetch(TTS_URL, {
    method: 'POST',
    headers: headers(voice),
    body: JSON.stringify({ text, mode: 'async', webhookUrl: `${base}/voice/vbee-callback`, voiceCode: voice.voice, outputFormat: 'mp3', bitrate: 64, speed: voice.speed }),
    signal: AbortSignal.timeout(15_000),
  });
  const accepted = (await submit.json().catch(() => null)) as { requestId?: string; error?: { code?: string; message?: string } } | null;
  if (!submit.ok || !accepted?.requestId) {
    throw new VoiceError(
      502,
      `Vbee từ chối (${accepted?.error?.code ?? submit.status}): ${accepted?.error?.message ?? 'không rõ lý do'}`,
      accepted?.error?.code === 'BAD_REQUEST' && voice.voice !== DEFAULT_VOICE ? 'voice-rejected' : null,
    );
  }
  // Vbee đã nhận việc → credit bị trừ: tính vào trần tháng ngay, dù lát nữa có lỗi.
  const used = await usage(context);
  await context.repos.settings.set(USAGE_KEY, { month: used.month, chars: used.chars + text.length }, 'system:voice');

  const deadline = Date.now() + JOB_MS;
  while (Date.now() < deadline) {
    const poll = await fetch(`${TTS_URL}/requests/${accepted.requestId}`, { headers: headers(voice), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const state = (await poll?.json().catch(() => null)) as { status?: string; audioLink?: string; error?: { message?: string } } | null;
    if (state?.status === 'COMPLETED' && state.audioLink) {
      const audio = await fetch(state.audioLink, { signal: AbortSignal.timeout(30_000) });
      if (!audio.ok) throw new VoiceError(502, `Không tải được file giọng Vbee (HTTP ${audio.status})`);
      return Buffer.from(await audio.arrayBuffer());
    }
    if (state?.status === 'FAILED') throw new VoiceError(502, `Vbee đọc hỏng: ${state.error?.message ?? 'không rõ lý do'}`);
    await sleep(POLL_MS);
  }
  throw new VoiceError(504, 'Vbee đọc quá lâu, đã bỏ');
}

/**
 * Đọc một câu thành mp3. Ném VoiceError (kèm mã HTTP) để route trả đúng lý do; trình duyệt nhận lỗi thì dùng giọng máy.
 * `waitMs`: trình duyệt chờ tối đa bao lâu — quá thì báo 504 nhưng việc đọc vẫn chạy tiếp để đệm.
 */
export async function speak(context: AppContext, raw: string, waitMs = WAIT_MS): Promise<Buffer> {
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) throw new VoiceError(400, 'Không có chữ để đọc');
  const voice = await loadVoice(context);
  if (!voice) throw new VoiceError(409, 'Chưa nối giọng Vbee (Cài đặt → Tích hợp → Giọng nói)');

  const key = createHash('sha256').update(`${voice.voice}|${voice.speed}|${text}`).digest('hex');
  const hit = memory.get(key) ?? (await readFile(join(cacheDir(), `${key}.mp3`)).catch(() => null));
  if (hit) {
    memory.set(key, hit);
    return hit;
  }

  let job = pending.get(key);
  if (!job) {
    const used = await usage(context);
    if (used.chars + text.length > voice.limit) {
      throw new VoiceError(429, `Đã dùng hết hạn mức ${voice.limit.toLocaleString('vi-VN')} ký tự Vbee tháng này — tạm dùng giọng máy.`);
    }
    job = synthesize(context, voice, text)
      .then(async (audio) => {
        memory.set(key, audio);
        if (memory.size > CACHE_MAX) memory.delete(memory.keys().next().value!);
        await mkdir(cacheDir(), { recursive: true });
        await writeFile(join(cacheDir(), `${key}.mp3`), audio).catch(() => undefined);
        return audio;
      })
      .finally(() => pending.delete(key));
    // Trình duyệt thôi chờ thì việc đọc vẫn chạy nền; lỗi nền không được làm sập tiến trình.
    job.catch(() => undefined);
    pending.set(key, job);
  }

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VoiceError(504, 'Vbee đang đọc câu này — lần sau sẽ phát ngay.')), waitMs);
  });
  try {
    return await Promise.race([job, timeout]);
  } catch (error) {
    // Giọng CEO chọn bị Vbee từ chối: nhớ lại, đọc lại ngay bằng giọng mặc định — văn phòng không im lặng vì một lựa chọn giọng.
    if (error instanceof VoiceError && error.reason === 'voice-rejected') {
      rejectedVoices.add(voice.voice);
      return speak(context, raw, waitMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Đang đọc sẵn cho cấu hình nào (giọng|tốc độ) — đổi giọng giữa chừng thì lượt cũ tự dừng, lượt mới chạy. */
let prewarming: string | null = null;

/**
 * Đọc sẵn mọi câu thông báo văn phòng (`allOfficeLines`, ~55 câu, ~1.600 ký tự) bằng Vbee để lần đầu cũng là giọng
 * Vbee, không phải giọng máy hay im lặng. Chạy nền, lần lượt từng câu (Vbee giới hạn số
 * lượt cùng lúc); câu đã có trong đệm đĩa thì bỏ qua, không tốn credit. Gọi lúc API khởi động và mỗi lần lưu cấu hình
 * Giọng nói (đổi giọng/tốc độ là đổi khoá đệm). Tắt bằng PN_VOICE_PREWARM=off (bộ test).
 */
export async function prewarmOfficeLines(context: AppContext, log: (message: string) => void = () => undefined): Promise<void> {
  if (process.env['PN_VOICE_PREWARM'] === 'off') return;
  const voice = await loadVoice(context);
  if (!voice) return;
  const tag = `${voice.voice}|${voice.speed}`;
  if (prewarming === tag) return;
  prewarming = tag;
  let made = 0;
  let failed = 0;
  for (const line of allOfficeLines()) {
    if (prewarming !== tag) return;
    try {
      const before = memory.size;
      await speak(context, line, JOB_MS);
      if (memory.size > before) made += 1;
    } catch (error) {
      failed += 1;
      // Hết trần tháng hay Vbee từ chối (hết credit, token hết hạn): dừng, đừng thử tiếp cả chục câu.
      if (error instanceof VoiceError && (error.status === 429 || error.status === 409)) break;
      if (failed >= 3) break;
    }
  }
  if (prewarming === tag) prewarming = null;
  log(`[voice] đọc sẵn câu văn phòng bằng Vbee: ${made} câu mới, ${failed} câu lỗi`);
}
