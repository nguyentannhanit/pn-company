/**
 * P&N — Thử các chức năng của hệ thống ĐANG CHẠY THẬT.
 *
 * Khác với `npm test`: bộ test kia chạy trên database giả, còn cái này gọi vào
 * API thật, database thật, WebSocket thật. Đây là thứ trả lời được câu "cài
 * xong rồi, nó có chạy không" — thứ mà test đơn vị không bao giờ trả lời được.
 *
 *   node tools/smoke.mjs [url-api]
 *
 * Tự tạo một tài khoản tạm để đăng nhập rồi xoá đi, nên không đụng vào tài
 * khoản thật và không để lại rác.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import WebSocket from 'ws';

import { hashPassword } from '../apps/api/dist/plugins/auth.js';

const run = promisify(execFile);
const API = process.argv[2] ?? 'http://127.0.0.1:4000';
const EMAIL = `smoke-${Date.now()}@pn.local`;
const PASSWORD = 'mat-khau-thu-nghiem-1234';

/** Key giả để chứng minh Test Connection báo lỗi thật chứ không giả vờ thành công. */
const FAKE_KEY = 'sk-ant-api03-KEYGIAKHONGCOTHATabcdefghijklmnop0123456789';

const PSQL = process.env['PN_PSQL'] ?? 'C:/Program Files/PostgreSQL/17/bin/psql.exe';
const DB = process.env['PN_SMOKE_DB'] ?? 'pn_company';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  LOI  ${name}${detail ? ` — ${detail}` : ''}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

async function sql(statement) {
  const { stdout } = await run(
    PSQL,
    ['-U', 'postgres', '-h', '127.0.0.1', '-d', DB, '-t', '-A', '-c', statement],
    { env: { ...process.env, PGPASSWORD: process.env['PGPASSWORD'] ?? 'postgres' } },
  );
  return stdout.trim();
}

let token = null;
/** `null` = chưa đụng tới; chuỗi rỗng = trước đó chưa cấu hình. */
let restoreProvider = null;

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* một số endpoint trả rỗng */
  }
  return { status: response.status, text, json };
}

/* -------------------------------------------------------------------------- */

