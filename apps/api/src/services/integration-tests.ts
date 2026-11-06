/**
 * P&N — Test Connection thật cho các tích hợp còn lại (§45, §62–§67, §89).
 *
 * Mỗi kiểm tra là request nhẹ nhất chứng minh được thông tin đăng nhập đúng và
 * không để lại gì ở dịch vụ ngoài (Google Play mở bản nháp rồi xoá ngay).
 * JWT, chữ ký S3 và bắt tay SMTP viết tay vì mỗi thứ chỉ vài chục dòng, còn
 * SDK chính hãng kéo theo hàng trăm gói phụ thuộc chỉ để hỏi một câu.
 */

import { createHash, createHmac, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect as connectPlain, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';

import { AI_PROVIDERS, redactText, type Environment, type IntegrationKind } from '@pn/shared';
import { secretRef } from '@pn/secrets';

import type { AppContext } from '../context.js';

export interface TestResult {
  ok: boolean;
  detail?: string;
  error: string | null;
}

interface Loaded {
  settings: Record<string, unknown>;
  secrets: Record<string, string | null>;
}

const TIMEOUT_MS = 15_000;

const pass = (detail: string): TestResult => ({ ok: true, detail, error: null });
const fail = (message: string): TestResult => ({ ok: false, error: redactText(message) });
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

/** Điểm vào cho route: Telegram/GitHub/Database đã có sẵn ở route, còn lại về đây. */
export async function testIntegration(
  context: AppContext,
  kind: IntegrationKind,
  env: Environment,
): Promise<TestResult> {
  if (kind === 'AI_PROVIDER') return testAiProviders(context);

  const secretNames: Partial<Record<IntegrationKind, string[]>> = {
    DEPLOYMENT: ['token'],
    APP_STORE_CONNECT: ['privateKey'],
    GOOGLE_PLAY: ['serviceAccountJson'],
    OBJECT_STORAGE: ['secretAccessKey'],
    SMTP: ['password'],
    WEBHOOK: ['secret'],
    VOICE: ['token'],
  };
  const runners: Partial<Record<IntegrationKind, (loaded: Loaded) => Promise<TestResult>>> = {
    DEPLOYMENT: testVercel,
    APP_STORE_CONNECT: testAppStore,
    GOOGLE_PLAY: testGooglePlay,
    OBJECT_STORAGE: testObjectStorage,
    SMTP: testSmtp,
    WEBHOOK: testWebhook,
    VOICE: testVbee,
  };
  const run = runners[kind];
  if (!run) return fail(`Chưa có kiểm tra cho ${kind}`);

  try {
    return await run(await loadIntegration(context, kind, env, secretNames[kind] ?? []));
  } catch (error) {
    // Lỗi mạng, timeout, khoá hỏng… về một câu ngắn thay vì stack trace.
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Cấu hình thường lấy từ bảng tích hợp, secret lấy từ kho mã hoá (§69). */
async function loadIntegration(
  context: AppContext,
  kind: IntegrationKind,
  env: Environment,
  secretNames: string[],
): Promise<Loaded> {
  const row = await context.repos.integrations.find(kind, env);
  const secrets: Record<string, string | null> = {};
  for (const name of secretNames) {
    secrets[name] = await context.secrets.reveal(secretRef.integration(kind, name, env)).catch(() => null);
  }
  return { settings: row?.settings ?? {}, secrets };
}

/* -------------------------------------------------------------------------- */
/* §45 — nhà cung cấp AI: hỏi tất cả provider đã có khoá                       */
/* -------------------------------------------------------------------------- */

async function testAiProviders(context: AppContext): Promise<TestResult> {
  const lines: string[] = [];
  let anyOk = false;
  for (const provider of AI_PROVIDERS) {
    if (!context.registry.has(provider)) {
      lines.push(`${provider}: chưa cấu hình`);
      continue;
    }
    const result = await context.registry.get(provider).testConnection();
    anyOk ||= result.ok;
    // Lỗi provider là cả một khối JSON; thẻ trên web chỉ cần dòng đầu.
    const reason = redactText(result.error ?? 'lỗi').split('\n')[0]?.slice(0, 140) ?? 'lỗi';
    lines.push(result.ok ? `${provider}: ổn` : `${provider}: ${reason}`);
  }
  const summary = lines.join(' · ');
  return anyOk ? pass(summary) : fail(summary);
}

/* -------------------------------------------------------------------------- */
/* §62 — Vercel                                                                */
/* -------------------------------------------------------------------------- */

async function testVercel({ settings, secrets }: Loaded): Promise<TestResult> {
  const token = secrets['token'];
  if (!token) return fail('Chưa lưu token Vercel');
  const headers = { authorization: `Bearer ${token}` };

  const me = await fetch('https://api.vercel.com/v2/user', { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const body = (await me.json()) as { user?: { username?: string }; error?: { message?: string } };
  if (!me.ok) return fail(body.error?.message ?? `Vercel trả HTTP ${me.status}`);

  let detail = `Tài khoản Vercel ${body.user?.username ?? 'không rõ tên'}`;
  const teamId = text(settings['teamId']);
  if (teamId) {
    const team = await fetch(`https://api.vercel.com/v2/teams/${encodeURIComponent(teamId)}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!team.ok) return fail(`Token đúng nhưng không vào được team ${teamId} (HTTP ${team.status})`);
    const info = (await team.json()) as { name?: string; slug?: string };
    detail += ` · team ${info.name ?? info.slug ?? teamId}`;
  }
  return pass(detail);
}

/* -------------------------------------------------------------------------- */
/* JWT ký bằng khoá riêng — Apple dùng ES256, Google dùng RS256                */
/* -------------------------------------------------------------------------- */

export function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject,
  alg: 'ES256' | 'RS256',
): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const data = `${part({ ...header, alg, typ: 'JWT' })}.${part(payload)}`;
  // JWT cần chữ ký ECDSA dạng r||s (ieee-p1363), không phải DER mặc định của OpenSSL.
  const signature = sign('sha256', Buffer.from(data), alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key);
  return `${data}.${signature.toString('base64url')}`;
}

/**
 * Ô nhập trên web là một dòng nên khoá .p8 dán vào bị mất xuống dòng; dựng lại
 * PEM từ phần base64 để OpenSSL đọc được.
 */
function normalizePem(raw: string): string {
  const type = /-----BEGIN ([A-Z ]+)-----/.exec(raw)?.[1] ?? 'PRIVATE KEY';
  const body = raw.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN ${type}-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${type}-----\n`;
}

/* -------------------------------------------------------------------------- */
/* §63 — App Store Connect                                                     */
/* -------------------------------------------------------------------------- */

async function testAppStore({ settings, secrets }: Loaded): Promise<TestResult> {
  const issuerId = text(settings['issuerId']);
  const keyId = text(settings['keyId']);
  const pem = secrets['privateKey'];
  if (!issuerId || !keyId || !pem) return fail('Cần đủ Issuer ID, Key ID và khoá riêng .p8');

  const now = Math.floor(Date.now() / 1000);
  const jwt = signJwt(
    { kid: keyId },
    { iss: issuerId, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' },
    createPrivateKey(normalizePem(pem)),
    'ES256',
  );
  const response = await fetch('https://api.appstoreconnect.apple.com/v1/apps?limit=1', {
    headers: { authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json()) as {
    data?: Array<{ attributes?: { name?: string } }>;
    errors?: Array<{ detail?: string; title?: string }>;
  };
  if (!response.ok) {
    return fail(body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? `App Store Connect trả HTTP ${response.status}`);
  }
  const first = body.data?.[0]?.attributes?.name;
  return pass(first ? `Đăng nhập được · ứng dụng đầu tiên: ${first}` : 'Đăng nhập được · tài khoản chưa có ứng dụng nào');
}

/* -------------------------------------------------------------------------- */
/* §64 — Google Play                                                           */
/* -------------------------------------------------------------------------- */

async function testGooglePlay({ settings, secrets }: Loaded): Promise<TestResult> {
  const raw = secrets['serviceAccountJson'];
  if (!raw) return fail('Chưa lưu tệp JSON của tài khoản dịch vụ');

  let account: { client_email?: string; private_key?: string; token_uri?: string };
  try {
    account = JSON.parse(raw) as typeof account;
  } catch {
    return fail('Tệp JSON tài khoản dịch vụ không đọc được');
  }
  if (!account.client_email || !account.private_key) return fail('JSON thiếu client_email hoặc private_key');

  const tokenUri = account.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(
    {},
    {
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: tokenUri,
      iat: now,
      exp: now + 600,
    },
    createPrivateKey(account.private_key),
    'RS256',
  );
  const tokenResponse = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const token = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenResponse.ok || !token.access_token) {
    return fail(token.error_description ?? token.error ?? `Google trả HTTP ${tokenResponse.status}`);
  }

  const packageName = text(settings['packageName']);
  if (!packageName) return pass(`Tài khoản dịch vụ ${account.client_email} đăng nhập được`);

  // Quyền trên một ứng dụng chỉ kiểm được bằng cách mở bản nháp; xoá ngay để không để lại gì.
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/edits`;
  const headers = { authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json' };
  const edit = await fetch(base, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(TIMEOUT_MS) });
  const editBody = (await edit.json()) as { id?: string; error?: { message?: string } };
  if (!edit.ok || !editBody.id) {
    return fail(editBody.error?.message ?? `Không mở được ứng dụng ${packageName} (HTTP ${edit.status})`);
  }
  await fetch(`${base}/${editBody.id}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(
    () => undefined,
  );
  return pass(`Tài khoản dịch vụ ${account.client_email} có quyền trên ${packageName}`);
}

/* -------------------------------------------------------------------------- */
/* §65 — kho tệp tương thích S3 (AWS, Cloudflare R2, MinIO…)                   */
/* -------------------------------------------------------------------------- */

export interface SigV4Input {
  method: string;
  url: URL;
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** Dạng 20130524T000000Z. */
  amzDate: string;
}

const sha256Hex = (data: string): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Chữ ký AWS Signature V4 cho request không có body. Trả header để gửi kèm. */
export function signV4(input: SigV4Input): { headers: Record<string, string>; signature: string } {
  const payloadHash = sha256Hex('');
  const lower: Record<string, string> = {};
  for (const [name, value] of Object.entries({
    ...input.headers,
    host: input.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': input.amzDate,
  })) {
    lower[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  }
  const names = Object.keys(lower).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${lower[name]}\n`).join('');
  const query = [...input.url.searchParams.entries()]
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .sort()
    .join('&');
  const canonicalRequest = [
    input.method,
    input.url.pathname || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // fetch tự đặt Host; gửi kèm sẽ bị từ chối.
  const { host: _host, ...headers } = lower;
  return {
    signature,
    headers: {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

async function testObjectStorage({ settings, secrets }: Loaded): Promise<TestResult> {
  const endpoint = text(settings['endpoint']).replace(/\/+$/, '');
  const bucket = text(settings['bucket']);
  const accessKeyId = text(settings['accessKeyId']);
  const secretAccessKey = secrets['secretAccessKey'];
  const region = text(settings['region']) || 'us-east-1';
  if (!/^https?:\/\//.test(endpoint) || !bucket || !accessKeyId || !secretAccessKey) {
    return fail('Cần đủ địa chỉ dịch vụ (http/https), bucket, access key ID và secret access key');
  }

  const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const { headers } = signV4({ method: 'GET', url, headers: {}, accessKeyId, secretAccessKey, region, service: 's3', amzDate });
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.ok) return pass(`Đọc được bucket ${bucket}`);

  const xml = await response.text();
  const message = /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? /<Code>([^<]*)<\/Code>/.exec(xml)?.[1];
  return fail(message ?? `Kho tệp trả HTTP ${response.status}`);
}

/* -------------------------------------------------------------------------- */
/* §66 — SMTP: bắt tay tới bước đăng nhập rồi thoát, không gửi thư             */
/* -------------------------------------------------------------------------- */

interface SmtpReply {
  code: number;
  text: string;
}

/** Đọc trọn một câu trả lời; nhiều dòng thì dòng cuối có dạng "250 ..." (không có gạch). */
function readReply(socket: Socket): Promise<SmtpReply> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      if (!buffer.endsWith('\r\n')) return;
      const last = buffer.slice(0, -2).split('\r\n').pop() ?? '';
      if (/^\d{3}( |$)/.test(last)) {
        cleanup();
        resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() });
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error('Máy chủ thư đóng kết nối giữa chừng'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

/** Gửi một lệnh và đòi mã trả lời cùng nhóm (2xx/3xx…); sai nhóm là báo nguyên câu của máy chủ. */
async function talk(socket: Socket, line: string | null, expected: number): Promise<SmtpReply> {
  if (line !== null) socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (Math.floor(reply.code / 100) !== Math.floor(expected / 100)) {
    throw new Error(`Máy chủ thư trả lời: ${reply.text.split('\r\n').pop() ?? reply.text}`);
  }
  return reply;
}

function upgradeToTls(socket: Socket, host: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, servername: host }, () => resolve(secure));
    secure.once('error', reject);
  });
}

export interface SmtpLogin {
  host: string;
  user: string;
  password: string;
  startTls: boolean;
}

/** Trả về dòng chào của máy chủ khi đăng nhập được; ném lỗi kèm câu trả lời khi không. */
export async function smtpLogin(socket: Socket, login: SmtpLogin): Promise<string> {
  await talk(socket, null, 220);
  let channel = socket;
  let ehlo = await talk(channel, 'EHLO pn.local', 250);
  if (login.startTls) {
    await talk(channel, 'STARTTLS', 220);
    channel = await upgradeToTls(channel, login.host);
    ehlo = await talk(channel, 'EHLO pn.local', 250);
  }
  const plain = Buffer.from(`\0${login.user}\0${login.password}`).toString('base64');
  await talk(channel, `AUTH PLAIN ${plain}`, 235);
  await talk(channel, 'QUIT', 221).catch(() => undefined);
  channel.destroy();
  return ehlo.text.split('\r\n')[0]?.replace(/^250[- ]/, '') ?? login.host;
}

function openSocket(host: string, port: number, tls: boolean): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tls
      ? connectTls({ host, port, servername: host }, () => resolve(socket))
      : connectPlain({ host, port }, () => resolve(socket));
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new Error('Máy chủ thư không trả lời trong 15 giây')));
    socket.once('error', reject);
  });
}

async function testSmtp({ settings, secrets }: Loaded): Promise<TestResult> {
  const host = text(settings['host']);
  const port = Number(text(settings['port'])) || 587;
  const user = text(settings['user']);
  const password = secrets['password'];
  if (!host || !user || !password) return fail('Cần đủ máy chủ, tên đăng nhập và mật khẩu');

  // 465 là TLS ngay từ đầu; các cổng khác (587, 25) nói chuyện thường rồi STARTTLS.
  const socket = await openSocket(host, port, port === 465);
  try {
    const greeting = await smtpLogin(socket, { host, user, password, startTls: port !== 465 });
    return pass(`Đăng nhập được ${host}:${port} (${greeting})`);
  } finally {
    socket.destroy();
  }
}

/* -------------------------------------------------------------------------- */
/* §67 — webhook: bắn một gói ping có chữ ký, đầu nhận trả 2xx là được         */
/* -------------------------------------------------------------------------- */

export function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Giọng Vbee: hỏi danh sách giọng tiếng Việt — chứng minh App ID + token đúng mà KHÔNG tốn credit (đọc thử mới tốn).
 * Trả kèm vài mã giọng để CEO chép vào ô "Mã giọng".
 */
export async function testVbee({ settings, secrets }: Loaded): Promise<TestResult> {
  const appId = text(settings['appId']);
  const token = secrets['token'];
  if (!appId || !token) return fail('Thiếu App ID hoặc token Vbee');
  // voiceOwnership bắt buộc (tài liệu ghi tuỳ chọn, thiếu thì Vbee trả 400 "Validation Failed" — gặp khi chạy thật).
  const response = await fetch('https://vbee.vn/api/public/v1/voices?voiceOwnership=VBEE&language_code=vi-VN&limit=100', {
    headers: { authorization: `Bearer ${token}`, 'App-Id': appId },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => null)) as
    | { status?: number; error_message?: string; result?: { voices?: Array<{ code: string; name: string }> } }
    | null;
  if (!response.ok || body?.status !== 1) {
    return fail(`Vbee từ chối (HTTP ${response.status})${body?.error_message ? `: ${body.error_message}` : ''}`);
  }
  const voices = body.result?.voices ?? [];
  return pass(`Token hợp lệ. Tài khoản có ${voices.length} giọng tiếng Việt — chọn giọng ở ô "Giọng đọc" rồi bấm Nghe thử.`);
}

export async function testWebhook({ settings, secrets }: Loaded): Promise<TestResult> {
  const url = text(settings['url']);
  if (!/^https?:\/\//.test(url)) return fail('Địa chỉ nhận phải bắt đầu bằng http:// hoặc https://');

  const body = JSON.stringify({ type: 'ping', company: 'P&N', at: new Date().toISOString() });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = secrets['secret'];
  if (secret) headers['x-pn-signature'] = webhookSignature(secret, body);

  const response = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return response.ok ? pass(`Đầu nhận trả HTTP ${response.status}`) : fail(`Đầu nhận trả HTTP ${response.status}`);
}
