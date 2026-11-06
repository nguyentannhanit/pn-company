/**
 * P&N — Hợp đồng giữa event của máy chủ và chuyển động trong cảnh 3D (§9).
 *
 * Đây là chỗ dễ trượt nhất: chỉ cần frontend đoán thêm một chuyển giao không có
 * trong event là văn phòng 3D bắt đầu diễn kịch. Bộ test này giữ đúng một luật:
 * event nói gì thì vẽ nấy, không nói thì không vẽ.
 */

import { describe, expect, it } from 'vitest';

import { applyAgentEvent, readHandoff } from './store';
import type { AgentRow } from './api';

/** Nhân viên đầu vào để kiểm tra state và liên kết công việc được đổi cùng nhau. */
const employee: AgentRow = {
  id: 'a1',
  role: 'BACKEND_DEVELOPER',
  displayName: 'Backend',
  department: 'BACKEND',
  state: 'idle',
  currentTaskId: null,
  currentProjectId: null,
  isEnabled: true,
  xp: 0,
  stateChangedAt: '2026-09-06T10:00:00Z',
};

describe('Đồng bộ nhân viên với công việc thật', () => {
  it('nhận việc cập nhật đồng thời trạng thái, task và dự án', () => {
    const next = applyAgentEvent([employee], {
      id: 'start',
      type: 'AGENT_STATE_CHANGED',
      ts: '2026-09-06T10:01:00Z',
      taskId: 'task-1',
      projectId: 'project-1',
      payload: { agentRole: employee.role, to: 'working' },
    });
    expect(next[0]).toMatchObject({
      state: 'working',
      currentTaskId: 'task-1',
      currentProjectId: 'project-1',
    });
    expect(employee.state).toBe('idle');
  });

  it('nghỉ xóa liên kết cũ để panel không còn báo đang làm task trước', () => {
    const next = applyAgentEvent(
      [{ ...employee, state: 'working', currentTaskId: 't1', currentProjectId: 'p1' }],
      {
        id: 'stop',
        type: 'AGENT_STATE_CHANGED',
        ts: '2026-09-06T10:02:00Z',
        taskId: null,
        projectId: null,
        payload: { agentRole: employee.role, to: 'idle' },
      },
    );
    expect(next[0]).toMatchObject({ state: 'idle', currentTaskId: null, currentProjectId: null });
  });

  it('chỉ event hoàn thành tạo thời điểm cho động tác kết thúc', () => {
    const event = {
      id: 'done',
      type: 'TASK_COMPLETED',
      ts: '2026-09-06T10:03:00Z',
      projectId: 'p1',
      payload: { agentRole: employee.role },
    };
    expect(applyAgentEvent([employee], event)[0]).toMatchObject({
      state: 'idle',
      lastCompletedAt: Date.parse(event.ts),
    });
    expect(applyAgentEvent([employee], { ...event, type: 'TASK_CREATED' })[0]).toEqual(employee);
  });

  it('event một nhân viên không thay đổi người khác', () => {
    const next = applyAgentEvent([employee], {
      id: 'qa',
      type: 'AGENT_STATE_CHANGED',
      ts: '',
      taskId: 'qa-task',
      projectId: 'p1',
      payload: { agentRole: 'QA', to: 'working' },
    });
    expect(next[0]).toBe(employee);
  });
});

describe('Đọc chuyển giao từ event', () => {
  it('CTO tạo task cho Developer là một lần chuyển giao', () => {
    const handoff = readHandoff('e1', 'TASK_CREATED', {
      taskId: 't1',
      title: 'Dựng API đăng nhập',
      assignedRole: 'BACKEND_DEVELOPER',
      fromRole: 'CTO_ORCHESTRATOR',
    });

    expect(handoff).toMatchObject({
      fromRole: 'CTO_ORCHESTRATOR',
      toRole: 'BACKEND_DEVELOPER',
      kind: 'task',
      label: 'Dựng API đăng nhập',
    });
  });

  it('mang theo độ gấp và bước quy trình để người đưa việc xếp thứ tự vòng đi', () => {
    const urgent = readHandoff('e5', 'TASK_CREATED', { title: 'Vá lỗi', assignedRole: 'QA', fromRole: 'CTO_ORCHESTRATOR', priority: 'HIGH', step: 4 });
    expect(urgent).toMatchObject({ priority: 2, step: 4 });
    // Máy chủ cũ chưa gửi hai trường này: coi như việc thường, ngoài quy trình.
    const old = readHandoff('e6', 'TASK_CREATED', { title: 'Việc cũ', assignedRole: 'QA', fromRole: 'CTO_ORCHESTRATOR' });
    expect(old).toMatchObject({ priority: 1, step: null });
  });

  it('CEO giao thẳng thì không có phòng gửi', () => {
    const handoff = readHandoff('e2', 'TASK_CREATED', {
      taskId: 't2',
      title: 'Việc CEO giao',
      assignedRole: 'FRONTEND_DEVELOPER',
      fromRole: null,
    });

    expect(handoff?.fromRole).toBeNull();
    expect(handoff?.toRole).toBe('FRONTEND_DEVELOPER');
  });

  it('task không giao cho ai thì không có người đưa việc nào chạy', () => {
    expect(
      readHandoff('e3', 'TASK_CREATED', { taskId: 't3', title: 'Chưa phân', assignedRole: null }),
    ).toBeNull();
  });

  it('QA báo lỗi thì việc đi ngược về người viết code', () => {
    const handoff = readHandoff('e4', 'BUG_CREATED', {
      bugId: 'b1',
      severity: 'HIGH',
      title: 'Nút gửi không phản hồi',
      fromRole: 'QA',
      toRole: 'FRONTEND_DEVELOPER',
    });

    expect(handoff).toMatchObject({ fromRole: 'QA', toRole: 'FRONTEND_DEVELOPER', kind: 'bug' });
  });

  it('lỗi không rõ giao cho ai thì chỉ là cảnh báo, không vẽ đường đi', () => {
    expect(
      readHandoff('e5', 'BUG_CREATED', { bugId: 'b2', severity: 'LOW', title: 'x', toRole: null }),
    ).toBeNull();
  });

  it('xong việc thì kết quả quay về chỗ điều phối', () => {
    const handoff = readHandoff('e6', 'TASK_COMPLETED', {
      taskId: 't6',
      durationMs: 1000,
      agentRole: 'BACKEND_DEVELOPER',
    });

    expect(handoff).toMatchObject({
      fromRole: 'BACKEND_DEVELOPER',
      toRole: 'CTO_ORCHESTRATOR',
      kind: 'report',
    });
  });

  it('event không phải chuyển giao thì không sinh chuyển động', () => {
    for (const type of [
      'TASK_STARTED',
      'AGENT_STATE_CHANGED',
      'BUDGET_WARNING',
      'DEPLOY_SUCCESS',
    ]) {
      expect(readHandoff('e7', type, { agentRole: 'QA' }), type).toBeNull();
    }
  });
});
