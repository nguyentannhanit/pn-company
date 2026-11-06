/**
 * P&N — Bot bấm nút duyệt trên Telegram (§5.2, §58).
 *
 * Lỗi đã gặp thật: chat chưa gắn tài khoản → API trả 403 → bot chỉ nói "Không
 * xử lý được, thử lại sau" và CEO phải quay về dashboard. Bộ này khoá lại ba
 * đường: duyệt xong báo số việc xếp tiếp, duyệt deploy production thì deploy
 * luôn, và lỗi từ API phải tới tay CEO nguyên câu.
 */

import { describe, expect, it, vi } from 'vitest';

import { ApiError, type PnApiClient } from './api.js';
import { guessProductType, handleCallback, handleMessage, type BotDeps } from './handler.js';
import type { TelegramClient } from './telegram.js';

const session = { token: 't', user: { id: 'u1', displayName: 'CEO', role: 'CEO' } };

function fakeDeps(api: Partial<Record<keyof PnApiClient, unknown>>): BotDeps & {
  sent: string[];
  toasts: string[];
  buttons: Array<Array<{ text: string; callback_data: string }>>;
} {
  const sent: string[] = [];
  const toasts: string[] = [];
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
  const telegram = {
    async sendMessage(_chat: string, text: string, options?: { buttons?: Array<Array<{ text: string; callback_data: string }>> }) {
      sent.push(text);
      if (options?.buttons) buttons.push(options.buttons.flat());
    },
    async editMessageText() {},
    async answerCallbackQuery(_id: string, text?: string) {
      toasts.push(text ?? '');
    },
  } as unknown as TelegramClient;
  return {
    telegram,
    api: api as unknown as PnApiClient,
    allowedChatIds: new Set<string>(),
    sent,
    toasts,
    buttons,
  };
}

const callback = (data: string) => ({
  id: 'cb1',
  data,
  from: { id: 6077 },
  message: { message_id: 1, chat: { id: 6077, type: 'private' }, text: 'Duyệt kiến trúc' },
});

describe('Đoán loại sản phẩm từ câu của CEO', () => {
  it('phần mềm / exe / máy tính là desktop; web là web dù có chữ app; điện thoại là mobile', () => {
    expect(guessProductType('Làm phần mềm ghi chú chạy trên Windows')).toBe('DESKTOP_APPLICATION');
    expect(guessProductType('Tạo app exe quản lý kho')).toBe('DESKTOP_APPLICATION');
    expect(guessProductType('Làm web app bán hàng có giỏ hàng')).toBe('WEB_APPLICATION');
    expect(guessProductType('App điện thoại đặt lịch cắt tóc')).toBe('MOBILE_APPLICATION');
    expect(guessProductType('Landing page cho khoá học')).toBe('LANDING_PAGE');
  });
});

describe('Nút duyệt', () => {
  it('duyệt xong báo luôn số việc được xếp chạy tiếp', async () => {
    const deps = fakeDeps({
      session: async () => session,
      decideApproval: async () => ({ approval: { kind: 'ARCHITECTURE', projectId: 'p1' }, queued: 3 }),
    });
    await handleCallback(deps, callback('approve:a1'));
    expect(deps.toasts).toEqual(['Đã duyệt · xếp 3 việc chạy tiếp']);
  });

  it('duyệt deploy production thì triển khai ngay với phiếu vừa duyệt', async () => {
    const deploy = vi.fn(async () => ({
      deployment: { id: 'd123456789', environment: 'PRODUCTION', status: 'PENDING' },
    }));
    const deps = fakeDeps({
      session: async () => session,
      decideApproval: async () => ({ approval: { kind: 'PRODUCTION_DEPLOY', projectId: 'p1' }, queued: 0 }),
      deploy,
    });
    await handleCallback(deps, callback('approve:a2'));
    expect(deploy).toHaveBeenCalledWith(session, 'p1', 'PRODUCTION', 'a2');
    expect(deps.sent.join('\n')).toContain('Đã khởi tạo triển khai production');
  });

  it('API từ chối phiên thì CEO đọc được đúng lý do, không phải câu chung chung', async () => {
    const reason = 'Chat 6077 chưa gắn với tài khoản nào trong P&N. Vào Cài đặt → Tích hợp → Telegram.';
    const deps = fakeDeps({
      session: async () => {
        throw new ApiError(403, reason);
      },
    });
    await handleCallback(deps, callback('approve:a3'));
    expect(deps.toasts[0]).toBe(reason);
    expect(deps.toasts[0]).not.toContain('thử lại sau');
  });

  it('phiếu đã quyết định trước đó thì nói rõ', async () => {
    const deps = fakeDeps({
      session: async () => session,
      decideApproval: async () => {
        throw new ApiError(409, 'đã quyết định');
      },
    });
    await handleCallback(deps, callback('reject:a4'));
    expect(deps.toasts).toEqual(['Yêu cầu này đã được quyết định trước đó.']);
  });
});

