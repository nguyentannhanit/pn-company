/** §18, §88.18 — kiểm chứng những ranh giới mà sandbox local thật sự cưỡng chế. */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SandboxEscapeError } from './contract.js';
import { CommandNotAllowedError, LocalSandboxDriver } from './local.js';

let root: string;
let driver: LocalSandboxDriver;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pn-sandbox-'));
  driver = new LocalSandboxDriver({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalSandboxDriver (§18)', () => {
  it('khai báo trung thực mức cô lập nó đạt được (§89)', async () => {
    expect(driver.enforcement.workspaceIsolation).toBe(true);
    expect(driver.enforcement.timeout).toBe(true);
    // Không được phép tuyên bố có, vì driver local không chặn mạng hay giới hạn RAM.
    expect(driver.enforcement.networkPolicy).toBe(false);
    expect(driver.enforcement.memoryLimit).toBe(false);
    expect(driver.enforcement.note).toContain('Docker');
  });

  it('mỗi run có workspace riêng theo run_id', async () => {
    const a = await driver.create({ runId: 'run-a', taskId: null, projectId: null });
    const b = await driver.create({ runId: 'run-b', taskId: null, projectId: null });
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.workspace.endsWith('run-a')).toBe(true);
  });

  it('đọc ghi file trong workspace hoạt động bình thường', async () => {
    const session = await driver.create({ runId: 'run-io', taskId: null, projectId: null });
    await session.writeFile('src/app.ts', 'export const x = 1;\n');
    expect(await session.readFile('src/app.ts')).toContain('export const x');
    expect(await session.listFiles()).toEqual(['src/app.ts']);
  });

  it('chặn đường dẫn thoát ra ngoài workspace', async () => {
    const session = await driver.create({ runId: 'run-escape', taskId: null, projectId: null });
    await expect(session.readFile('../../secret.txt')).rejects.toBeInstanceOf(SandboxEscapeError);
    await expect(session.writeFile('../evil.txt', 'x')).rejects.toBeInstanceOf(SandboxEscapeError);
  });

  it('từ chối lệnh ngoài allow-list', async () => {
    const session = await driver.create({ runId: 'run-cmd', taskId: null, projectId: null });
    await expect(session.exec('curl', ['https://example.com'])).rejects.toBeInstanceOf(
      CommandNotAllowedError,
    );
    await expect(session.exec('rm', ['-rf', '/'])).rejects.toBeInstanceOf(CommandNotAllowedError);
  });

  it('chạy lệnh được phép và ghi lại đầy đủ log (§18)', async () => {
    const session = await driver.create({ runId: 'run-exec', taskId: null, projectId: null });
    const result = await session.exec('node', ['-e', 'console.log("pn ok")']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('pn ok');
    expect(result.timedOut).toBe(false);
    expect(session.commandLog()).toHaveLength(1);
    expect(session.commandLog()[0]!.command).toContain('node');
  });

  it('npm chạy được — trên Windows npm là .cmd, spawn thẳng thì ENOENT', async () => {
    const session = await driver.create({ runId: 'run-npm', taskId: null, projectId: null });
    const result = await session.exec('npm', ['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.command).toBe('npm --version');
  });

  it('npm run <script> chạy được dù đường dẫn workspace có dấu & (ví dụ thư mục "P&N App")', async () => {
    const { windowsBash } = await import('./local.js');
    if (process.platform === 'win32' && !windowsBash()) return; // máy không có Git Bash thì không kiểm được
    const ampRoot = await mkdtemp(path.join(tmpdir(), 'pn&amp-'));
    try {
      const ampDriver = new LocalSandboxDriver({ root: ampRoot });
      const session = await ampDriver.create({ runId: 'run-amp', taskId: null, projectId: null });
      await session.writeFile(
        'package.json',
        JSON.stringify({ name: 'amp', scripts: { build: 'node -e "console.log(\'built ok\')"' } }),
      );
      const result = await session.exec('npm', ['run', 'build', '--silent']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('built ok');
    } finally {
      await rm(ampRoot, { recursive: true, force: true });
    }
  });

  it('trả về exit code khác 0 thay vì ném lỗi', async () => {
    const session = await driver.create({ runId: 'run-fail', taskId: null, projectId: null });
    const result = await session.exec('node', ['-e', 'process.exit(3)']);
    expect(result.exitCode).toBe(3);
  });

  it('không rò biến môi trường của nền tảng vào tiến trình con (§88.18)', async () => {
    process.env['PN_MASTER_KEY'] = 'khong-duoc-lo-ra-ngoai';
    const session = await driver.create({ runId: 'run-env', taskId: null, projectId: null });
    const result = await session.exec('node', [
      '-e',
      'console.log(process.env.PN_MASTER_KEY ?? "UNSET")',
    ]);
    expect(result.stdout.trim()).toBe('UNSET');
    delete process.env['PN_MASTER_KEY'];
  });

  it('chỉ nhận biến môi trường được truyền tường minh', async () => {
    const session = await driver.create({
      runId: 'run-env2',
      taskId: null,
      projectId: null,
      env: { PN_TASK_ID: 'task-123' },
    });
    const result = await session.exec('node', ['-e', 'console.log(process.env.PN_TASK_ID)']);
    expect(result.stdout.trim()).toBe('task-123');
  });

  it('giết tiến trình khi quá timeout', async () => {
    const session = await driver.create({
      runId: 'run-timeout',
      taskId: null,
      projectId: null,
      limits: { timeoutMs: 300 },
    });
    const result = await session.exec('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(10_000);
  }, 20_000);

  it('healthCheck xác nhận ghi được vào thư mục gốc (§74)', async () => {
    const health = await driver.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain(root);
  });
});
