/**
 * P&N — Bản chạy trong tiến trình của `AgentGatewayClient` (§89).
 *
 * Agent chạy cùng tiến trình API nên không cần thêm một chặng HTTP; nó gọi thẳng
 * `AiGateway`. Điều quan trọng của §89 vẫn được giữ: chỉ có đúng một cổng ra
 * provider, và cổng đó vẫn kiểm ngân sách, định tuyến, ghi cost và ghi log.
 *
 * Khi tách `apps/worker` thành tiến trình riêng, chỉ cần thay lớp này bằng bản
 * gọi HTTP tới `/ai/generate` — agent không đổi một dòng nào.
 */

import type { AgentGatewayClient, AgentGenerateRequest, AgentGenerateResult } from '@pn/agents';

import type { AiGateway } from './ai-gateway.js';

export class InProcessAgentGateway implements AgentGatewayClient {
  constructor(private readonly gateway: AiGateway) {}

  async generate(request: AgentGenerateRequest): Promise<AgentGenerateResult> {
    const result = await this.gateway.generate({
      agentRole: request.agentRole,
      system: request.system,
      messages: request.messages,
      projectId: request.projectId ?? null,
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      agentId: request.agentId ?? null,
      ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
      ...(request.taskKind ? { taskKind: request.taskKind } : {}),
      ...(request.avoidModels ? { avoidModels: request.avoidModels } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });

    return {
      text: result.text,
      provider: result.provider,
      model: result.model,
      costUsd: result.costUsd,
      usage: result.usage,
    };
  }
}
