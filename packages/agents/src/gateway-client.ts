/**
 * P&N — Cổng gọi model dành cho agent (§89).
 *
 * Agent KHÔNG bao giờ cầm API key và không gọi thẳng provider. Nó chỉ biết
 * interface này. Tiến trình API cắm bản chạy trong tiến trình (dùng thẳng
 * `AiGateway`); tiến trình worker tách rời sẽ cắm bản gọi HTTP tới `/ai/generate`.
 * Cả hai đều đi qua đúng một cổng, nên cost, ngân sách và fallback luôn được
 * ghi nhận như nhau.
 */

import type { AgentRole, AiProviderId, Uuid } from '@pn/shared';

export interface AgentLlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentGenerateRequest {
  agentRole: AgentRole;
  system: string;
  messages: AgentLlmMessage[];
  projectId?: Uuid | null;
  taskId?: Uuid | null;
  runId?: Uuid | null;
  agentId?: Uuid | null;
  maxOutputTokens?: number;
  /** Gợi ý loại công việc để router chọn hạng model phù hợp (§52). */
  taskKind?:
    | 'classification'
    | 'summarization'
    | 'formatting'
    | 'code'
    | 'architecture_review'
    | 'debugging'
    | 'general';
  /** Model đã thử và trả JSON hỏng ở lượt trước — gateway bỏ qua khi chọn lại (§53). */
  avoidModels?: Array<{ provider: AiProviderId; model: string }>;
  signal?: AbortSignal;
}

export interface AgentGenerateResult {
  text: string;
  provider: string;
  model: string;
  costUsd: number | null;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
}

export interface AgentGatewayClient {
  generate(request: AgentGenerateRequest): Promise<AgentGenerateResult>;
}
