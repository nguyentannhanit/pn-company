/**
 * P&N — Dựng bộ cài đặt để mang sang máy khác.
 *
 * Gói mã nguồn + script cài, KHÔNG gói `node_modules` và KHÔNG gói bản đã biên
 * dịch. Lý do: dashboard nhúng địa chỉ API vào lúc build, còn `node_modules`
 * chứa binary biên dịch theo đúng máy — mang nguyên sang máy khác là hỏng. Bộ
 * cài tự biên dịch trên máy đích nên luôn khớp.
 *
 * Danh sách tệp lấy từ `git ls-files` chứ không tự liệt kê. Hai lý do: thêm tệp
 * mới vào repo là bộ cài tự có, và mọi thứ bị `.gitignore` — trong đó có `.env`
 * chứa khoá giải mã toàn bộ API key (§19, §69) — không có đường lọt vào.
 *
 *   node tools/package.mjs
 */

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const outRoot = join(root, 'dist-install');
const bundleName = `pn-company-${version}`;
const bundle = join(outRoot, bundleName);

const { stdout: listed } = await run('git', ['ls-files'], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
const files = listed.split('\n').filter(Boolean);
if (files.length === 0) throw new Error('git ls-files khong tra ve tep nao — dang o dung thu muc repo chua?');

// Chốt chặn cuối: dù `.gitignore` có sai thì cũng không đóng gói tệp bí mật.
const forbidden = files.filter((file) => /(^|\/)\.env$|\.pem$|\.key$/.test(file));
if (forbidden.length > 0) {
  throw new Error(`Tu choi dong goi: co tep bi mat trong git — ${forbidden.join(', ')}`);
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(bundle, { recursive: true });

for (const file of files) {
  const target = join(bundle, file);
  await mkdir(dirname(target), { recursive: true });
  await cp(join(root, file), target);
}

// Dấu vết để biết bộ cài này dựng từ commit nào — cần khi đối chiếu lỗi về sau.
let commit = 'khong-xac-dinh';
try {
  commit = (await run('git', ['rev-parse', '--short', 'HEAD'])).stdout.trim();
} catch {
  /* không phải repo git thì bỏ qua */
}
await writeFile(
  join(bundle, 'BUILD-INFO.txt'),
  [
    'P&N - Build. Learn. Evolve.',
    `Phien ban: ${version}`,
    `Commit:    ${commit}`,
    `Dong goi:  ${new Date().toISOString()}`,
    `So tep:    ${files.length}`,
    '',
    'Cai dat:   chay cai-dat.cmd',
    'Khoi dong: chay.cmd',
    'Dung lai:  dung.cmd',
    '',
  ].join('\n'),
  'utf8',
);

const zip = join(outRoot, `${bundleName}.zip`);
await run('powershell', [
  '-NoProfile',
  '-Command',
  `Compress-Archive -Path '${bundle}\\*' -DestinationPath '${zip}' -Force`,
]);

const size = (await stat(zip)).size;
process.stdout.write(`\nDa dong goi ${files.length} tep (commit ${commit})\n`);
process.stdout.write(`  Thu muc: ${bundle}\n`);
process.stdout.write(`  Tep nen: ${zip} (${(size / 1024 / 1024).toFixed(1)} MB)\n`);
