/**
 * Tài khoản & phân quyền: mời người, đăng nhập đúng quyền, khoá có hiệu lực ngay, luôn còn một CEO.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from './test/fixtures.js';

let h: TestHarness;
let ceo: string;

beforeEach(async () => {
  h = await createTestApp();
  ceo = await h.loginAsCeo();
});
afterEach(async () => {
  await h.app.close();
});

const call = (token: string | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  h.app.inject({ method, url, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}), ...(payload ? { payload } : {}) });

/** CEO mời một người bằng link, người đó nhận lời mời và trả về token của họ. */
async function invite(role: string, access?: Record<string, number>): Promise<{ id: string; token: string }> {
  const created = await call(ceo, 'POST', '/users', { email: `${role.toLowerCase()}@pn.test`, displayName: `Người ${role}`, role, way: 'link', ...(access ? { access } : {}) });
  expect(created.statusCode).toBe(201);
  const { user, inviteUrl } = created.json() as { user: { id: string; status: string }; inviteUrl: string };
  expect(user.status).toBe('invited');
  const inviteToken = new URL(inviteUrl).searchParams.get('invite')!;
  const accepted = await call(null, 'POST', '/auth/invite/accept', { token: inviteToken, password: 'mat-khau-moi-123' });
  expect(accepted.statusCode).toBe(200);
  return { id: user.id, token: (accepted.json() as { token: string }).token };
}

