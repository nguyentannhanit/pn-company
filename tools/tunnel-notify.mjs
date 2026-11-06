// Báo CEO qua Telegram khi địa chỉ đường hầm đổi (sau khi tools/tunnel.ps1 chạy).
// Gửi kèm link mở dashboard với `?api=` để app trên điện thoại tự nhớ địa chỉ API mới.
// Chạy: node --env-file-if-exists=.env tools/tunnel-notify.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('logs/tunnel.env', 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => line.split('=', 2)),
);
const api = env.API_PUBLIC_URL;
const web = process.env.WEB_PUBLIC_ORIGIN_STABLE || env.WEB_TUNNEL_ORIGIN;
if (!api || !web) {
  console.log('tunnel.env thieu dia chi');
  process.exit(1);
}

const last = existsSync('logs/tunnel.last') ? readFileSync('logs/tunnel.last', 'utf8').trim() : '';
const current = `${api}|${web}`;
if (last === current) {
  console.log('dia chi khong doi, khong bao');
  process.exit(0);
}

// Mất mạng thì báo một dòng và thoát 1; bộ canh gọi lại ở nhịp sau.
process.on('unhandledRejection', (error) => {
  console.log('khong bao duoc:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const secret = process.env.PN_SERVICE_SECRET ?? '';
const boot = await fetch('http://127.0.0.1:4000/internal/telegram/bootstrap', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-pn-service-secret': secret },
  body: '{}',
});
if (!boot.ok) {
  console.log('API chua san sang de lay cau hinh Telegram:', boot.status);
  process.exit(1);
}
const { botToken, allowedChatIds } = await boot.json();
const link = `${web}/login?api=${encodeURIComponent(api)}`;
const text = [
  '<b>P&amp;N — địa chỉ truy cập từ ngoài</b>',
  '',
  `Mở dashboard: ${link}`,
  '',
  'Hoặc bấm nút "Mở P&N" cạnh ô nhập trong bot — nút đó luôn trỏ đúng địa chỉ hiện tại và tự đăng nhập, không bao giờ chết link.',
  'Cài thành app: mở bằng Chrome → menu ⋮ → "Thêm vào màn hình chính". Nếu đã cài từ link cũ thì cài lại từ link này (app gắn với địa chỉ web).',
].join('\n');

for (const chatId of allowedChatIds ?? []) {
  // Nút menu cạnh ô nhập phải trỏ địa chỉ mới, nếu không CEO bấm vào link chết.
  const menu = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, menu_button: { type: 'web_app', text: 'Mở P&N', web_app: { url: `${web}/login` } } }),
  });
  console.log('menu', chatId, 'HTTP', menu.status);

  const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  console.log('chat', chatId, 'HTTP', r.status);
}
writeFileSync('logs/tunnel.last', current);
