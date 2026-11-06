/**
 * P&N — Số liệu quan sát lấy từ `/insights/*`: việc kẹt kèm lý do, thành tích
 * nhân viên, số lần model từ chối. Tự tải lại khi có sự kiện realtime mới.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import type { ExplainedFailure } from '@pn/shared';

import { api } from '@/lib/api';
import { useRealtime } from '@/lib/store';

export interface BlockedItem {
  taskId: string;
  projectId: string;
  projectName: string;
  title: string;
  role: string | null;
  failedRuns: number;
  since: string;
  reason: string | null;
  explained: ExplainedFailure;
}

export interface AgentStat {
  role: string;
  done: number;
  open: number;
  succeeded: number;
  failed: number;
  costUsd: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface Refusals {
  days: number;
  total: number;
  byModel: Array<{ provider: string | null; model: string | null; kind: string; count: number; last: string }>;
  perDay: Array<{ day: string; count: number }>;
}

/** Tải một đường `/insights/*`, tải lại khi có sự kiện mới; `reload` để gọi tay sau khi bấm nút. */
function useInsight<T>(path: string): { data: T | null; error: string | null; reload: () => void } {
  const { lastEventAt } = useRealtime();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api<T>(path)
      .then((result) => alive && (setData(result), setError(null)))
      .catch((caught: unknown) => alive && setError(caught instanceof Error ? caught.message : 'Không tải được số liệu'));
    return () => {
      alive = false;
    };
  }, [path, lastEventAt, tick]);
  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, reload };
}

/** Tên việc đã tải, dùng chung cho thẻ phòng và bong bóng trên đầu nhân viên (mã việc không đổi tên). */
const taskTitles = new Map<string, string>();

/**
 * Tên việc đang làm của từng mã việc (agent chỉ mang mã). Mỗi mã chỉ tải một lần
 * trong phiên trang: văn phòng 3D hỏi cho cả công ty mỗi lần có người đổi việc.
 */
export function useTaskTitles(taskIds: string[]): Record<string, string> {
  const key = [...new Set(taskIds)].sort().join(',');
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    const ids = key.split(',').filter(Boolean);
    void Promise.all(
      ids
        .filter((id) => !taskTitles.has(id))
        .map((id) =>
          api<{ task: { id: string; title: string } }>(`/tasks/${id}`)
            .then(({ task }) => taskTitles.set(task.id, task.title))
            .catch(() => undefined),
        ),
    ).then(() => {
      if (alive) setTitles(Object.fromEntries(ids.flatMap((id) => (taskTitles.has(id) ? [[id, taskTitles.get(id)!]] : []))));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return titles;
}

export function useBlocked(): { items: BlockedItem[]; error: string | null; reload: () => void } {
  const { data, error, reload } = useInsight<{ items: BlockedItem[] }>('/insights/blocked');
  return { items: data?.items ?? [], error, reload };
}

export function useAgentStats(): Map<string, AgentStat> {
  const { data } = useInsight<{ agents: AgentStat[] }>('/insights/agents');
  return new Map((data?.agents ?? []).map((row) => [row.role, row]));
}

export function useRefusals(days = 7): Refusals | null {
  return useInsight<Refusals>(`/insights/refusals?days=${days}`).data;
}

/**
 * Chạy lại một việc. Không gửi body: Fastify trả 500 nếu có header JSON mà
 * thân rỗng, nên `api()` chỉ đặt header khi có body.
 */
export async function rerunTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  try {
    // Máy chủ xếp việc vào hàng đợi của dự án rồi trả lời ngay; việc đang chạy thì báo 409 kèm lý do.
    await api(`/tasks/${taskId}/run`, { method: 'POST' });
    return { ok: true, message: 'Đã xếp chạy lại, xong sẽ tự cập nhật' };
  } catch (caught) {
    return { ok: false, message: caught instanceof Error ? caught.message : 'Không chạy lại được' };
  }
}

/** Tạm dừng (giữ tiến độ, bấm Chạy lại để làm nối) hoặc bỏ hẳn một việc — lượt đang chạy bị cắt ngay. */
export async function stopTaskRun(taskId: string, mode: 'pause' | 'cancel'): Promise<{ ok: boolean; message: string }> {
  try {
    await api(`/tasks/${taskId}/stop`, { method: 'POST', body: { mode } });
    return { ok: true, message: mode === 'pause' ? 'Đã tạm dừng, tiến độ vẫn giữ' : 'Đã bỏ việc này' };
  } catch (caught) {
    return { ok: false, message: caught instanceof Error ? caught.message : 'Không dừng được' };
  }
}