describe('tài khoản & phân quyền', () => {
  it('người được mời vào bằng link, link chỉ dùng một lần', async () => {
    const created = await call(ceo, 'POST', '/users', { email: 'lan@pn.test', displayName: 'Lan', role: 'PROJECT_MANAGER', way: 'link' });
    const inviteToken = new URL((created.json() as { inviteUrl: string }).inviteUrl).searchParams.get('invite')!;

    const info = await call(null, 'GET', `/auth/invite/${inviteToken}`);
    expect(info.json()).toMatchObject({ displayName: 'Lan', email: 'lan@pn.test' });

    expect((await call(null, 'POST', '/auth/invite/accept', { token: inviteToken, password: 'mat-khau-moi-123' })).statusCode).toBe(200);
    expect((await call(null, 'POST', '/auth/invite/accept', { token: inviteToken, password: 'mat-khau-khac-456' })).statusCode).toBe(404);
    // Mật khẩu vừa đặt đăng nhập được.
    expect((await call(null, 'POST', '/auth/login', { email: 'lan@pn.test', password: 'mat-khau-moi-123' })).statusCode).toBe(200);
  });

  it('mỗi người chỉ làm được việc trong quyền của mình', async () => {
    const acc = await invite('ACCOUNTANT');
    expect((await call(acc.token, 'GET', '/api-center/budgets')).statusCode).toBe(200);
    // Kế toán không thấy khoá API, không mời được ai, không duyệt được kế hoạch.
    expect((await call(acc.token, 'GET', '/api-center/providers')).statusCode).toBe(403);
    expect((await call(acc.token, 'GET', '/users')).statusCode).toBe(403);
    expect((await call(acc.token, 'GET', '/approvals')).statusCode).toBe(403);

    const me = (await call(acc.token, 'GET', '/auth/me')).json() as { access: Record<string, number>; capabilities: string[] };
    expect(me.access['budget']).toBe(2);
    expect(me.capabilities).toContain('budget:write');
    expect(me.capabilities).not.toContain('budget:reset');
  });

  it('chỉnh riêng một khu có hiệu lực ngay, không cần đăng nhập lại', async () => {
    const pm = await invite('PROJECT_MANAGER');
    expect((await call(pm.token, 'GET', '/cost/summary')).statusCode).toBe(200);
    const patched = await call(ceo, 'PATCH', `/users/${pm.id}`, { access: { budget: 0 } });
    expect(patched.json()).toMatchObject({ user: { customized: true, access: { budget: 0 } } });
    expect((await call(pm.token, 'GET', '/cost/summary')).statusCode).toBe(403);
  });

  it('không ai ngoài CEO có toàn quyền tài khoản, dù CEO cố cấp', async () => {
    const cto = await invite('CTO', { accounts: 3 });
    const me = (await call(cto.token, 'GET', '/auth/me')).json() as { capabilities: string[] };
    expect(me.capabilities).toContain('users:read');
    expect(me.capabilities).not.toContain('users:manage');
    expect((await call(cto.token, 'POST', '/users', { email: 'x@pn.test', displayName: 'X', role: 'CEO', way: 'link' })).statusCode).toBe(403);
  });

  it('khoá tài khoản thì phiên đang mở hết hiệu lực ngay', async () => {
    const viewer = await invite('VIEWER');
    expect((await call(viewer.token, 'GET', '/projects')).statusCode).toBe(200);
    expect((await call(ceo, 'POST', `/users/${viewer.id}/lock`)).statusCode).toBe(200);
    expect((await call(viewer.token, 'GET', '/projects')).statusCode).toBe(401);
    // Mở khoá rồi vẫn phải đăng nhập lại — token cũ đã bị thu hồi.
    await call(ceo, 'POST', `/users/${viewer.id}/unlock`);
    expect((await call(viewer.token, 'GET', '/projects')).statusCode).toBe(401);
  });

  it('đăng xuất mọi thiết bị thu hồi token cũ', async () => {
    const viewer = await invite('VIEWER');
    await call(ceo, 'POST', `/users/${viewer.id}/logout-all`);
    expect((await call(viewer.token, 'GET', '/projects')).statusCode).toBe(401);
  });

  it('công ty luôn còn ít nhất một CEO', async () => {
    const me = (await call(ceo, 'GET', '/auth/me')).json() as { user: { id: string } };
    expect((await call(ceo, 'PATCH', `/users/${me.user.id}`, { role: 'CTO' })).statusCode).toBe(409);
    expect((await call(ceo, 'POST', `/users/${me.user.id}/lock`)).statusCode).toBe(409);
    expect((await call(ceo, 'DELETE', `/users/${me.user.id}`)).statusCode).toBe(409);
  });

  it('mật khẩu tạm: chỉ đổi được mật khẩu, đổi xong mới dùng được công ty', async () => {
    const created = await call(ceo, 'POST', '/users', { email: 'ha@pn.test', displayName: 'Hà', role: 'VIEWER', way: 'password' });
    const { tempPassword } = created.json() as { tempPassword: string };
    expect(tempPassword).toMatch(/^[\w]{4}-[\w]{4}-[\w]{4}$/);

    const login = (await call(null, 'POST', '/auth/login', { email: 'ha@pn.test', password: tempPassword })).json() as { token: string; mustChangePassword: boolean };
    expect(login.mustChangePassword).toBe(true);
    expect((await call(login.token, 'GET', '/projects')).statusCode).toBe(403);

    expect((await call(login.token, 'POST', '/auth/password', { currentPassword: tempPassword, password: 'mat-khau-rieng-789' })).statusCode).toBe(200);
    expect((await call(login.token, 'GET', '/projects')).statusCode).toBe(200);
  });

  it('danh sách tài khoản không lộ mã mời hay chat Telegram', async () => {
    await invite('VIEWER');
    const body = (await call(ceo, 'GET', '/users')).body;
    expect(body).not.toMatch(/inviteTokenHash|passwordHash|telegramChatId/);
  });

  it('mọi thay đổi quyền ghi nhật ký từ gì sang gì', async () => {
    const pm = await invite('PROJECT_MANAGER');
    await call(ceo, 'PATCH', `/users/${pm.id}`, { role: 'VIEWER' });
    const entry = h.store.audit.find((row) => row['action'] === 'USER_UPDATED');
    expect(entry?.['metadata']).toMatchObject({ from: { role: 'PROJECT_MANAGER' }, to: { role: 'VIEWER' } });
  });
});
