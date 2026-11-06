/**
 * P&N — Kho trạng thái realtime của dashboard (§9, §21, §22).
 *
 * §9 là ràng buộc quan trọng nhất ở đây: nhân vật 3D đọc trạng thái từ store
 * này, và store này chỉ thay đổi khi có event thật từ máy chủ. Không có chỗ nào
 * trong frontend được phép tự đặt trạng thái agent.
 */

'use client';

import { create } from 'zustand';

import { apiUrl, getToken, type AgentRow } from './api';

/**
 * Một lần chuyển giao công việc giữa hai phòng ban — thứ mà cảnh 3D dựng thành
 * người đưa việc đi từ phòng này sang phòng kia (§9).
 *
 * Chỉ sinh ra từ event thật của máy chủ. `fromRole` rỗng nghĩa là CEO giao
 * thẳng, khi đó Khang ở quầy lễ tân mang việc lên (`three/Courier.tsx`).
 */
export interface Handoff {
  id: string;
  fromRole: string | null;
  toRole: string;
  kind: 'task' | 'bug' | 'report';
  label: string;
  startedAt: number;
  /** Độ gấp 0–3 (LOW → CRITICAL): người đưa việc gom nhiều hồ sơ thì đưa việc gấp trước. */
  priority: number;
  /** Bước trong quy trình dự án; cùng độ gấp thì bước sớm đưa trước. `null` là ngoài quy trình. */
  step: number | null;
}

/** Thứ tự độ gấp của task và mức nghiêm trọng của lỗi — cùng bốn bậc. */
const URGENCY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const urgencyOf = (value: unknown): number => {
  const rank = URGENCY.indexOf(String(value));
  return rank < 0 ? 1 : rank;
};

export interface FeedEntry {
  id: string;
  type: string;
  ts: string;
  projectId: string | null;
  label: string;
  /** Vai trò gây ra sự kiện và vai trò nhận (nếu event nêu), để cột phải ghi "phòng → phòng". */
  fromRole: string | null;
  toRole: string | null;
}

interface RealtimeState {
  connected: boolean;
  agents: AgentRow[];
  pendingApprovals: number;
  /** Dòng sự kiện gần nhất, hiển thị ở Status Panel (§24). */
  feed: FeedEntry[];
  /** Đếm số lần agent đổi trạng thái, dùng để kích hoạt hiệu ứng 3D. */
  lastEventAt: number;
  /** Các lần chuyển giao đang diễn ra, cảnh 3D vẽ thành người đưa việc. */
  handoffs: Handoff[];
  /**
   * §148 — dashboard phải cho thấy cả sản xuất lẫn HỌC. Đây là phần học:
   * phòng nào vừa nhận kiến thức, phòng nào vừa lên cấp.
   */
  learning: LearningPulse[];

  connect: () => void;
  disconnect: () => void;
  setAgents: (agents: AgentRow[]) => void;
  /** Cảnh 3D gọi khi người đưa việc đi tới nơi, để dọn khỏi danh sách. */
  clearHandoff: (id: string) => void;
  /** Cảnh 3D gọi khi hiệu ứng học chạy xong. */
  clearLearning: (id: string) => void;
}

/** Một socket duy nhất cho cả ứng dụng — mở lại mỗi lần điều hướng là lãng phí. */
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
let intentionalDisconnect = false;

/** Event realtime giữ cả mã task và dự án để panel không hiển thị việc cũ. */
export interface RealtimeEvent {
  id: string;
  type: string;
  ts: string;
  projectId: string | null;
  taskId?: string | null;
  payload: Record<string, unknown>;
}

