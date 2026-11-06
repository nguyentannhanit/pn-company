// P&N — Bộ canh: giữ cho công ty luôn vào được từ điện thoại.
//
// Hai hỏng hóc đã gặp thật:
//   - Cloudflare xoá đường hầm miễn phí, địa chỉ ngoài chết dù máy vẫn chạy.
//   - API/web/bot chết theo cửa sổ đã bật chúng; nút "Mở P&N" bấm không phản hồi.
// Nên mỗi 30 giây kiểm tra hai tầng: dịch vụ ngay trên máy, và địa chỉ nhìn từ ngoài.
// Hỏng hai lần liên tiếp mới xử lý (một cú rớt mạng thoáng qua không đáng đổi địa chỉ).
// Chạy: node --env-file-if-exists=.env tools/tunnel-watch.mjs
/* global AbortSignal */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const EVERY_MS = 30_000;
const TIMEOUT_MS = 20_000;
/** Bật lại dịch vụ là việc nặng; không làm dày hơn 10 phút một lần. */
const RESTART_COOLDOWN_MS = 10 * 60_000;

let localFailures = 0;
let publicFailures = 0;
let lastRestartAt = 0;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);

function addresses() {
  try {
    const values = Object.fromEntries(
      readFileSync('logs/tunnel.env', 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.includes('='))
        .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
    );
    const api = values.API_PUBLIC_URL ?? null;
    const web = values.WEB_TUNNEL_ORIGIN ?? null;
    // Dia chi may chu cap phat (api.trycloudflare.com) tung bi ghi nham lam dia chi duong ham.
    // Duong ham tam: <ten>.trycloudflare.com. Duong ham co ten (link co dinh): ten mien rieng cua CEO, API o api.<ten mien>.
    const isQuick = (u) => typeof u === 'string' && /^https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/.test(u);
    const isNamed = (u) => typeof u === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(u) && !/\.trycloudflare\.com$/.test(u);
    const valid = (u) => isQuick(u) || isNamed(u);
    return { api: valid(api) && api !== web ? api : null, web: valid(web) ? web : null };
  } catch {
    return { api: null, web: null };
  }
}

/** Tien trinh cloudflared ghi trong pid file con song khong. */
function tunnelAlive(name) {
  try {
    const pid = Number(readFileSync(`logs/tunnel-${name}.pid`, 'utf8').trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    return response.status > 0 && response.status < 500;
  } catch {
    return false;
  }
}

function run(what, command, args) {
  log(what);
  const result = spawnSync(command, args, { encoding: 'utf8' });
  const output = (result.stdout ?? '').trim() || (result.stderr ?? '').trim();
  if (output) log(output);
}

/** Mở lại đường hầm rồi báo địa chỉ mới qua Telegram và chỉnh nút "Mở P&N". */
function reopenTunnels() {
  run('mở lại đường hầm…', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/tunnel.ps1']);
  run('báo địa chỉ mới…', process.execPath, ['--env-file-if-exists=.env', 'tools/tunnel-notify.mjs']);
}

/**
 * Dịch vụ trên máy chết thì bật lại bằng chính script khởi động. Không gọi
 * stop.ps1 vì nó giết luôn bộ canh này; start.ps1 thấy bộ canh còn sống sẽ
 * không bật thêm cái thứ hai.
 */
function restartServices() {
  lastRestartAt = Date.now();
  run('dịch vụ trên máy chết, bật lại…', 'powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'install/start.ps1']);
}

log(`bắt đầu canh mỗi ${EVERY_MS / 1000} giây`);
for (;;) {
  const [apiLocal, webLocal] = await Promise.all([
    reachable('http://127.0.0.1:4000/health'),
    reachable('http://127.0.0.1:3000/login'),
  ]);

  if (apiLocal && webLocal) {
    localFailures = 0;
    const { api, web } = addresses();
    if (!api || !web || !tunnelAlive('api') || !tunnelAlive('web')) {
      publicFailures += 1;
      log(`đường hầm không hợp lệ hoặc đã chết: api=${api} web=${web} (lần ${publicFailures})`);
    } else {
      const [apiOk, webOk] = await Promise.all([reachable(`${api}/health`), reachable(`${web}/login`)]);
      publicFailures = apiOk && webOk ? 0 : publicFailures + 1;
      if (!apiOk || !webOk) log(`địa chỉ ngoài hỏng: api=${apiOk} web=${webOk} (lần ${publicFailures})`);
    }
    if (publicFailures >= 2) {
      reopenTunnels();
      publicFailures = 0;
    }
  } else {
    localFailures += 1;
    publicFailures = 0;
    log(`dịch vụ trên máy hỏng: api=${apiLocal} web=${webLocal} (lần ${localFailures})`);
    if (localFailures >= 2 && Date.now() - lastRestartAt > RESTART_COOLDOWN_MS) {
      restartServices();
      localFailures = 0;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
}
