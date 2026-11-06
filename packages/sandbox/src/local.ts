/**
 * P&N — Sandbox chạy cục bộ (§18), driver dùng cho Phase 1.
 *
 * Driver này cưỡng chế thật những thứ sau:
 *   - workspace cô lập theo `run_id`, chặn mọi đường dẫn thoát ra ngoài;
 *   - timeout cứng, giết cả cây tiến trình con khi quá giờ;
 *   - allow-list lệnh: chỉ chạy được đúng những executable được phép;
 *   - allow-list biến môi trường: tiến trình con KHÔNG thừa hưởng `process.env`
 *     của nền tảng, nên coding agent không đọc được `.env` (§88.18).
 *
 * Nó KHÔNG cưỡng chế được: giới hạn RAM/CPU ở mức kernel và chính sách mạng.
 * Những thứ đó cần cô lập ở mức container và thuộc `DockerSandboxDriver`
 * (Phase 2). `healthCheck()` và `SandboxSession.enforcement` nói rõ điều này —
 * hệ thống không bao giờ được phép tuyên bố mức cô lập mà nó không có (§89).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  DEFAULT_LIMITS,
  SandboxEscapeError,
  resolveLimits,
  type CommandResult,
  type SandboxDriver,
  type SandboxEnforcement,
  type SandboxLimits,
  type SandboxSession,
  type SandboxSpec,
} from './contract.js';

/** Những gì driver local thật sự cưỡng chế được — khai báo trung thực (§89). */
const LOCAL_ENFORCEMENT: SandboxEnforcement = {
  workspaceIsolation: true,
  timeout: true,
  commandAllowList: true,
  envAllowList: true,
  memoryLimit: false,
  networkPolicy: false,
  note:
    'Driver local không cô lập được RAM/CPU ở mức kernel và không chặn được mạng. ' +
    'Dùng DockerSandboxDriver (Phase 2) khi cần hai điều đó.',
};

/** Executable mà coding agent được phép gọi. Ngoài danh sách này là từ chối. */
export const DEFAULT_ALLOWED_COMMANDS: readonly string[] = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'git',
  'python',
  'python3',
  'pip',
  'pytest',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'prettier',
];

export class CommandNotAllowedError extends Error {
  constructor(readonly command: string) {
    super(`Lệnh "${command}" không nằm trong allow-list của sandbox (spec §18)`);
    this.name = 'CommandNotAllowedError';
  }
}

export interface LocalSandboxOptions {
  /** Thư mục gốc chứa mọi workspace. Mỗi run là một thư mục con theo `run_id`. */
  root: string;
  allowedCommands?: readonly string[];
  /** Biến môi trường tối thiểu cấp cho tiến trình con. */
  baseEnv?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Phiên làm việc                                                              */
/* -------------------------------------------------------------------------- */

class LocalSandboxSession implements SandboxSession {
  readonly enforcement = LOCAL_ENFORCEMENT;
  readonly #log: CommandResult[] = [];
  #disposed = false;