/** Cập nhật nhân viên từ event thật; không suy ra làm việc từ chuyển động. */
export function applyAgentEvent(agents: AgentRow[], event: RealtimeEvent): AgentRow[] {
  if (event.type === 'AGENT_STATE_CHANGED') {
    // Đổi trạng thái là hết lượt cũ: bỏ thanh tiến độ của lượt đó.
    return agents.map((agent) => agent.role === event.payload['agentRole'] ? {
      ...agent,
      state: String(event.payload['to']),
      stateChangedAt: event.ts,
      currentTaskId: event.taskId ?? null,
      currentProjectId: event.projectId,
      progress: undefined,
    } : agent);
  }
  if (event.type === 'AGENT_PROGRESS') {
    return agents.map((agent) => agent.role === event.payload['agentRole']
      ? { ...agent, progress: { pct: Number(event.payload['pct']), text: String(event.payload['text']) } }
      : agent);
  }
  if (event.type === 'TASK_COMPLETED') {
    return agents.map((agent) => agent.role === event.payload['agentRole']
      ? { ...agent, lastCompletedAt: Date.parse(event.ts) }
      : agent);
  }
  return agents;
}

/** Diễn giải event thành câu tiếng Việt ngắn cho Status Panel. */
function describe(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case 'PROJECT_CREATED':
      return `Dự án mới: ${String(payload['name'])}`;
    case 'TASK_CREATED':
      return `Task mới: ${String(payload['title'])}`;
    case 'TASK_STARTED':
      return `${String(payload['agentRole'])} bắt đầu làm`;
    case 'AGENT_PROGRESS':
      return `${String(payload['agentRole'])}: ${String(payload['text'])} (${String(payload['pct'])}%)`;
    case 'TASK_COMPLETED':
      return 'Hoàn thành một task';
    case 'TASK_FAILED':
      return `Task thất bại: ${String(payload['reason'] ?? '')}`.slice(0, 120);
    case 'BUG_CREATED':
      return `Lỗi ${String(payload['severity'])}: ${String(payload['title'])}`;
    case 'AGENT_STATE_CHANGED':
      return `${String(payload['agentRole'])}: ${String(payload['from'])} → ${String(payload['to'])}`;
    case 'APPROVAL_REQUIRED':
      return `Cần duyệt: ${String(payload['title'])}`;
    case 'APPROVED':
      return 'Đã duyệt một yêu cầu';
    case 'REJECTED':
      return 'Đã từ chối một yêu cầu';
    case 'DEPLOY_STARTED':
      return `Bắt đầu triển khai ${String(payload['environment'])}`;
    case 'DEPLOY_SUCCESS':
      return `Triển khai ${String(payload['environment'])} thành công`;
    case 'DEPLOY_FAILED':
      return `Triển khai ${String(payload['environment'])} thất bại`;
    case 'BUDGET_WARNING':
      return `Ngân sách đã dùng ${Math.round(Number(payload['ratio']) * 100)}%`;
    case 'BUDGET_EXCEEDED':
      return 'Đã chạm trần ngân sách';
    case 'KNOWLEDGE_EVALUATED':
      return `R&D chạy thử kiến thức: ${Math.round(Number(payload['score'] ?? 0))}/100`;
    case 'KNOWLEDGE_ACTIVATED':
      return `Kiến thức mới cho ${String(payload['department'] ?? 'phòng ban')}`;
    case 'KNOWLEDGE_DEPRECATED':
      return 'Ngừng dùng một gói kiến thức';
    case 'DEPARTMENT_XP_GAINED':
      return `${String(payload['department'])} +${String(payload['xp'])} XP`;
    case 'DEPARTMENT_LEVEL_UP':
      return `${String(payload['department'])} lên cấp ${String(payload['level'])}`;
    case 'AGENT_PROFILE_UPGRADED':
      return `${String(payload['agentRole'])} lên hồ sơ v${String(payload['toVersion'])}`;
    default:
      return type;
  }
}

/** Hai đầu của một sự kiện theo tên khoá máy chủ gửi; khoá nào vắng thì để trống, không đoán. */
function feedRoles(payload: Record<string, unknown>): { fromRole: string | null; toRole: string | null } {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  };
  return { fromRole: pick('fromRole', 'agentRole'), toRole: pick('toRole', 'assignedRole') };
}

