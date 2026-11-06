// Đặt lại mật khẩu cho một tài khoản dashboard, chạy trực tiếp trên máy công ty.
// Mật khẩu gõ tại chỗ (không hiện ra màn hình), băm bằng đúng hàm của API rồi ghi
// vào bảng users. Không lưu mật khẩu ở bất kỳ đâu.
// Chạy: node --env-file=.env tools/dat-lai-mat-khau.mjs   (hoặc bấm đúp doi-mat-khau.cmd)
import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createRequire } from 'node:module';

import { hashPassword } from '../apps/api/dist/plugins/auth.js';

const { Client } = createRequire(import.meta.url)('pg');

const db = new Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const accounts = await db.query('SELECT email, display_name, role FROM users ORDER BY created_at');
console.log('Tài khoản hiện có:');
for (const row of accounts.rows) console.log(`  - ${row.email} (${row.display_name}, ${row.role})`);

// Đọc từng dòng qua async iterator: dòng đến sớm được giữ lại chứ không rơi mất,
// hết đầu vào thì trả rỗng — nên chạy được cả khi gõ tay lẫn khi nhận qua ống.
const rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
const lines = rl[Symbol.asyncIterator]();
let muted = false;
rl._writeToOutput = function (text) {
  // Khi đang nhập mật khẩu chỉ hiện dấu * thay vì ký tự thật.
  if (muted && !text.includes('\n')) this.output.write('*');
  else this.output.write(text);
};
const ask = async (question, hidden = false) => {
  stdout.write(question);
  muted = hidden;
  const next = await lines.next();
  muted = false;
  if (hidden) stdout.write('\n');
  return next.done ? '' : next.value.trim();
};

const quit = async (message, code) => {
  console.log(message);
  rl.close();
  await db.end();
  process.exit(code);
};

const first = accounts.rows[0]?.email ?? '';
const email = (await ask(`Email cần đặt lại [${first}]: `)) || first;
if (!accounts.rows.some((row) => row.email === email)) await quit('Không tìm thấy tài khoản với email này. Không thay đổi gì.', 1);

const password = await ask('Mật khẩu mới (tối thiểu 8 ký tự): ', true);
const again = await ask('Gõ lại mật khẩu mới: ', true);
if (password.length < 8) await quit('Mật khẩu quá ngắn. Không thay đổi gì.', 1);
if (password !== again) await quit('Hai lần gõ không khớp. Không thay đổi gì.', 1);

// updated_at do trigger pn_touch_updated_at trong DB tự cập nhật.
await db.query('UPDATE users SET password_hash = $1 WHERE email = $2', [await hashPassword(password), email]);
await quit(`Đã đặt lại mật khẩu cho ${email}. Đăng nhập lại trên dashboard bằng mật khẩu mới.`, 0);
