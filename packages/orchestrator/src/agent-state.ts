/**
 * P&N — Dịch vụ trạng thái agent (§8, §9).
 *
 * §9 là ràng buộc quan trọng nhất của lớp 3D: animation phải gắn với trạng thái
 * THẬT. Vì thế mọi thay đổi trạng thái agent đều đi qua đúng một cửa này, và
 * cửa này luôn làm hai việc cùng lúc: ghi database rồi phát event. Không có
 * đường nào đổi state mà dashboard không biết.
 */

import type { Repositories } from '@pn/database';
import type { EventBus } from '@pn/events';
import { canTransition } from '@pn/agents';
import type { Agent, AgentRole, AgentState, Uuid } from '@pn/shared';

export class InvalidStateTransitionError extends Error {
  constructor(
    readonly role: AgentRole,
    readonly from: AgentState,
    readonly to: AgentState,
  ) {
    super(`Agent ${role} không thể chuyển từ "${from}" sang "${to}" (spec §8.1)`);
    this.name = 'InvalidStateTransitionError';
  }
}

export class AgentStateService {
  constructor(
    private readonly repos: Repositories,
    private readonly events: EventBus,
  ) {}

  /**
   * Đổi trạng thái agent và phát event tương ứng.
   *
   * Chuyển trạng thái không hợp lệ bị từ chối chứ không "sửa cho xong" — nếu
   * logic gọi sai thì phải lộ ra ngay, vì nhân vật 3D đang phản ánh dữ liệu này.
   */
  async transition(
    role: AgentRole,
    to: AgentState,
    context: { taskId?: Uuid | null; projectId?: Uuid | null } = {},
  ): Promise<Agent> {
    const agent = await this.repos.agents.findByRole(role);
    if (!agent) throw new Error(`Chưa có agent nào với vai trò ${role}`);

    if (!canTransition(agent.state, to)) {
      throw new InvalidStateTransitionError(role, agent.state, to);
    }
    if (agent.state === to && agent.currentTaskId === (context.taskId ?? null)) {
      return agent; // không có gì đổi thì không phát event thừa
    }

    const updated = await this.repos.agents.setState(agent.id, to, context);

    await this.events.publish(
      'AGENT_STATE_CHANGED',
      { agentRole: role, from: agent.state, to },
      {
        agentId: agent.id,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        actor: `agent:${agent.id}`,
      },
    );

    return updated;
  }

  /** Đưa toàn bộ agent về idle — dùng khi API khởi động lại sau sự cố. */
  async resetAll(): Promise<number> {
    const agents = await this.repos.agents.list();
    let count = 0;
    for (const agent of agents) {
      if (agent.state === 'idle' || agent.state === 'offline') continue;
      await this.repos.agents.setState(agent.id, 'idle', {});
      await this.events.publish(
        'AGENT_STATE_CHANGED',
        { agentRole: agent.role, from: agent.state, to: 'idle' },
        { agentId: agent.id },
      );
      count += 1;
    }
    return count;
  }

  /** Ảnh chụp trạng thái cho lần kết nối WebSocket đầu tiên (§22). */
  async snapshot(): Promise<Agent[]> {
    return this.repos.agents.list();
  }
}
