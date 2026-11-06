/**
 * P&N — Staging tại chỗ (§38, §144).
 *
 * Công ty chưa nối Vercel/Netlify, nhưng "ra sản phẩm" phải là thứ CEO mở
 * được bằng trình duyệt, không phải một thư mục mã nguồn. Staging tại chỗ:
 * dựng (`npm run build` nếu có) ngay trong workspace của dự án, rồi chính API
 * phục vụ thư mục kết quả ở `/product/<slug>/`. Dựng hỏng thì bản triển khai
 * FAILED và CEO nhận tin đẩy như mọi lần deploy hỏng khác.
 */

import { spawn } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { EventBus } from '@pn/events';
import { NPM_INSTALL_ARGS, type SandboxDriver } from '@pn/sandbox';
import type { DeployStatus, Deployment, Project, Uuid } from '@pn/shared';

/** Thứ tự tìm thư mục sản phẩm sau khi dựng; không có thì lấy thư mục gốc. */
export const BUILD_DIRS = ['dist', 'build', 'out'] as const;

/** Chỉ phục vụ file web; mã nguồn, cấu hình, dotfile không bao giờ ra ngoài. */
export const SERVABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.txt', '.webmanifest', '.wasm',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(extension: string): string {
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export interface LocalDeployDeps {
  sandbox: Pick<SandboxDriver, 'create'>;
  deployments: {
    setStatus(id: Uuid, status: DeployStatus, extra?: { url?: string | null; logExcerpt?: string | null }): Promise<void>;
  };
  events: Pick<EventBus, 'publish'>;
  publicUrl: string;
  /** Link có vé xem cho CEO mở từ Telegram; không có thì dùng URL thường. */
  viewUrl?: (slug: string) => string;
  /** Khởi động thử file thực thi; test cắm bản giả để khỏi chạy .exe thật. */
  smoke?: (options: { file: string; timeoutMs: number }) => Promise<{ ok: boolean; detail: string; screenshot?: string }>;
}

export interface LocalDeployResult {
  status: 'SUCCESS' | 'FAILED' | 'CANCELLED';
  /** Lý do khi FAILED — cũng là nội dung giao cho DevOps sửa. */
  reason?: string;
  /** Link mở sản phẩm khi SUCCESS (có vé xem nếu cấp được). */
  url?: string;
  /** Đường dẫn tuyệt đối file .exe (phần mềm desktop) để gửi thẳng cho CEO. */
  file?: string;
}

/**
 * Dựng và ghi kết quả vào bản triển khai. Không ném lỗi: mọi thất bại là FAILED có lý do. `signal` huỷ thì lệnh đang chạy
 * bị giết cả cây tiến trình và kết quả là CANCELLED — không báo lỗi, không giao DevOps sửa.
 */
