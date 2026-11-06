/**
 * Làm lại dự án cất mã cũ (không xoá) và giữ tài liệu các bước không làm lại; xoá dự án xoá hẳn thư mục.
 */

import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { archiveWorkspace, removeWorkspace, workspaceOf } from './project-admin.js';

let root: string;
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'pn-admin-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

describe('thư mục dự án khi làm lại / xoá', () => {
  it('cất mã cũ sang _luu, workspace mới chỉ còn tài liệu được giữ', async () => {
    const ws = workspaceOf(root, 'app-hen-gio');
    await mkdir(path.join(ws, 'src'), { recursive: true });
    await mkdir(path.join(ws, 'docs'), { recursive: true });
    await writeFile(path.join(ws, 'src', 'main.ts'), 'mã cũ');
    await writeFile(path.join(ws, 'docs', 'pham-vi.md'), 'phạm vi');
    await writeFile(path.join(ws, 'docs', 'quyet-dinh.md'), 'sổ quyết định');
    await writeFile(path.join(ws, 'docs', 'yeu-cau.md'), 'yêu cầu cũ');

    const archived = await archiveWorkspace(
      root,
      'app-hen-gio',
      ['docs/quyet-dinh.md', 'docs/pham-vi.md', 'docs/ke-hoach.md'],
      new Date('2026-09-25T10:30:00Z'),
    );

    expect(archived).toBe(path.resolve(root, '_luu', 'app-hen-gio-2026-09-25-10-30'));
    expect(await exists(path.join(archived!, 'src', 'main.ts'))).toBe(true);
    expect(await exists(path.join(ws, 'src'))).toBe(false);
    expect((await readdir(path.join(ws, 'docs'))).sort()).toEqual(['pham-vi.md', 'quyet-dinh.md']);
  });

  it('dự án chưa có workspace thì không cất gì', async () => {
    expect(await archiveWorkspace(root, 'chua-co', [])).toBeNull();
  });

  it('xoá dự án xoá hẳn workspace và ảnh sản phẩm', async () => {
    const ws = workspaceOf(root, 'du-an-loi');
    await mkdir(ws, { recursive: true });
    await writeFile(path.join(ws, 'a.txt'), 'x');
    await mkdir(path.join(root, '_anh-san-pham'), { recursive: true });
    await writeFile(path.join(root, '_anh-san-pham', 'du-an-loi.png'), 'png');
    // Bản cất từ lần "làm lại" cũng phải đi theo; dự án khác cùng tiền tố thì không được đụng.
    await mkdir(path.join(root, '_luu', 'du-an-loi-2026-09-25-01-00'), { recursive: true });
    await mkdir(path.join(root, '_luu', 'du-an-loi-khac-2026-09-25-01-00'), { recursive: true });
    await removeWorkspace(root, 'du-an-loi');
    expect(await exists(ws)).toBe(false);
    expect(await exists(path.join(root, '_anh-san-pham', 'du-an-loi.png'))).toBe(false);
    expect(await exists(path.join(root, '_luu', 'du-an-loi-2026-09-25-01-00'))).toBe(false);
    expect(await exists(path.join(root, '_luu', 'du-an-loi-khac-2026-09-25-01-00'))).toBe(true);
  });
});
