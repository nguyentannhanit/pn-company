/**
 * P&N — "Mô tả công việc" của một nhân viên AI.
 *
 * Không viết tay bản mô tả riêng: lấy thẳng từ bản chỉ dẫn mà nhân viên đó ĐANG làm theo (`AGENT_PROMPTS` — vai trò,
 * quy trình, định nghĩa xong, nguyên tắc) và từ quy trình sản xuất (bước nào, nhận việc từ ai, giao cho ai). Sửa
 * chỉ dẫn là mô tả tự đổi theo — CEO đọc đúng thứ agent đang được dặn, không phải một bản giới thiệu dần lệch đi.
 */

import { AGENT_PROMPTS, DEPARTMENT_DOCS, type AgentRegistry, type PromptRole } from '@pn/agents';
import { STANDARD_WORKFLOW, WEB_WORKFLOW, type WorkflowStage } from '@pn/orchestrator';
import { AGENT_PROFILES, type AgentRole } from '@pn/shared';

export interface AgentJob {
  /** Một câu: nhân viên này chịu trách nhiệm gì. */
  mission: string;
  /** Các bước làm việc theo thứ tự. */
  steps: string[];
  /** Thế nào là xong việc. */
  done: string | null;
  /** Nguyên tắc / giới hạn. */
  rules: string[];
  /** Vị trí trong dây chuyền sản xuất. */
  stages: Array<{ flow: string; stage: string; from: string[]; to: string[]; parallel: string[] }>;
  /** Tài liệu dự án phòng này phải viết. */
  document: string | null;
  /** Có mã chạy thật chưa — vai trò mới có chỗ ngồi thì nói thẳng là chưa nhận việc. */
  active: boolean;
}

/** Vai trò R&D chưa có bản chỉ dẫn riêng — mô tả đúng việc luồng tri thức đang giao cho họ (knowledge-pipeline.ts). */
const PLAIN: Partial<Record<AgentRole, string>> = {
  GITHUB_SCOUT: 'Tìm repo mã nguồn mở trên GitHub theo chủ đề các phòng đang cần, chấm điểm và loại trùng (bước 1–3 của luồng tri thức hằng ngày).',
  KNOWLEDGE_SECURITY_REVIEW: 'Soi mỗi phát hiện mới tìm dấu hiệu chèn chỉ thị độc hại trước khi nó được biên tập thành kiến thức (bước 4).',
  KNOWLEDGE_DIRECTOR: 'Trưởng phòng Nghiên cứu: điều phối việc tìm và đánh giá kiến thức mới cho các phòng.',
  TECHNOLOGY_RADAR: 'Theo dõi công nghệ mới đáng để công ty áp dụng.',
  SKILL_SCOUT: 'Tìm kỹ năng và cách làm mới cho từng phòng ban.',
  SANDBOX_EVALUATION: 'Chạy thử kiến thức mới trong môi trường cách ly trước khi đề xuất dùng thật.',
  DEPARTMENT_TRAINER: 'Đưa kiến thức đã được CEO duyệt vào cách làm của từng phòng.',
  KNOWLEDGE_AUDITOR: 'Rà lại kiến thức đang dùng: còn đúng, còn hiệu quả không.',
  // Hai vai trò dưới có chỉ dẫn viết theo kiểu đoạn văn (không theo mẫu VAI TRÒ / QUY TRÌNH) nên tóm tại đây.
  KNOWLEDGE_CURATOR: 'Biến một phát hiện thô (repo, bài viết, tài liệu) thành gói kiến thức các phòng đọc là áp dụng được: giải quyết gì, làm thế nào, khi nào KHÔNG nên dùng. Chỉ viết điều có trong nguồn (bước 5 của luồng tri thức).',
  RESEARCH: 'Trả lời một câu hỏi kỹ thuật cụ thể dựa trên tài liệu được đưa; mỗi kết luận chỉ ra được chỗ trong tài liệu, thiếu thì nói thiếu.',
};
/** Vai trò R&D có mã chạy thật trong luồng tri thức (không nằm trong bộ agent của dây chuyền sản xuất). */
const KNOWLEDGE_ACTIVE = new Set<AgentRole>(['GITHUB_SCOUT', 'KNOWLEDGE_SECURITY_REVIEW', 'KNOWLEDGE_CURATOR', 'RESEARCH']);

