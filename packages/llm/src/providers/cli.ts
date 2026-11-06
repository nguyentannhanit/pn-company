/**
 * P&N — Phần chung cho provider chạy qua CLI đăng nhập gói thuê bao.
 *
 * Claude Code CLI và Codex CLI là chương trình chính hãng chạy trên máy CEO, đăng nhập bằng tài
 * khoản gói (Claude Pro/Max, ChatGPT). Gọi chúng không tính tiền theo token mà trừ vào hạn mức gói.
 * Ở đây: chạy tiến trình không qua shell (prompt đi qua stdin, không ghép vào dòng lệnh), môi trường
 * tối thiểu (không mang DATABASE_URL, khoá chủ, API key của nền tảng sang), giới hạn số lượt chạy
 * cùng lúc, và phân loại lỗi để router biết khi nào lùi về API.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { AiProviderId } from '@pn/shared';

import { LlmError, type LlmErrorKind, type LlmMessage } from '../types.js';

/** Chương trình cần chạy: tệp thực thi và các đối số đứng trước (ví dụ `node codex.js`). */
export interface CliCommand {
  file: string;
  prefixArgs: string[];
}

export interface CliRun {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Biến môi trường được phép sang CLI: đủ để tìm thư mục đăng nhập và chạy trên Windows, không hơn. */
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'USERNAME',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'LANG', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH',
];

export function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Chạy CLI một lần: ghi prompt vào stdin, đợi thoát; quá giờ hoặc bị huỷ thì giết cả cây tiến trình. */
export function runCli(options: {
  command: CliCommand;
  args: string[];
  input: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    // Lượt đã hết giờ (có thể trong lúc chờ Limiter): không mở tiến trình mới. Sự kiện 'abort' đã phát rồi
    // sẽ không phát lại, nên nghe nó ở dưới là vô ích — tiến trình mở ra sẽ chạy tới hết 20 phút.
    if (options.signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: null, timedOut: false });
      return;
    }
    const child = spawn(options.command.file, [...options.command.prefixArgs, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const kill = (): void => killTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs);
    const onAbort = (): void => kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input, 'utf8');
  });
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* đã thoát */
  }
}

/** Thư mục làm việc trống cho mỗi lượt gọi: CLI không đọc được mã hay tài liệu nào ngoài prompt. */
export async function withWorkDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pn-cli-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeText(file: string, text: string): Promise<void> {
  await writeFile(file, text, 'utf8');
}

/**
 * Gộp hội thoại nhiều lượt thành một prompt: CLI chỉ nhận một lời nhắn. Một lượt thì gửi nguyên văn;
 * nhiều lượt (vòng sửa JSON, dev sửa sau test đỏ) thì đánh dấu rõ ai nói gì để model tiếp đúng mạch.
 */
export function transcript(messages: readonly LlmMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content;
  const turns = messages.map((message) =>
    message.role === 'user'
      ? `<nguoi_dung>\n${message.content}\n</nguoi_dung>`
      : `<tro_ly_luot_truoc>\n${message.content}\n</tro_ly_luot_truoc>`,
  );
  return `Tiếp tục cuộc trao đổi dưới đây với vai trò trợ lý; trả lời lời nhắn cuối của người dùng.\n\n${turns.join('\n\n')}`;
}

/**
 * Phân loại lỗi CLI theo câu chữ: hết hạn mức gói → `quota` (lùi về API, né lâu, báo CEO); đăng nhập hết
 * hạn → `auth` (lùi về API, báo CEO đăng nhập lại); còn lại theo loại thường gặp.
 */
export function classifyCliFailure(text: string): LlmErrorKind {
  if (/hit your (?:\w+ )?limit|usage limit|limit reached|reached your (?:\w+ )?limit|out of (?:extra )?usage|out of credits|spend limit|credit balance/i.test(text)) return 'quota';
  if (/authenticat|oauth|not logged in|log ?in again|please (?:run )?(?:\/)?login|unauthori[sz]ed|\b401\b|invalid api key|token (?:has )?expired/i.test(text)) return 'auth';
  if (/overloaded|\b529\b|\b503\b|capacity/i.test(text)) return 'overloaded';
  if (/rate.?limit|\b429\b|too many requests/i.test(text)) return 'rate_limit';
  if (/not supported|unknown model|invalid model|\b400\b|invalid_request/i.test(text)) return 'invalid_request';
  return 'server';
}

/** Lỗi CLI thành LlmError; không cài CLI (ENOENT) coi như chưa đăng nhập được để router lùi về API và báo CEO. */
export function cliError(provider: AiProviderId, label: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === 'ENOENT') {
    return new LlmError(provider, 'auth', `${label}: chưa cài hoặc không tìm thấy chương trình CLI trên máy`, undefined, error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmError(provider, classifyCliFailure(message), `${label}: ${message.slice(0, 600)}`, undefined, error);
}

/** Giới hạn số lượt CLI chạy cùng lúc: mỗi lượt là một tiến trình nặng và cùng ăn chung hạn mức gói. */
export class Limiter {
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.max) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }
}
