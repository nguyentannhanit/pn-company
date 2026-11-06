/**
 * P&N — Cổng gọi model qua HTTP, dành cho tiến trình chạy tách rời API (§89).
 *
 * Tiến trình worker KHÔNG cầm API key của provider và không cầm master key. Nó
 * gọi `/ai/generate` của API bằng một phiên dịch vụ, nên mọi ràng buộc vẫn giữ
 * nguyên: kiểm ngân sách trước khi tiêu, định tuyến theo vai trò, ghi
 * `cost_records` và `api_request_logs`.
 */

import type {
  AgentGatewayClient,
  AgentGenerateRequest,
  AgentGenerateResult,
} from './gateway-client.js';

export interface HttpAgentGatewayOptions {
  /** Gốc API, ví dụ `http://127.0.0.1:4000`. */
  baseUrl: string;
  /** Token phiên dịch vụ; worker xin ở `/internal/service/session`. */
  token: string;
}

export class HttpAgentGateway implements AgentGatewayClient {
  constructor(private readonly options: HttpAgentGatewayOptions) {}

  async generate(request: AgentGenerateRequest): Promise<AgentGenerateResult> {
    const { signal, ...body } = request;

    const response = await fetch(`${this.options.baseUrl}/ai/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      // Giữ nguyên câu lỗi API trả về: nó đã đi qua redaction ở phía API, và nó
      // là thứ duy nhất nói được vì sao lượt gọi này hỏng.
      throw new Error(
        typeof payload['error'] === 'string'
          ? payload['error']
          : `AI Gateway trả HTTP ${response.status}`,
      );
    }

    return {
      text: String(payload['text'] ?? ''),
      provider: String(payload['provider'] ?? ''),
      model: String(payload['model'] ?? ''),
      costUsd: typeof payload['costUsd'] === 'number' ? payload['costUsd'] : null,
      usage: (payload['usage'] as AgentGenerateResult['usage']) ?? {
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
      },
    };
  }
}
