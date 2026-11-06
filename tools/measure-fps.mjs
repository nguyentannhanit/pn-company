/**
 * P&N — Đo số khung hình mỗi giây của cảnh 3D (§30).
 *
 * §30 đặt yêu cầu hiệu năng cho văn phòng 3D. Đoán bằng mắt thì không kiểm
 * chứng được, nên script này mở trang bằng Chrome headless, đếm khung hình thật
 * trong vài giây, và báo cả số lượng đối tượng trong cảnh.
 *
 * Lưu ý khi đọc kết quả: headless dùng SwiftShader (kết xuất bằng CPU), nên con
 * số ở đây là **cận dưới bi quan**. Máy có GPU thật sẽ cao hơn nhiều.
 *
 *   node tools/measure-fps.mjs <url> [số-giây]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

const [url, seconds = '5'] = process.argv.slice(2);
if (!url) {
  console.error('Cách dùng: node tools/measure-fps.mjs <url> [số-giây]');
  process.exit(1);
}

const PORT = 9224;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function debuggerUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await response.json()).find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* chưa sẵn sàng */
    }
    await sleep(250);
  }
  throw new Error('Chrome không mở được cổng gỡ lỗi.');
}

function rpc(socket) {
  let id = 1;
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
      const current = id++;
      pending.set(current, { resolve, reject });
      socket.send(JSON.stringify({ id: current, method, params }));
    });
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1680,1000',
    // Mặc định dùng GPU thật nếu có; đặt SHOT_SOFTWARE=1 để ép kết xuất CPU.
    ...(process.env['SHOT_SOFTWARE'] === '1'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist']),
    '--no-first-run',
    '--user-data-dir=' + (process.env['TEMP'] ?? '/tmp') + '/pn-chrome-fps',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  const socket = new WebSocket(await debuggerUrl());
  await new Promise((resolve) => socket.once('open', resolve));
  const send = rpc(socket);

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });

  // Đợi canvas xuất hiện rồi mới bắt đầu đếm.
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = await send('Runtime.evaluate', {
      expression: '!!document.querySelector("canvas")',
      returnByValue: true,
    });
    if (found.result?.value) break;
    await sleep(250);
  }
  // Bỏ qua vài giây đầu: lúc đó còn đang biên dịch shader và tải texture.
  await sleep(4000);

  const measure = await send('Runtime.evaluate', {
    awaitPromise: true,
    returnByValue: true,
    expression: `
      new Promise((resolve) => {
        let frames = 0;
        const started = performance.now();
        const tick = () => {
          frames += 1;
          if (performance.now() - started < ${Number(seconds) * 1000}) requestAnimationFrame(tick);
          else resolve({ frames, ms: performance.now() - started });
        };
        requestAnimationFrame(tick);
      })
    `,
  });

  const { frames, ms } = measure.result.value;
  const fps = (frames / ms) * 1000;

  console.log(`FPS trung bình: ${fps.toFixed(1)} (${frames} khung trong ${(ms / 1000).toFixed(1)}s)`);
  const renderer = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: "(() => { const gl = document.querySelector('canvas')?.getContext('webgl2'); if (!gl) return 'không có WebGL'; const info = gl.getExtension('WEBGL_debug_renderer_info'); return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'không đọc được'; })()",
  });
  console.log('Kết xuất bởi:', renderer.result.value);

  socket.close();
} finally {
  chrome.kill();
}
