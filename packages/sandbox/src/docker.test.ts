/**
 * §18, §117, §118 — bộ cờ `docker run` LÀ ranh giới bảo mật của driver này.
 * Một lần sửa vô ý làm rơi mất `--cap-drop ALL` hay `--network none` không lộ
 * ra ở bất kỳ đâu khác, nên nó phải có test riêng.
 *
 * Test chạy được trên máy không có Docker vì nó chỉ kiểm tham số, không gọi ra
 * ngoài. Việc container có thật sự cưỡng chế các cờ này hay không là việc của
 * `healthCheck()` trên máy đã cài Docker.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMITS, resolveLimits } from './contract.js';
import { DEFAULT_IMAGE, DockerSandboxDriver, buildDockerRunArgs } from './docker.js';

/** Tìm giá trị đi ngay sau một cờ, để test không phụ thuộc thứ tự tham số. */
function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function build(overrides: Partial<Parameters<typeof buildDockerRunArgs>[0]> = {}): string[] {
  return buildDockerRunArgs({
    workspace: '/host/ws',
    limits: DEFAULT_LIMITS,
    env: {},
    image: DEFAULT_IMAGE,
    command: 'npm',
    args: ['test'],
    ...overrides,
  });
}

describe('tham số docker run (§18)', () => {
  it('giới hạn RAM và chặn luôn swap để không lách được trần', () => {
    const args = build({ limits: resolveLimits({ maxMemoryMb: 512 }) });

    expect(valueAfter(args, '--memory')).toBe('512m');
    expect(valueAfter(args, '--memory-swap')).toBe('512m');
  });

  it('bỏ mọi capability và chặn leo thang quyền', () => {
    const args = build();

    expect(valueAfter(args, '--cap-drop')).toBe('ALL');
    expect(valueAfter(args, '--security-opt')).toBe('no-new-privileges');
    expect(valueAfter(args, '--user')).toBe('1000:1000');
  });

  it('cắt mạng khi chính sách là none (§117, §118)', () => {
    const args = build({ limits: resolveLimits({ network: 'none' }) });
    expect(valueAfter(args, '--network')).toBe('none');
  });

  it('không tự cắt mạng khi chính sách cho phép — không hứa thứ không làm', () => {
    const args = build({ limits: resolveLimits({ network: 'full' }) });
    expect(args).not.toContain('--network');
  });

  it('container biến mất sau mỗi lệnh, không để lại trạng thái', () => {
    expect(build()).toContain('--rm');
  });

  it('chỉ mount đúng workspace của run vào container', () => {
    const args = build({ workspace: '/host/du-an-a' });
    expect(valueAfter(args, '--mount')).toBe('type=bind,source=/host/du-an-a,target=/workspace');
  });

  it('biến môi trường của agent đi qua cờ -e, không thừa hưởng env của host (§88.18)', () => {
    const args = build({ env: { PN_PROJECT: 'cafe' } });

    expect(args).toContain('-e');
    expect(args).toContain('PN_PROJECT=cafe');
  });

  it('lệnh của agent nằm sau tên ảnh', () => {
    const args = build({ command: 'npm', args: ['test', '--silent'] });
    const imageIndex = args.indexOf(DEFAULT_IMAGE);

    expect(args.slice(imageIndex + 1)).toEqual(['npm', 'test', '--silent']);
  });
});

describe('driver Docker', () => {
  it('khai báo cưỡng chế được cả RAM lẫn mạng — đây là lý do nó tồn tại (§89)', () => {
    const driver = new DockerSandboxDriver({ root: './workspaces' });

    expect(driver.id).toBe('docker');
    expect(driver.enforcement.memoryLimit).toBe(true);
    expect(driver.enforcement.networkPolicy).toBe(true);
  });

  it('nói rõ phải làm gì khi máy chưa có Docker, thay vì ném lỗi (§74, §89)', async () => {
    const driver = new DockerSandboxDriver({
      root: './workspaces',
      dockerPath: 'khong-co-lenh-nay-tren-may',
    });

    const health = await driver.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('SANDBOX_DRIVER=local');
  });
});
