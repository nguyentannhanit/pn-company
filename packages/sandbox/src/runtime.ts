/**
 * P&N — Chạy thử sản phẩm thật cho QA ("QA phải mở sản phẩm và bấm thử").
 *
 * Trước đây QA chỉ chạy `npm test`, `npm run build` rồi đọc chữ trong index.html —
 * 242 lỗi ghi nhận mà không ai từng mở sản phẩm. Ở đây:
 *   - Web: phục vụ thư mục dựng bằng máy chủ tĩnh trong tiến trình, mở bằng trình
 *     duyệt có sẵn trên máy (Edge/Chrome/Chromium của Playwright) ở chế độ không cửa sổ,
 *     đi qua tối đa vài trang, bấm thử các nút, gom lỗi JavaScript / console / request
 *     hỏng, chụp ảnh từng bước.
 *   - Electron: chạy `node_modules/electron/cli.js .` với cổng DevTools, nối vào cửa sổ
 *     đầu tiên, cùng bộ kiểm.
 * Điều khiển qua Chrome DevTools Protocol thuần (WebSocket có sẵn trong Node 22) —
 * không thêm gói, không tải trình duyệt.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { killTree, minimalEnv } from './local.js';

export interface PageReport {
  url: string;
  title: string;
  /** Số nút / ô nhập / link — trang không có gì bấm được là trang hỏng. */
  interactive: number;
  textLength: number;
  /** Nhãn các nút đã bấm thử. */
  clicked: string[];
  problems: string[];
  /** Dấu hiệu đáng ngờ nhưng chưa chắc là lỗi (bấm mà giao diện không đổi) — QA tự xét. */
  warnings?: string[];
  /** Số màn hình khác nhau đã đi qua (tính cả màn đầu) — ứng dụng một trang đổi màn không đổi URL. */
  screens?: number;
}

export interface RuntimeReport {
  kind: 'web' | 'electron';
  ok: boolean;
  /** Không chạy thử được vì máy thiếu trình duyệt/Electron — QA không được coi là lỗi sản phẩm. */
  skipped?: boolean;
  pages: PageReport[];
  screenshots: string[];
  /** Bằng chứng cho QA đọc: từng trang, nút đã bấm, lỗi gặp. */
  detail: string;
}

export interface ProbeOptions {
  /** Thư mục ghi ảnh chụp `qa-1.png`, `qa-2.png`… */
  screenshotDir: string;
  maxPages?: number;
  maxClicks?: number;
  /** Đường dẫn trình duyệt; mặc định tự tìm. */
  browser?: string | null;
}

const CLICKABLE = 'button, [role=button], input[type=submit], input[type=button]';
const SUMMARY_JS =
  '({ href: location.href, title: document.title, interactive: document.querySelectorAll("button, input, select, textarea, a[href], [role=button]").length, textLength: (document.body?.innerText ?? "").trim().length })';
/**
 * Điền ô nhập đang hiện mà còn trống (chữ: "Minh", số: 3, email/điện thoại mẫu) bằng setter gốc + sự kiện input/change
 * để cả app thuần lẫn React nhận. Bỏ ô mật khẩu, ô ẩn, ô khoá.
 */
const FILL_INPUTS_JS = `(() => { let n = 0; for (const el of document.querySelectorAll('input:not([type]), input[type=text], input[type=search], input[type=number], input[type=email], input[type=tel], textarea')) {
  const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0 || el.disabled || el.readOnly || el.value) continue;
  const value = el.type === 'number' ? '3' : el.type === 'email' ? 'minh@example.com' : el.type === 'tel' ? '0900000000' : 'Minh';
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); n += 1;
} return n; })()`;
/** Nút lùi / thoát / xoá — bấm sau cùng để đi được sâu vào ứng dụng trước. */
const BACK_LABEL = /quay l[aạ]i|trở v[eề]|thoát|hu[ỷy]|xo[áa]|đóng|back|cancel|exit|close|delete/i;
const CLICKABLES_JS = `[...document.querySelectorAll('${CLICKABLE}')].slice(0, 40).map((el, i) => ({ i, text: String(el.innerText || el.value || el.getAttribute('aria-label') || el.id || el.tagName).trim().slice(0, 40) }))`;
const LINKS_JS =
  "[...new Set([...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin) && !h.includes('#')))].slice(0, 6)";