const FLOWS: Array<[string, WorkflowStage[]]> = [
  ['Phần mềm, ứng dụng, máy tính', STANDARD_WORKFLOW],
  ['Website', WEB_WORKFLOW],
];

const nameOf = (role: AgentRole): string => AGENT_PROFILES[role]?.displayName ?? role;

/** Tách các mục trong một dòng liệt kê kiểu "a; b; c" hoặc "a → b → c". */
const splitList = (text: string): string[] =>
  text.split(/\s*(?:;|→)\s*/).map((part) => part.trim().replace(/\.$/, '')).filter(Boolean);

/** Đọc bản chỉ dẫn thành các phần; bỏ đoạn quy chuẩn chung của công ty (giống nhau ở mọi vai trò). */
function parsePrompt(prompt: string): Pick<AgentJob, 'mission' | 'steps' | 'done' | 'rules'> {
  const lines = prompt.split('\n').map((line) => line.trim());
  const start = lines.findIndex((line) => /^(VAI TRÒ:|Vai trò của bạn:)/.test(line));
  const body = start >= 0 ? lines.slice(start) : lines;
  const after = (label: RegExp): string | null => {
    const line = body.find((row) => label.test(row));
    return line ? line.replace(label, '').trim() || null : null;
  };

  const mission = after(/^Nhiệm vụ:/) ?? after(/^(VAI TRÒ:|Vai trò của bạn:)/) ?? '';
  const steps: string[] = [];
  const flowAt = body.findIndex((row) => /^(QUY TRÌNH|QUY TRÌNH KHI NHẬN YÊU CẦU MỚI|RÀ):/.test(row));
  if (flowAt >= 0) {
    const inline = body[flowAt]!.replace(/^[^:]+:/, '').trim();
    if (inline) steps.push(...splitList(inline));
    for (const row of body.slice(flowAt + 1)) {
      const numbered = /^\d+\.\s+(.*)$/.exec(row);
      if (!numbered) break;
      steps.push(numbered[1]!);
    }
  }
  const rulesLine = after(/^NGUYÊN TẮC:/);
  const rules = rulesLine
    ? splitList(rulesLine)
    : body.filter((row) => row.startsWith('- ')).map((row) => row.slice(2)).slice(0, 5);
  return { mission, steps, done: after(/^ĐỊNH NGHĨA XONG:/), rules };
}

export function agentJob(role: AgentRole, registry: AgentRegistry): AgentJob {
  const agent = registry.get(role);
  const promptRole = (agent?.definition.promptRole ?? role) as PromptRole;
  const prompt = (AGENT_PROMPTS as Record<string, string>)[promptRole];
  const parsed = PLAIN[role] || !prompt ? { mission: PLAIN[role] ?? '', steps: [], done: null, rules: [] } : parsePrompt(prompt);

  const stages: AgentJob['stages'] = [];
  for (const [flow, workflow] of FLOWS) {
    const stage = workflow.find((item) => item.roles.includes(role));
    if (!stage) continue;
    const before = workflow.filter((item) => stage.dependsOn.includes(item.id));
    const next = workflow.filter((item) => item.dependsOn.includes(stage.id));
    stages.push({
      flow,
      stage: stage.description,
      from: [...new Set(before.flatMap((item) => item.roles))].map(nameOf),
      to: [...new Set(next.flatMap((item) => item.roles))].filter((other) => other !== role).map(nameOf),
      parallel: stage.roles.filter((other) => other !== role).map(nameOf),
    });
  }

  return {
    ...parsed,
    stages,
    document: DEPARTMENT_DOCS[role]?.title ?? null,
    active: Boolean(agent) || KNOWLEDGE_ACTIVE.has(role),
  };
}
