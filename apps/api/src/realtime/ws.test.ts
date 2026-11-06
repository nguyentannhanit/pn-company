/** Kiểm tra đường dữ liệu thật từ dịch vụ trạng thái qua WebSocket đến cảnh 3D. */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { newId } from '@pn/shared';
import { applyAgentEvent, type RealtimeEvent } from '../../../web/src/lib/store';
import type { AgentRow } from '../../../web/src/lib/api';
import { createTestApp, type TestHarness } from '../test/fixtures.js';

let harness: TestHarness | undefined;
let connection: WebSocket | undefined;

/** Đóng socket và ứng dụng thử; không đụng database hoặc tài khoản của công ty. */
afterEach(async () => {
  connection?.terminate();
  await harness?.app.close();
  await harness?.context.shutdown();
});

describe('WebSocket → nhân viên 3D', () => {
  it('giữ đúng task, dự án và trạng thái bị chặn sau khi kết nối lại', async () => {
    harness = await createTestApp();
    const token = await harness.loginAsCeo();
    const address = await harness.app.listen({ port: 0, host: '127.0.0.1' });
    const url = address.replace(/^http/, 'ws') + '/ws?token=' + token;
    connection = new WebSocket(url);
    const messages: Array<{ type: string; agents?: AgentRow[]; event?: RealtimeEvent }> = [];
    connection.on('message', (data: Buffer) => messages.push(JSON.parse(data.toString())));
    await expect.poll(() => messages.some((message) => message.type === 'snapshot')).toBe(true);
    let agents = messages.find((message) => message.type === 'snapshot')!.agents!;
    expect(agents.find((agent) => agent.role === 'CTO_ORCHESTRATOR')?.state).toBe('idle');

    const taskId = newId();
    const projectId = newId();
    await harness.context.agentState.transition('CTO_ORCHESTRATOR', 'working', {
      taskId,
      projectId,
    });
    await expect.poll(() => messages.filter((message) => message.type === 'event').length).toBe(1);
    agents = applyAgentEvent(agents, messages.find((message) => message.type === 'event')!.event!);
    expect(agents.find((agent) => agent.role === 'CTO_ORCHESTRATOR')).toMatchObject({
      state: 'working',
      currentTaskId: taskId,
      currentProjectId: projectId,
    });

    await harness.context.agentState.transition('CTO_ORCHESTRATOR', 'blocked', {
      taskId,
      projectId,
    });
    await expect.poll(() => messages.filter((message) => message.type === 'event').length).toBe(2);
    agents = applyAgentEvent(agents, messages.at(-1)!.event!);
    expect(agents.find((agent) => agent.role === 'CTO_ORCHESTRATOR')?.state).toBe('blocked');

    connection.terminate();
    connection = new WebSocket(url);
    const snapshots: AgentRow[][] = [];
    connection.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString()) as { type: string; agents: AgentRow[] };
      if (message.type === 'snapshot') snapshots.push(message.agents);
    });
    await expect.poll(() => snapshots.length).toBe(1);
    expect(snapshots[0]!.find((agent) => agent.role === 'CTO_ORCHESTRATOR')).toMatchObject({
      state: 'blocked',
      currentTaskId: taskId,
      currentProjectId: projectId,
    });
    expect(snapshots[0]!.find((agent) => agent.role === 'QA')?.state).toBe('idle');
  });
});
