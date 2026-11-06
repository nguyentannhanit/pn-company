/**
 * P&N — Đo cảnh 3D lúc chạy: số lệnh vẽ, số đa giác, số nguồn sáng.
 *
 * Vì sao cần: đếm thẻ JSX để đoán chi phí thì luôn sai. Lần đo đầu tiên cho ra
 * 1566 lệnh vẽ nhưng chỉ 70 nghìn tam giác — tức là nút thắt nằm ở SỐ LỆNH VẼ
 * chứ không phải hình học. Không có con số này thì tối ưu sẽ nhắm sai chỗ (§30).
 *
 * Yêu cầu: trang phải chạy ở chế độ phát triển (cửa sau `window.__pnScene` chỉ
 * mở khi NODE_ENV khác production).
 *
 *   node tools/probe-scene.mjs [url]
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import WebSocket from 'ws';

const url = process.argv[2] ?? 'http://localhost:3000/preview/office';
const PORT = 9225;

const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1680,1000',
    '--use-angle=d3d11',
    '--no-first-run',
    '--user-data-dir=' + (process.env['TEMP'] ?? '/tmp') + '/pn-chrome-probe',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function debuggerUrl() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = (await response.json()).find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* Chrome chưa mở xong cổng gỡ lỗi, thử lại */
    }
    await sleep(250);
  }
  throw new Error('Chrome không mở được cổng gỡ lỗi.');
}

try {
  const socket = new WebSocket(await debuggerUrl());
  await new Promise((resolve) => socket.once('open', resolve));

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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    const found = await send('Runtime.evaluate', {
      expression: '!!document.querySelector("canvas")',
      returnByValue: true,
    });
    if (found.result?.value) break;
    await sleep(250);
  }
  // Chờ vài khung hình để renderer.info phản ánh một khung vẽ đầy đủ.
  await sleep(6000);

  const result = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const probe = window.__pnScene;
      if (!probe) return { error: 'chưa có window.__pnScene — trang phải chạy ở chế độ phát triển' };
      const gl = probe.gl;
      const scene = probe.scene;
      let meshes = 0, lights = 0, transparent = 0;
      // Vị trí người đưa việc: kiểm tra họ đi trong hành lang chứ không xuyên tường.
      const couriers = [];
      scene.traverse((object) => {
        if (object.isMesh) {
          meshes += 1;
          if (object.material && object.material.transparent) transparent += 1;
        }
        if (object.isLight) lights += 1;
        if (object.name === 'chibi-walking-' + object.name.split('-')[2]) {
          const parent = object.parent;
          if (parent) {
            couriers.push({
              x: Number(parent.position.x.toFixed(2)),
              z: Number(parent.position.z.toFixed(2)),
              facing: Number(parent.rotation.y.toFixed(2)),
            });
          }
        }
      });
      return {
        drawCalls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        programs: gl.info.programs ? gl.info.programs.length : null,
        textures: gl.info.memory.textures,
        geometries: gl.info.memory.geometries,
        meshes,
        lights,
        transparent,
        couriers,
      };
    })()`,
  });

  process.stdout.write(JSON.stringify(result.result.value, null, 2) + String.fromCharCode(10));
  socket.close();
} finally {
  chrome.kill();
}
