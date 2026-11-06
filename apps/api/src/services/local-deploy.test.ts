/**
 * §38, §144 — staging tại chỗ phải dựng thật và nói thật: có index.html thì
 * SUCCESS kèm URL mở được, không thì FAILED kèm lý do và tin đẩy.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  findExecutable,
  judgePage,
  packagingProblem,
  resolveProductDir,
  smokeTestExecutable,
  rewriteHtml,
  runLocalStagingDeploy,
  safeProductPath,
  unbuiltEntry,
} from './local-deploy.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pn-product-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeDeps(workspace: string, execExit = 0) {
  const statuses: Array<{ status: string; url?: string | null; log?: string | null }> = [];
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const execs: string[] = [];
  const deps = {
    sandbox: {
      async create() {
        return {
          workspace,
          async listFiles() {
            const { readdir } = await import('node:fs/promises');
            return readdir(workspace);
          },
          async readFile(relative: string) {
            const { readFile } = await import('node:fs/promises');
            return readFile(path.join(workspace, relative), 'utf8');
          },
          async exec(command: string, args: string[] = []) {
            const line = [command, ...args].join(' ');
            execs.push(line);
            if (line === 'npm run build' && execExit === 0) {
              await mkdir(path.join(workspace, 'dist'), { recursive: true });
              await writeFile(path.join(workspace, 'dist', 'index.html'), '<h1>built</h1>');
            }
            return { command: line, exitCode: execExit, stdout: '', stderr: execExit ? '\u001b[31mboom\u001b[39m' : '', durationMs: 1, timedOut: false };
          },
          async dispose() {},
        } as never;
      },
    },
    deployments: {
      async setStatus(_id: string, status: string, extra: { url?: string | null; logExcerpt?: string | null } = {}) {
        statuses.push({ status, url: extra.url, log: extra.logExcerpt });
      },
    },
    events: {
      async publish(type: string, payload: Record<string, unknown>) {
        events.push({ type, payload });
      },
    },
    publicUrl: 'http://localhost:4000',
    viewUrl: (slug: string) => `http://localhost:4000/product/${slug}/?v=ve-xem`,
    smoke: async () => ({ ok: true, detail: 'giả lập' }),
  };
  return { deps: deps as never, statuses, events, execs };
}

const deployment = { id: 'd1' };
const project = { id: 'p1', slug: 'ghi-chu', productType: 'WEB_APPLICATION' as const };
const desktopProject = { id: 'p2', slug: 'ghi-chu-exe', productType: 'DESKTOP_APPLICATION' as const };

describe('runLocalStagingDeploy', () => {
  it('có script build thì cài, dựng, rồi phục vụ dist/', async () => {
    const workspace = path.join(root, 'build-ok');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    const fake = fakeDeps(workspace);

    expect((await runLocalStagingDeploy(fake.deps, deployment, project)).status).toBe('SUCCESS');
    expect(fake.execs).toEqual(['npm install --no-audit --no-fund --dangerously-allow-all-scripts', 'npm run build']);
    expect(fake.statuses.at(-1)).toMatchObject({ status: 'SUCCESS', url: 'http://localhost:4000/product/ghi-chu/' });
    // Bản ghi giữ URL thường; event mang link có vé để đẩy Telegram.
    expect(fake.events.at(-1)).toMatchObject({ type: 'DEPLOY_SUCCESS', payload: { url: 'http://localhost:4000/product/ghi-chu/?v=ve-xem' } });
  });

  it('không có build nhưng có index.html ở gốc thì phục vụ thẳng', async () => {
    const workspace = path.join(root, 'static');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'index.html'), '<p>hi</p>');
    const fake = fakeDeps(workspace);

    expect((await runLocalStagingDeploy(fake.deps, deployment, project)).status).toBe('SUCCESS');
    expect(fake.execs).toEqual([]);
    expect(fake.statuses.at(-1)?.log).toContain('Không có package.json');
  });

  it('dựng hỏng thì FAILED, nói exit code, và phát DEPLOY_FAILED để đẩy Telegram', async () => {
    const workspace = path.join(root, 'build-fail');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    const fake = fakeDeps(workspace, 2);

    expect((await runLocalStagingDeploy(fake.deps, deployment, project)).status).toBe('FAILED');
    expect(fake.statuses.at(-1)).toMatchObject({ status: 'FAILED' });
    expect(fake.events.at(-1)?.type).toBe('DEPLOY_FAILED');
    expect(String(fake.events.at(-1)?.payload['reason'])).toContain('npm install thất bại (exit 2)');
    expect(String(fake.events.at(-1)?.payload['reason'])).toContain('boom');
    // Mã màu ANSI của vite/npm không được lọt vào lý do gửi Telegram.
    expect(String(fake.events.at(-1)?.payload['reason'])).not.toContain('\u001b');
  });

  it('không có gì để mở thì FAILED thay vì SUCCESS rỗng', async () => {
    const workspace = path.join(root, 'empty');
    await mkdir(workspace, { recursive: true });
    const fake = fakeDeps(workspace);
    expect((await runLocalStagingDeploy(fake.deps, deployment, project)).status).toBe('FAILED');
    expect(String(fake.events.at(-1)?.payload['reason'])).toContain('index.html');
  });

  it('trang trỏ tới /src/main.ts mà không có script build thì FAILED, không giả vờ có sản phẩm', async () => {
    const workspace = path.join(root, 'unbuilt');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    await writeFile(path.join(workspace, 'index.html'), '<script type="module" src="/src/main.ts"></script>');
    const fake = fakeDeps(workspace);

    const result = await runLocalStagingDeploy(fake.deps, deployment, project);
    expect(result.status).toBe('FAILED');
    expect(result.reason).toContain('/src/main.ts');
    expect(result.reason).toContain('script "build"');
  });
});

describe('phần mềm desktop (.exe)', () => {
  it('dựng xong có .exe thì SUCCESS, log ghi tên và cỡ file', async () => {
    const workspace = path.join(root, 'exe-ok');
    await mkdir(path.join(workspace, 'dist'), { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'electron-builder --win portable' } }));
    await writeFile(path.join(workspace, 'dist', 'GhiChu 1.0.0.exe'), Buffer.alloc(2048, 1));
    await writeFile(path.join(workspace, 'dist', 'GhiChu 1.0.0.exe.blockmap'), 'x');
    const fake = fakeDeps(workspace);

    const result = await runLocalStagingDeploy(fake.deps, deployment, desktopProject);
    expect(result.status).toBe('SUCCESS');
    expect(fake.statuses.at(-1)?.log).toContain('GhiChu 1.0.0.exe');
  });

  it('.exe xuất vào đúng thư mục đang gói thì FAILED trước khi dựng, giao DevOps sửa (app 391 MB)', async () => {
    const workspace = path.join(root, 'exe-bloat');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc && electron-builder --win portable' },
        build: { files: ['dist/**/*', 'node_modules/**/*', 'package.json'], directories: { output: 'dist' } },
      }),
    );
    const fake = fakeDeps(workspace);
    const result = await runLocalStagingDeploy(fake.deps, deployment, desktopProject);
    expect(result.status).toBe('FAILED');
    expect(result.reason).toContain('"release"');
    expect(fake.execs).toEqual([]);
  });

  it('packagingProblem: mặc định electron-builder xuất vào dist/, xuất ra release/ thì ổn', () => {
    const scripts = { build: 'electron-builder --win portable' };
    expect(packagingProblem({ scripts, build: { files: ['dist/**/*'] } })).toMatch(/dist\//);
    expect(packagingProblem({ scripts, build: { files: ['./dist/**/*', 'package.json'], directories: { output: 'release' } } })).toBeNull();
    expect(packagingProblem({ scripts, build: { files: ['!dist/win-unpacked/**', 'src/**/*'] } })).toBeNull();
    expect(packagingProblem({ scripts: { build: 'vite build' }, build: { files: ['dist/**/*'] } })).toBeNull();
    expect(packagingProblem({ scripts })).toBeNull();
  });

  it('không có script build thì FAILED và nói rõ cần .exe', async () => {
    const workspace = path.join(root, 'exe-nobuild');
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const fake = fakeDeps(workspace);
    const result = await runLocalStagingDeploy(fake.deps, deployment, desktopProject);
    expect(result.status).toBe('FAILED');
    expect(result.reason).toContain('.exe');
  });

  it('findExecutable lấy file .exe lớn nhất, bỏ qua blockmap và node_modules', async () => {
    const workspace = path.join(root, 'exe-find');
    await mkdir(path.join(workspace, 'release', 'win'), { recursive: true });
    await mkdir(path.join(workspace, 'dist', 'node_modules'), { recursive: true });
    await writeFile(path.join(workspace, 'release', 'win', 'App.exe'), Buffer.alloc(100));
    await writeFile(path.join(workspace, 'release', 'Setup.exe'), Buffer.alloc(300));
    await writeFile(path.join(workspace, 'dist', 'node_modules', 'big.exe'), Buffer.alloc(9999));
    const found = await findExecutable(workspace);
    expect(found?.file.endsWith('Setup.exe')).toBe(true);
    expect(found?.size).toBe(300);
  });

  it('file giao không bao giờ là file Electron trần trong win-unpacked (177MB, thiếu tài nguyên đi kèm)', async () => {
    const workspace = path.join(root, 'exe-unpacked');
    await mkdir(path.join(workspace, 'dist', 'win-unpacked'), { recursive: true });
    await writeFile(path.join(workspace, 'dist', 'win-unpacked', 'App.exe'), Buffer.alloc(5000));
    await writeFile(path.join(workspace, 'dist', 'App Portable.exe'), Buffer.alloc(2000));
    const delivered = await findExecutable(workspace);
    expect(delivered?.file.endsWith('App Portable.exe')).toBe(true);
    const unpacked = await findExecutable(workspace, ['dist/win-unpacked']);
    expect(unpacked?.file.endsWith(path.join('win-unpacked', 'App.exe'))).toBe(true);
  });
});