/* -------------------------------------------------------------------------- */
/* Trình duyệt trên máy                                                        */
/* -------------------------------------------------------------------------- */

/** Trình duyệt Chromium có sẵn: biến PN_BROWSER, rồi Edge, Chrome, rồi Chromium của Playwright. */
export function findBrowser(): string | null {
  const fromEnv = process.env['PN_BROWSER'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  // Playwright cài Chromium vào ~/AppData/Local/ms-playwright/chromium-<n>/chrome-win*/chrome.exe.
  const playwright = path.join(home, process.platform === 'win32' ? 'AppData/Local/ms-playwright' : '.cache/ms-playwright');
  try {
    for (const dir of readdirSync(playwright)) {
      if (!dir.startsWith('chromium-')) continue;
      for (const sub of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const file = path.join(playwright, dir, sub);
        if (existsSync(file)) return file;
      }
    }
  } catch {
    /* không có thư mục Playwright */
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Máy chủ tĩnh                                                                */
/* -------------------------------------------------------------------------- */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

/** Phục vụ một thư mục dựng trên 127.0.0.1 cổng trống; đường dẫn lạ trả index.html (ứng dụng một trang). */
export async function serveStatic(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
    let file = path.resolve(root, `.${pathname}`);
    if (!file.startsWith(root)) file = path.join(root, 'index.html');
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    } catch {
      // Không có tệp: tài nguyên (có đuôi) thì 404 để QA thấy thiếu; đường dẫn trang thì trả index.html.
      if (path.extname(pathname)) {
        response.writeHead(404).end();
        return;
      }
      file = path.join(root, 'index.html');
    }
    try {
      const bytes = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/* -------------------------------------------------------------------------- */
/* Chrome DevTools Protocol                                                    */
/* -------------------------------------------------------------------------- */

type CdpEvent = { method?: string; id?: number; result?: unknown; error?: { message: string }; params?: Record<string, unknown> };

/** Một kết nối tới một trang; gom lỗi JavaScript, console, request hỏng vào `problems`. */
class CdpPage {
  readonly problems: string[] = [];
  #id = 0;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #waiters = new Map<string, Array<() => void>>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => this.#onMessage(JSON.parse(String(event.data)) as CdpEvent);
  }

  /** Đợi tới khi cổng DevTools có một trang rồi nối vào trang đó. */
  static async connect(port: number, timeoutMs: number): Promise<CdpPage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()) as Array<{
          type: string;
          webSocketDebuggerUrl?: string;
        }>;
        const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
        if (target?.webSocketDebuggerUrl) {
          const ws = new WebSocket(target.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('không nối được DevTools'));
          });
          const page = new CdpPage(ws);
          await page.send('Page.enable');
          await page.send('Runtime.enable');
          await page.send('Log.enable');
          await page.send('Network.enable');
          return page;
        }
      } catch {
        /* chưa lên */
      }
      await sleep(400);
    }
    throw new Error(`Trình duyệt không mở cổng DevTools ${port} sau ${Math.round(timeoutMs / 1000)} giây`);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Đợi một sự kiện (ví dụ trang tải xong); quá giờ thì thôi, không ném. */
  waitFor(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.#waiters.get(method) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#waiters.set(method, list);
    });
  }

  async evaluate<T>(expression: string): Promise<T | null> {
    const result = (await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as {
      result?: { value?: T };
      exceptionDetails?: unknown;
    };
    return result.result?.value ?? null;
  }

  async screenshot(file: string): Promise<boolean> {
    const shot = (await this.send('Page.captureScreenshot', { format: 'png' }).catch(() => null)) as { data?: string } | null;
    if (!shot?.data) return false;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    return true;
  }

  close(): void {
    this.ws.close();
  }

  #onMessage(data: CdpEvent): void {
    if (data.id !== undefined && this.#pending.has(data.id)) {
      const { resolve, reject } = this.#pending.get(data.id)!;
      this.#pending.delete(data.id);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result);
      return;
    }
    const params = data.params ?? {};
    switch (data.method) {
      case 'Runtime.exceptionThrown': {
        const details = params['exceptionDetails'] as { text?: string; exception?: { description?: string } } | undefined;
        this.problems.push(`Lỗi JavaScript: ${(details?.exception?.description ?? details?.text ?? 'exception').split('\n')[0]!.slice(0, 300)}`);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        if (params['type'] !== 'error') break;
        const args = (params['args'] as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
        this.problems.push(`console.error: ${args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ').slice(0, 300)}`);
        break;
      }
      case 'Log.entryAdded': {
        const entry = params['entry'] as { level: string; text: string } | undefined;
        // "Failed to load resource" đã có dòng HTTP tương ứng; không ghi hai lần.
        if (entry?.level === 'error' && !/Content Security Policy|Failed to load resource/.test(entry.text)) this.problems.push(`console: ${entry.text.slice(0, 300)}`);
        break;
      }
      case 'Network.loadingFailed': {
        const text = String(params['errorText'] ?? '');
        if (!/ERR_ABORTED/.test(text)) this.problems.push(`Tải hỏng: ${text}`);
        break;
      }
      case 'Network.responseReceived': {
        const response = params['response'] as { status: number; url: string } | undefined;
        // favicon thiếu là chuyện thường của trang mẫu, không phải lỗi sản phẩm.
        if (response && response.status >= 400 && !/favicon\.ico$/.test(response.url)) this.problems.push(`HTTP ${response.status}: ${response.url.slice(0, 200)}`);
        break;
      }
      default:
        break;
    }
    const waiters = data.method ? this.#waiters.get(data.method) : undefined;
    if (waiters) {
      this.#waiters.delete(data.method!);
      for (const waiter of waiters) waiter();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Đi thử một trang                                                            */
/* -------------------------------------------------------------------------- */

interface Summary {
  href: string;
  title: string;
  interactive: number;
  textLength: number;
}

/** Xem trang đang mở: tóm tắt, bấm thử tối đa `maxClicks` nút, ghi lỗi phát sinh, chụp ảnh trước/sau. */
async function exercisePage(page: CdpPage, shots: string[], shotDir: string, maxClicks: number, before: number): Promise<PageReport> {
  await sleep(800);
  const summary = (await page.evaluate<Summary>(SUMMARY_JS)) ?? { href: '', title: '', interactive: 0, textLength: 0 };
  if (shots.length < 4 && (await page.screenshot(path.join(shotDir, `qa-${shots.length + 1}.png`)))) shots.push(path.join(shotDir, `qa-${shots.length + 1}.png`));

  // Bấm bằng chuột thật qua DevTools (di, nhấn, nhả tại tâm nút) chứ không `el.click()`: app bắt
  // pointerdown/mousedown thì click giả không kích được gì — từng có app bấm 12 nút mà màn hình vẫn "0".
  // Đi như người dùng: mỗi bước điền ô nhập còn trống, đọc lại các nút của màn đang hiện, bấm nút chưa thử ở màn này
  // (nút lùi/thoát để sau). Trước đây chỉ bấm lần lượt các nút của màn đầu với ô tên để trống — app bị QA
  // báo "kẹt ở một màn" dù app chỉ đúng mực không cho chơi khi chưa nhập tên.
  const clicked: string[] = [];
  const textBefore = (await page.evaluate<string>('document.body?.innerText ?? ""')) ?? '';
  const screens = new Set<string>([textBefore]);
  const tried = new Set<string>();
  for (let step = 0; step < maxClicks; step += 1) {
    await page.evaluate(FILL_INPUTS_JS);
    const buttons = (await page.evaluate<Array<{ i: number; text: string }>>(CLICKABLES_JS)) ?? [];
    const screen = buttons.map((button) => button.text).join('|');
    const next = [...buttons]
      .sort((a, b) => Number(BACK_LABEL.test(a.text)) - Number(BACK_LABEL.test(b.text)))
      .find((button) => !tried.has(`${screen}#${button.text}`));
    if (!next) break;
    tried.add(`${screen}#${next.text}`);
    const at = await page.evaluate<{ x: number; y: number } | null>(
      `(() => { const el = document.querySelectorAll('${CLICKABLE}')[${next.i}]; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) return null; return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    );
    if (!at) continue;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    clicked.push(next.text || `nút #${next.i + 1}`);
    await sleep(350);
    screens.add((await page.evaluate<string>('document.body?.innerText ?? ""')) ?? '');
  }
  const textAfter = (await page.evaluate<string>('document.body?.innerText ?? ""')) ?? '';
  if (clicked.length > 0 && shots.length < 4 && (await page.screenshot(path.join(shotDir, `qa-${shots.length + 1}.png`)))) {
    shots.push(path.join(shotDir, `qa-${shots.length + 1}.png`));
  }
  // Không tự đánh rớt (nút mở hộp thoại ngoài trang cũng không đổi chữ) — ghi cảnh báo để QA tự xét.
  const warnings =
    clicked.length >= 3 && textAfter === textBefore
      ? [`Bấm thử ${clicked.length} nút nhưng chữ trên trang không đổi gì — nút có thể chưa nối vào xử lý.`]
      : [];
  return {
    url: summary.href,
    title: summary.title,
    interactive: summary.interactive,
    textLength: summary.textLength,
    clicked,
    problems: page.problems.slice(before),
    warnings,
    screens: screens.size,
  };
}

function verdict(kind: RuntimeReport['kind'], pages: PageReport[], screenshots: string[], extra: string[] = []): RuntimeReport {
  const first = pages[0];
  const problems = [...extra, ...pages.flatMap((page) => page.problems)];
  const failures: string[] = [];
  if (!first) failures.push('Không mở được trang nào.');
  else {
    if (/^(data|about):/.test(first.url)) failures.push(`Cửa sổ nạp trang tạm (${first.url.slice(0, 60)}) chứ không phải giao diện thật.`);
    if (first.interactive === 0) failures.push('Trang đầu không có nút hay ô nhập nào — người dùng không làm được gì.');
    if (first.textLength === 0) failures.push('Trang đầu trống, không có chữ nào.');
  }
  const ok = failures.length === 0 && problems.length === 0;
  const lines = pages.map(
    (page, index) =>
      `Trang ${index + 1}: ${page.url || '(không rõ)'} — "${page.title}", ${page.interactive} phần tử bấm được, ${page.textLength} ký tự.` +
      (page.clicked.length ? `\n  Đã bấm thử: ${page.clicked.join(' · ')}` : '') +
      (page.screens && page.screens > 1 ? `\n  Đã đi qua ${page.screens} màn hình khác nhau.` : '') +
      (page.warnings?.length ? `\n  CẢNH BÁO: ${page.warnings.join(' ')}` : '') +
      (page.problems.length ? `\n  LỖI:\n  - ${page.problems.join('\n  - ')}` : '\n  Không lỗi.'),
  );
  const detail = [...failures.map((line) => `LỖI: ${line}`), ...extra.map((line) => `LỖI: ${line}`), ...lines].join('\n');
  return { kind, ok, pages, screenshots, detail };
}

/* -------------------------------------------------------------------------- */
/* Web                                                                         */
/* -------------------------------------------------------------------------- */

/** Thư mục có index.html để mở: dist/build/out trước, rồi gốc workspace. */
export async function findProductDir(workspace: string): Promise<string | null> {
  for (const dir of ['dist', 'build', 'out', '.']) {
    const candidate = path.join(workspace, dir);
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** Mở thư mục web đã dựng bằng trình duyệt không cửa sổ, đi vài trang, bấm thử, chụp ảnh. */
export async function probeWeb(productDir: string, options: ProbeOptions): Promise<RuntimeReport> {
  const browser = options.browser === undefined ? findBrowser() : options.browser;
  if (!browser) return { kind: 'web', ok: true, skipped: true, pages: [], screenshots: [], detail: 'Bỏ qua chạy thử: máy không có trình duyệt Chromium (Edge/Chrome).' };

  const server = await serveStatic(productDir);
  const port = 9600 + Math.floor(Math.random() * 300);
  const profile = await mkdtemp(path.join(tmpdir(), 'pn-qa-'));
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--window-size=1280,800',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { env: minimalEnv(), windowsHide: true, stdio: 'ignore' },
  );
  const shots: string[] = [];
  const pages: PageReport[] = [];
  let page: CdpPage | null = null;
  try {
    page = await CdpPage.connect(port, 20_000);
    const visit = async (url: string, clicks: number): Promise<void> => {
      // Đếm lỗi từ lúc bắt đầu nạp: 404 tài nguyên, tải hỏng xảy ra trước khi trang sẵn sàng.
      const before = page!.problems.length;
      const loaded = page!.waitFor('Page.loadEventFired', 15_000);
      const nav = (await page!.send('Page.navigate', { url })) as { errorText?: string };
      if (nav.errorText) page!.problems.push(`Không mở được ${url}: ${nav.errorText}`);
      await loaded;
      pages.push(await exercisePage(page!, shots, options.screenshotDir, clicks, before));
    };
    await visit(server.url, options.maxClicks ?? 12);
    const links = (await page.evaluate<string[]>(LINKS_JS)) ?? [];
    for (const link of links.slice(0, (options.maxPages ?? 5) - 1)) {
      if (link.replace(/\/$/, '') === server.url.replace(/\/$/, '')) continue;
      await visit(link, 4);
    }
    return verdict('web', pages, shots);
  } catch (error) {
    return verdict('web', pages, shots, [`Không chạy thử được: ${error instanceof Error ? error.message : String(error)}`]);
  } finally {
    page?.close();
    await stopProcess(child);
    await server.close();
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* -------------------------------------------------------------------------- */
/* Electron                                                                    */
/* -------------------------------------------------------------------------- */

/** Mở ứng dụng Electron chưa đóng gói từ workspace (cần `npm install` xong) và soi cửa sổ đầu tiên. */
export async function probeElectron(workspace: string, options: ProbeOptions): Promise<RuntimeReport> {
  const cli = path.join(workspace, 'node_modules', 'electron', 'cli.js');
  if (!existsSync(cli)) {
    return { kind: 'electron', ok: true, skipped: true, pages: [], screenshots: [], detail: 'Bỏ qua chạy thử: chưa cài electron trong node_modules.' };
  }
  const port = 9600 + Math.floor(Math.random() * 300);
  let output = '';
  const child = spawn(process.execPath, [cli, '.', `--remote-debugging-port=${port}`], {
    cwd: workspace,
    env: { ...minimalEnv(), ELECTRON_ENABLE_LOGGING: '1' },
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const shots: string[] = [];
  const pages: PageReport[] = [];
  let page: CdpPage | null = null;
  try {
    page = await CdpPage.connect(port, 30_000);
    await sleep(1500);
    pages.push(await exercisePage(page, shots, options.screenshotDir, options.maxClicks ?? 12, 0));
    const consoleProblems = output
      .split('\n')
      .filter((line) => /Uncaught |A JavaScript error occurred|Cannot find module|ERROR:|TypeError|ReferenceError/.test(line))
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, '').trim())
      .slice(0, 12);
    return verdict('electron', pages, shots, consoleProblems);
  } catch (error) {
    const tail = output.trim().split('\n').slice(-15).join('\n');
    return verdict('electron', pages, shots, [`Không mở được ứng dụng: ${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ''}`]);
  } finally {
    page?.close();
    await stopProcess(child);
  }
}

/**
 * Chạy thử sản phẩm trong workspace theo thứ tự: Electron (package.json có electron) rồi web
 * (thư mục có index.html). Không có gì chạy được thì `null` — QA nghiệm thu như cũ.
 */
export async function probeProduct(workspace: string, options: ProbeOptions): Promise<RuntimeReport | null> {
  if (!workspace) return null;
  await rm(options.screenshotDir, { recursive: true, force: true }).catch(() => undefined);
  const manifest = await readFile(path.join(workspace, 'package.json'), 'utf8').catch(() => null);
  if (manifest && /"electron"\s*:/.test(manifest)) return probeElectron(workspace, options);
  const dir = await findProductDir(workspace);
  if (dir) return probeWeb(dir, options);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.pid) killTree(child.pid);
  await sleep(200);
}

/** Ảnh QA đã chụp trong thư mục, theo thứ tự tên. */
export async function listScreenshots(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith('.png')).sort().map((name) => path.join(dir, name));
}