export async function runLocalStagingDeploy(
  deps: LocalDeployDeps,
  deployment: Pick<Deployment, 'id'>,
  project: Pick<Project, 'id' | 'slug' | 'productType'>,
  signal?: AbortSignal,
): Promise<LocalDeployResult> {
  const desktop = project.productType === 'DESKTOP_APPLICATION';
  const log: string[] = [];
  const cancelled = async (): Promise<LocalDeployResult> => {
    log.push('CEO dừng bản dựng giữa chừng.');
    await deps.deployments.setStatus(deployment.id, 'CANCELLED', { logExcerpt: tail(log.join('\n'), 20_000) });
    return { status: 'CANCELLED' };
  };
  const fail = async (reason: string): Promise<LocalDeployResult> => {
    if (signal?.aborted) return cancelled();
    log.push(reason);
    await deps.deployments.setStatus(deployment.id, 'FAILED', { logExcerpt: tail(log.join('\n'), 20_000) });
    await deps.events.publish(
      'DEPLOY_FAILED',
      { deploymentId: deployment.id, environment: 'STAGING', reason },
      { projectId: project.id },
    );
    return { status: 'FAILED', reason };
  };

  await deps.deployments.setStatus(deployment.id, 'IN_PROGRESS');

  let session: Awaited<ReturnType<SandboxDriver['create']>>;
  try {
    session = await deps.sandbox.create({
      runId: deployment.id,
      taskId: null,
      projectId: project.id,
      workspaceKey: project.slug,
      signal,
    });
  } catch (error) {
    return fail(`Không mở được workspace: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const files = await session.listFiles().catch((): string[] => []);
    let built = false;
    if (files.includes('package.json')) {
      let manifest: { scripts?: Record<string, string> } = {};
      try {
        manifest = JSON.parse(await session.readFile('package.json')) as typeof manifest;
      } catch {
        log.push('package.json không đọc được — bỏ qua bước dựng.');
      }
      const scripts = manifest.scripts ?? {};
      // Cấu hình đóng gói sai thì trả DevOps sửa trước khi dựng vài phút ra một app phình to.
      const problem = desktop ? packagingProblem(manifest) : null;
      if (problem) return fail(problem);
      if (scripts['build']) {
        for (const args of [[...NPM_INSTALL_ARGS], ['run', 'build']]) {
          const result = await session.exec('npm', args);
          log.push(`$ ${result.command} (exit ${result.exitCode}, ${result.durationMs}ms)`, tail(result.stdout, 3000), tail(result.stderr, 3000));
          if (result.exitCode !== 0) {
            // Kèm đuôi output để DevOps sửa được ngay, không phải đoán "exit 1" nghĩa là gì.
            return fail(
              `npm ${args[0]} thất bại (exit ${result.exitCode}):\n${tail(`${result.stdout}\n${result.stderr}`.trim(), 2500)}`,
            );
          }
        }
        built = true;
      } else {
        log.push('package.json không có script build — phục vụ thẳng file trong workspace.');
      }
    } else {
      log.push('Không có package.json — phục vụ thẳng file trong workspace.');
    }

    if (signal?.aborted) return cancelled();

    // Phần mềm desktop: sản phẩm là file .exe, không có thì chưa có gì để giao.
    if (desktop) {
      if (!built) {
        return fail(
          'Ứng dụng desktop cần package.json có script "build" tạo file .exe ' +
            '(electron-builder --win portable, hoặc PyInstaller) — chưa có thì chưa có sản phẩm.',
        );
      }
      const exe = await findExecutable(session.workspace);
      if (!exe) return fail('Dựng xong nhưng không thấy file .exe nào trong dist/, release/, out/ hay build/.');
      log.push(`Sản phẩm: ${path.relative(session.workspace, exe.file)} (${(exe.size / 1_048_576).toFixed(1)} MB)`);

      // Khởi động thật ĐÚNG file sẽ giao và soi giao diện qua DevTools: bản
      // máy tính đầu tiên đẹp nhưng renderer chết ngay ("exports is not
      // defined"), bản thứ hai giao nhầm file trần — QA chỉ chạy unit test nên
      // không ai biết, CEO tải về mới thấy. Portable giải nén vào Temp trước
      // khi mở cửa sổ nên cho 30 giây.
      let smokeShot: string | undefined;
      if (process.platform === 'win32') {
        const smoke = await (deps.smoke ?? smokeTestExecutable)({ file: exe.file, timeoutMs: 30_000 });
        if (signal?.aborted) return cancelled();
        smokeShot = smoke.screenshot;
        log.push(`Khởi động thử ${path.basename(exe.file)}: ${smoke.ok ? 'OK' : 'LỖI'}\n${smoke.detail}`);
        if (!smoke.ok) {
          return fail(
            `Ứng dụng dựng được nhưng khởi động lỗi (${path.basename(exe.file)}):\n${smoke.detail}\n` +
              'Sửa để cửa sổ mở lên không có lỗi JavaScript nào trong console; renderer nạp bằng <script> thường ' +
              'thì phải là mã trình duyệt (không có require/exports), hoặc dùng type="module"/bundler.',
          );
        }
      }
      const url = `${deps.publicUrl}/product/${project.slug}/`;
      const viewUrl = deps.viewUrl ? deps.viewUrl(project.slug) : url;
      // Ảnh cửa sổ thật lúc khởi động thử: CEO nhìn thấy sản phẩm ngay trong tin Telegram,
      // không phải tải về mới biết nó rỗng. Để ngoài thư mục sản phẩm cho khỏi lẫn vào gói.
      let screenshot: string | null = null;
      if (smokeShot) {
        screenshot = path.join(path.dirname(session.workspace), '_anh-san-pham', `${project.slug}.png`);
        await mkdir(path.dirname(screenshot), { recursive: true });
        await writeFile(screenshot, Buffer.from(smokeShot, 'base64'));
      }
      await deps.deployments.setStatus(deployment.id, 'SUCCESS', { url, logExcerpt: tail(log.join('\n'), 20_000) });
      await deps.events.publish(
        'DEPLOY_SUCCESS',
        { deploymentId: deployment.id, environment: 'STAGING', url: viewUrl, screenshot },
        { projectId: project.id },
      );
      return { status: 'SUCCESS', url: viewUrl, file: exe.file };
    }

    const productDir = await resolveProductDir(session.workspace);
    if (!productDir) {
      return fail('Không tìm thấy index.html trong dist/, build/, out/ hay thư mục gốc — chưa có gì để mở.');
    }
    log.push(`Phục vụ từ ${path.relative(session.workspace, productDir) || '.'}`);

    // Trang trỏ tới file TypeScript/JSX mà không qua bước dựng thì trình duyệt
    // chỉ hiện vỏ, không có logic — "sản phẩm" như thế là chưa có sản phẩm.
    if (!built) {
      const entry = unbuiltEntry(await readFile(path.join(productDir, 'index.html'), 'utf8').catch(() => ''));
      if (entry) {
        return fail(
          `index.html trỏ tới "${entry}" là file cần dựng, nhưng package.json không có script "build" ` +
            '(hoặc không có package.json). Cần khôi phục toolchain (ví dụ vite + script build/dev) ' +
            'hoặc trỏ trang tới file JS chạy thẳng được.',
        );
      }
    }

    const url = `${deps.publicUrl}/product/${project.slug}/`;
    const viewUrl = deps.viewUrl ? deps.viewUrl(project.slug) : url;
    await deps.deployments.setStatus(deployment.id, 'SUCCESS', { url, logExcerpt: tail(log.join('\n'), 20_000) });
    await deps.events.publish(
      'DEPLOY_SUCCESS',
      { deploymentId: deployment.id, environment: 'STAGING', url: viewUrl },
      { projectId: project.id },
    );
    return { status: 'SUCCESS', url: viewUrl };
  } finally {
    await session.dispose().catch(() => undefined);
  }
}

/** Đường dẫn script đầu tiên trong HTML cần bước dựng (ts, tsx, jsx, vue, svelte), nếu có. */
/**
 * electron-builder xuất .exe vào thư mục mà chính `build.files` đang gói thì lần
 * dựng sau gói luôn .exe và win-unpacked của lần trước vào app. Bản tắt/mở máy
 * Ví dụ đo thật: app 391,6 MB (trong đó 518 MB là bản dựng cũ trước khi nén), dựng 281 giây.
 * Trả về lý do để giao DevOps sửa, hoặc `null` khi cấu hình ổn.
 */
export function packagingProblem(manifest: unknown): string | null {
  const pkg = manifest as { scripts?: Record<string, string>; build?: { files?: unknown; directories?: { output?: string } } };
  if (!pkg.scripts?.['build']?.includes('electron-builder')) return null;
  const top = (value: string): string => value.replace(/^\.\//, '').replace(/\/+$/, '').split('/')[0] ?? '';
  const output = top(pkg.build?.directories?.output ?? 'dist');
  const patterns = Array.isArray(pkg.build?.files) ? pkg.build.files : [];
  const clash = patterns.find((pattern): pattern is string => typeof pattern === 'string' && !pattern.startsWith('!') && top(pattern) === output);
  if (!clash) return null;
  return (
    `Cấu hình đóng gói sai: "build.files" có "${clash}" nằm trong thư mục xuất "${output}/" của electron-builder, ` +
    'nên mỗi lần dựng gói luôn .exe và win-unpacked của lần trước vào app (app phình hàng trăm MB, dựng lâu dần). ' +
    'Sửa: đặt "build.directories.output" = "release" (tsc vẫn biên dịch vào dist/) rồi dựng lại.'
  );
}

export function unbuiltEntry(html: string): string | null {
  const match = /<script[^>]*\ssrc\s*=\s*["']([^"']+\.(?:tsx?|jsx|vue|svelte))(?:\?[^"']*)?["']/i.exec(html);
  return match ? match[1]! : null;
}

export type ProductArtifact = { kind: 'web'; dir: string } | { kind: 'exe'; file: string; size: number };

/** Sản phẩm của workspace theo loại: web là thư mục có index.html, desktop là file .exe. */
export async function resolveProductArtifact(workspace: string, productType: string): Promise<ProductArtifact | null> {
  if (productType === 'DESKTOP_APPLICATION') {
    const exe = await findExecutable(workspace);
    return exe ? { kind: 'exe', ...exe } : null;
  }
  const dir = await resolveProductDir(workspace);
  return dir ? { kind: 'web', dir } : null;
}

/**
 * Chạy thử một file thực thi. App Electron được mở với cổng DevTools: chờ cửa
 * sổ lên, đọc lỗi JavaScript, đếm phần tử bấm được (trang trống cũng là hỏng).
 * App không có DevTools (PyInstaller…) thì chỉ xét thoát sớm và console.
 */
export async function smokeTestExecutable(options: {
  file: string;
  args?: string[];
  timeoutMs: number;
  /** Mở cổng DevTools (Electron); app thường không hiểu cờ này thì tắt. */
  devtools?: boolean;
}): Promise<{ ok: boolean; detail: string; screenshot?: string }> {
  const port = 9400 + Math.floor(Math.random() * 500);
  const devtools = options.devtools ?? true;
  return new Promise((resolve) => {
    let output = '';
    let exited: number | null = null;
    let settled = false;
    const child = spawn(options.file, [...(options.args ?? []), ...(devtools ? [`--remote-debugging-port=${port}`] : [])], {
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        TEMP: process.env['TEMP'] ?? '',
        TMP: process.env['TMP'] ?? '',
        USERPROFILE: process.env['USERPROFILE'] ?? '',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      windowsHide: true,
    });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (error) => {
      exited = -1;
      output += `\n${error.message}`;
    });
    child.on('exit', (code) => {
      exited = code ?? -1;
    });

    const consoleProblems = (): string[] =>
      output
        .split('\n')
        .filter((line) => /Uncaught |A JavaScript error occurred|Cannot find module|ERROR:|TypeError|ReferenceError/.test(line))
        .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
        .slice(0, 12);
    const finish = (ok: boolean, detail: string, screenshot?: string): void => {
      if (settled) return;
      settled = true;
      if (exited === null) killTree(child.pid);
      resolve(screenshot ? { ok, detail, screenshot } : { ok, detail });
    };

    // Đường DevTools: có trang thì soi trang.
    void (async () => {
      const deadline = Date.now() + options.timeoutMs;
      while (devtools && Date.now() < deadline && !settled && exited === null) {
        const page = await inspectDevtoolsPage(port).catch(() => null);
        if (page) {
          const verdict = judgePage(page, consoleProblems());
          finish(verdict.ok, verdict.detail, page.screenshot);
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    })();

    setTimeout(() => {
      const problems = consoleProblems();
      if (exited !== null && exited !== 0) {
        finish(false, `Thoát sớm với mã ${exited}.\n${problems.join('\n') || tail(output, 1500)}`);
      } else if (problems.length > 0) {
        finish(false, problems.join('\n'));
      } else {
        finish(true, exited === null ? 'Chạy hết thời gian thử, không có lỗi trong console (không có DevTools để soi trang).' : 'Thoát mã 0, không lỗi.');
      }
    }, options.timeoutMs);
  });
}

export interface DevtoolsPage {
  title: string;
  /** Địa chỉ trang đang mở — `data:` nghĩa là app tự dựng trang tạm, không phải giao diện thật. */
  href: string;
  interactive: number;
  textLength: number;
  problems: string[];
  /** Ảnh chụp cửa sổ (PNG base64) để gửi CEO kèm tin "sản phẩm mở được rồi". */
  screenshot?: string;
}

/**
 * Cửa sổ mở lên có phải giao diện thật không. App tắt/mở máy từng lọt qua bản cũ
 * (chỉ chặn trang không nút VÀ dưới 20 ký tự): thiếu file giao diện, app tự nạp một
 * trang `data:` ghi "System active" (36 ký tự) — CEO tải về mới thấy app rỗng.
 */
export function judgePage(
  page: Pick<DevtoolsPage, 'title' | 'href' | 'interactive' | 'problems'>,
  consoleProblems: string[] = [],
): { ok: boolean; detail: string } {
  const problems = [...page.problems, ...consoleProblems];
  if (problems.length > 0) return { ok: false, detail: problems.join('\n') };
  if (/^(data|about):/.test(page.href)) {
    return {
      ok: false,
      detail:
        `Cửa sổ không nạp giao diện thật mà nạp trang tạm (${page.href.slice(0, 60)}…). Thường là file giao diện ` +
        'không nằm trong gói hoặc sai đường dẫn, và mã có trang dự phòng che lỗi. Bỏ trang dự phòng, chép giao diện vào gói.',
    };
  }
  if (page.interactive === 0) {
    return { ok: false, detail: 'Cửa sổ mở nhưng không có nút hay ô nhập nào — người dùng không làm được gì.' };
  }
  return { ok: true, detail: `Cửa sổ "${page.title}" mở, ${page.interactive} phần tử bấm được, không lỗi JavaScript.` };
}

/** Nối vào trang đầu tiên của app qua Chrome DevTools Protocol; không có trang thì null. */
async function inspectDevtoolsPage(port: number): Promise<DevtoolsPage | null> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()) as Array<{
    type: string;
    title: string;
    webSocketDebuggerUrl?: string;
  }>;
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) return null;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('không nối được DevTools'));
  });
  const problems: string[] = [];
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  ws.onmessage = (event) => {
    const data = JSON.parse(String(event.data)) as {
      id?: number;
      method?: string;
      result?: unknown;
      params?: { exceptionDetails?: { text?: string; exception?: { description?: string } }; entry?: { level: string; text: string; url?: string } };
    };
    if (data.id !== undefined && pending.has(data.id)) {
      pending.get(data.id)!(data.result);
      pending.delete(data.id);
    } else if (data.method === 'Runtime.exceptionThrown') {
      problems.push(data.params?.exceptionDetails?.exception?.description ?? data.params?.exceptionDetails?.text ?? 'exception');
    } else if (data.method === 'Log.entryAdded' && data.params?.entry?.level === 'error' && !/Content Security Policy/.test(data.params.entry.text)) {
      // Kèm đường dẫn tệp hỏng: "ERR_FILE_NOT_FOUND" trần khiến DevOps sửa mò hai vòng mà không biết thiếu tệp nào.
      const url = data.params.entry.url ? ` — ${data.params.entry.url}` : '';
      problems.push(`${data.params.entry.text.slice(0, 300)}${url.slice(0, 300)}`);
    }
  };
  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve) => {
      const current = ++id;
      pending.set(current, resolve);
      ws.send(JSON.stringify({ id: current, method, params }));
    });
  try {
    await send('Runtime.enable');
    await send('Log.enable');
    // Đợi renderer chạy xong đoạn khởi tạo rồi mới đếm.
    await new Promise((r) => setTimeout(r, 1500));
    const result = (await send('Runtime.evaluate', {
      expression:
        '({ href: location.href, ready: document.readyState, interactive: document.querySelectorAll("button, input, select, textarea, a[href], [role=button]").length, textLength: (document.body?.innerText ?? "").trim().length })',
      returnByValue: true,
    })) as { result?: { value?: { href: string; interactive: number; textLength: number } } };
    const value = result.result?.value ?? { href: '', interactive: 0, textLength: 0 };
    const shot = (await send('Page.captureScreenshot', { format: 'png' })) as { data?: string } | undefined;
    return {
      title: page.title,
      href: value.href,
      interactive: value.interactive,
      textLength: value.textLength,
      problems: problems.slice(0, 12),
      ...(shot?.data ? { screenshot: shot.data } : {}),
    };
  } finally {
    ws.close();
  }
}

/** Giết cả cây tiến trình (Electron mở nhiều tiến trình con). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // đã thoát
  }
}

/**
 * File .exe giao cho CEO: lớn nhất trong các thư mục kết quả dựng (sâu tối đa
 * 2 cấp), bỏ .blockmap và bỏ hẳn thư mục `*-unpacked` — trong đó là file
 * Electron trần 177MB không chạy được nếu thiếu thư mục đi kèm; CEO từng tải
 * đúng file đó về và thấy "lỗi". Muốn lấy bản unpacked (để chạy thử) thì
 * truyền thẳng thư mục đó trong `roots`.
 */
export async function findExecutable(
  workspace: string,
  roots: readonly string[] = ['dist', 'release', 'out', 'build'],
): Promise<{ file: string; size: number } | null> {
  let best: { file: string; size: number } | null = null;
  const allowUnpacked = roots.some((root) => /unpacked/i.test(root));
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!allowUnpacked && /-unpacked$/i.test(entry.name)) continue;
        if (depth < 2 && entry.name !== 'node_modules') await visit(full, depth + 1);
      } else if (/\.exe$/i.test(entry.name)) {
        const info = await stat(full).catch(() => null);
        if (info && (!best || info.size > best.size)) best = { file: full, size: info.size };
      }
    }
  };
  for (const name of roots) await visit(path.join(workspace, name), 0);
  return best;
}

/** Thư mục có index.html để phục vụ: bản dựng trước, thư mục gốc sau. */
export async function resolveProductDir(workspace: string): Promise<string | null> {
  for (const dir of [...BUILD_DIRS.map((name) => path.join(workspace, name)), workspace]) {
    try {
      await access(path.join(dir, 'index.html'));
      return dir;
    } catch {
      // thử thư mục kế tiếp
    }
  }
  return null;
}

/**
 * Đường dẫn tương đối an toàn bên trong thư mục sản phẩm, hoặc `null` nếu bị
 * từ chối: thoát thư mục, dotfile, node_modules, hay không phải file web.
 */
export function safeProductPath(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  let relative = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  const segments = relative.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.startsWith('.') || segment === 'node_modules') {
      return null;
    }
  }
  if (!SERVABLE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return null;
  return segments.join('/');
}

/**
 * Trang do agent viết trỏ tài nguyên bằng đường dẫn tuyệt đối (`/assets/x.js`,
 * `/src/styles.css`) vì tưởng mình ở gốc tên miền. Ở đây nó nằm dưới
 * `/product/<slug>/`, nên viết lại các đường dẫn đó cho khỏi 404 hàng loạt.
 */
export function rewriteHtml(html: string, prefix: string): string {
  return html
    .replace(/((?:href|src|content|action)\s*=\s*["'])\/(?!\/)/gi, `$1${prefix}`)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}`);
}

/** Đuôi output, bỏ mã màu ANSI của vite/npm để lý do đọc được trên Telegram và trong task. */
function tail(text: string, max: number): string {
  // Ghép regex từ mã ký tự vì ESLint (no-control-regex) không cho ký tự điều khiển trong literal.
  const clean = text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'), '');
  return clean.length <= max ? clean : `…${clean.slice(-max)}`;
}
