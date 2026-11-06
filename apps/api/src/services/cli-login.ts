/**
 * P&N — Đăng nhập CLI gói thuê bao ngay từ trang Cài đặt ("ở phần CLI tạo thêm nút đăng nhập khi chưa
 * đăng nhập"). Mở được trên điện thoại: máy chủ chạy lệnh đăng nhập, trả về đường link (và mã) để CEO mở trên bất kỳ
 * máy nào.
 *
 *   Claude  — `claude auth login --claudeai`: in link, CEO đăng nhập rồi dán mã Claude đưa về; mã đi vào stdin.
 *   ChatGPT — `codex login --device-auth`: in link + mã thiết bị; CEO nhập mã trên trang OpenAI, lệnh tự kết thúc.
 *
 * Chỉ mở lượt mới khi CLI CHƯA đăng nhập: `codex login` xoá phiên đang có ngay lúc bắt đầu (một lần chạy thử đã
 * làm mất đăng nhập ChatGPT của công ty).
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { claudeCommand, cliEnv, codexCommand, type CliCommand } from '@pn/llm';

export type CliLoginProvider = 'claude-code' | 'codex';

export interface CliLoginView {
  provider: CliLoginProvider;
  state: 'starting' | 'waiting' | 'done' | 'failed';
  /** Trang CEO cần mở để đăng nhập. */
  url: string | null;
  /** Mã thiết bị CEO nhập trên trang đó (ChatGPT). */
  userCode: string | null;
  /** Claude: sau khi đăng nhập, CEO dán mã trang Claude hiện ra vào đây. */
  needsCode: boolean;
  message: string | null;
}

interface Session extends CliLoginView {
  child: ChildProcessWithoutNullStreams;
  output: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Link và mã hết hạn sau 15 phút; giữ tiến trình lâu hơn cũng vô ích. */
const LOGIN_TTL_MS = 15 * 60_000;
const sessions = new Map<CliLoginProvider, Session>();

const commandFor = (provider: CliLoginProvider): CliCommand => (provider === 'claude-code' ? claudeCommand() : codexCommand());
// BROWSER=none: không tự bật trình duyệt trên máy chủ — CEO có thể đang cầm điện thoại, link hiện trên trang.
const loginEnv = (): Record<string, string> => cliEnv({ BROWSER: 'none', DISABLE_AUTOUPDATER: '1' });
/** Mã màu của terminal (ESC [ … chữ cái) — CLI tô màu dòng in ra, phải bỏ đi mới đọc được link. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** CLI trên máy chủ đã đăng nhập tài khoản gói chưa (hỏi thẳng CLI, mất 1–3 giây, không chặn máy chủ). */
export function cliLoggedIn(provider: CliLoginProvider): Promise<boolean> {
  const command = commandFor(provider);
  const args = provider === 'claude-code' ? ['auth', 'status', '--json'] : ['login', 'status'];
  return new Promise((resolve) => {
    execFile(command.file, [...command.prefixArgs, ...args], { env: loginEnv(), timeout: 20_000, windowsHide: true }, (error, stdout, stderr) => {
      const text = stripAnsi(`${stdout}${stderr}`);
      if (provider === 'claude-code') return resolve(/"loggedIn"\s*:\s*true/.test(text));
      resolve(!error && /logged in/i.test(text) && !/not logged in/i.test(text));
    });
  });
}

function view(session: Session): CliLoginView {
  const { provider, state, url, userCode, needsCode, message } = session;
  return { provider, state, url, userCode, needsCode, message };
}

/** Đọc link / mã từ đầu ra của lệnh đăng nhập. */
function parse(session: Session): void {
  const text = stripAnsi(session.output);
  if (session.provider === 'claude-code') {
    session.url ??= /https:\/\/\S*oauth\/authorize\S*/.exec(text)?.[0] ?? null;
    session.needsCode = /paste code/i.test(text);
  } else {
    session.url ??= /https:\/\/auth\.openai\.com\/\S*device\S*/.exec(text)?.[0] ?? null;
    session.userCode ??= /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(text)?.[0] ?? null;
  }
  if (session.state === 'starting' && session.url) session.state = 'waiting';
}

export function loginStatus(provider: CliLoginProvider): CliLoginView | null {
  const session = sessions.get(provider);
  return session ? view(session) : null;
}

/** Mở lượt đăng nhập; đang có lượt chờ thì trả lượt đó, không mở thêm. */
export async function startLogin(provider: CliLoginProvider): Promise<CliLoginView> {
  const existing = sessions.get(provider);
  if (existing && (existing.state === 'starting' || existing.state === 'waiting')) return view(existing);
  if (existing) sessions.delete(provider);

  const command = commandFor(provider);
  const args = provider === 'claude-code' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth'];
  const child = spawn(command.file, [...command.prefixArgs, ...args], { env: loginEnv(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const session: Session = {
    provider,
    state: 'starting',
    url: null,
    userCode: null,
    needsCode: false,
    message: null,
    child,
    output: '',
    timer: setTimeout(() => {
      session.state = 'failed';
      session.message = 'Quá 15 phút chưa đăng nhập xong, link đã hết hạn. Bấm Đăng nhập để lấy link mới.';
      child.kill();
    }, LOGIN_TTL_MS),
  };
  sessions.set(provider, session);

  const onData = (chunk: Buffer): void => {
    session.output += chunk.toString('utf8');
    parse(session);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (error) => {
    clearTimeout(session.timer);
    session.state = 'failed';
    session.message = `Không chạy được CLI trên máy chủ: ${error.message}`;
  });
  child.on('close', (code) => {
    clearTimeout(session.timer);
    if (session.state === 'failed') return;
    const text = stripAnsi(session.output);
    if (code === 0) {
      session.state = 'done';
      session.message = 'Đã đăng nhập.';
    } else {
      session.state = 'failed';
      const last = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
      session.message = `Đăng nhập không thành công${last ? `: ${last.slice(0, 200)}` : ''}.`;
    }
  });

  // Đợi CLI in link (thường dưới 3 giây) để lần trả lời đầu đã có link cho CEO bấm.
  for (let i = 0; i < 40 && session.state === 'starting'; i += 1) await new Promise((resolve) => setTimeout(resolve, 250));
  return view(session);
}

/** Claude: đưa mã CEO dán vào CLI đang chờ. */
export function submitLoginCode(provider: CliLoginProvider, code: string): CliLoginView | null {
  const session = sessions.get(provider);
  if (!session || session.state !== 'waiting') return null;
  session.child.stdin.write(`${code}\n`);
  session.message = 'Đã gửi mã, đang chờ Claude xác nhận…';
  return view(session);
}

export function cancelLogin(provider: CliLoginProvider): void {
  const session = sessions.get(provider);
  if (!session) return;
  clearTimeout(session.timer);
  if (session.state === 'starting' || session.state === 'waiting') session.child.kill();
  sessions.delete(provider);
}