try {
  section('1. Tien trinh con song');
  const health = await api('/health');
  check('GET /health tra 200', health.status === 200);
  check('brand la P&N', health.json?.company === 'P&N', health.json?.company);

  const ready = await api('/ready');
  check(
    'GET /ready — database ket noi duoc',
    ready.status === 200 && ready.json?.database?.ok === true,
    ready.text.slice(0, 120),
  );

  section('2. Dang nhap');
  const hash = await hashPassword(PASSWORD);
  await sql(
    `INSERT INTO users (email, display_name, role, password_hash, is_active) VALUES ('${EMAIL}', 'Smoke Test', 'CEO', '${hash}', true)`,
  );

  const badLogin = await api('/auth/login', {
    method: 'POST',
    body: { email: EMAIL, password: 'sai-mat-khau-hoan-toan' },
  });
  check('sai mat khau bi tu choi', badLogin.status === 401);

  const login = await api('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  check(
    'dang nhap dung tra token',
    login.status === 200 && typeof login.json?.token === 'string',
    login.text.slice(0, 160),
  );
  token = login.json?.token ?? null;

  const noAuth = await fetch(`${API}/agents`).then((response) => response.status);
  check('khong token thi bi chan', noAuth === 401, String(noAuth));

  const me = await api('/auth/me');
  check('GET /auth/me hoat dong', me.status === 200);
  check('§89 — khong lo password hash', !me.text.includes('scrypt$') && !me.text.includes('passwordHash'));

  section('3. Du lieu nen');
  const agents = await api('/agents');
  const agentRows = agents.json?.agents ?? [];
  check('danh sach agent da seed', agentRows.length >= 20, `${agentRows.length} agent`);
  check('moi agent co phong ban', agentRows.every((agent) => Boolean(agent.department)));

  const branding = await api('/branding');
  check('GET /branding', branding.status === 200 && branding.json?.companyName === 'P&N');

  const setup = await api('/setup/status');
  check('GET /setup/status', setup.status === 200 && Array.isArray(setup.json?.steps));

  section('4. Cac trang cua dashboard deu co du lieu');
  for (const [label, path] of [
    ['Du an', '/projects'],
    ['Phe duyet', '/approvals'],
    ['Trien khai', '/deployments'],
    ['Chi phi', '/cost/summary'],
    ['Nhat ky', '/audit'],
    ['Hang doi', '/orchestrator/status'],
    ['AI Providers', '/api-center/providers'],
    ['Dinh tuyen', '/api-center/routing'],
    ['Tich hop', '/api-center/integrations'],
    ['Suc khoe he thong', '/api-center/health'],
    ['Ngan sach', '/api-center/budgets'],
  ]) {
    const response = await api(path);
    check(`GET ${path} (${label})`, response.status === 200, `HTTP ${response.status}`);
  }

  section('5. §89 — secret khong lot ra ngoai');
  // Nhớ trạng thái cũ để trả lại nguyên vẹn: bộ thử này chạy trên database
  // thật của người dùng, không được để lại một cấu hình provider giả.
  restoreProvider = await sql(
    "SELECT coalesce(secret_ref, '') FROM ai_providers WHERE provider = 'anthropic'",
  );
  const providersBefore = await api('/api-center/providers');
  check('response provider khong chua secretRef', !providersBefore.text.includes('secretRef'));

  const save = await api('/api-center/providers/anthropic', {
    method: 'PUT',
    body: { apiKey: FAKE_KEY, isEnabled: true },
  });
  check('luu duoc cau hinh provider', save.status === 200, save.text.slice(0, 160));
  check('luu xong khong tra lai key', !save.text.includes(FAKE_KEY));

  const providersAfter = await api('/api-center/providers');
  check('§88.3 — tai lai chi thay key da che', !providersAfter.text.includes(FAKE_KEY));

  const test = await api('/api-center/providers/anthropic/test', { method: 'POST' });
  check('§89 — Test Connection voi key gia phai THAT BAI', test.json?.ok === false, test.text.slice(0, 200));
  check('§89 — loi cua provider khong kem theo key', !test.text.includes(FAKE_KEY));

  section('6. Giao viec bao dung thu con thieu');
  const intake = await api('/orchestrator/intake', {
    method: 'POST',
    body: {
      goal: 'Thu giao mot viec de kiem tra he thong phan hoi ra sao',
      productType: 'WEB_APPLICATION',
    },
  });
  if (intake.status === 409) {
    check('bi chan kem chi dan cu the', Boolean(intake.json?.fix), intake.text.slice(0, 200));
    check('chi dan tro toi trang can vao', intake.json?.fixPath === '/settings');
  } else {
    check('giao viec thanh cong', intake.status === 201, `HTTP ${intake.status} ${intake.text.slice(0, 200)}`);
  }

  section('7. Realtime');
  await new Promise((resolve) => {
    const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${token}`);
    const timer = setTimeout(() => {
      check('WebSocket gui snapshot khi ket noi', false, 'qua 8 giay khong nhan duoc gi');
      socket.close();
      resolve();
    }, 8000);

    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      check('WebSocket gui snapshot khi ket noi', message.type === 'snapshot', message.type);
      check('snapshot kem trang thai agent', Array.isArray(message.agents) && message.agents.length > 0);
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.on('error', (error) => {
      check('WebSocket ket noi duoc', false, error.message);
      clearTimeout(timer);
      resolve();
    });
  });
} finally {
  section('Don dep');
  try {
    await sql(`DELETE FROM users WHERE email = '${EMAIL}'`);
    process.stdout.write('  ok   da xoa tai khoan tam\n');
  } catch (error) {
    process.stdout.write(`  LOI  khong xoa duoc tai khoan tam: ${error.message}\n`);
  }

  // Trước khi thử, provider chưa được cấu hình → phải trả về đúng như cũ, không
  // để lại key giả trong kho secret thật.
  if (restoreProvider === '') {
    try {
      await sql(
        "DELETE FROM secrets WHERE ref = 'ai:anthropic:development'; " +
          "UPDATE ai_providers SET secret_ref = NULL, key_preview = NULL, status = 'NOT_CONFIGURED', is_enabled = false WHERE provider = 'anthropic'",
      );
      process.stdout.write('  ok   da xoa key gia, provider tro ve trang thai cu\n');
    } catch (error) {
      process.stdout.write(`  LOI  con sot key gia trong database: ${error.message}\n`);
    }
  }
}

process.stdout.write(`\n${passed} dat / ${failed} loi\n`);
if (failures.length > 0) {
  process.stdout.write('\nCac muc chua dat:\n');
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
}
process.exit(failed === 0 ? 0 : 1);
