/**
 * Kiểm tra phần viết tay của Test Connection: chữ ký S3 phải khớp ví dụ chính
 * thức của AWS, JWT phải xác minh được bằng khoá công khai, bắt tay SMTP phải
 * đúng thứ tự lệnh, webhook phải mang chữ ký đúng phần thân.
 */

import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';

import { signJwt, signV4, smtpLogin, testWebhook, webhookSignature } from './services/integration-tests.js';

describe('chữ ký S3 (AWS Signature V4)', () => {
  it('khớp ví dụ GET Object trong tài liệu AWS', () => {
    const { signature, headers } = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { Range: 'bytes=0-9' },
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
    });
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(headers['authorization']).toContain('SignedHeaders=host;range;x-amz-content-sha256;x-amz-date');
    expect(headers['host']).toBeUndefined();
  });
});

describe('JWT cho Apple và Google', () => {
  it('ES256 và RS256 xác minh được bằng khoá công khai tương ứng', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const apple = signJwt({ kid: 'ABC' }, { iss: 'x', aud: 'appstoreconnect-v1' }, ec.privateKey, 'ES256');
    const [h, p, s] = apple.split('.') as [string, string, string];
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ kid: 'ABC', alg: 'ES256', typ: 'JWT' });
    expect(
      verify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')),
    ).toBe(true);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const google = signJwt({}, { iss: 'sa@x' }, rsa.privateKey, 'RS256');
    const [h2, p2, s2] = google.split('.') as [string, string, string];
    expect(verify('sha256', Buffer.from(`${h2}.${p2}`), rsa.publicKey, Buffer.from(s2, 'base64url'))).toBe(true);
  });
});

describe('đăng nhập SMTP', () => {
  async function fakeServer(authReply: string): Promise<{ port: number; lines: string[]; close: () => void }> {
    const lines: string[] = [];
    const server = createServer((socket) => {
      socket.write('220 mail.test ESMTP\r\n');
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
          lines.push(line);
          if (line.startsWith('EHLO')) socket.write('250-mail.test\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (line.startsWith('AUTH')) socket.write(`${authReply}\r\n`);
          else if (line === 'QUIT') {
            socket.write('221 bye\r\n');
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    return { port: typeof address === 'object' && address ? address.port : 0, lines, close: () => server.close() };
  }

  const dial = (port: number): Promise<Socket> =>
    new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port }, () => resolve(socket));
    });

  it('gửi EHLO, AUTH PLAIN rồi QUIT; 235 là đăng nhập được', async () => {
    const server = await fakeServer('235 2.7.0 ok');
    const greeting = await smtpLogin(await dial(server.port), { host: 'mail.test', user: 'ceo', password: 'pw', startTls: false });
    expect(greeting).toBe('mail.test');
    expect(server.lines[0]).toMatch(/^EHLO /);
    expect(server.lines[1]).toBe(`AUTH PLAIN ${Buffer.from('\0ceo\0pw').toString('base64')}`);
    expect(server.lines[2]).toBe('QUIT');
    server.close();
  });

  it('sai mật khẩu thì báo nguyên câu của máy chủ', async () => {
    const server = await fakeServer('535 5.7.8 Sai mật khẩu');
    const socket = await dial(server.port);
    await expect(
      smtpLogin(socket, { host: 'mail.test', user: 'ceo', password: 'x', startTls: false }),
    ).rejects.toThrow('535 5.7.8 Sai mật khẩu');
    socket.destroy();
    server.close();
  });
});

describe('webhook', () => {
  it('bắn ping kèm chữ ký HMAC của đúng phần thân; đầu nhận 2xx là ok', async () => {
    let received: { signature: string | undefined; body: string } | null = null;
    const server = createHttpServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        received = { signature: request.headers['x-pn-signature'] as string | undefined, body };
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const result = await testWebhook({ settings: { url: `http://127.0.0.1:${port}/hook` }, secrets: { secret: 'k' } });
    expect(result).toEqual({ ok: true, detail: 'Đầu nhận trả HTTP 204', error: null });
    const got = received as { signature: string | undefined; body: string } | null;
    expect(got?.signature).toBe(webhookSignature('k', got?.body ?? ''));
    expect(got?.signature).toBe(`sha256=${createHmac('sha256', 'k').update(got?.body ?? '').digest('hex')}`);
    expect(JSON.parse(got?.body ?? '{}')).toMatchObject({ type: 'ping', company: 'P&N' });
    server.close();
  });
});