describe('Nút chạy lại việc bị chặn', () => {
  it('xếp chạy lại qua máy chủ rồi báo ngay trên nút, không chờ cả lượt chạy', async () => {
    const runTask = vi.fn(async () => ({ queued: true, task: { title: 'Lập test plan', status: 'IN_PROGRESS' } }));
    const deps = fakeDeps({ session: async () => session, runTask });
    await handleCallback(deps, callback('retry:t1'));
    expect(runTask).toHaveBeenCalledWith(session, 't1');
    expect(deps.toasts).toEqual(['Đã xếp chạy lại.']);
  });

  it('API từ chối (việc đang chạy) thì CEO đọc được lý do ngay trên nút', async () => {
    const deps = fakeDeps({
      session: async () => session,
      runTask: async () => {
        throw new ApiError(409, 'Việc này đang chạy hoặc đang chờ tới lượt, không cần bấm lại.');
      },
    });
    await handleCallback(deps, callback('retry:t2'));
    expect(deps.toasts[0]).toContain('đang chạy');
  });
});

describe('Trợ lý: hỏi đáp và đề nghị tạo dự án', () => {
  const message = (text: string) => ({ message_id: 3, chat: { id: 6077, type: 'private' }, text }) as never;

  it('câu hỏi thì trả lời bằng số liệu, không tạo dự án', async () => {
    const createProject = vi.fn();
    const deps = fakeDeps({
      session: async () => session,
      ask: async () => ({ intent: 'answer', text: 'Hôm nay $2.24, tháng này $3.80.' }),
      createProject,
    });
    await handleMessage(deps, message('Hôm nay tiêu bao nhiêu?'));
    expect(deps.sent[0]).toContain('$2.24');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('yêu cầu làm sản phẩm thì hỏi lại kèm nút; bấm Tạo mới tạo với đúng loại', async () => {
    const createProject = vi.fn(async () => ({ project: { id: 'p9', name: 'Đặt lịch', slug: 'dat-lich' }, tasks: [1, 2], plan: 'kế hoạch' }));
    const deps = fakeDeps({
      session: async () => session,
      ask: async () => ({ intent: 'project', name: 'Đặt lịch cắt tóc', goal: 'Web đặt lịch cắt tóc có chọn giờ', productType: 'WEB_APPLICATION' }),
      createProject,
    });
    await handleMessage(deps, message('Làm web đặt lịch cắt tóc có chọn giờ'));
    expect(deps.sent[0]).toContain('Đặt lịch cắt tóc');
    expect(deps.sent[0]).toContain('ứng dụng web');
    expect(createProject).not.toHaveBeenCalled();

    const code = deps.buttons.at(-1)!.find((button) => button.callback_data.startsWith('newproject:'))!.callback_data;
    await handleCallback(deps, { ...callback(code), message: { message_id: 3, chat: { id: 6077, type: 'private' }, text: 'đề nghị' } });
    expect(createProject).toHaveBeenCalledWith(session, { goal: 'Web đặt lịch cắt tóc có chọn giờ', productType: 'WEB_APPLICATION' });
  });
});

describe('Tin nhắn thường', () => {
  it('chat chưa gắn tài khoản nhận nguyên hướng dẫn của API', async () => {
    const deps = fakeDeps({
      session: async () => {
        throw new ApiError(403, 'Chat 6077 chưa gắn với tài khoản nào trong P&N.');
      },
    });
    await handleMessage(deps, {
      message_id: 2,
      chat: { id: 6077, type: 'private' },
      text: '/status',
    } as never);
    expect(deps.sent[0]).toContain('Chat 6077 chưa gắn');
  });
});

describe('Người được mời nối bot', () => {
  const message = (text: string) => ({ message_id: 1, chat: { id: 555, type: 'private' }, text }) as never;

  it('chat lạ bấm link mời thì được nối và chào đúng vai trò, dù chưa có trong allowlist', async () => {
    const linkChat = vi.fn(async () => ({ user: { id: 'u2', displayName: 'Lan', role: 'PROJECT_MANAGER' } }));
    const deps = fakeDeps({ linkChat });
    deps.allowedChatIds.add('6077');
    await handleMessage(deps, message('/start link_AbCdEf123456_-xyz'));
    expect(linkChat).toHaveBeenCalledWith('AbCdEf123456_-xyz', '555');
    expect(deps.allowedChatIds.has('555')).toBe(true);
    expect(deps.sent[0]).toContain('Quản lý dự án');
  });

  it('mã hết hạn thì nói rõ để người đó xin link mới, không thêm vào allowlist', async () => {
    const deps = fakeDeps({
      linkChat: async () => {
        throw new ApiError(404, 'Link nối bot đã hết hạn hoặc đã dùng. Nhờ CEO tạo link mới.');
      },
    });
    deps.allowedChatIds.add('6077');
    await handleMessage(deps, message('/start link_AbCdEf123456'));
    expect(deps.allowedChatIds.has('555')).toBe(false);
    expect(deps.sent[0]).toContain('Nhờ CEO tạo link mới');
  });

  it('chat lạ gõ lệnh khác vẫn bị lờ đi như cũ', async () => {
    const deps = fakeDeps({ session: async () => session });
    deps.allowedChatIds.add('6077');
    await handleMessage(deps, message('/start'));
    expect(deps.sent).toEqual([]);
  });
});

describe('/pause dừng thật', () => {
  // Chat riêng cho bộ này: bot nhớ "dự án đang nói tới" theo chat, các test trên đã dùng chat 6077.
  let chat = 7000;
  const message = (text: string) => ({ message_id: 1, chat: { id: (chat += 1), type: 'private' }, text }) as never;
  const projects = async () => ({ projects: [{ id: 'p1', name: 'Web bán hàng', status: 'IN_PROGRESS' }] });

  it('/pause gọi dừng dự án (cắt lượt đang chạy), không chỉ đổi nhãn', async () => {
    const stopProject = vi.fn(async () => ({ aborted: 1, reset: 0 }));
    const setProjectStatus = vi.fn();
    const deps = fakeDeps({ session: async () => session, listProjects: projects, stopProject, setProjectStatus });
    await handleMessage(deps, message('/pause'));
    expect(stopProject).toHaveBeenCalledWith(session, 'p1');
    expect(setProjectStatus).not.toHaveBeenCalled();
    expect(deps.sent.at(-1)).toContain('cắt 1 lượt đang chạy');
  });

  it('/resume với dự án dừng kiểu cũ (ghi "kẹt") vẫn chạy tiếp được', async () => {
    const advance = vi.fn(async () => ({ queued: 2 }));
    const setProjectStatus = vi.fn(async () => ({}));
    const deps = fakeDeps({
      session: async () => session,
      listProjects: projects,
      resumeProject: async () => {
        throw new ApiError(409, 'Dự án không ở trạng thái dừng.');
      },
      setProjectStatus,
      advance,
    });
    await handleMessage(deps, message('/resume'));
    expect(setProjectStatus).toHaveBeenCalledWith(session, 'p1', 'IN_PROGRESS');
    expect(deps.sent.at(-1)).toContain('Đã xếp 2 task');
  });
});
