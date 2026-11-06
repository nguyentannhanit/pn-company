/**
 * §38, §144 — CEO mở được sản phẩm từ dashboard: vé xem là JWT thật (không bị
 * hook che thành [REDACTED] như lần đầu), đổi thành cookie, rồi file web được
 * phục vụ với đường dẫn tuyệt đối đã viết lại; mã nguồn và dotfile thì không.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from './test/fixtures.js';

let harness: TestHarness;
let token: string;
let root: string;
let projectId: string;
const SLUG = 'ghi-chu-thu';

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pn-product-route-'));
  await mkdir(path.join(root, SLUG, 'src'), { recursive: true });
  await writeFile(
    path.join(root, SLUG, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="/src/styles.css"><h1>Ghi chú</h1>',
  );
  await writeFile(path.join(root, SLUG, 'src', 'styles.css'), 'h1{color:red}');
  await writeFile(path.join(root, SLUG, 'src', 'calc.ts'), 'export const x = 1;');
  await writeFile(path.join(root, SLUG, '.env'), 'SECRET=1');

  harness = await createTestApp({ sandboxRoot: root });
  token = await harness.loginAsCeo();
  const project = await harness.context.repos.projects.create({
    name: 'Máy tính thử', slug: SLUG, goal: 'x', productType: 'WEB_APPLICATION', status: 'IN_PROGRESS', budgetUsd: 1,
  } as never);
  projectId = project.id;
});

afterAll(async () => {
  await harness.app.close();
  await harness.context.shutdown();
  await rm(root, { recursive: true, force: true });
});

describe('Mở sản phẩm', () => {
  let cookie: string;

  it('vé xem là JWT thật, và lần mở đầu đổi vé thành cookie', async () => {
    const link = await harness.app.inject({
      method: 'GET',
      url: `/projects/${projectId}/product-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(link.statusCode).toBe(200);
    const url = String(link.json().url);
    const ticket = new URL(url).searchParams.get('v') ?? '';
    expect(ticket.split('.')).toHaveLength(3);

    const first = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/?v=${ticket}` });
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`/product/${SLUG}/`);
    cookie = String(first.headers['set-cookie']).split(';')[0]!;
    expect(cookie.startsWith('pn_product=')).toBe(true);
  });

  it('có cookie thì thấy trang, đường dẫn tuyệt đối được viết lại, css tải được', async () => {
    const page = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/`, headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain(`href="/product/${SLUG}/src/styles.css"`);

    const css = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/src/styles.css`, headers: { cookie } });
    expect(css.statusCode).toBe(200);
    expect(css.body).toBe('h1{color:red}');
  });

  it('không cookie thì chỉ thấy hướng dẫn; mã nguồn và dotfile không bao giờ ra ngoài', async () => {
    const anonymous = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/` });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain('Ghi chú');

    for (const file of ['src/calc.ts', '.env', '../x.html', 'node_modules/a/index.js']) {
      const response = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/${file}`, headers: { cookie } });
      // `..` bị Fastify chặn từ tầng URL (400); phần còn lại do route từ chối (404).
      expect([400, 404], file).toContain(response.statusCode);
      expect(response.body).not.toContain('SECRET');
    }
  });

  it('phần mềm desktop: trang tải nêu tên và cỡ file, /download trả đúng file .exe', async () => {
    const slug = 'ghi-chu-exe';
    await mkdir(path.join(root, slug, 'dist'), { recursive: true });
    await writeFile(path.join(root, slug, 'dist', 'GhiChu.exe'), Buffer.from('MZ-gia-lap'));
    const project = await harness.context.repos.projects.create({
      name: 'Máy tính exe', slug, goal: 'x', productType: 'DESKTOP_APPLICATION', status: 'IN_PROGRESS', budgetUsd: 1,
    } as never);
    const link = await harness.app.inject({
      method: 'GET', url: `/projects/${project.id}/product-link`, headers: { authorization: `Bearer ${token}` },
    });
    const ticket = new URL(String(link.json().url)).searchParams.get('v') ?? '';
    const first = await harness.app.inject({ method: 'GET', url: `/product/${slug}/?v=${ticket}` });
    const exeCookie = String(first.headers['set-cookie']).split(';')[0]!;

    const page = await harness.app.inject({ method: 'GET', url: `/product/${slug}/`, headers: { cookie: exeCookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('GhiChu.exe');
    expect(page.body).toContain(`/product/${slug}/download`);

    const file = await harness.app.inject({ method: 'GET', url: `/product/${slug}/download`, headers: { cookie: exeCookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-disposition']).toContain('GhiChu.exe');
    expect(file.body).toBe('MZ-gia-lap');
  });

  it('vé của slug khác không mở được sản phẩm này', async () => {
    const other = await harness.context.repos.projects.create({
      name: 'Khác', slug: 'du-an-khac', goal: 'x', productType: 'WEB_APPLICATION', status: 'IN_PROGRESS', budgetUsd: 1,
    } as never);
    const link = await harness.app.inject({
      method: 'GET',
      url: `/projects/${other.id}/product-link`,
      headers: { authorization: `Bearer ${token}` },
    });
    const ticket = new URL(String(link.json().url)).searchParams.get('v') ?? '';
    const response = await harness.app.inject({ method: 'GET', url: `/product/${SLUG}/?v=${ticket}` });
    expect(response.statusCode).toBe(403);
  });
});
