/**
 * P&N — Kiểm chứng DockerSandboxDriver trên MÁY THẬT (§18, §89).
 *
 * Khác `npm test`: bộ test kia chỉ kiểm tham số `docker run`, chạy được cả trên
 * máy không có Docker. Cái này gọi daemon thật và kiểm ba điều mà driver local
 * không làm được — giới hạn RAM, cắt mạng, chặn thoát workspace — để câu
 * "container cưỡng chế được" là điều đã đo chứ không phải điều đã viết.
 *
 *   node tools/check-docker.mjs
 *
 * Dọn sạch workspace tạm sau khi chạy.
 */

import { rm } from 'node:fs/promises';

import { DockerSandboxDriver } from '../packages/sandbox/dist/docker.js';

const ROOT = './workspaces/_check-docker';
const DOCKER = process.env.PN_DOCKER ?? 'docker';

let failed = 0;
const check = (name, ok, detail = '') => {
  process.stdout.write(`  ${ok ? 'ok  ' : 'LOI '} ${name}${detail ? ` — ${detail}` : ''}\n`);
  if (!ok) failed += 1;
};

const driver = new DockerSandboxDriver({ root: ROOT, dockerPath: DOCKER });

const health = await driver.healthCheck();
check('daemon và ảnh sẵn sàng', health.ok, health.detail);
if (!health.ok) {
  process.stdout.write('\nDừng lại: chưa chạy được Docker.\n');
  process.exit(1);
}

const session = await driver.create({ runId: 'chay-lenh', taskId: null, projectId: null });
await session.writeFile('chao.js', 'console.log("xin chao tu trong container");');
const run = await session.exec('node', ['chao.js']);
check('chạy được lệnh trong container', run.exitCode === 0 && run.stdout.includes('xin chao'));

// Xin 900MB trong container giới hạn 256MB. Kernel phải giết tiến trình.
const limited = await driver.create({
  runId: 'gioi-han-ram', taskId: null, projectId: null, limits: { maxMemoryMb: 256 },
});
await limited.writeFile('an-ram.js', 'const a=[];for(;;){a.push(Buffer.alloc(10*1024*1024));}');
const oom = await limited.exec('node', ['an-ram.js']);
check('kernel chặn khi vượt trần RAM', oom.exitCode !== 0, `exit ${oom.exitCode}`);

const noNet = await driver.create({
  runId: 'cat-mang', taskId: null, projectId: null, limits: { network: 'none' },
});
await noNet.writeFile(
  'goi-mang.js',
  'fetch("https://registry.npmjs.org/").then(()=>process.exit(0)).catch(()=>process.exit(3));',
);
const net = await noNet.exec('node', ['goi-mang.js']);
check('mạng bị cắt thật', net.exitCode === 3, `exit ${net.exitCode}`);

const escaped = await session
  .writeFile('../thoat-ra-ngoai.txt', 'x')
  .then(() => null)
  .catch((error) => error.name);
check('chặn ghi ra ngoài workspace', escaped === 'SandboxEscapeError', escaped ?? 'KHÔNG CHẶN');

await Promise.all([session.dispose(), limited.dispose(), noNet.dispose()]);
await rm(ROOT, { recursive: true, force: true });

process.stdout.write(failed === 0 ? '\nĐạt toàn bộ.\n' : `\n${failed} mục KHÔNG đạt.\n`);
process.exit(failed === 0 ? 0 : 1);