describe('khởi động thử ứng dụng', () => {
  const node = process.execPath;

  it('judgePage: trang tạm data: (app tắt/mở máy, 36 ký tự "System active") là KHÔNG ĐẠT', () => {
    const placeholder = { title: 'pn-auto-shutdown-wake', href: 'data:text/html;charset=utf-8,<h2>PN Auto Shutdown & Wake System active</h2>', interactive: 0, problems: [] };
    expect(judgePage(placeholder).ok).toBe(false);
    expect(judgePage(placeholder).detail).toContain('trang tạm');
    // Có chữ nhưng không có nút nào cũng không đạt.
    expect(judgePage({ ...placeholder, href: 'file:///C:/app/dist/renderer/index.html' }).ok).toBe(false);
    // Giao diện thật: nạp từ file, có nút bấm.
    expect(judgePage({ ...placeholder, href: 'file:///C:/app/dist/renderer/index.html', interactive: 7 }).ok).toBe(true);
    // Lỗi JavaScript luôn thắng.
    expect(judgePage({ ...placeholder, href: 'file:///x', interactive: 7, problems: ['Uncaught TypeError: api.cancelCountdown is not a function'] }).ok).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('dựng .exe thành công thì lưu ảnh cửa sổ thật và gắn vào tin DEPLOY_SUCCESS', async () => {
    const workspace = path.join(root, 'ws-shot', 'exe-shot');
    await mkdir(path.join(workspace, 'release'), { recursive: true });
    await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'electron-builder --win portable' } }));
    await writeFile(path.join(workspace, 'release', 'App 1.0.0.exe'), Buffer.alloc(2048, 1));
    const fake = fakeDeps(workspace);
    (fake.deps as { smoke: unknown }).smoke = async () => ({ ok: true, detail: 'giả lập', screenshot: Buffer.from('png').toString('base64') });

    const result = await runLocalStagingDeploy(fake.deps, deployment, desktopProject);

    expect(result.status).toBe('SUCCESS');
    const shot = fake.events.find((event) => event.type === 'DEPLOY_SUCCESS')?.payload['screenshot'] as string;
    expect(shot).toBe(path.join(root, 'ws-shot', '_anh-san-pham', 'ghi-chu-exe.png'));
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(shot)).toString()).toBe('png');
  });

  it('console có lỗi JavaScript thì hỏng, nêu đúng dòng lỗi', async () => {
    const result = await smokeTestExecutable({
      file: node,
      args: ['-e', "console.error('[1:0910/1.2:INFO:CONSOLE(2)] \"Uncaught ReferenceError: exports is not defined\"'); setTimeout(() => {}, 5000)"],
      timeoutMs: 1500,
      devtools: false,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('exports is not defined');
  });

  it('thoát sớm với mã khác 0 là hỏng', async () => {
    const result = await smokeTestExecutable({ file: node, args: ['-e', 'process.exit(3)'], timeoutMs: 1500, devtools: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mã 3');
  });

  it('chạy hết thời gian thử mà console sạch thì đạt (app không có DevTools)', async () => {
    const result = await smokeTestExecutable({
      file: node,
      args: ['-e', "console.log('san sang'); setTimeout(() => {}, 5000)"],
      timeoutMs: 1000,
      devtools: false,
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('không có DevTools');
  });
});

describe('unbuiltEntry', () => {
  it('nhận ra file cần dựng, bỏ qua js thường', () => {
    expect(unbuiltEntry('<script type="module" src="/src/main.ts"></script>')).toBe('/src/main.ts');
    expect(unbuiltEntry('<script src="app.js" defer></script>')).toBeNull();
    expect(unbuiltEntry('<script src="/src/App.tsx?v=1"></script>')).toBe('/src/App.tsx');
  });
});

describe('phục vụ file sản phẩm', () => {
  it('resolveProductDir ưu tiên dist/ rồi gốc', async () => {
    const workspace = path.join(root, 'resolve');
    await mkdir(path.join(workspace, 'dist'), { recursive: true });
    await writeFile(path.join(workspace, 'index.html'), 'root');
    await writeFile(path.join(workspace, 'dist', 'index.html'), 'dist');
    expect(await resolveProductDir(workspace)).toBe(path.join(workspace, 'dist'));
    expect(await resolveProductDir(path.join(root, 'khong-co'))).toBeNull();
  });

  it('safeProductPath chặn thoát thư mục, dotfile, node_modules và file không phải web', () => {
    expect(safeProductPath('')).toBe('index.html');
    expect(safeProductPath('assets/app.js')).toBe('assets/app.js');
    expect(safeProductPath('docs/')).toBe('docs/index.html');
    expect(safeProductPath('../secret.txt')).toBeNull();
    expect(safeProductPath('.env')).toBeNull();
    expect(safeProductPath('node_modules/x/index.js')).toBeNull();
    expect(safeProductPath('src/calc.ts')).toBeNull();
    expect(safeProductPath('%2e%2e/x.html')).toBeNull();
  });

  it('rewriteHtml đưa đường dẫn tuyệt đối về dưới /product/<slug>/', () => {
    const html = '<link href="/src/styles.css"><script src="/src/main.js"></script><a href="//cdn.x/y">x</a><div style="background:url(/img/a.png)">';
    const out = rewriteHtml(html, '/product/ghi-chu/');
    expect(out).toContain('href="/product/ghi-chu/src/styles.css"');
    expect(out).toContain('src="/product/ghi-chu/src/main.js"');
    expect(out).toContain('href="//cdn.x/y"');
    expect(out).toContain('url(/product/ghi-chu/img/a.png)');
  });
});
