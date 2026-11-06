/**
 * §55, §5.2 — chỉ những event đáng làm phiền người dùng mới thành tin đẩy, và
 * nội dung tin phải nói được con số chứ không chỉ nói "có cảnh báo".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PnEvent } from '@pn/events';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describeEvent, productScreenshots, sendTelegram, sendTelegramDocument, sendTelegramMediaGroup } from './notifier.js';

function event<T extends PnEvent['type']>(type: T, payload: unknown): PnEvent {
  return {
    id: 'e1',
    type,
    ts: new Date().toISOString(),
    actor: 'system',
    projectId: null,
    taskId: null,
    agentId: null,
    payload,
  } as unknown as PnEvent;
}

describe('tin đẩy Telegram', () => {
  it('cảnh báo ngân sách nói rõ đã dùng bao nhiêu phần trăm và bao nhiêu tiền', () => {
    const text = describeEvent(
      event('BUDGET_WARNING', { scope: 'GLOBAL', spentUsd: 8, limitUsd: 10, ratio: 0.8 }),
    );

    expect(text).toContain('80%');
    expect(text).toContain('$8.00');
    expect(text).toContain('$10.00');
  });

  it('hãng hết credit: nói tên hãng, thời gian né và việc CEO cần làm', () => {
    const text = describeEvent(
      event('PROVIDER_ALERT', { provider: 'openai', model: 'gpt-4o-mini', kind: 'quota', detail: 'insufficient_quota', cooldownMs: 6 * 3_600_000 }),
    );
    expect(text).toContain('OpenAI hết credit');
    expect(text).toContain('6 giờ');
    expect(text).toContain('nạp tiền');
  });

  it('phiếu duyệt mang theo tiêu đề để biết duyệt cái gì', () => {
    expect(describeEvent(event('APPROVAL_REQUIRED', { title: 'Duyệt kiến trúc' }))).toContain(
      'Duyệt kiến trúc',
    );
  });

  it('phiếu duyệt kèm dự án, chi phí và tóm tắt lý do để CEO quyết trên điện thoại', () => {
    const text = describeEvent(event('APPROVAL_REQUIRED', { title: 'QA vẫn không đạt sau nhiều vòng sửa' }), {
      approval: {
        summary: 'Task "Engine" đã sửa 3 lần.\nDuyệt = sửa thêm một vòng. Từ chối = chấp nhận hiện trạng.\n- [HIGH] Tính tổng sai',
        projectName: 'Web bán hoa',
        spentUsd: 2.6412,
      },
    });
    expect(text).toContain('Web bán hoa');
    expect(text).toContain('$2.64');
    expect(text).toContain('[HIGH] Tính tổng sai');
    expect(text).toContain('Duyệt = sửa thêm một vòng');
  });

  it('triển khai thất bại nói nguyên nhân', () => {
    expect(describeEvent(event('DEPLOY_FAILED', { reason: 'build lỗi' }))).toContain('build lỗi');
  });

  it('việc bị chặn nêu tên việc và lý do để CEO quyết ngay trên điện thoại', () => {
    const text = describeEvent(
      event('TASK_FAILED', { taskId: 't1', reason: 'spawn npm ENOENT' }),
      { taskTitle: 'Lập test plan' },
    );
    expect(text).toContain('Lập test plan');
    expect(text).toContain('spawn npm ENOENT');
    expect(text).toContain('việc bị chặn');
  });

  it('sản phẩm sẵn sàng thì gửi link; mốc dự án nêu tên mốc và chi phí', () => {
    expect(
      describeEvent(event('DEPLOY_SUCCESS', { deploymentId: 'd', environment: 'STAGING', url: 'http://x/product/p/?v=t' })),
    ).toContain('http://x/product/p/?v=t');
    expect(describeEvent(event('DEPLOY_SUCCESS', { deploymentId: 'd', environment: 'STAGING', url: null }))).toBeNull();
    const milestone = describeEvent(
      event('PROJECT_MILESTONE', { projectId: 'p', stageId: 'design', title: 'Thiết kế giao diện xong', detail: 'Wireframe', spentUsd: 1.234 }),
    );
    expect(milestone).toContain('Thiết kế giao diện xong');
    expect(milestone).toContain('$1.23');
  });

  it('event thường không thành tin đẩy — không làm phiền vì mỗi task chạy xong', () => {
    expect(describeEvent(event('TASK_COMPLETED', { taskId: 't1' }))).toBeNull();
    expect(describeEvent(event('AGENT_STARTED', { agentRole: 'QA' }))).toBeNull();
  });
});

describe('sendTelegram', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('phiếu duyệt gửi kèm nút Duyệt/Từ chối để CEO bấm ngay trong chat', async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response('{"ok":true}', { status: 200 });
      }),
    );
    const buttons = [[{ text: '✅ Duyệt', callback_data: 'approve:a1' }]];
    const delivered = await sendTelegram({ botToken: 't', chatIds: ['1', '2'] }, 'x', undefined, buttons);
    expect(delivered).toBe(2);
    expect(calls[0]).toMatchObject({ chat_id: '1', reply_markup: { inline_keyboard: buttons } });
  });
});

describe('bàn giao sản phẩm', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tin bàn giao có tên, link dùng thử, chi phí và tên tệp; mốc "hoàn thành" cũ không gửi trùng', () => {
    const text = describeEvent(
      event('PROJECT_DELIVERED', { projectId: 'p', slug: 'ghi-chu', name: 'Ứng dụng ghi chú', url: 'http://x/product/ghi-chu/?v=t', file: 'D:/ws/dist/GhiChu.exe', spentUsd: 1.5, taskCount: 8 }),
    );
    expect(text).toContain('Ứng dụng ghi chú');
    expect(text).toContain('http://x/product/ghi-chu/?v=t');
    expect(text).toContain('GhiChu.exe');
    expect(text).toContain('$1.50');
    expect(describeEvent(event('PROJECT_MILESTONE', { projectId: 'p', stageId: 'staging', title: 'Dự án hoàn thành: X', detail: null, spentUsd: 1 }))).toBeNull();
  });

  it('gom ảnh: ảnh staging trước, rồi ảnh QA theo tên, tối đa 4', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pn-anh-'));
    const dir = path.join(root, '_anh-san-pham', 'ghi-chu');
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
    for (const name of ['qa-3.png', 'qa-1.png', 'qa-2.png', 'qa-4.png', 'ghi-chu.txt']) await writeFile(path.join(dir, name), 'x');
    await writeFile(path.join(root, '_anh-san-pham', 'ghi-chu.png'), 'x');
    const shots = await productScreenshots(root, 'ghi-chu');
    expect(shots.map((shot) => path.basename(shot))).toEqual(['ghi-chu.png', 'qa-1.png', 'qa-2.png', 'qa-3.png']);
    expect(await productScreenshots(root, 'khong-co')).toEqual([]);
  });

  it('nhiều ảnh gửi thành album với chú thích ở ảnh đầu; tệp gửi bằng sendDocument đúng tên', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pn-tep-'));
    const a = path.join(root, 'a.png');
    const b = path.join(root, 'b.png');
    const exe = path.join(root, 'GhiChu.exe');
    for (const file of [a, b, exe]) await writeFile(file, 'bytes');
    const calls: Array<{ url: string; form: FormData }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, form: init?.body as FormData });
        return new Response('{"ok":true}', { status: 200 });
      }),
    );
    const target = { botToken: 't', chatIds: ['1'] };
    expect(await sendTelegramMediaGroup(target, [a, b], 'chú thích')).toBe(1);
    expect(calls[0]!.url).toContain('/sendMediaGroup');
    const media = JSON.parse(String(calls[0]!.form.get('media'))) as Array<Record<string, string>>;
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({ type: 'photo', media: 'attach://anh-1.png', caption: 'chú thích' });
    expect(media[1]!['caption']).toBeUndefined();

    expect(await sendTelegramDocument(target, exe, 'tệp')).toBe(1);
    expect(calls[1]!.url).toContain('/sendDocument');
    expect((calls[1]!.form.get('document') as File).name).toBe('GhiChu.exe');
  });
});