  constructor(
    readonly runId: string,
    readonly workspace: string,
    private readonly limits: SandboxLimits,
    private readonly allowedCommands: ReadonlySet<string>,
    private readonly env: Record<string, string>,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * Chạy một lệnh trong workspace. Trả về kết quả kể cả khi lệnh lỗi — lỗi thực
   * thi là dữ liệu để agent xử lý, không phải exception làm đứt luồng.
   */
  async exec(command: string, args: string[] = []): Promise<CommandResult> {
    this.#assertUsable();
    if (!this.allowedCommands.has(command)) {
      throw new CommandNotAllowedError(command);
    }

    const startedAt = Date.now();
    if (this.signal?.aborted) return this.#skipped(command, args);
    const [file, fileArgs] = resolveExecutable(command, args);
    return new Promise<CommandResult>((resolve) => {
      const child = spawn(file, fileArgs, {
        cwd: this.workspace,
        env: this.env,
        shell: false, // không qua shell để không mở đường cho chuỗi lệnh ghép
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, this.limits.timeoutMs);
      const onAbort = (): void => {
        timedOut = true;
        killTree(child.pid);
      };
      this.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const finish = (exitCode: number | null): void => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
        const result: CommandResult = {
          command: [command, ...args].join(' '),
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode,
          durationMs: Date.now() - startedAt,
          timedOut,
        };
        this.#log.push(result);
        resolve(result);
      };

      child.on('error', (error) => {
        stderr += `\n${error.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  /** Lượt đã hết giờ: không mở lệnh mới, trả kết quả "quá giờ" để agent dừng ở bước kế tiếp. */
  #skipped(command: string, args: string[]): CommandResult {
    const result: CommandResult = {
      command: [command, ...args].join(' '),
      stdout: '',
      stderr: 'Không chạy: lượt đã hết giờ',
      exitCode: null,
      durationMs: 0,
      timedOut: true,
    };
    this.#log.push(result);
    return result;
  }

  async readFile(relativePath: string): Promise<string> {
    return readFile(this.#resolve(relativePath), 'utf8');
  }

  async writeFile(relativePath: string, content: string): Promise<void> {
    const target = this.#resolve(relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  /** Liệt kê file trong workspace, bỏ qua thư mục nặng và không cần thiết. */
  async listFiles(relativeDir = '.'): Promise<string[]> {
    const base = this.#resolve(relativeDir);
    const skip = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__']);
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          out.push(path.relative(this.workspace, full).split(path.sep).join('/'));
        }
      }
    };

    await walk(base);
    return out.sort();
  }

  commandLog(): CommandResult[] {
    return [...this.#log];
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    // Workspace được giữ lại để CEO xem được sản phẩm của lần chạy; việc dọn dẹp
    // là trách nhiệm của driver qua `prune()`.
  }

  /** Chặn path traversal — đây là ranh giới cô lập thật của driver local. */
  #resolve(relativePath: string): string {
    const target = path.resolve(this.workspace, relativePath);
    const root = path.resolve(this.workspace);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new SandboxEscapeError(relativePath);
    }
    return target;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new Error(`Sandbox ${this.runId} đã đóng, không chạy thêm lệnh được`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Driver                                                                      */
/* -------------------------------------------------------------------------- */

export class LocalSandboxDriver implements SandboxDriver {
  readonly id = 'local' as const;
  readonly enforcement = LOCAL_ENFORCEMENT;

  readonly #root: string;
  readonly #allowedCommands: ReadonlySet<string>;
  readonly #baseEnv: Record<string, string>;

  constructor(options: LocalSandboxOptions) {
    this.#root = path.resolve(options.root);
    this.#allowedCommands = new Set(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
    this.#baseEnv = options.baseEnv ?? minimalEnv();
  }

  async create(spec: SandboxSpec): Promise<SandboxSession> {
    const limits = resolveLimits(spec.limits);
    const workspace = path.join(this.#root, spec.workspaceKey ?? spec.runId);
    await mkdir(workspace, { recursive: true });

    // §88.18 — chỉ những biến truyền vào tường minh, cộng PATH tối thiểu.
    const env = { ...this.#baseEnv, ...(spec.env ?? {}) };

    return new LocalSandboxSession(spec.runId, workspace, limits, this.#allowedCommands, env, spec.signal);
  }

  /** §74 — kiểm tra thư mục gốc ghi được và nói rõ mức cô lập đạt được. */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.#root, { recursive: true });
      const probe = path.join(this.#root, '.pn-health');
      await writeFile(probe, 'ok', 'utf8');
      await rm(probe, { force: true });
      return {
        ok: true,
        detail: `Sandbox local sẵn sàng tại ${this.#root}. ${LOCAL_ENFORCEMENT.note}`,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `Không ghi được vào ${this.#root}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** Xoá workspace của các run đã quá `maxAgeMs` để đĩa không phình vô hạn. */
  async prune(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<string[]> {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.#root);
    } catch {
      return removed;
    }

    const now = Date.now();
    for (const entry of entries) {
      const full = path.join(this.#root, entry);
      try {
        const info = await stat(full);
        if (now - info.mtimeMs > maxAgeMs) {
          await rm(full, { recursive: true, force: true });
          removed.push(entry);
        }
      } catch {
        // Thư mục biến mất giữa chừng thì bỏ qua, không phải lỗi.
      }
    }
    return removed;
  }
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/** Giết cả cây tiến trình con; Windows cần taskkill vì không có process group. */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Tiến trình đã chết trước đó.
    }
  }
}

/**
 * Windows: `npm`/`npx` là file `.cmd`; spawn không qua shell thì ENOENT, và Node
 * mới còn từ chối chạy `.cmd` khi không có shell. Gọi thẳng file JS của npm
 * bằng đúng node đang chạy — vẫn không qua shell nên không mở đường ghép chuỗi
 * lệnh. Lỗi thật đã gặp: QA không chạy được `npm test` và chặn cả dự án.
 */
function resolveExecutable(command: string, args: string[]): [string, string[]] {
  if (process.platform !== 'win32' || (command !== 'npm' && command !== 'npx')) return [command, args];
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', `${command}-cli.js`);
  return existsSync(cli) ? [process.execPath, [cli, ...args]] : [command, args];
}

/** Cắt bớt log dài để một lệnh nói nhiều không làm nổ bản ghi run. */
function truncate(text: string, max = 100_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[đã cắt bớt ${text.length - max} ký tự]`;
}

/**
 * Bộ biến môi trường tối thiểu. Cố tình KHÔNG sao chép `process.env` để không
 * có secret nào của nền tảng rò vào tiến trình con (§19, §88.18).
 */
export function minimalEnv(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    LANG: 'en_US.UTF-8',
    CI: 'true',
    NODE_ENV: 'test',
  };
  if (process.platform === 'win32') {
    // Windows cần vài biến hệ thống thì mới spawn được tiến trình.
    for (const key of ['SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE']) {
      const value = process.env[key];
      if (value) env[key] = value;
    }
    // npm chạy script qua cmd.exe, mà cmd.exe coi `&` trong đường dẫn workspace
    // (ví dụ "P&N App") là nối lệnh: `vite build` chết với "'N' is not
    // recognized". Git Bash trích dẫn đường dẫn đúng; có nó thì dùng làm shell.
    const bash = windowsBash();
    if (bash) env['npm_config_script_shell'] = bash;
  }
  return env;
}

/** Git Bash ở vị trí cài mặc định; không có thì trả null và npm dùng cmd.exe như cũ. */
export function windowsBash(): string | null {
  const candidates = [
    process.env['PN_SCRIPT_SHELL'],
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate) && existsSync(candidate!)) ?? null;
}

export { DEFAULT_LIMITS };
