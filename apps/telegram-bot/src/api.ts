/**
 * P&N — Client gọi API của P&N từ tiến trình bot.
 *
 * §2.2: Telegram không phải agent. Nó không suy nghĩ, không gọi model, không
 * chạm database. Nó chỉ chuyển yêu cầu của CEO tới API và trình bày lại kết quả.
 * Vì thế toàn bộ file này chỉ là các lời gọi HTTP.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Session {
  token: string;
  user: { id: string; displayName: string; role: string };
}

export class PnApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly serviceSecret: string,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Cửa nội bộ                                                              */
  /* ---------------------------------------------------------------------- */

  async bootstrap(): Promise<{ botToken: string; allowedChatIds: string[]; webPublicUrl?: string }> {
    return this.#internal('/internal/telegram/bootstrap', {});
  }

  /** §58 — đổi chat id lấy phiên đúng vai trò; không có quyền thì ném lỗi 403. */
  async session(telegramChatId: string): Promise<Session> {
    return this.#internal<Session>('/internal/telegram/session', { telegramChatId });
  }

  /** Nối chat này với tài khoản có mã trong link mời t.me/...?start=link_<mã>. */
  async linkChat(code: string, telegramChatId: string): Promise<{ user: { id: string; displayName: string; role: string } }> {
    return this.#internal('/internal/telegram/link', { code, telegramChatId });
  }

  /** Link mở dashboard đã đăng nhập sẵn (mã một lần, 2 phút). */
  async loginLink(telegramChatId: string): Promise<{ url: string; expiresInSeconds: number }> {
    return this.#internal('/internal/telegram/login-link', { telegramChatId });
  }

  /* ---------------------------------------------------------------------- */
  /* Nghiệp vụ — luôn dùng phiên của chính người gửi lệnh                    */
  /* ---------------------------------------------------------------------- */

  async createProject(
    session: Session,
    input: { goal: string; productType: string; name?: string },
  ): Promise<{ project: { id: string; name: string; slug: string }; tasks: unknown[]; plan: string }> {
    // CTO phân rã ngay trong request này; qua gói Claude có thể mất vài phút (từng tới 3 phút 45 giây),
    // nên chờ lâu hơn trần 15 phút một lượt agent chứ không dừng ở 5 phút như request thường.
    return this.#request(session, 'POST', '/orchestrator/intake', input, 16 * 60_000);
  }

  /** Trợ lý điều hành: hỏi gì cũng trả lời; yêu cầu làm sản phẩm thì trả về đề nghị tạo dự án. */
  async ask(
    session: Session,
    question: string,
  ): Promise<
    | { intent: 'answer'; text: string }
    | { intent: 'project'; goal: string; name: string; productType: string }
  > {
    return this.#request(session, 'POST', '/assistant/ask', { question });
  }

  async listProjects(session: Session): Promise<{ projects: Array<Record<string, unknown>> }> {
    return this.#request(session, 'GET', '/projects');
  }

  async projectDetail(session: Session, id: string): Promise<Record<string, unknown>> {
    return this.#request(session, 'GET', `/projects/${id}`);
  }

  async listAgents(session: Session): Promise<{ agents: Array<Record<string, unknown>> }> {
    return this.#request(session, 'GET', '/agents');
  }

  async listApprovals(session: Session): Promise<{ approvals: Array<Record<string, unknown>> }> {
    return this.#request(session, 'GET', '/approvals');
  }

  async decideApproval(
    session: Session,
    id: string,
    decision: 'APPROVED' | 'REJECTED',
    note?: string,
  ): Promise<Record<string, unknown>> {
    return this.#request(session, 'POST', `/approvals/${id}/decide`, { decision, note });
  }

  async brief(session: Session): Promise<{ text: string }> {
    return this.#request(session, 'GET', '/reports/brief');
  }

  async costSummary(session: Session): Promise<Record<string, unknown>> {
    return this.#request(session, 'GET', '/cost/summary');
  }

  async health(session: Session): Promise<Record<string, unknown>> {
    return this.#request(session, 'GET', '/api-center/health');
  }

  async orchestratorStatus(session: Session): Promise<{ queueSize: number; implementedRoles: string[] }> {
    return this.#request(session, 'GET', '/orchestrator/status');
  }

  async setProjectStatus(session: Session, id: string, status: string): Promise<unknown> {
    return this.#request(session, 'PATCH', `/projects/${id}/status`, { status });
  }

  /** Xếp chạy lại một việc bị chặn vào hàng đợi của dự án — máy chủ trả lời ngay, không chờ lượt chạy. */
  async runTask(session: Session, id: string): Promise<{ queued: boolean; task: Record<string, unknown> | null }> {
    return this.#request(session, 'POST', `/tasks/${id}/run`, {});
  }

  /** Dừng dự án thật: cắt lượt đang chạy, không nhận việc mới. */
  /** `cancel` = dừng hẳn (không có /resume, làm tiếp bằng "Làm lại dự án" trên web). */
  async stopProject(session: Session, id: string, mode: 'pause' | 'cancel' = 'pause'): Promise<{ aborted: number; reset: number }> {
    return this.#request(session, 'POST', `/projects/${id}/stop`, { mode });
  }

  async resumeProject(session: Session, id: string): Promise<{ queued: number }> {
    return this.#request(session, 'POST', `/projects/${id}/resume`, {});
  }

  async advance(session: Session, id: string): Promise<{ queued: number }> {
    return this.#request(session, 'POST', `/projects/${id}/advance`, {});
  }

  async deploy(
    session: Session,
    projectId: string,
    environment: 'STAGING' | 'PRODUCTION',
    approvalId?: string,
  ): Promise<Record<string, unknown>> {
    return this.#request(session, 'POST', '/deployments', {
      projectId,
      environment,
      ...(approvalId ? { approvalId } : {}),
    });
  }

  /* ---------------------------------------------------------------------- */

  async #internal<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pn-service-secret': this.serviceSecret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiError(response.status, extractError(text) ?? `HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }

  async #request<T>(session: Session, method: string, path: string, body?: unknown, timeoutMs = 300_000): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${session.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(response.status, extractError(text) ?? `HTTP ${response.status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** API luôn trả lỗi ở dạng `{ error }`; lấy đúng câu đó để hiện cho CEO. */
function extractError(text: string): string | null {
  try {
    const payload = JSON.parse(text) as { error?: string };
    return payload.error ?? null;
  } catch {
    return text.slice(0, 300) || null;
  }
}
