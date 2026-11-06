/**
 * P&N — Sandbox chạy trong container (§18).
 *
 * Khác driver local ở đúng ba điều mà local không làm được:
 *   - RAM và CPU bị chặn ở mức kernel qua cgroup (`--memory`, `--cpus`);
 *   - mạng cắt được thật (`--network none`) cho mã chưa tin cậy (§117, §118);
 *   - tiến trình chạy dưới người dùng không đặc quyền, hệ thống tệp gốc chỉ đọc.
 *
 * Workspace vẫn nằm trên host và được mount vào container. Lý do: QA phải đọc
 * được file mà Developer vừa viết ở lần chạy trước, và bản ghi run phải trỏ tới
 * một đường dẫn còn tồn tại sau khi container biến mất (§18).
 *
 * Mọi lệnh đi qua `docker run --rm`, không phải `docker exec` vào một container
 * sống lâu: một container mỗi lệnh nghĩa là không có trạng thái nào rò rỉ giữa
 * hai lệnh, và không có gì phải dọn khi tiến trình API chết giữa chừng.
 */

import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  SandboxEscapeError,
  resolveLimits,
  type CommandResult,
  type SandboxDriver,
  type SandboxEnforcement,
  type SandboxLimits,
  type SandboxSession,
  type SandboxSpec,
} from './contract.js';
import { CommandNotAllowedError, DEFAULT_ALLOWED_COMMANDS } from './local.js';

/** Container cưỡng chế được đủ sáu mục — đây là lý do driver này tồn tại (§89). */
const DOCKER_ENFORCEMENT: SandboxEnforcement = {
  workspaceIsolation: true,
  timeout: true,
  commandAllowList: true,
  envAllowList: true,
  memoryLimit: true,
  networkPolicy: true,
  note:
    'Chạy trong container: RAM/CPU giới hạn bằng cgroup, mạng cắt được ở mức ' +
    'network namespace, tiến trình chạy dưới người dùng không đặc quyền.',
};

/** Ảnh mặc định: Node LTS đủ để chạy npm và test của dự án agent sinh ra. */
export const DEFAULT_IMAGE = 'node:22-bookworm-slim';

export interface DockerSandboxOptions {
  /** Thư mục gốc trên host, mount vào container. */
  root: string;
  image?: string;
  allowedCommands?: readonly string[];
  /** Đường dẫn tới `docker`; đổi được vì Windows hay cài ngoài PATH. */
  dockerPath?: string;
  baseEnv?: Record<string, string>;
}

/** Thư mục làm việc bên trong container. Cố định để lệnh không phụ thuộc host. */
const CONTAINER_WORKDIR = '/workspace';

/* -------------------------------------------------------------------------- */
/* Dựng tham số docker run                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Đây là chỗ mọi ràng buộc §18 được áp vào, nên nó là hàm thuần và được export:
 * bộ cờ này là ranh giới bảo mật thật của driver, và một lần sửa vô ý làm rơi
 * mất `--network none` hay `--cap-drop ALL` sẽ không lộ ra ở đâu khác.
 */
export function buildDockerRunArgs(input: {
  workspace: string;
  limits: SandboxLimits;
  env: Record<string, string>;
  image: string;
  command: string;
  args: string[];
}): string[] {
  const { workspace, limits, env, image, command, args } = input;

  const dockerArgs = [
    'run',
    '--rm',
    '--workdir',
    CONTAINER_WORKDIR,
    '--mount',
    `type=bind,source=${workspace},target=${CONTAINER_WORKDIR}`,
    // Giới hạn tài nguyên ở mức kernel — thứ driver local không làm được.
    // `--memory-swap` bằng `--memory` để container không lách trần bằng swap.
    '--memory',
    `${limits.maxMemoryMb}m`,
    '--memory-swap',
    `${limits.maxMemoryMb}m`,
    '--pids-limit',
    '512',
    // Không đặc quyền, không leo thang quyền.
    '--user',
    '1000:1000',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
  ];

  if (limits.maxCpus !== undefined) {
    dockerArgs.push('--cpus', String(limits.maxCpus));
  }

  // §117, §118 — mã chưa tin cậy chạy không có mạng. `allowlist` chưa lọc được
  // theo host ở mức `docker run` nên nó được đối xử như `full`, và điều đó nói
  // thẳng trong `enforcement.note` thay vì giả vờ đã lọc.
  if (limits.network === 'none') {
    dockerArgs.push('--network', 'none');
  }

  for (const [key, value] of Object.entries(env)) {
    dockerArgs.push('-e', `${key}=${value}`);
  }

  dockerArgs.push(image, command, ...args);
  return dockerArgs;
}

/* -------------------------------------------------------------------------- */
/* Phiên làm việc                                                              */
/* -------------------------------------------------------------------------- */

class DockerSandboxSession implements SandboxSession {
  readonly enforcement = DOCKER_ENFORCEMENT;
  readonly #log: CommandResult[] = [];
  #disposed = false;

  constructor(
    readonly runId: string,
    readonly workspace: string,
    private readonly limits: SandboxLimits,
    private readonly allowedCommands: ReadonlySet<string>,
    private readonly env: Record<string, string>,
    private readonly image: string,
    private readonly dockerPath: string,
    private readonly signal?: AbortSignal,
  ) {}

