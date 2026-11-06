/**
 * P&N — Chụp ảnh màn hình một trang của dashboard.
 *
 * Vì sao tự viết thay vì cài Playwright: chỉ cần đúng một việc là "mở trang,
 * đợi phần tử xuất hiện, chụp lại", và Chrome đã có sẵn trên máy. Dùng thẳng
 * giao thức DevTools qua WebSocket thì không phải tải thêm ~300MB trình duyệt.
 *
 * Cách dùng:
 *   node tools/screenshot.mjs <url> <đường-dẫn-ảnh> [selector-chờ] [ms-chờ-thêm]
 *
 * Ví dụ:
 *   node tools/screenshot.mjs http://127.0.0.1:3000/preview/office /tmp/office.png canvas 4000
 */

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

const [url, output, waitFor = 'body', extraWaitMs = '3000'] = process.argv.slice(2);

if (!url || !output) {
  console.error('Cách dùng: node tools/screenshot.mjs <url> <ảnh.png> [selector] [ms]');
  process.exit(1);
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const WIDTH = Number(process.env['SHOT_WIDTH'] ?? 1680);
const HEIGHT = Number(process.env['SHOT_HEIGHT'] ?? 1000);
const PORT = 9223;

/** Tìm trình duyệt đầu tiên có trên máy. */
async function findBrowser() {
  const { existsSync } = await import('node:fs');
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (!found) throw new Error('Không tìm thấy Chrome hoặc Edge trên máy này.');
  return found;
}

/** Đợi Chrome mở xong cổng gỡ lỗi rồi lấy địa chỉ WebSocket của tab. */
async function waitForDebugger() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chưa sẵn sàng, thử lại */
    }
    await sleep(250);
  }
  throw new Error('Chrome không mở được cổng gỡ lỗi.');
}

/** Bọc giao thức DevTools thành hàm gọi lệnh có await. */
function createClient(socket) {
  let nextId = 1;
  const pending = new Map();

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });

  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`Quá hạn khi gọi ${method}`));
      }, 60_000);
    });
}

async function main() {
  const browser = await findBrowser();

  const chrome = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--window-size=${WIDTH},${HEIGHT}`,
      // Dùng GPU thật nếu máy có; SHOT_SOFTWARE=1 để ép kết xuất bằng CPU
      // (chậm hơn hàng chục lần, chỉ dùng khi máy không có GPU).
      ...(process.env['SHOT_SOFTWARE'] === '1'
        ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
        : ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist']),
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--user-data-dir=' + (process.env['TEMP'] ?? '/tmp') + '/pn-chrome-profile',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );

  const errors = [];
  let socket;

  try {
    const wsUrl = await waitForDebugger();
    socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const send = createClient(socket);

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    // Gom lỗi console để biết trang có hỏng gì không, thay vì chỉ nhìn ảnh trắng.
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails?.exception?.description ?? 'lỗi không rõ');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        errors.push(message.params.entry.text);
      }
    });

    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Trang trong dashboard đòi đăng nhập. Đặt sẵn token vào localStorage TRƯỚC
    // khi trang chạy, nếu không React sẽ đẩy về /login trước cả khi ta kịp ghi.
    if (process.env['SHOT_TOKEN']) {
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { localStorage.setItem('pn.session.token', ${JSON.stringify(process.env['SHOT_TOKEN'])}); } catch {}`,
      });
    }

    await send('Page.navigate', { url });

    // Đợi phần tử cần thiết xuất hiện — quan trọng với cảnh 3D vì canvas chỉ
    // được tạo sau khi React hydrate và tải xong chunk động.
    let appeared = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const result = await send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(waitFor)})`,
        returnByValue: true,
      });
      if (result.result?.value === true) {
        appeared = true;
        break;
      }
      await sleep(250);
    }

    if (!appeared) {
      console.warn(`Không thấy phần tử "${waitFor}" — vẫn chụp để xem trang đang hiện gì.`);
    }

    // Chờ thêm để WebGL vẽ xong vài khung hình đầu.
    await sleep(Number(extraWaitMs));

    // Chụp được cả những gì chỉ hiện ra sau khi bấm (ngăn kéo, hộp thoại).
    if (process.env['SHOT_CLICK']) {
      const clicked = await send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector(${JSON.stringify(process.env['SHOT_CLICK'])}); if (!el) return false; el.click(); return true; })()`,
        returnByValue: true,
      });
      if (clicked.result?.value !== true) {
        console.warn(`Không tìm thấy "${process.env['SHOT_CLICK']}" để bấm.`);
      }
      await sleep(1500);
    }

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(output, Buffer.from(shot.data, 'base64'));

    console.log(`Đã lưu ${output}`);
    if (errors.length > 0) {
      console.log(`\n${errors.length} lỗi phía trình duyệt:`);
      for (const error of errors.slice(0, 10)) console.log(`  - ${String(error).slice(0, 300)}`);
    }
  } finally {
    socket?.close();
    chrome.kill();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
