/**
 * P&N — Lấy token phiên để chụp màn hình và thử API bằng tay.
 *
 *   node tools/dev-session.mjs        # in ra token của CEO, sống 2 giờ
 *   node tools/dev-session.mjs xoa    # dọn tài khoản "phiên tạm" do bản cũ của script này để lại (nếu có)
 *
 * Nay (Tài khoản & phân quyền) mỗi yêu cầu đều tra người dùng trong database: token của một tài khoản đã
 * xoá không còn dùng được, nên cách cũ "tạo CEO tạm → lấy token → xoá ngay" hết tác dụng. Bản này ký token cho
 * CEO đang dùng bằng chính `JWT_SECRET` của máy — không tạo tài khoản nào, không có mật khẩu nào trong mã nguồn
 * (file này nằm trong bộ cài giao cho người dùng). Ai đọc được `JWT_SECRET` thì vốn đã giữ chìa khoá của API.
 *
 * Từ chối chạy khi `NODE_ENV=production`. Thông tin database đọc từ biến môi trường, không viết cứng.
 */

import { execFile } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

if (process.env.NODE_ENV === 'production') {
  console.error('Script này chỉ dùng khi phát triển, không chạy trên môi trường thật.');
  process.exit(1);
}

const PSQL = process.env.PN_PSQL ?? 'C:/Program Files/PostgreSQL/17/bin/psql.exe';
const DB = process.env.PN_DEV_DB ?? 'pn_company';
const DB_USER = process.env.PGUSER ?? 'postgres';
const TTL_SECONDS = 2 * 60 * 60;

const sql = async (statement) =>
  (
    await run(PSQL, ['-U', DB_USER, '-h', '127.0.0.1', '-d', DB, '-t', '-A', '-F', '|', '-c', statement], {
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'postgres' },
    })
  ).stdout.trim();

/** JWT_SECRET: biến môi trường trước, không có thì đọc `.env` ở gốc repo (cùng chỗ API đọc). */
function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const line = readFileSync(fileURLToPath(new globalThis.URL('../.env', import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .find((row) => row.startsWith('JWT_SECRET='));
  const value = line?.slice('JWT_SECRET='.length).trim().replace(/^["']|["']$/g, '');
  if (!value) throw new Error('Không tìm thấy JWT_SECRET trong môi trường hay .env');
  return value;
}

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

if (process.argv[2] === 'xoa') {
  await sql(`DELETE FROM users WHERE email = 'phien-tam@pn.local'`);
  console.log('da xoa phien tam');
} else {
  const row = await sql(
    `SELECT id, email, session_version FROM users WHERE role = 'CEO' AND is_active ORDER BY created_at LIMIT 1`,
  );
  if (!row) throw new Error('Chưa có CEO nào đang dùng trong database');
  const [id, email, version] = row.split('|');

  // Đúng dạng token API tự ký (HS256, sub/email/role/ver) — kèm số phiên hiện tại, "đăng xuất mọi thiết bị" vẫn thu hồi được.
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: id, email, role: 'CEO', ver: Number(version), iat: now, exp: now + TTL_SECONDS })}`;
  const signature = createHmac('sha256', jwtSecret()).update(body).digest('base64url');
  console.log(`${body}.${signature}`);
}
