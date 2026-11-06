/**
 * Thẻ "Mô tả công việc": đọc từ chính bản chỉ dẫn agent đang làm theo, không phải chữ viết tay.
 */

import { describe, expect, it } from 'vitest';

import { AgentRegistry, coreAgents, webAgents } from '@pn/agents';

import { agentJob } from './services/agent-job.js';

const registry = new AgentRegistry();
for (const agent of [...coreAgents(), ...webAgents()]) registry.register(agent);

describe('mô tả công việc của nhân viên AI', () => {
  it('lấy vai trò, các bước và định nghĩa xong từ chỉ dẫn thật', () => {
    const job = agentJob('BACKEND_DEVELOPER', registry);
    expect(job.mission).toContain('Lập trình phần lõi');
    expect(job.steps).toHaveLength(4);
    expect(job.done).toContain('hợp đồng');
    expect(job.active).toBe(true);
  });

  it('biết đứng ở đâu trong dây chuyền: nhận từ ai, giao cho ai, làm cùng ai', () => {
    const [software] = agentJob('QA', registry).stages;
    expect(software).toMatchObject({ from: expect.arrayContaining(['Lập trình máy chủ']), to: ['Kỹ sư an ninh'] });
    expect(agentJob('BACKEND_DEVELOPER', registry).stages[0]!.parallel).toContain('Lập trình giao diện');
  });

  it('vai trò mới có chỗ ngồi mà chưa có mã chạy thì nói thẳng là chưa nhận việc', () => {
    const job = agentJob('SKILL_SCOUT', registry);
    expect(job.active).toBe(false);
    expect(job.mission).not.toBe('');
  });

  it('không lẫn quy chuẩn chung của công ty vào phần riêng của vai trò', () => {
    const job = agentJob('UIUX_DESIGNER', registry);
    expect(job.steps.join(' ')).not.toContain('SỔ QUYẾT ĐỊNH là luật');
    expect(job.document).toContain('Thiết kế giao diện');
  });
});
