import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { describeFiles, pickFile, storeAttachment, takePendingFiles } from './files.js';
import type { TelegramClient, TelegramMessage } from './telegram.js';

const base = { chat: { id: 1, type: 'private' }, date: 0 };

describe('kho tệp từ Telegram', () => {
  it('tải tệp về đĩa, nhớ theo chat, rồi gắn vào dự án kế tiếp và chỉ một lần', async () => {
    process.env['PN_ATTACHMENT_DIR'] = await mkdtemp(join(tmpdir(), 'pn-files-'));
    const server = createServer((_request, response) => response.end('noi dung'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const telegram = { getFileUrl: async () => `http://127.0.0.1:${port}/f` } as unknown as TelegramClient;

    const message: TelegramMessage = { ...base, message_id: 7, document: { file_id: 'x', file_name: 'yêu cầu (bản 2).pdf' } };
    const saved = await storeAttachment(telegram, '1', message);
    expect(saved.size).toBe(8);
    expect(saved.path).toMatch(/7-yêu-cầu-bản-2-.pdf$/);
    expect(await readFile(saved.path, 'utf8')).toBe('noi dung');

    const description = describeFiles(takePendingFiles('1'));
    expect(description).toContain('yêu cầu (bản 2).pdf');
    expect(description).toContain(saved.path);
    expect(takePendingFiles('1')).toEqual([]);
    expect(describeFiles([])).toBe('');
    server.close();
  });

  it('ảnh lấy cỡ lớn nhất; ghi âm và tài liệu đặt tên đọc được', () => {
    const photo: TelegramMessage = {
      ...base,
      message_id: 3,
      photo: [
        { file_id: 'small', width: 90, height: 90 },
        { file_id: 'big', width: 1280, height: 960 },
      ],
    };
    expect(pickFile(photo)).toEqual({ fileId: 'big', name: 'anh-3.jpg' });
    expect(pickFile({ ...base, message_id: 4, voice: { file_id: 'v', duration: 3 } })).toEqual({ fileId: 'v', name: 'ghi-am-4.ogg' });
    expect(pickFile({ ...base, message_id: 5, text: 'chỉ chữ' })).toBeNull();
  });
});
