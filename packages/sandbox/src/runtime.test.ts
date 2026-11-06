/**
 * QA phải mở sản phẩm thật. Bộ test này dựng một trang tĩnh nhỏ, mở bằng trình
 * duyệt có sẵn trên máy; máy không có trình duyệt thì bỏ qua phần mở (vẫn kiểm máy chủ tĩnh).
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { findBrowser, findProductDir, probeProduct, probeWeb, serveStatic } from './runtime.js';

async function site(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pn-site-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

const browser = findBrowser();

describe('máy chủ tĩnh', () => {
  it('phục vụ tệp, trả index.html cho đường dẫn trang, 404 cho tài nguyên thiếu', async () => {
    const dir = await site({ 'index.html': '<h1>hi</h1>', 'app.js': 'x', 'dist/a.css': 'b{}' });
    const server = await serveStatic(dir);
    try {
      expect(await (await fetch(server.url)).text()).toBe('<h1>hi</h1>');
      expect((await fetch(`${server.url}app.js`)).headers.get('content-type')).toBe('text/javascript');
      expect(await (await fetch(`${server.url}gioi-thieu`)).text()).toBe('<h1>hi</h1>');
      expect((await fetch(`${server.url}thieu.png`)).status).toBe(404);
      expect((await fetch(`${server.url}../../etc/passwd`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('tìm thư mục dựng: dist trước, rồi gốc', async () => {
    const dir = await site({ 'dist/index.html': '<p>d</p>', 'index.html': '<p>r</p>' });
    expect(await findProductDir(dir)).toBe(path.join(dir, 'dist'));
    const rootOnly = await site({ 'index.html': '' });
    expect(await findProductDir(rootOnly)).toBe(rootOnly);
    expect(await findProductDir(await site({ 'src/a.ts': '' }))).toBeNull();
  });

  it('không có trình duyệt thì báo bỏ qua, không phải lỗi', async () => {
    const dir = await site({ 'index.html': '<button>a</button>' });
    const report = await probeWeb(dir, { screenshotDir: path.join(dir, 'anh'), browser: null });
    expect(report).toMatchObject({ ok: true, skipped: true });
  });
});

describe.skipIf(!browser)('mở bằng trình duyệt thật', () => {
  it('trang tốt: có nút, bấm được, không lỗi, có ảnh chụp', async () => {
    const dir = await site({
      'index.html':
        '<!doctype html><title>Ghi chú</title><button id="b" onclick="document.getElementById(\'o\').textContent=1+1">Cộng</button><p id="o">?</p><a href="/ve">Về</a>',
      'app.js': '',
    });
    const report = await probeProduct(dir, { screenshotDir: path.join(dir, 'anh'), maxClicks: 3 });
    expect(report).not.toBeNull();
    expect(report!.ok).toBe(true);
    expect(report!.pages[0]).toMatchObject({ title: 'Ghi chú', clicked: ['Cộng'] });
    expect(report!.pages[0]!.interactive).toBeGreaterThan(0);
    expect(report!.screenshots.length).toBeGreaterThanOrEqual(1);
    // Link nội bộ /ve được mở như trang thứ hai (ứng dụng một trang trả index.html).
    expect(report!.pages.length).toBe(2);
  }, 60_000);

  it('trang hỏng: lỗi JavaScript khi bấm và tài nguyên thiếu thì không đạt, lỗi ghi rõ', async () => {
    const dir = await site({
      'index.html': '<!doctype html><title>Hỏng</title><script src="/thieu.js"></script><button onclick="khongCo()">Bấm</button>',
    });
    const report = await probeWeb(dir, { screenshotDir: path.join(dir, 'anh'), maxClicks: 3 });
    expect(report.ok).toBe(false);
    const problems = report.pages.flatMap((page) => page.problems).join('\n');
    expect(problems).toMatch(/HTTP 404|Tải hỏng/);
    expect(problems).toMatch(/khongCo/);
    expect(report.detail).toContain('LỖI');
  }, 60_000);

  it('bấm bằng chuột thật: nút bắt pointerdown vẫn chạy; nút chết thì có cảnh báo ', async () => {
    const live = await site({
      'index.html':
        '<!doctype html><title>Sống</title><p id="o">0</p>' +
        ['1', '2', '3'].map((n) => `<button onpointerdown="document.getElementById('o').textContent += '${n}'">${n}</button>`).join(''),
    });
    const good = await probeWeb(live, { screenshotDir: path.join(live, 'anh'), maxClicks: 3 });
    expect(good.pages[0]!.clicked).toEqual(['1', '2', '3']);
    expect(good.detail).not.toContain('CẢNH BÁO');

    const dead = await site({ 'index.html': '<!doctype html><title>Chết</title><p>0</p><button>1</button><button>2</button><button>3</button>' });
    const bad = await probeWeb(dead, { screenshotDir: path.join(dead, 'anh'), maxClicks: 3 });
    expect(bad.ok).toBe(true);
    expect(bad.detail).toContain('CẢNH BÁO: Bấm thử 3 nút nhưng chữ trên trang không đổi gì');
  }, 60_000);

  it('ứng dụng nhiều màn cần nhập tên: điền ô nhập rồi đi tiếp tới màn sau, không kẹt ở màn đầu', async () => {
    const dir = await site({
      'index.html':
        '<!doctype html><title>Đố vui</title><main id="m"></main><script>' +
        "const m=document.getElementById('m');" +
        "function hoso(){m.innerHTML='<h1>Em là ai?</h1><button onclick=\"ten()\">Thêm Bạn Mới</button>'}" +
        "function ten(){m.innerHTML='<h1>Tên của em?</h1><input id=t><button onclick=\"batdau()\">Bắt Đầu Chơi</button><button onclick=\"hoso()\">Quay Lại</button>'}" +
        "function batdau(){if(!document.getElementById('t').value.trim())return;m.innerHTML='<h1>Menu chính</h1><button onclick=\"hoc()\">Học Bảng</button>'}" +
        "function hoc(){m.innerHTML='<h1>Bảng 2</h1><p>2 x 1 = 2</p>'}" +
        'hoso()</script>',
    });
    const report = await probeWeb(dir, { screenshotDir: path.join(dir, 'anh'), maxClicks: 8 });
    expect(report.pages[0]!.clicked).toEqual(['Thêm Bạn Mới', 'Bắt Đầu Chơi', 'Học Bảng']);
    expect(report.pages[0]!.screens).toBe(4);
    expect(report.detail).toContain('đi qua 4 màn');
  }, 60_000);

  it('trang trống không có gì bấm được thì không đạt', async () => {
    const dir = await site({ 'index.html': '<!doctype html><title>Trống</title><p>System active</p>' });
    const report = await probeWeb(dir, { screenshotDir: path.join(dir, 'anh') });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('không có nút');
  }, 60_000);
});