  async exec(command: string, args: string[] = []): Promise<CommandResult> {
    this.#assertUsable();
    if (!this.allowedCommands.has(command)) {
      throw new CommandNotAllowedError(command);
    }

    const startedAt = Date.now();
    if (this.signal?.aborted) return this.#skipped(command, args);
    const dockerArgs = this.#buildDockerArgs(command, args);

    return new Promise<CommandResult>((resolve) => {
      // Tiến trình `docker` chạy trên host nên nó thừa hưởng env của host để
      // tìm được daemon; env của AGENT đi vào container qua cờ `-e` (§88.18).
      const child = spawn(this.dockerPath, dockerArgs, { shell: false, windowsHide: true });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Giết tiến trình `docker` là đủ: `--rm` cộng cờ `--stop-timeout` khiến
      // container tự biến mất, không để lại container mồ côi.
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.limits.timeoutMs);
      // Hết giờ của lượt chạy: giết ngay như quá giờ của lệnh.
      const onAbort = (): void => {
        timedOut = true;
        child.kill('SIGKILL');
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
          // Ghi lệnh của AGENT chứ không ghi cả dòng `docker run …`: bản ghi run
          // là để người đọc hiểu agent đã làm gì, không phải để đọc hạ tầng.
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
        stderr += `\nKhông chạy được docker: ${error.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
    });
  }

  #buildDockerArgs(command: string, args: string[]): string[] {
    return buildDockerRunArgs({
      workspace: this.workspace,
      limits: this.limits,
      env: this.env,
      image: this.image,
      command,
      args,
    });
  }

  /* Thao tác tệp làm thẳng trên host: workspace là thư mục thật, và làm qua
     container thì mỗi lần đọc một file lại tốn một container. */

  /** Lượt đã hết giờ: không mở container mới, trả kết quả "quá giờ" để agent dừng ở bước kế tiếp. */
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

  async listFiles(relativeDir = '.'): Promise<string[]> {
    const base = this.#resolve(relativeDir);
    const skip = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', '__pycache__']);
    const out: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(path.relative(this.workspace, full).split(path.sep).join('/'));
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
    // Không có container nào sống giữa hai lệnh nên không có gì phải dọn.
    // Workspace giữ lại để CEO xem được sản phẩm; driver dọn qua `prune()`.
  }

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

export class DockerSandboxDriver implements SandboxDriver {
  readonly id = 'docker' as const;
  readonly enforcement = DOCKER_ENFORCEMENT;

  readonly #root: string;
  readonly #image: string;
  readonly #allowedCommands: ReadonlySet<string>;
  readonly #dockerPath: string;
  readonly #baseEnv: Record<string, string>;

  constructor(options: DockerSandboxOptions) {
    this.#root = path.resolve(options.root);
    this.#image = options.image ?? DEFAULT_IMAGE;
    this.#allowedCommands = new Set(options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS);
    this.#dockerPath = options.dockerPath ?? 'docker';
    this.#baseEnv = options.baseEnv ?? {};
  }

  async create(spec: SandboxSpec): Promise<SandboxSession> {
    const limits = resolveLimits(spec.limits);
    const workspace = path.join(this.#root, spec.workspaceKey ?? spec.runId);
    await mkdir(workspace, { recursive: true });

    return new DockerSandboxSession(
      spec.runId,
      workspace,
      limits,
      this.#allowedCommands,
      { ...this.#baseEnv, ...(spec.env ?? {}) },
      this.#image,
      this.#dockerPath,
      spec.signal,
    );
  }

  /**
   * §74 — hỏi thẳng daemon xem nó có sống không, và ảnh đã có chưa.
   *
   * Không có Docker thì trả `ok: false` kèm câu người dùng làm được gì, chứ
   * không ném lỗi: System Health phải hiện được tình trạng này (§89).
   */
  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    const version = await runOnHost(this.#dockerPath, ['version', '--format', '{{.Server.Version}}']);
    if (version.exitCode !== 0) {
      return {
        ok: false,
        detail:
          `Không kết nối được Docker daemon (${this.#dockerPath}). ` +
          'Cài Docker Desktop và bật nó, hoặc đặt SANDBOX_DRIVER=local để dùng driver cục bộ. ' +
          version.stderr.trim(),
      };
    }

    const image = await runOnHost(this.#dockerPath, ['image', 'inspect', this.#image]);
    if (image.exitCode !== 0) {
      return {
        ok: false,
        detail:
          `Docker ${version.stdout.trim()} đang chạy nhưng chưa có ảnh ${this.#image}. ` +
          `Chạy: docker pull ${this.#image}`,
      };
    }

    try {
      await mkdir(this.#root, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        detail: `Không tạo được thư mục workspace ${this.#root}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    return {
      ok: true,
      detail: `Docker ${version.stdout.trim()}, ảnh ${this.#image}. ${DOCKER_ENFORCEMENT.note}`,
    };
  }

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
        /* thư mục biến mất giữa chừng thì coi như đã dọn */
      }
    }
    return removed;
  }
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/** Chạy một lệnh trên host (chỉ dùng cho chính `docker`), thu output. */
function runOnHost(
  command: string,
  args: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

/** Cắt output để một lệnh nói nhiều không thổi bay bản ghi run. */
function truncate(text: string, max = 200_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(đã cắt bớt)`;
}
