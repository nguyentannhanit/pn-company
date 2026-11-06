/**
 * P&N — Client gọi API từ dashboard.
 *
 * §89: frontend không bao giờ giữ API key của provider và không gọi thẳng
 * provider. Nó chỉ nói chuyện với API của P&N bằng token phiên.
 */

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

const TOKEN_KEY = 'pn.session.token';
/** Địa chỉ API do người dùng chỉ định, ưu tiên hơn địa chỉ gắn lúc build. */
const API_KEY = 'pn.api.url';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* -------------------------------------------------------------------------- */
/* Phiên đăng nhập                                                             */
/* -------------------------------------------------------------------------- */

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Trình duyệt chặn localStorage (chế độ riêng tư) — coi như chưa đăng nhập.
    return null;
  }
}

export function setToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* không lưu được thì phiên chỉ sống trong tab hiện tại */
  }
}

/**
 * Dashboard trên Vercel gọi API chạy ở máy công ty qua đường hầm; địa chỉ đường
 * hầm đổi được nên cho phép ghi đè tại chỗ (qua `?api=` hoặc ô ở trang đăng nhập).
 */
export function apiUrl(): string {
  if (typeof window !== 'undefined') {
    try {
      const custom = window.localStorage.getItem(API_KEY);
      if (custom) return custom;
    } catch {
      /* không đọc được thì dùng địa chỉ mặc định */
    }
  }
  return API_URL;
}

/** Ghi nhớ địa chỉ API mới; chỉ nhận http(s) hợp lệ. Trả về true khi có thay đổi. */
export function rememberApiUrl(value: string): boolean {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed && !/^https?:\/\/[^\s/]+$/i.test(trimmed)) return false;
  if (typeof window === 'undefined') return false;
  try {
    const current = window.localStorage.getItem(API_KEY) ?? '';
    if (trimmed === current) return false;
    if (trimmed) window.localStorage.setItem(API_KEY, trimmed);
    else window.localStorage.removeItem(API_KEY);
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Gọi API                                                                     */
/* -------------------------------------------------------------------------- */

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true } = options;
  const token = auth ? getToken() : null;

  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();

  // Thao tác ghi (lưu, tạo, xoá…) xong thì báo cho ClickSounds kêu "ting" hoặc tiếng lỗi. Chỉ phát sự kiện, không phụ
  // thuộc vào bộ âm thanh — trang nào không cần thì bỏ qua.
  if (method !== 'GET' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pn:api-result', { detail: { method, path, ok: response.ok, status: response.status } }));
  }

  if (!response.ok) {
    // Phiên hết hạn thì xoá token để layout đưa người dùng về trang đăng nhập.
    if (response.status === 401) setToken(null);
    throw new ApiError(response.status, parseError(text) ?? `HTTP ${response.status}`);
  }

  return (text ? JSON.parse(text) : {}) as T;
}

function parseError(text: string): string | null {
  try {
    const payload = JSON.parse(text) as {
      error?: string;
      fix?: string;
      issues?: Array<{ message: string }>;
    };
    if (payload.issues?.length) {
      return payload.issues.map((issue) => issue.message).join('; ');
    }
    // Một số lỗi kèm chỉ dẫn bước cần làm; giữ lại vì đó mới là phần hữu ích
    // với người dùng — bản thân câu lỗi chỉ nói cái gì sai, không nói làm gì.
    if (payload.error && payload.fix) return `${payload.error}

→ ${payload.fix}`;
    return payload.error ?? null;
  } catch {
    return text.slice(0, 200) || null;
  }
}

/* -------------------------------------------------------------------------- */
/* Kiểu dữ liệu dùng ở giao diện                                               */
/* -------------------------------------------------------------------------- */

export interface AgentRow {
  id: string;
  role: string;
  displayName: string;
  department: string;
  state: string;
  currentTaskId: string | null;
  currentProjectId: string | null;
  isEnabled: boolean;
  xp: number;
  stateChangedAt: string;
  /** Thời điểm hoàn thành từ event thật, chỉ dùng cho động tác kết thúc ngắn. */
  lastCompletedAt?: number;
  /** Tiến độ thật của lượt đang làm (AGENT_PROGRESS), bong bóng 3D hiện thanh phần trăm. */
  progress?: { pct: number; text: string };
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  productType: string;
  status: string;
  budgetUsd: number;
  spentUsd: number;
  repoFullName: string | null;
  createdAt: string;
  /** Số task theo từng trạng thái. Chỉ có ở danh sách dự án. */
  taskCounts?: Record<string, number>;
}

export interface TaskRow {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignedRole: string | null;
  fixLoopCount: number;
}

export interface BugRow {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
}

export interface ApprovalRow {
  id: string;
  kind: string;
  title: string;
  summary: string;
  status: string;
  createdAt: string;
}

/** §68 — một dòng trong bảng tích hợp; `secretRefs` không bao giờ ra tới đây. */
export interface IntegrationRow {
  id: string;
  kind: string;
  displayName: string;
  isEnabled: boolean;
  status: string;
  settings: Record<string, unknown>;
  hasSecrets: boolean;
  lastTestedAt: string | null;
  lastError: string | null;
}

/** §54, §55 — một chính sách ngân sách. */
export interface BudgetPolicyRow {
  id: string;
  scope: string;
  scopeId: string | null;
  limitUsd: number;
  period: string;
  warnThreshold: number;
  hardStop: boolean;
  spentUsd?: number;
}

/** §28, §71 — một dòng nhật ký kiểm toán. */
export interface AuditRow {
  id: string;
  actor: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CostSummary {
  today: { costUsd: number; calls: number; unpricedCalls: number };
  month: { costUsd: number; calls: number; unpricedCalls: number };
  byProject: Array<{ key: string; label: string; costUsd: number; calls: number }>;
  byAgent: Array<{ key: string; label: string; costUsd: number; calls: number }>;
  byModel: Array<{ key: string; label: string; costUsd: number; calls: number }>;
  byProvider: Array<{ key: string; label: string; costUsd: number; calls: number }>;
  daily: Array<{ day: string; costUsd: number; calls: number }>;
  note: string | null;
  /** Mốc "đếm lại chi phí" gần nhất (ISO); null là đếm từ đầu. */
  countFrom?: string | null;
}

export interface HealthReport {
  company: string;
  environment: string;
  ready: boolean;
  checks: Array<{ id: string; label: string; ok: boolean; detail: string }>;
  providers: Array<{
    provider: string;
    displayName: string;
    status: string;
    keyPreview: string | null;
    hasKey: boolean;
    isEnabled: boolean;
    defaultModel: string | null;
    lastError: string | null;
  }>;
  circuitBreakers: Array<{ key: string; state: string }>;
  sandboxEnforcement: Record<string, boolean | string>;
}
