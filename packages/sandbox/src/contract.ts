/**
 * P&N — Hợp đồng sandbox thực thi (§18).
 *
 * §18: coding agent không bao giờ được chạy trên host production. Mỗi lần chạy
 * có workspace cô lập, giới hạn tài nguyên, timeout, chính sách mạng, và bản ghi
 * đầy đủ `run_id / task_id / workspace / command log / stdout / stderr /
 * exit code`.
 *
 * Phase 0 chỉ định nghĩa hợp đồng driver. Theo §40.9, interface chốt từ bây giờ,
 * phần hiện thực làm sau:
 *   - `LocalSandboxDriver`  — Phase 1 (thư mục làm việc cô lập + timeout cứng)
 *   - `DockerSandboxDriver` — Phase 2 (container, giới hạn cgroup, chính sách mạng)
 */

import type { Uuid } from '@pn/shared';

export type NetworkPolicy =
  /** Chặn hoàn toàn mạng ra ngoài — mặc định cho code chưa tin cậy (§117, §118). */
  | 'none'
  /** Chỉ các host trong allow-list (registry gói, repo của chính dự án). */
  | 'allowlist'
  /** Không giới hạn — phải có phê duyệt tường minh (§27). */
  | 'full';

export interface SandboxLimits {
  timeoutMs: number;
  maxMemoryMb: number;
  maxCpus?: number;
  maxDiskMb?: number;
  network: NetworkPolicy;
  allowedHosts?: string[];
}

/**
 * Đối số `npm install` dùng chung trong sandbox. npm 11 bỏ qua install script
 * của gói lạ (electron tải binary, esbuild…) nếu không cho phép rõ — Electron
 * mà thiếu binary thì không dựng được .exe. Workspace đã cô lập theo §18, và
 * `npm test` vẫn chạy mã của gói, nên cho phép script lúc cài không mở thêm rủi ro.
 */
export const NPM_INSTALL_ARGS: readonly string[] = [
  'install',
  '--no-audit',
  '--no-fund',
  '--dangerously-allow-all-scripts',
];

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 600_000,
  maxMemoryMb: 2048,
  maxCpus: 2,
  maxDiskMb: 4096,
  network: 'allowlist',
};

export interface SandboxSpec {
  /** §18 — mỗi lần chạy đều có định danh và truy vết được. */
  runId: Uuid;
  taskId: Uuid | null;
  projectId: Uuid | null;
  /**
   * Khoá thư mục làm việc. Mặc định là , tức mỗi run một thư mục riêng.
   * Truyền khoá theo dự án khi muốn nhiều run nối tiếp cùng thao tác trên một
   * bản checkout — giống cách một lập trình viên làm việc trên cùng một cây thư
   * mục qua nhiều lần sửa. Bản ghi run vẫn lưu đường dẫn nên §18 vẫn truy vết được.
   */
  workspaceKey?: string;
  /** Repo cần checkout vào workspace, nếu có. */
  repoFullName?: string | null;
  branch?: string | null;
  limits?: Partial<SandboxLimits>;
  /**
   * Biến môi trường cho tiến trình. §88.18 — coding agent không được đọc `.env`
   * của chính nền tảng; chỉ nhận đúng những gì truyền vào đây.
   */
  env?: Record<string, string>;
  /**
   * Hết giờ của lượt chạy (§18): lệnh đang chạy (npm install/test) bị giết ngay, lệnh mới không mở nữa.
   * Không có thì một lệnh treo kéo lượt quá giờ thêm tới 10 phút.
   */
  signal?: AbortSignal;
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Mức cô lập mà một driver THẬT SỰ cưỡng chế được. §89 cấm hệ thống tuyên bố
 * mức bảo vệ nó không có, nên mọi driver phải khai báo trung thực ở đây và
 * dashboard hiển thị đúng những gì đọc được.
 */
export interface SandboxEnforcement {
  workspaceIsolation: boolean;
  timeout: boolean;
  commandAllowList: boolean;
  envAllowList: boolean;
  memoryLimit: boolean;
  networkPolicy: boolean;
  /** Giải thích ngắn cho phần chưa cưỡng chế được. */
  note: string;
}

export interface SandboxSession {
  readonly runId: Uuid;
  /** Mức cô lập thực tế của phiên này. */
  readonly enforcement: SandboxEnforcement;
  /** Đường dẫn tuyệt đối của workspace cô lập. */
  readonly workspace: string;

  exec(command: string, args?: string[]): Promise<CommandResult>;
  readFile(relativePath: string): Promise<string>;
  writeFile(relativePath: string, content: string): Promise<void>;
  listFiles(relativeDir?: string): Promise<string[]>;
  /** Toàn bộ lệnh đã chạy theo thứ tự, để ghi vào bản ghi run (§18). */
  commandLog(): CommandResult[];
  dispose(): Promise<void>;
}

export interface SandboxDriver {
  readonly id: 'local' | 'docker';
  readonly enforcement: SandboxEnforcement;
  create(spec: SandboxSpec): Promise<SandboxSession>;
  /** Kiểm tra driver có thật sự chạy được trên máy này không (§74). */
  healthCheck(): Promise<{ ok: boolean; detail: string }>;
}

export class SandboxTimeoutError extends Error {
  constructor(readonly runId: Uuid, readonly timeoutMs: number) {
    super(`Sandbox run ${runId} exceeded ${timeoutMs}ms (spec §18)`);
    this.name = 'SandboxTimeoutError';
  }
}

export class SandboxEscapeError extends Error {
  constructor(readonly attemptedPath: string) {
    super(`Path "${attemptedPath}" escapes the sandbox workspace (spec §18)`);
    this.name = 'SandboxEscapeError';
  }
}

export function resolveLimits(overrides?: Partial<SandboxLimits>): SandboxLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}