/**
 * Rút ra lần chuyển giao công việc từ một event, hoặc `null` nếu event đó không
 * phải chuyển giao.
 *
 * Chỉ đọc những gì máy chủ đã nói. Không suy đoán: event không nêu đủ hai đầu
 * thì không có người đưa việc nào chạy trên màn hình (§9).
 */
export function readHandoff(
  id: string,
  type: string,
  payload: Record<string, unknown>,
): Handoff | null {
  const from = (key: string): string | null => {
    const value = payload[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  switch (type) {
    case 'TASK_CREATED': {
      const toRole = from('assignedRole');
      if (!toRole) return null;
      return {
        id,
        fromRole: from('fromRole'),
        toRole,
        kind: 'task',
        label: String(payload['title'] ?? 'Task mới'),
        startedAt: Date.now(),
        priority: urgencyOf(payload['priority']),
        step: typeof payload['step'] === 'number' && payload['step'] >= 0 ? payload['step'] : null,
      };
    }
    case 'BUG_CREATED': {
      const toRole = from('toRole');
      if (!toRole) return null;
      return {
        id,
        fromRole: from('fromRole'),
        toRole,
        kind: 'bug',
        label: `Lỗi: ${String(payload['title'] ?? '')}`,
        startedAt: Date.now(),
        priority: urgencyOf(payload['severity']),
        step: null,
      };
    }
    case 'TASK_COMPLETED': {
      // Xong việc thì kết quả quay về chỗ điều phối — đó là chuyển giao ngược.
      const fromRole = from('agentRole');
      if (!fromRole) return null;
      return {
        id,
        fromRole,
        toRole: 'CTO_ORCHESTRATOR',
        kind: 'report',
        label: 'Bàn giao kết quả',
        startedAt: Date.now(),
        priority: 1,
        step: null,
      };
    }
    default:
      return null;
  }
}

/**
 * Giữ tối đa tám chuyển giao. Mỗi người đi lần lượt từng chuyến (cả đi lẫn
 * về), nên CTO chia sáu việc cùng lúc là sáu chuyến xếp hàng; giữ bốn như
 * trước thì hai chuyến đầu bị đẩy ra khi còn đang đi.
 */
const MAX_HANDOFFS = 8;

/** Nhịp học chỉ sống vài giây rồi tắt; giữ nhiều hơn thế là giữ rác. */
const MAX_LEARNING = 6;

/**
 * §126–§128 — một nhịp hoạt động học nhìn thấy được trong văn phòng 3D.
 *
 * `kind` quyết định hình ảnh: `discover` là phòng R&D sáng lên khi tìm được thứ
 * mới, `activate` là kiến thức chảy về một phòng ban, `levelUp` là phòng đó
 * vừa lên cấp. Ba việc khác nhau nên trông phải khác nhau.
 */
export interface LearningPulse {
  id: string;
  kind: 'discover' | 'activate' | 'levelUp';
  /** Phòng ban nhận; `null` với `discover` vì lúc đó chưa biết về ai. */
  department: string | null;
  label: string;
  at: number;
}

/**
 * Rút nhịp học ra từ một event, hoặc `null` nếu event đó không thuộc việc học.
 *
 * Cùng nguyên tắc với `readHandoff` (§9): chỉ đọc thứ máy chủ đã nói, không
 * suy đoán. Không có phòng ban trong payload thì không vẽ gì cả.
 */
export function readLearning(
  id: string,
  type: string,
  payload: Record<string, unknown>,
): LearningPulse | null {
  const department = typeof payload['department'] === 'string' ? payload['department'] : null;

  switch (type) {
    case 'KNOWLEDGE_EVALUATED':
      return { id, kind: 'discover', department: null, label: 'R&D đang chạy thử kiến thức', at: Date.now() };
    case 'KNOWLEDGE_ACTIVATED':
      return department
        ? { id, kind: 'activate', department, label: 'Nhận kiến thức mới', at: Date.now() }
        : null;
    case 'DEPARTMENT_LEVEL_UP':
      return department
        ? {
            id,
            kind: 'levelUp',
            department,
            label: `Lên cấp ${String(payload['level'] ?? '')}`,
            at: Date.now(),
          }
        : null;
    default:
      return null;
  }
}

export const useRealtime = create<RealtimeState>((set, get) => ({
  connected: false,
  agents: [],
  pendingApprovals: 0,
  feed: [],
  lastEventAt: 0,
  handoffs: [],
  learning: [],

  setAgents: (agents) => set({ agents }),

  clearHandoff: (id) =>
    set((state) => ({ handoffs: state.handoffs.filter((handoff) => handoff.id !== id) })),

  clearLearning: (id) =>
    set((state) => ({ learning: state.learning.filter((pulse) => pulse.id !== id) })),

  connect: () => {
    if (typeof window === 'undefined') return;
    intentionalDisconnect = false;
    if (socket && socket.readyState <= 1) return;

    const token = getToken();
    if (!token) return;

    const url = new URL(apiUrl().replace(/^http/, 'ws') + '/ws');
    url.searchParams.set('token', token);

    socket = new WebSocket(url.toString());

    socket.onopen = () => {
      reconnectDelay = 1000;
      set({ connected: true });
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: {
        type: string;
        agents?: AgentRow[];
        pendingApprovals?: number;
        event?: RealtimeEvent;
      };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === 'snapshot') {
        set({
          agents: message.agents ?? [],
          pendingApprovals: message.pendingApprovals ?? 0,
          handoffs: [],
          learning: [],
        });
        return;
      }

      if (message.type === 'event' && message.event) {
        const incoming = message.event;

        set((state) => {
          // §9 — chỉ event AGENT_STATE_CHANGED mới đổi trạng thái nhân vật.
          const agents = applyAgentEvent(state.agents, incoming);

          const pendingApprovals =
            incoming.type === 'APPROVAL_REQUIRED'
              ? state.pendingApprovals + 1
              : incoming.type === 'APPROVED' || incoming.type === 'REJECTED'
                ? Math.max(0, state.pendingApprovals - 1)
                : state.pendingApprovals;

          const handoff = readHandoff(incoming.id, incoming.type, incoming.payload);
          const handoffs =
            handoff && handoff.fromRole !== handoff.toRole
              ? [...state.handoffs, handoff].slice(-MAX_HANDOFFS)
              : state.handoffs;

          // §148 — hoạt động học hiện lên cùng chỗ với hoạt động sản xuất.
          const pulse = readLearning(incoming.id, incoming.type, incoming.payload);
          const learning = pulse
            ? [...state.learning, pulse].slice(-MAX_LEARNING)
            : state.learning;

          return {
            agents,
            pendingApprovals,
            handoffs,
            learning,
            lastEventAt: Date.now(),
            feed: [
              {
                id: incoming.id,
                type: incoming.type,
                ts: incoming.ts,
                projectId: incoming.projectId,
                label: describe(incoming.type, incoming.payload),
                ...feedRoles(incoming.payload),
              },
              ...state.feed,
            ].slice(0, 50),
          };
        });
      }
    };

    socket.onclose = () => {
      set({ connected: false, handoffs: [], learning: [] });
      if (intentionalDisconnect) return;
      // Kết nối lại với khoảng chờ tăng dần, tối đa 30 giây.
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
        get().connect();
      }, reconnectDelay);
    };

    socket.onerror = () => {
      socket?.close();
    };
  },

  disconnect: () => {
    intentionalDisconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (socket) socket.onclose = null;
    socket?.close();
    socket = null;
    set({ connected: false, handoffs: [], learning: [] });
  },
}));
