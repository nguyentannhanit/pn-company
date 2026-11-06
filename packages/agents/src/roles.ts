/**
 * P&N — Mười hai agent lõi (§3.1–§3.12).
 *
 * Mỗi agent là một bước có đầu vào và đầu ra rõ ràng, không phải một cuộc trò
 * chuyện mở. Đầu ra luôn có cấu trúc để orchestrator dùng được ngay: task đề
 * xuất, file sinh ra, hoặc kết luận kiểm thử kèm bug.
 *
 * Ba lớp phủ hết mười hai vai trò, vì chúng chỉ khác nhau ở prompt chứ không
 * khác ở quy trình: nghĩ rồi giao việc (`PlanningAgent`), sinh file vào
 * workspace (`DeveloperAgent`), đọc mã rồi báo lỗi (`ReviewAgent`).
 */

import { AGENT_ROLES, agentProfile, type AgentRole } from '@pn/shared';
import path from 'node:path';

import { NPM_INSTALL_ARGS, probeProduct, type RuntimeReport } from '@pn/sandbox';
import { z } from 'zod';

import type { Agent, AgentContext, AgentDefinition, AgentOutcome } from './contract.js';
import { DEPARTMENT_DOCS, describeDocuments } from './documents.js';
import { buildSystemPrompt } from './prompts.js';
import { ASK_INSTRUCTION, questionsField } from './questions.js';
import { generateStructured, StructuredOutputError, type StructuredResult } from './structured.js';
import { clipped } from './clip.js';

/* -------------------------------------------------------------------------- */
/* Schema đầu ra                                                               */
/* -------------------------------------------------------------------------- */

const proposedTaskSchema = z.object({
  title: clipped(200, 3),
  description: clipped(5000, 1),
  assignedRole: z.enum(AGENT_ROLES),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  dependsOnIndexes: z.array(z.number().int().min(0)).default([]),
});

export const planSchema = z.object({
  summary: clipped(4000, 1),
  tasks: z.array(proposedTaskSchema).min(1).max(20),
  risks: z.array(clipped(500)).default([]),
  // Câu hỏi cho CEO dài quá thì cắt bớt, không vứt cả kế hoạch: model từng viết
  // hơn 1000 ký tự và toàn bộ lần phân rã bị coi là hỏng chỉ vì vậy.
  needsCeoDecision: z
    .string()
    .transform((text) => (text.length > 2000 ? text.slice(0, 2000) + '…' : text))
    .nullable()
    .default(null),
});

/**
 * Phòng lập kế hoạch (PM, BA, Kiến trúc, Thiết kế, Web) trả về TÀI LIỆU đầy đủ.
 * Task đề xuất của họ không bao giờ thành task (chỉ lần phân rã đầu của CTO tạo
 * task), nên nội dung phải nằm trong tài liệu — trước đây nằm trong mô tả task
 * đề xuất rồi bị vứt, chỉ còn lại tên.
 */
export const planningSchema = planSchema.omit({ needsCeoDecision: true }).extend({
  tasks: z.array(proposedTaskSchema).max(20).default([]),
  document: z.string().min(300, 'tài liệu quá ngắn — viết đầy đủ theo mẫu'),
  // Chỗ chưa rõ hỏi Phòng điều hành, không hỏi thẳng CEO.
  questions: questionsField,
});

// Chặn đường dẫn tuyệt đối và `..` ngay từ schema, trước cả sandbox (§18).
const filePathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[\w./-]+$/, 'đường dẫn chỉ được chứa chữ, số, dấu chấm, gạch và /')
  .refine((value) => !value.startsWith('/') && !value.includes('..'), {
    message: 'đường dẫn phải nằm trong workspace',
  });

const codeSchema = z.object({
  summary: clipped(4000, 1),
  files: z.array(z.object({ path: filePathSchema, content: z.string().max(200_000) })).min(1).max(30),
  testCommand: z.string().max(200).nullable().default(null),
  questions: questionsField,
});

const qaSchema = z.object({
  questions: questionsField,
  passed: z.boolean(),
  summary: clipped(4000, 1),
  bugs: z
    .array(
      z.object({
        title: clipped(200, 3),
        description: clipped(5000, 1),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
      }),
    )
    .default([]),
});

/* -------------------------------------------------------------------------- */
/* Tiện ích chung                                                              */
/* -------------------------------------------------------------------------- */

/** Gói ngữ cảnh dự án và task thành đoạn văn để đưa vào prompt. */
/**
 * Chuẩn kỹ thuật của công ty cho từng loại sản phẩm. Mọi agent đều đọc dòng
 * này nên CTO, Architect, dev và DevOps cùng một khung; không có nó thì "phần
 * mềm máy tính" bị dựng thành trang web.
 */
export const PRODUCT_GUIDE: Record<string, string> = {
  DESKTOP_APPLICATION:
    'Phần mềm desktop cho Windows. Chuẩn công ty: Electron + TypeScript — src/main.ts (tiến trình chính), ' +
    'src/preload.ts, src/renderer/ (giao diện HTML/CSS); tsc biên dịch vào dist/, đóng gói bằng electron-builder ' +
    'target "portable" ra một file .exe trong release/ (directories.output = "release", KHÔNG để trùng dist/ — ' +
    'trùng thì lần dựng sau gói luôn .exe và win-unpacked của lần trước vào app). "build.files" chỉ gồm mã đã ' +
    'biên dịch và giao diện (ví dụ ["dist/**/*", "package.json"]); electron, electron-builder, typescript nằm ở ' +
    '"devDependencies". package.json phải có scripts ' +
    '"start" (electron .), "build" (tsc && electron-builder --win portable) và "test" (node --test, không cần Electron). ' +
    'File giao diện (HTML/CSS/ảnh) phải được chép vào dist/ lúc build và nạp bằng đường dẫn tính từ file đã biên dịch ' +
    '(path.join(__dirname, "renderer/index.html")) — src/ không có trong gói; CẤM trang dự phòng giả khi thiếu file ' +
    '(thiếu thì để lỗi lộ ra). Tắt thanh menu mặc định (Menu.setApplicationMenu(null)). Tên kênh IPC trong preload và ' +
    'renderer phải khớp đúng hợp đồng. Lệnh cần quyền quản trị thì kiểm tra quyền và báo rõ khi thiếu, không báo thành ' +
    'công giả. Công cụ không có giao diện thì Python + PyInstaller, script build tạo dist/<tên>.exe. Sản phẩm giao cho CEO là file .exe.',
  WEB_APPLICATION:
    'Ứng dụng web: Vite + TypeScript, "npm run build" ra dist/index.html chạy được tĩnh.',
  LANDING_PAGE: 'Trang tĩnh: HTML/CSS/JS thuần hoặc Vite, "npm run build" ra dist/index.html.',
  CORPORATE_WEBSITE: 'Website tĩnh nhiều trang: Vite nhiều entry hoặc HTML thuần, "npm run build" ra dist/.',
  MOBILE_APPLICATION:
    'Ứng dụng di động: dựng web app (Vite + TypeScript) trước, bọc Capacitor để ra APK ở bước sau.',
};

/**
 * Điều phải xác định cho từng loại sản phẩm trước khi dựng. Phân tích đi qua danh
 * sách này; điều nào tài liệu chưa trả lời thì hỏi Phòng điều hành. App tắt/mở máy
 * Từng hỏng đúng ở các điểm trong danh sách desktop (quyền, tự bật từ đâu, giao diện).
 */
export const MUST_CLARIFY: Record<string, string[]> = {
  DESKTOP_APPLICATION: [
    'Windows phiên bản nào; người dùng có quyền quản trị không; app cần quyền gì và xin thế nào',
    'Việc nào nền tảng không cho phép (ví dụ bật máy đã tắt hẳn) và phương án thay thế nói với người dùng',
    'Chạy nền ở khay hệ thống? Khởi động cùng Windows? Đóng cửa sổ thì thoát hay ẩn',
    'Dữ liệu lưu ở đâu, còn lại sau khi cài lại/cập nhật không',
    'Thao tác nguy hiểm (tắt máy, xoá…) cần cảnh báo và hủy thế nào',
    'Ngôn ngữ, phong cách giao diện, cỡ cửa sổ',
  ],
  WEB_APPLICATION: [
    'Ai dùng, trên điện thoại hay máy tính là chính',
    'Có đăng nhập/tài khoản không; dữ liệu lưu ở trình duyệt hay máy chủ',
    'Luồng chính từ lúc vào tới lúc xong việc',
    'Trạng thái rỗng, lỗi mạng, dữ liệu sai thì hiển thị gì',
    'Ngôn ngữ, phong cách, thương hiệu (màu, logo)',
  ],
  LANDING_PAGE: [
    'Mục tiêu chuyển đổi: khách phải làm gì (gọi, đặt, để lại số…) và nút đó dẫn đi đâu',
    'Khách hàng mục tiêu, lời hứa chính',
    'Nội dung thật có sẵn chưa (giá, ảnh, địa chỉ) hay phải dùng chỗ đánh dấu rõ ràng',
    'Thương hiệu: màu, logo, giọng văn',
  ],
  CORPORATE_WEBSITE: [
    'Danh sách trang và nội dung thật của từng trang',
    'Thông tin liên hệ, bản đồ, mạng xã hội',
    'Thương hiệu: màu, logo, giọng văn',
    'Cần tiếng Anh không',
  ],
  MOBILE_APPLICATION: [
    'Android, iOS hay cả hai; cần chạy khi mất mạng không',
    'Có đăng nhập/tài khoản không; dữ liệu lưu ở máy hay máy chủ',
    'Quyền máy cần dùng (thông báo, vị trí, máy ảnh) và lúc xin',
    'Ngôn ngữ, phong cách giao diện',
  ],
};

function describeContext(context: AgentContext): string {
  const lines: string[] = [];
  if (context.project) {
    lines.push(
      `DỰ ÁN: ${context.project.name}`,
      `Loại sản phẩm: ${context.project.productType}`,
      `Mô tả: ${context.project.description}`,
    );
    const guide = PRODUCT_GUIDE[context.project.productType];
    if (guide) lines.push(`Chuẩn kỹ thuật cho loại này (bắt buộc): ${guide}`);
    const clarify = MUST_CLARIFY[context.project.productType];
    if (clarify) lines.push(`Điều phải xác định cho loại sản phẩm này (đã có trong tài liệu chưa?): ${clarify.map((item) => `• ${item}`).join(' ')}`);
  }
  if (context.task) {
    lines.push(
      '',
      `TASK: ${context.task.title}`,
      `Chi tiết: ${context.task.description}`,
    );
    if (context.task.fixLoopCount > 0) {
      lines.push(
        `Đây là lần sửa thứ ${context.task.fixLoopCount} — lần trước QA chưa duyệt, đọc kỹ phần lỗi bên dưới.`,
      );
    }
  }
  if (context.history.length > 0) {
    lines.push('', 'TRAO ĐỔI TRƯỚC ĐÓ:');
    for (const entry of context.history.slice(-10)) {
      lines.push(`- ${entry.author}: ${entry.content.slice(0, 1500)}`);
    }
  }
  const documents = describeDocuments(context.documents ?? []);
  if (documents) lines.push(documents);
  if (context.priorWork.length > 0) {
    lines.push('', 'KẾT QUẢ CÁC BƯỚC TRƯỚC (đã chốt — làm theo, đừng làm lại):');
    let budget = 9000;
    for (const item of context.priorWork) {
      const summary = item.summary.length > 1500 ? `${item.summary.slice(0, 1500)}…` : item.summary;
      const line = `- [${item.role}] ${item.title}: ${summary}`;
      if (budget - line.length < 0) break;
      budget -= line.length;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * §92 — nói cho agent biết nó được giao việc cho những ai. Danh sách này đến từ
 * workflow của loại sản phẩm chứ không phải hằng số: dự án landing page không
 * có kiến trúc sư, dự án mobile thì có Mobile Developer.
 */
function describeAllowedRoles(context: AgentContext): string {
  return `Chỉ được giao task cho các vai trò sau, viết đúng nguyên văn:\n${context.allowedRoles.join(', ')}`;
}

/* -------------------------------------------------------------------------- */
/* CTO Orchestrator — §3.1                                                     */
/* -------------------------------------------------------------------------- */

export class CtoAgent implements Agent {
  readonly definition: AgentDefinition = {
    role: 'CTO_ORCHESTRATOR',
    displayName: 'Giám đốc kỹ thuật (CTO)',
    department: 'COMMAND_CENTER',
    promptRole: 'CTO_ORCHESTRATOR',
    defaultTaskKind: 'architecture_review',
    needsSandbox: false,
  };

  async run(context: AgentContext): Promise<AgentOutcome> {
    const result = await generateStructured(
      context.gateway,
      {
        agentRole: this.definition.role,
        system: buildSystemPrompt('CTO_ORCHESTRATOR', context.knowledge),
        messages: [
          {
            role: 'user',
            content:
              `${describeContext(context)}\n\n` +
              'Hãy phân rã yêu cầu này thành các task cụ thể cho đội. Mô tả mỗi task đủ để phòng nhận ' +
              'làm được mà không phải đoán (mục tiêu, phạm vi, tiêu chí xong). Chỗ chưa rõ trong yêu cầu thì ' +
              'bạn tự quyết theo mục tiêu của CEO và ghi quyết định vào phần summary. "needsCeoDecision" CHỈ ' +
              'dùng khi phải tiêu tiền thật (dịch vụ trả phí, mua bản quyền, vượt ngân sách): nêu rõ số tiền, ' +
              'vì sao cần, và phương án không tốn tiền; còn lại để null.\n' +
              describeAllowedRoles(context),
          },
        ],
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        taskKind: 'architecture_review',
        signal: context.signal,
      },
      planSchema,
      `{
  "summary": "tóm tắt kế hoạch",
  "tasks": [{ "title": "...", "description": "...", "assignedRole": "BACKEND_DEVELOPER",
              "priority": "HIGH", "dependsOnIndexes": [0] }],
  "risks": ["..."],
  "needsCeoDecision": null
}`,
    );

    const plan = result.data;

    return {
      status: 'completed',
      summary: plan.summary,
      proposedTasks: plan.tasks.map((task) => ({
        title: task.title,
        description: task.description,
        assignedRole: task.assignedRole,
        priority: task.priority,
        dependsOnIndexes: task.dependsOnIndexes,
      })),
      // Phòng điều hành tự quyết mọi việc, chỉ xin CEO khi phát sinh chi phí.
      requiresApproval: plan.needsCeoDecision
        ? {
            kind: 'BUDGET_INCREASE',
            title: 'Cần anh quyết chi phí phát sinh',
            summary: plan.needsCeoDecision,
          }
        : null,
      endState: 'completed',
      costUsd: result.costUsd,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Nhóm agent lập kế hoạch — §3.2, §3.3, §3.4, §3.5                            */
/* -------------------------------------------------------------------------- */

/** Vai trò làm việc bằng cách nghĩ rồi giao việc, không chạm vào mã nguồn. */
type PlanningRole = Extract<
  AgentRole,
  | 'PRODUCT_MANAGER'
  | 'BUSINESS_ANALYST'
  | 'SOLUTION_ARCHITECT'
  | 'UIUX_DESIGNER'
  | 'WEB_PRODUCT_LEAD'
>;

/**
 * Câu lệnh riêng của từng vai trò kèm MẪU tài liệu phải viết. Mẫu là khung tối
 * thiểu của một công ty phần mềm làm bài bản: người đọc sau (dev, QA) dựng và
 * nghiệm thu được mà không phải đoán.
 */
const PLANNING_INSTRUCTIONS: Record<PlanningRole, string> = {
  PRODUCT_MANAGER:
    'Viết tài liệu PHẠM VI theo mẫu:\n' +
    '# Phạm vi sản phẩm\n## Mục tiêu (CEO muốn đạt được gì, đo bằng gì)\n## Người dùng và tình huống dùng\n' +
    '## Trong phạm vi bản đầu (liệt kê tính năng, mỗi dòng một việc)\n## Ngoài phạm vi (nói rõ để không ai làm thừa)\n' +
    '## Backlog: mỗi mục gồm Tên — Mô tả — Tiêu chí nghiệm thu — Ưu tiên (Cao/Vừa/Thấp)\n## Rủi ro và giới hạn cần nói trước với người dùng',
  BUSINESS_ANALYST:
    'Viết tài liệu YÊU CẦU theo mẫu:\n' +
    '# Yêu cầu\n## Người dùng và bối cảnh (máy gì, hệ điều hành gì, trình độ, dùng lúc nào)\n' +
    '## Yêu cầu chức năng: đánh số YC-01, YC-02…; mỗi yêu cầu một việc, kèm tiêu chí nghiệm thu dạng "Cho… Khi… Thì…" kiểm được bằng tay trên sản phẩm thật\n' +
    '## Yêu cầu phi chức năng (ngôn ngữ giao diện, quyền cần có, hiệu năng, cài đặt, chạy nền…)\n' +
    '## Trường hợp biên và lỗi (người dùng làm sai, thiếu quyền, mất mạng, trùng lịch…) và app phải phản ứng thế nào\n' +
    '## Giới hạn kỹ thuật phải nói rõ với người dùng (việc nền tảng không cho phép) và cách thay thế\n' +
    '## Giả định đã dùng (mỗi giả định kèm lý do chọn)',
  SOLUTION_ARCHITECT:
    'Viết tài liệu KIẾN TRÚC theo mẫu:\n' +
    '# Kiến trúc\n## Thành phần và trách nhiệm từng phần\n## Luồng dữ liệu (từ thao tác người dùng tới kết quả)\n' +
    '## Công nghệ chọn và lý do (một câu người không chuyên đọc được)\n## Cấu trúc thư mục (đường dẫn thật)\n' +
    '## Hợp đồng giữa các phần: tên hàm/kênh IPC/API chính xác, tham số, kết quả — frontend và backend phải dùng ĐÚNG các tên này\n' +
    '## Dựng, đóng gói, chạy thử (lệnh cụ thể, sản phẩm cuối nằm ở đâu)\n## Quyền hệ thống cần có và cách xin\n## Rủi ro kỹ thuật và cách giảm',
  UIUX_DESIGNER:
    'Viết tài liệu THIẾT KẾ theo mẫu — đủ để frontend dựng giống hệt, không phải đoán:\n' +
    '# Thiết kế giao diện\n## Tinh thần và nguyên tắc (sản phẩm này cần cảm giác gì, vì sao)\n' +
    '## Hệ thống thiết kế: bảng màu (mã hex, màu nào mang nghĩa gì), phông chữ và cỡ chữ, khoảng cách, bo góc, bóng; có cả sáng/tối nếu hợp\n' +
    '## Danh sách màn hình và luồng đi giữa chúng\n' +
    '## Từng màn hình: mục đích; bố cục (vùng nào ở đâu, kích thước); thành phần; CHỮ HIỂN THỊ nguyên văn tiếng Việt; ' +
    'trạng thái rỗng / đang tải / lỗi / thành công; thao tác và phản hồi\n' +
    '## Chi tiết tạo cảm giác chuyên nghiệp (không dùng giao diện HTML mặc định, không thanh menu mặc định, biểu tượng nhất quán)\n## Tiếp cận: bàn phím, tương phản, cỡ chữ',
  WEB_PRODUCT_LEAD:
    'Viết tài liệu WEBSITE theo mẫu:\n' +
    '# Website\n## Mục tiêu chuyển đổi (khách phải làm gì, đo bằng gì)\n## Khách hàng mục tiêu\n' +
    '## Sơ đồ trang: mỗi trang gồm mục đích, nội dung chính, hành động chính, phục vụ mục tiêu nào\n' +
    '## Nội dung chữ chính (tiêu đề, lời kêu gọi) nguyên văn tiếng Việt\n## Yêu cầu SEO, hiệu năng, tiếp cận cho đội rà soát',
};

/**
 * Một lớp cho năm vai trò lập kế hoạch: khác nhau ở prompt và mẫu tài liệu, còn
 * quy trình giống hệt — đọc ngữ cảnh và tài liệu các bước trước, viết tài liệu
 * của phòng mình vào `docs/` của dự án để mọi bước sau đọc nguyên văn.
 */
export class PlanningAgent implements Agent {
  readonly definition: AgentDefinition;
  readonly #instruction: string;

  constructor(role: PlanningRole) {
    const profile = agentProfile(role);
    this.definition = {
      role,
      displayName: profile.displayName,
      department: profile.department,
      promptRole: role,
      defaultTaskKind: role === 'SOLUTION_ARCHITECT' ? 'architecture_review' : 'general',
      // Cần workspace để ghi tài liệu vào docs/ cho các phòng sau đọc.
      needsSandbox: true,
    };
    this.#instruction = PLANNING_INSTRUCTIONS[role];
  }

  async run(context: AgentContext): Promise<AgentOutcome> {
    const doc = DEPARTMENT_DOCS[this.definition.role]!;
    const result = await generateStructured(
      context.gateway,
      {
        agentRole: this.definition.role,
        system: buildSystemPrompt(this.definition.promptRole, context.knowledge),
        messages: [
          {
            role: 'user',
            content:
              `${describeContext(context)}\n\n${this.#instruction}\n\n` +
              `Trường "document" là toàn bộ tài liệu (markdown) sẽ được lưu ở ${doc.path}. ` +
              'Trường "summary" là 2–4 câu tóm tắt cho dashboard.\n\n' +
              ASK_INSTRUCTION,
          },
        ],
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        taskKind: this.definition.defaultTaskKind,
        signal: context.signal,
      },
      planningSchema,
      `{
  "summary": "tóm tắt 2–4 câu",
  "document": "# ...\n## ...\n(tài liệu đầy đủ theo mẫu)",
  "risks": [],
  "questions": []
}`,
    );

    const content = result.data.document.trim() + '\n';
    await context.sandbox?.writeFile(doc.path, content);

    return {
      status: 'completed',
      summary: `${result.data.summary}\n\nTài liệu: ${doc.path}`,
      producedFiles: [{ path: doc.path, content }],
      questions: result.data.questions,
      endState: 'completed',
      costUsd: result.costUsd,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Developer — §3.6, §3.7                                                      */
/* -------------------------------------------------------------------------- */

/** Vai trò viết file vào workspace: mã sản phẩm hoặc cấu hình triển khai. */
type BuilderRole = Extract<
  AgentRole,
  'BACKEND_DEVELOPER' | 'FRONTEND_DEVELOPER' | 'MOBILE_DEVELOPER' | 'DEVOPS'
>;

/**
 * Một lớp dùng chung cho các vai trò sinh file: khác nhau ở prompt và phạm vi
 * được ghi, còn quy trình thì giống hệt — sinh file, ghi vào sandbox, chạy test.
 *
 * DevOps cũng nằm ở đây vì sản phẩm của nó cũng là file trong workspace
 * (script build, cấu hình CI), chỉ khác nội dung.
 */
export class DeveloperAgent implements Agent {
  readonly definition: AgentDefinition;

  constructor(role: BuilderRole) {
    const profile = agentProfile(role);
    this.definition = {
      role,
      displayName: profile.displayName,
      department: profile.department,
      promptRole: role,
      defaultTaskKind: 'code',
      needsSandbox: true,
    };
  }

  async run(context: AgentContext): Promise<AgentOutcome> {
    if (!context.sandbox) {
      return {
        status: 'failed',
        summary: 'Không có workspace sandbox nên không thể viết mã (§18).',
        endState: 'blocked',
      };
    }

    const sandbox = context.sandbox;
    // Cho model biết trong workspace đang có gì, để nó sửa thay vì viết đè.
    const existing = await sandbox.listFiles().catch((): string[] => []);
    // Kèm nội dung các file định hình sản phẩm (trang, CSS, package.json): không
    // có nó thì dev "sửa" bằng cách viết lại từ đầu và giao diện của Designer
    // biến mất — từng có sản phẩm thành trang trần đúng như vậy.
    const shown = await keyFileContents(context.sandbox, existing);
    const fileList =
      existing.length > 0
        ? `\nFile hiện có trong workspace:\n${existing.slice(0, 100).join('\n')}` +
          (shown ? `\n\nNỘI DUNG FILE ĐANG CÓ (sửa trên nền này, đừng viết lại):\n${shown}` : '')
        : '\nWorkspace đang trống.';

    const brief = `${describeContext(context)}${fileList}`;
    const request = {
      agentRole: this.definition.role,
      system: buildSystemPrompt(this.definition.promptRole, context.knowledge),
      projectId: context.projectId,
      taskId: context.taskId,
      runId: context.runId,
      agentId: context.agentId,
      signal: context.signal,
    };
    const progress = (pct: number, text: string): void => {
      if (!context.taskId) return;
      void context.events
        .publish('AGENT_PROGRESS', { taskId: context.taskId, agentRole: this.definition.role, pct: Math.round(pct), text }, {
          agentId: context.agentId,
          projectId: context.projectId,
          taskId: context.taskId,
        })
        .catch(() => undefined);
    };

    // Việc dài chia nhỏ: một lần gọi "viết cả ứng dụng" 10 phút bị cắt là mất trắng.
    // Bước 1 lập danh sách tệp (gọi nhỏ), bước 2 viết theo lô ≤ BATCH tệp, sau mỗi lô ghi tiến độ
    // vào workspace — lượt sau bị cắt giữa chừng thì đọc lại và viết tiếp tệp còn thiếu.
    const saved = await readProgress(context.sandbox, context.taskId);
    const resumable = saved && saved.taskId === context.taskId && saved.fixLoopCount === (context.task?.fixLoopCount ?? 0);
    let costUsd = 0;
    let plan: CodePlan;
    if (resumable) {
      plan = saved.plan;
      progress((saved.done.length / plan.files.length) * 80, `Viết tiếp ${plan.files.length - saved.done.length} tệp còn thiếu`);
    } else {
      const planned = await generateStructured(
        context.gateway,
        {
          ...request,
          messages: [
            {
              role: 'user',
              content:
                `${brief}\n\n` +
                'Hãy lập danh sách tệp cần tạo mới hoặc sửa cho task này (chưa viết nội dung). Mỗi tệp một dòng mục đích ' +
                'ngắn. File đã có thì sửa trên nền hiện tại: giữ bố cục, CSS và cấu trúc mà Designer và các dev trước đã làm, ' +
                'không viết lại từ đầu, không xoá giao diện. Kèm ít nhất một tệp test; chưa có package.json thì thêm và đặt ' +
                '"test" script chạy được. Xếp thứ tự để tệp sau chỉ phụ thuộc tệp trước (package.json, cấu hình, lõi, giao diện, test).\n\n' +
                ASK_INSTRUCTION,
            },
          ],
          taskKind: context.task && context.task.fixLoopCount > 0 ? 'debugging' : 'code',
          maxOutputTokens: 4_000,
        },
        fileListSchema,
        `{ "summary": "sẽ làm gì", "files": [{ "path": "src/app.ts", "purpose": "màn hình chính" }], "testCommand": "npm test" }`,
      );
      costUsd += planned.costUsd;
      if (planned.data.questions?.length) {
        return { status: 'completed', summary: planned.data.summary, questions: planned.data.questions, endState: 'idle', costUsd };
      }
      plan = { summary: planned.data.summary, files: planned.data.files, testCommand: planned.data.testCommand ?? null };
      await writeProgress(context.sandbox, { taskId: context.taskId, fixLoopCount: context.task?.fixLoopCount ?? 0, plan, done: [] });
    }

    // Bước 2: viết theo lô. Tệp mô hình quên trả trong lô vẫn nằm trong danh sách chờ; chặn vòng lặp vô hạn bằng số lô tối đa.
    const done = new Set<string>(resumable ? saved.done : []);
    const written: Array<{ path: string; content: string }> = [];
    const planText = plan.files.map((file) => `- ${file.path}: ${file.purpose}`).join('\n');
    const callBatch = async (pending: CodePlan['files']): Promise<StructuredResult<z.output<typeof codeSchema>>> => {
      const already = await writtenSoFar(sandbox, [...done]);
      return generateStructured(
        context.gateway,
        {
          ...request,
          messages: [
            {
              role: 'user',
              content:
                `${brief}\n\nKẾ HOẠCH TỆP (${plan.summary}):\n${planText}\n\n` +
                (already ? `TỆP ĐÃ VIẾT XONG TRONG LƯỢT NÀY (tham chiếu đúng tên hàm/đường dẫn từ đây):\n${already}\n\n` : '') +
                `Bây giờ viết TOÀN BỘ nội dung (không diff, không viết tắt) cho đúng các tệp sau, không thêm tệp khác:\n` +
                pending.map((file) => `- ${file.path}: ${file.purpose}`).join('\n') +
                '\npackage.json chỉ thêm hoặc sửa khoá cần thiết.',
            },
          ],
          taskKind: context.task && context.task.fixLoopCount > 0 ? 'debugging' : 'code',
          maxOutputTokens: 24_000,
        },
        codeSchema,
        `{ "summary": "đã viết gì", "files": [{ "path": "${pending[0]?.path ?? 'src/app.ts'}", "content": "toàn bộ nội dung file" }], "testCommand": "npm test" }`,
      );
    };
    let batches = 0;
    const maxBatches = Math.ceil(plan.files.length / BATCH) + 4;
    while (done.size < plan.files.length && batches < maxBatches) {
      stopIfTimedOut(context.signal);
      batches += 1;
      let pending = plan.files.filter((file) => !done.has(file.path)).slice(0, BATCH);
      let batch: StructuredResult<z.output<typeof codeSchema>>;
      try {
        batch = await callBatch(pending);
      } catch (error) {
        // Không ra JSON thường là câu trả lời bị cắt vì lô quá dài (Electron: 6 tệp giao diện + lõi
        // vượt trần token cả hai hãng). Thu lô còn một nửa rồi hỏi lại; còn một tệp mà vẫn hỏng thì chịu.
        if (!(error instanceof StructuredOutputError) || pending.length === 1) throw error;
        pending = pending.slice(0, Math.ceil(pending.length / 2));
        batch = await callBatch(pending);
      }
      costUsd += batch.costUsd;
      const wanted = new Set(pending.map((file) => file.path));
      const accepted = batch.data.files.filter((file) => wanted.has(file.path) || !done.has(file.path));
      await writeFiles(context.sandbox, accepted);
      for (const file of accepted) {
        done.add(file.path);
        written.push(file);
      }
      await writeProgress(context.sandbox, { taskId: context.taskId, fixLoopCount: context.task?.fixLoopCount ?? 0, plan, done: [...done] });
      progress((Math.min(done.size, plan.files.length) / plan.files.length) * 80, `Đã viết ${Math.min(done.size, plan.files.length)}/${plan.files.length} tệp`);
    }

    // Tự chạy test trước khi báo xong. Trước đây dev giao thẳng cho QA mà chưa
    // từng chạy thử; QA chấm rớt, dev sửa mù theo mô tả — từng có dự án
    // đi 13 vòng như vậy. Đỏ thì được sửa đúng một lần với output thật.
    stopIfTimedOut(context.signal);
    progress(85, 'Đang chạy test');
    let check = await selfTest(context.sandbox);
    let files = dedupe(written);
    let summary = plan.summary;
    // Sửa tối đa SELF_FIX_ROUNDS vòng: một vòng thường chỉ gỡ được lỗi đầu tiên (test), lỗi biên dịch lộ ra sau đó.
    for (let round = 1; round <= SELF_FIX_ROUNDS && check && check.exitCode !== 0; round += 1) {
      stopIfTimedOut(context.signal);
      progress(88 + round * 2, 'Tự kiểm còn đỏ, đang sửa');
      const fix = await generateStructured(
        context.gateway,
        {
          agentRole: this.definition.role,
          system: buildSystemPrompt(this.definition.promptRole, context.knowledge),
          messages: [
            { role: 'user', content: `${brief}\n\nKẾ HOẠCH TỆP:\n${planText}` },
            { role: 'assistant', content: `Đã viết các tệp: ${[...done].join(', ')}` },
            {
              role: 'user',
              content:
                `Đã ghi file và chạy \`${check.command}\`, kết quả ĐỎ (exit ${check.exitCode}):\n` +
                `${tail(stripAnsi(check.stdout), 6000)}\n${tail(stripAnsi(check.stderr), 4000)}\n\n` +
                (await errorExcerpts(context.sandbox, `${check.stdout}\n${check.stderr}`)) +
                'Sửa đúng chỗ lỗi (đoạn mã ở trên có số dòng), đừng viết lại cả tầng hay đổi cấu trúc chỗ đang chạy được. ' +
                'Sửa cho lệnh này xanh. Không đổi tên hay xoá kiểu, hàm mà tệp khác (kể cả của phòng khác) đang dùng; ' +
                'buộc phải đổi thì sửa luôn nơi dùng. Chỉ trả về những file cần thay đổi, mỗi file đầy đủ nội dung.',
            },
          ],
          projectId: context.projectId,
          taskId: context.taskId,
          runId: context.runId,
          agentId: context.agentId,
          taskKind: 'debugging',
          maxOutputTokens: 24_000,
          signal: context.signal,
        },
        codeSchema,
        `{ "summary": "đã sửa gì", "files": [{ "path": "...", "content": "..." }], "testCommand": "npm test" }`,
      );
      costUsd += fix.costUsd;
      await writeFiles(context.sandbox, fix.data.files);
      const fixed = new Set(fix.data.files.map((file) => file.path));
      files = [...files.filter((file) => !fixed.has(file.path)), ...fix.data.files];
      summary = `${summary}\n\nTự kiểm vòng ${round} đỏ (${check.command}), đã sửa: ${fix.data.summary}`;
      stopIfTimedOut(context.signal);
      check = await selfTest(context.sandbox);
    }
    // Xong lượt: xoá tiến độ để lượt sau (vòng sửa mới) lập kế hoạch lại từ đầu.
    await clearProgress(context.sandbox, context.taskId);
    progress(100, 'Xong');

    const verdict = !check
      ? 'Chưa có package.json nên chưa chạy được test.'
      : check.exitCode === 0
        ? `✅ ${check.command} xanh.`
        : `❌ ${check.command} vẫn đỏ (exit ${check.exitCode}):\n${tail(`${check.stdout}\n${check.stderr}`, 2000)}`;

    return {
      status: 'completed',
      summary: `${summary}\n\n${verdict}\n\nĐã ghi ${files.length} file: ${files.map((file) => file.path).join(', ')}`,
      producedFiles: files,
      endState: 'completed',
      costUsd,
    };
  }
}

/** Số tệp mỗi lần gọi model: đủ nhỏ để một lần gọi vài phút và không vượt trần token, đủ lớn để tệp liên quan đi cùng nhau. */
const BATCH = 4;
/**
 * Tiến độ lượt đang viết, nằm trong workspace để lượt sau (cùng task, cùng vòng sửa) viết tiếp. Mỗi task một file:
 * trước đây cả dự án dùng chung `.pn/tien-do.json`, lượt Frontend ghi đè tiến độ của Backend đang dở.
 */
function progressFile(taskId: string | null): string {
  return `.pn/tien-do/${taskId ?? 'chung'}.json`;
}

/** Lượt đã hết giờ: dừng giữa hai bước (tiến độ đã lưu sau mỗi lô) thay vì mở thêm lời gọi hay chạy test mới. */
function stopIfTimedOut(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Hết giờ của lượt chạy — đã dừng, tiến độ đã lưu để lượt sau viết tiếp');
}

interface CodePlan {
  summary: string;
  files: Array<{ path: string; purpose: string }>;
  testCommand: string | null;
}

interface CodeProgress {
  taskId: string | null;
  fixLoopCount: number;
  plan: CodePlan;
  done: string[];
}

const fileListSchema = z
  .object({
    summary: clipped(2000, 1),
    files: z.array(z.object({ path: filePathSchema, purpose: clipped(300).default('') })).max(40).default([]),
    testCommand: z.string().max(200).nullable().default(null),
    questions: questionsField,
  })
  // Còn câu hỏi thì chưa lập được danh sách tệp là bình thường (Backend từng bị coi là trả sai khuôn); không hỏi thì phải có tệp.
  .refine((plan) => plan.files.length > 0 || plan.questions.length > 0, {
    path: ['files'],
    message: 'cần ít nhất một tệp (hoặc đặt câu hỏi trong "questions")',
  });

async function readProgress(sandbox: NonNullable<AgentContext['sandbox']>, taskId: string | null): Promise<CodeProgress | null> {
  try {
    const parsed = JSON.parse(await sandbox.readFile(progressFile(taskId))) as CodeProgress;
    return parsed.plan?.files?.length ? parsed : null;
  } catch {
    return null;
  }
}

async function writeProgress(sandbox: NonNullable<AgentContext['sandbox']>, progress: CodeProgress): Promise<void> {
  await sandbox.writeFile(progressFile(progress.taskId), JSON.stringify(progress, null, 2)).catch(() => undefined);
}

async function clearProgress(sandbox: NonNullable<AgentContext['sandbox']>, taskId: string | null): Promise<void> {
  await sandbox.writeFile(progressFile(taskId), '{}').catch(() => undefined);
}

/** Nội dung các tệp đã viết trong lượt này để lô sau tham chiếu đúng; cắt để không nổ ngữ cảnh. */
async function writtenSoFar(sandbox: NonNullable<AgentContext['sandbox']>, paths: string[]): Promise<string> {
  const chunks: string[] = [];
  let total = 0;
  for (const path of paths) {
    const content = await sandbox.readFile(path).catch(() => null);
    if (content === null) continue;
    const body = content.length > 5000 ? `${content.slice(0, 5000)}\n…[cắt bớt]` : content;
    const chunk = `--- ${path} ---\n${body}`;
    if (total + chunk.length > 30_000) break;
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join('\n\n');
}

/** Tệp ghi nhiều lần thì giữ bản cuối. */
function dedupe(files: Array<{ path: string; content: string }>): Array<{ path: string; content: string }> {
  const last = new Map<string, { path: string; content: string }>();
  for (const file of files) last.set(file.path, file);
  return [...last.values()];
}

/**
 * Ghi file, riêng package.json thì hợp nhất với bản đang có. Mỗi vai trò trả
 * về CẢ file, nên dev backend từng ghi đè package.json và xoá sạch toolchain
 * (vite, vitest, script build) mà DevOps vừa dựng — sản phẩm hết build được.
 */
async function writeFiles(
  sandbox: NonNullable<AgentContext['sandbox']>,
  files: Array<{ path: string; content: string }>,
): Promise<void> {
  for (const file of files) {
    const content =
      file.path === 'package.json' ? await mergePackageJson(sandbox, file.content) : file.content;
    await sandbox.writeFile(file.path, content);
  }
}

/** File định hình sản phẩm mà dev phải nhìn thấy trước khi sửa: trang, CSS, entry, package.json. */
export async function keyFileContents(
  sandbox: Pick<NonNullable<AgentContext['sandbox']>, 'readFile'>,
  files: string[],
  limits = { perFile: 6000, total: 24000, count: 8 },
): Promise<string> {
  const wanted = files.filter(
    (path) =>
      /^(index\.html|package\.json|README\.md)$/.test(path) ||
      /^src\/[^/]+\.(html|css)$/.test(path) ||
      /^src\/(main|index|app)\.(ts|tsx|js|jsx)$/.test(path),
  );
  const chunks: string[] = [];
  let total = 0;
  for (const path of wanted.slice(0, limits.count)) {
    const content = await sandbox.readFile(path).catch(() => null);
    if (content === null) continue;
    const body = content.length > limits.perFile ? `${content.slice(0, limits.perFile)}\n…[cắt bớt]` : content;
    const chunk = `--- ${path} ---\n${body}`;
    if (total + chunk.length > limits.total) break;
    chunks.push(chunk);
    total += chunk.length;
  }
  return chunks.join('\n\n');
}

export async function mergePackageJson(
  sandbox: Pick<NonNullable<AgentContext['sandbox']>, 'readFile'>,
  incomingText: string,
): Promise<string> {
  const existingText = await sandbox.readFile('package.json').catch(() => null);
  if (!existingText) return incomingText;
  let existing: Record<string, unknown>;
  let incoming: Record<string, unknown>;
  try {
    existing = JSON.parse(existingText) as Record<string, unknown>;
    incoming = JSON.parse(incomingText) as Record<string, unknown>;
  } catch {
    return incomingText;
  }
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  for (const key of ['scripts', 'dependencies', 'devDependencies']) {
    const a = (existing[key] ?? {}) as Record<string, unknown>;
    const b = (incoming[key] ?? {}) as Record<string, unknown>;
    if (Object.keys(a).length > 0 || Object.keys(b).length > 0) merged[key] = { ...a, ...b };
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Cài, chạy `npm test`, rồi kiểm biên dịch cả dự án; trả lệnh ĐỎ đầu tiên (xanh hết thì lệnh test), không có
 * package.json thì null. Kiểm biên dịch vì test xanh chưa đủ: từng có lúc Frontend sửa src/shared/types.ts,
 * test của mình vẫn xanh nhưng preload.ts của Backend hết biên dịch được — không ai biết tới khi QA dựng.
 */
async function selfTest(
  sandbox: NonNullable<AgentContext['sandbox']>,
): Promise<Awaited<ReturnType<NonNullable<AgentContext['sandbox']>['exec']>> | null> {
  const files = await sandbox.listFiles().catch((): string[] => []);
  if (!files.includes('package.json')) return null;
  const install = await sandbox.exec('npm', [...NPM_INSTALL_ARGS]);
  if (install.exitCode !== 0) return install;
  const test = await sandbox.exec('npm', ['test', '--silent']);
  if (test.exitCode !== 0) return test;
  // typecheck → compile → build; bỏ build nếu nó đóng gói (.exe) — mất vài phút, bước dựng staging lo phần đó.
  const scripts = await packageScripts(sandbox);
  const compile = ['typecheck', 'compile', 'build'].find(
    (name) => scripts[name] && !(name === 'build' && /electron-builder|pyinstaller|electron-packager/i.test(scripts[name]!)),
  );
  if (!compile) return test;
  const compiled = await sandbox.exec('npm', ['run', compile, '--silent']);
  return compiled.exitCode !== 0 ? compiled : test;
}

/** Bỏ mã màu terminal (tsc, npm in màu) — trong câu nhắc chúng chỉ là rác che mất đường dẫn và số dòng. */
function stripAnsi(text: string): string {
  return text.replace(ANSI_COLOR, '');
}
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Đoạn mã ±30 dòng (đánh số dòng) quanh từng chỗ lỗi mà output nêu (`src/a.ts:109:3`, `src/a.ts(109,3)`), tối đa 4 tệp.
 * Không có đoạn này vòng sửa chỉ thấy thông báo lỗi, không thấy mã: Frontend từng sửa hai vòng không trúng một lỗi
 * một dòng (app.ts:109 thiếu `?? null`), còn viết lại cả tầng giao diện.
 */
async function errorExcerpts(sandbox: NonNullable<AgentContext['sandbox']>, output: string): Promise<string> {
  const hits = new Map<string, Set<number>>();
  for (const match of stripAnsi(output).matchAll(/([\w@.-]+(?:\/[\w@.-]+)*\.(?:tsx?|jsx?|mjs|cjs|vue|svelte))(?:[:(](\d+))?/g)) {
    const file = match[1]!.replace(/^\.\//, '');
    if (/(^|\/)(node_modules|out-test|dist|build)\//.test(file)) continue;
    const lines = hits.get(file) ?? new Set<number>();
    if (match[2]) lines.add(Number(match[2]));
    hits.set(file, lines);
  }
  const chunks: string[] = [];
  for (const [file, lines] of [...hits].slice(0, 4)) {
    const content = await sandbox.readFile(file).catch(() => null);
    if (content === null) continue;
    const all = content.split('\n');
    const wanted = lines.size > 0 ? [...lines].sort((a, b) => a - b) : [1];
    // Gộp các khoảng chồng nhau để một tệp nhiều lỗi gần nhau không lặp đoạn.
    const ranges: Array<[number, number]> = [];
    for (const line of wanted) {
      const from = Math.max(1, line - 30);
      const to = Math.min(all.length, line + 30);
      const last = ranges.at(-1);
      if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
      else ranges.push([from, to]);
    }
    for (const [from, to] of ranges) {
      chunks.push(`--- ${file} (dòng ${from}–${to}) ---\n${all.slice(from - 1, to).map((text, i) => `${from + i}| ${text}`).join('\n')}`);
    }
  }
  return chunks.length > 0 ? `MÃ QUANH CHỖ LỖI:\n${chunks.join('\n\n').slice(0, 24_000)}\n\n` : '';
}

/** Số vòng dev tự sửa khi tự kiểm còn đỏ, trước khi giao cho QA. */
const SELF_FIX_ROUNDS = 2;

function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}

/* -------------------------------------------------------------------------- */
/* QA — §3.9                                                                   */
/* -------------------------------------------------------------------------- */

/** Hàm chạy thử sản phẩm thật; test thay bằng hàm giả. */
export type ProductProbe = (workspace: string, screenshotDir: string) => Promise<RuntimeReport | null>;

export class QaAgent implements Agent {
  readonly definition: AgentDefinition = {
    role: 'QA',
    displayName: 'Kiểm thử',
    department: 'QA_LAB',
    promptRole: 'QA',
    defaultTaskKind: 'debugging',
    needsSandbox: true,
  };

  readonly #probe: ProductProbe;

  constructor(options: { probe?: ProductProbe } = {}) {
    this.#probe = options.probe ?? ((workspace, screenshotDir) => probeProduct(workspace, { screenshotDir }));
  }

  async run(context: AgentContext): Promise<AgentOutcome> {
    if (!context.sandbox) {
      return {
        status: 'failed',
        summary: 'Không có workspace sandbox nên không chạy được test (§18).',
        endState: 'blocked',
      };
    }

    // Chạy test thật trước khi hỏi model. Kết luận phải dựa trên output thật,
    // không phải phỏng đoán từ việc đọc code (§3.9).
    const files = await context.sandbox.listFiles().catch((): string[] => []);
    const hasPackageJson = files.includes('package.json');

    let install = null;
    let test = null;
    if (hasPackageJson) {
      install = await context.sandbox.exec('npm', [...NPM_INSTALL_ARGS]);
      test = await context.sandbox.exec('npm', ['test', '--silent']);
    }

    // §144 — nghiệm thu bản dựng thật, không chỉ unit test: có script build thì
    // phải dựng được, và trang dựng ra phải giống thiết kế của UI/UX.
    let build = null;
    if (hasPackageJson && (await packageScripts(context.sandbox))['build']) {
      build = await context.sandbox.exec('npm', ['run', 'build', '--silent']);
    }
    const ui = await uiSnapshot(context.sandbox, files);

    // Chạy thử sản phẩm thật: mở web/Electron bằng trình duyệt, bấm nút, gom lỗi, chụp ảnh
    // vào `_anh-san-pham/<slug>/` cạnh workspace để bàn giao. Dựng lỗi thì không có gì để mở.
    const buildOk = build === null || (build.exitCode === 0 && !build.timedOut);
    const workspace = context.sandbox.workspace ?? '';
    const runtime = buildOk && workspace
      ? await this.#probe(workspace, path.join(path.dirname(workspace), '_anh-san-pham', path.basename(workspace))).catch(
          (error: unknown): RuntimeReport => ({
            kind: 'web',
            ok: false,
            pages: [],
            screenshots: [],
            detail: `Không chạy thử được: ${error instanceof Error ? error.message : String(error)}`,
          }),
        )
      : null;

    const evidence = [
      test
        ? [
            `Lệnh: ${test.command}`,
            `Exit code: ${test.exitCode}${test.timedOut ? ' (hết thời gian chờ)' : ''}`,
            `stdout:\n${test.stdout.slice(-8000)}`,
            `stderr:\n${test.stderr.slice(-8000)}`,
          ].join('\n')
        : 'Chưa chạy được test: workspace không có package.json nên không có bộ test nào để chạy.',
      build
        ? `KẾT QUẢ DỰNG (${build.command}): exit ${build.exitCode}${build.timedOut ? ' (hết giờ)' : ''}\n` +
          `${build.stdout.slice(-3000)}\n${build.stderr.slice(-3000)}`
        : 'Không có script build (hoặc không có package.json) nên không dựng.',
      ui
        ? `GIAO DIỆN ĐÃ DỰNG — đối chiếu với thiết kế của UI/UX ở "kết quả các bước trước":\n${ui}`
        : 'Không tìm thấy index.html để đối chiếu giao diện.',
      runtime
        ? `CHẠY THỬ SẢN PHẨM THẬT (${runtime.kind === 'electron' ? 'ứng dụng Electron' : 'trình duyệt'}): ${
            runtime.skipped ? 'BỎ QUA' : runtime.ok ? 'KHÔNG LỖI' : 'CÓ LỖI'
          }\n${runtime.detail}`
        : 'Không có gì để chạy thử (không thấy index.html đã dựng hay ứng dụng Electron).',
    ].join('\n\n');

    const result = await generateStructured(
      context.gateway,
      {
        agentRole: this.definition.role,
        system: buildSystemPrompt('QA', context.knowledge),
        messages: [
          {
            role: 'user',
            content:
              `${describeContext(context)}\n\n` +
              `File trong workspace:\n${files.slice(0, 100).join('\n')}\n\n` +
              `KẾT QUẢ CHẠY TEST:\n${evidence}\n\n` +
              (install && install.exitCode !== 0
                ? `Cài đặt phụ thuộc cũng lỗi (exit ${install.exitCode}):\n${install.stderr.slice(-3000)}\n\n`
                : '') +
              'Dựa trên kết quả thật ở trên, kết luận đạt hay không đạt. Không đạt khi: test đỏ, ' +
              'dựng lỗi, chạy thử có lỗi JavaScript/console/request hỏng, trang không có gì bấm được, ' +
              'hoặc giao diện không theo thiết kế của UI/UX (trang trần không CSS, thiếu ' +
              'thành phần chính, bố cục/màu khác hẳn). Lỗi giao diện đặt title bắt đầu bằng "Giao diện:". ' +
              'Không đạt thì liệt kê từng lỗi kèm cách tái hiện.\n\n' +
              ASK_INSTRUCTION,
          },
        ],
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        taskKind: 'debugging',
        signal: context.signal,
      },
      qaSchema,
      `{
  "passed": false,
  "summary": "kết luận ngắn gọn",
  "bugs": [{ "title": "...", "description": "cách tái hiện + đoạn output lỗi", "severity": "HIGH" }]
}`,
    );

    // Chốt chặn: test fail hoặc chưa chạy được test thì không thể "đạt", dù model
    // có nói gì đi nữa (§3.9 — kết luận phải dựa trên bằng chứng).
    const testActuallyPassed = test !== null && test.exitCode === 0 && !test.timedOut;
    const buildActuallyPassed = buildOk;
    const runtimeActuallyPassed = runtime === null || runtime.skipped === true || runtime.ok;
    const passed = result.data.passed && testActuallyPassed && buildActuallyPassed && runtimeActuallyPassed;

    const bugs = [...result.data.bugs];
    if (result.data.passed && !runtimeActuallyPassed && runtime) {
      bugs.push({
        title: runtime.kind === 'electron' ? 'Ứng dụng mở lên có lỗi khi chạy thử' : 'Trang web có lỗi khi chạy thử trong trình duyệt',
        description: `QA đã mở sản phẩm thật và bấm thử; không thể đạt khi còn lỗi lúc chạy.\n\n${runtime.detail.slice(0, 3000)}`,
        severity: 'HIGH',
      });
    }
    if (result.data.passed && !buildActuallyPassed && build) {
      bugs.push({
        title: 'Bản dựng (npm run build) lỗi',
        description: `Không thể phát hành khi dựng lỗi.\n\n${build.stdout.slice(-2000)}\n${build.stderr.slice(-2000)}`,
        severity: 'HIGH',
      });
    }
    if (result.data.passed && !testActuallyPassed) {
      bugs.push({
        title: test === null ? 'Dự án chưa có bộ test chạy được' : 'Bộ test không chạy qua',
        description:
          'QA không được kết luận đạt khi chưa có bằng chứng test xanh.\n\n' + evidence.slice(0, 4000),
        severity: 'HIGH',
      });
    }

    return {
      status: 'completed',
      summary: passed
        ? `Đạt. ${result.data.summary}`
        : `Không đạt. ${result.data.summary}`,
      reportedBugs: passed ? [] : bugs,
      questions: result.data.questions,
      endState: passed ? 'completed' : 'alert',
      costUsd: result.costUsd,
    };
  }
}

/** scripts trong package.json của workspace; hỏng hay thiếu thì rỗng. */
async function packageScripts(
  sandbox: Pick<NonNullable<AgentContext['sandbox']>, 'readFile'>,
): Promise<Record<string, string>> {
  try {
    return (JSON.parse(await sandbox.readFile('package.json')) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

/** Trang đã dựng (dist/build/out, không thì gốc) kèm tối đa hai file CSS, để QA đối chiếu thiết kế. */
async function uiSnapshot(
  sandbox: Pick<NonNullable<AgentContext['sandbox']>, 'readFile'>,
  files: string[],
): Promise<string> {
  const chunks: string[] = [];
  for (const path of ['dist/index.html', 'build/index.html', 'out/index.html', 'index.html', 'src/index.html']) {
    const html = await sandbox.readFile(path).catch(() => null);
    if (html !== null) {
      chunks.push(`--- ${path} ---\n${html.slice(0, 6000)}`);
      break;
    }
  }
  if (chunks.length === 0) return '';
  const css = files.filter((path) => /\.css$/.test(path) && !/^(node_modules|dist|build|out)\//.test(path)).slice(0, 2);
  for (const path of css) {
    const content = await sandbox.readFile(path).catch(() => null);
    if (content !== null) chunks.push(`--- ${path} ---\n${content.slice(0, 4000)}`);
  }
  return chunks.join('\n\n');
}

/* -------------------------------------------------------------------------- */
/* Rà soát — §3.10 Security, §3.11 Red Team                                    */
/* -------------------------------------------------------------------------- */

type ReviewRole = Extract<
  AgentRole,
  'SECURITY' | 'RED_TEAM' | 'SEO' | 'WEB_PERFORMANCE' | 'ACCESSIBILITY'
>;

const REVIEW_INSTRUCTIONS: Record<ReviewRole, string> = {
  SECURITY:
    'Hãy rà mã nguồn trên tìm lỗ hổng bảo mật. Với mỗi lỗ hổng: nói rõ file và ' +
    'chỗ nào, khai thác được thế nào, hậu quả tới đâu, và sửa ra sao. ' +
    'Không chép giá trị bí mật vào báo cáo — mô tả vị trí là đủ.',
  RED_TEAM:
    'Hãy tìm cách làm hệ thống này hỏng hoặc làm sai: đầu vào bất thường, thứ tự ' +
    'thao tác bất thường, vượt quyền, lạm dụng chức năng đúng nghĩa. ' +
    'Với mỗi kịch bản: mô tả từng bước và kết quả thu được.',
  SEO:
    'Hãy rà phần SEO kỹ thuật: thẻ title và description, OpenGraph, dữ liệu có ' +
    'cấu trúc, sitemap.xml, robots.txt, canonical, cấu trúc heading và liên kết ' +
    'nội bộ. Mỗi thiếu sót nói rõ file nào và thêm gì vào đó.',
  WEB_PERFORMANCE:
    'Hãy tìm thứ làm trang chậm: ảnh không tối ưu hoặc thiếu kích thước, gói phụ ' +
    'thuộc nặng, mã không dùng tới, script chặn hiển thị, phần tử không đặt sẵn ' +
    'kích thước làm nhảy bố cục. Không đoán số đo bạn chưa chạy.',
  ACCESSIBILITY:
    'Hãy tìm chỗ người khuyết tật không dùng được: thẻ HTML dùng sai nghĩa, không ' +
    'đi được bằng bàn phím, ảnh thiếu mô tả, ô nhập thiếu nhãn, tương phản màu ' +
    'không đủ, ARIA dán bừa. Mỗi phát hiện nói rõ ai bị chặn ở bước nào.',
};

/** File không phải mã do đội viết: khoá phụ thuộc, bản dựng, ghi chú tiến độ nội bộ `.pn/`. */
const REVIEW_SKIP = /(^|\/)(node_modules|dist|build|out|out-test|release|coverage|\.next|\.pn)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/**
 * Thứ tự đọc cho người rà soát: cấu hình gói và HTML, rồi file ranh giới (main, preload, IPC, API, lưu trữ…),
 * rồi phần mã còn lại, test đọc sau cùng. Trong cùng nhóm giữ thứ tự ABC.
 */
function reviewOrder(files: string[]): string[] {
  const rank = (path: string): number => {
    if (/(^|\/)package\.json$/.test(path) || /\.html?$/.test(path)) return 0;
    if (/(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/.test(path)) return 3;
    if (/(main|preload|ipc|server|api|route|auth|storage|db|database|config)/i.test(path)) return 1;
    return 2;
  };
  return files
    .filter((path) => !REVIEW_SKIP.test(path) && /\.(ts|tsx|js|jsx|mjs|cjs|json|sql|ya?ml|html?)$/.test(path))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Đọc mã trong workspace rồi báo lỗi. Không sửa mã — phát hiện đi vào bug và
 * quay lại đúng người viết ra nó qua fix loop (§4).
 *
 * Đọc thật nội dung file chứ không chỉ tên file: một danh sách tên file không
 * đủ để nói bất kỳ điều gì có căn cứ về bảo mật.
 */
export class ReviewAgent implements Agent {
  readonly definition: AgentDefinition;
  readonly #instruction: string;

  /** Trần ký tự gửi lên model — đủ để rà một dự án nhỏ mà không thổi bay ngân sách. */
  static readonly #MAX_SOURCE_CHARS = 120_000;
  /** Trần mỗi file — một file dài không được chiếm hết chỗ của các file khác. */
  static readonly #MAX_FILE_CHARS = 15_000;

  constructor(role: ReviewRole) {
    const profile = agentProfile(role);
    this.definition = {
      role,
      displayName: profile.displayName,
      department: profile.department,
      promptRole: role,
      defaultTaskKind: 'architecture_review',
      needsSandbox: true,
    };
    this.#instruction = REVIEW_INSTRUCTIONS[role];
  }

  async run(context: AgentContext): Promise<AgentOutcome> {
    if (!context.sandbox) {
      return {
        status: 'failed',
        summary: 'Không có workspace sandbox nên không đọc được mã để rà (§18).',
        endState: 'blocked',
      };
    }

    const files = await context.sandbox.listFiles().catch((): string[] => []);
    const source = await this.#readSource(context.sandbox, files);

    if (source.length === 0) {
      return {
        status: 'completed',
        summary: 'Workspace chưa có mã nguồn nào để rà.',
        endState: 'completed',
      };
    }

    const result = await generateStructured(
      context.gateway,
      {
        agentRole: this.definition.role,
        system: buildSystemPrompt(this.definition.promptRole, context.knowledge),
        messages: [
          {
            role: 'user',
            content:
              `${describeContext(context)}\n\nMÃ NGUỒN:\n${source}\n\n${this.#instruction}\n` +
              'Mỗi phát hiện phải chỉ ra được đoạn mã cụ thể ở trên. Không báo lỗi kiểu "thiếu file" hay ' +
              '"không rà được" cho file có trong danh sách — những báo cáo đó đẩy đội dev sửa mù.\n\n' +
              ASK_INSTRUCTION,
          },
        ],
        projectId: context.projectId,
        taskId: context.taskId,
        runId: context.runId,
        agentId: context.agentId,
        taskKind: 'architecture_review',
        signal: context.signal,
      },
      qaSchema,
      `{
  "passed": true,
  "summary": "kết luận ngắn gọn",
  "bugs": [{ "title": "...", "description": "file, cách khai thác, cách sửa", "severity": "HIGH" }]
}`,
    );

    // Có phát hiện thì không thể "đạt", bất kể model đánh dấu thế nào.
    const clean = result.data.bugs.length === 0;
    return {
      status: 'completed',
      summary: clean
        ? `Không phát hiện vấn đề. ${result.data.summary}`
        : `Phát hiện ${result.data.bugs.length} vấn đề. ${result.data.summary}`,
      reportedBugs: clean ? [] : result.data.bugs,
      questions: result.data.questions,
      endState: clean ? 'completed' : 'alert',
      costUsd: result.costUsd,
    };
  }

  /**
   * Gom mã nguồn tới trần ký tự: file ranh giới bảo mật đọc trước, file dài cắt bớt, hết chỗ thì chỉ nêu tên.
   * Trước đây đọc theo ABC và dừng hẳn khi vượt trần — package-lock.json 160 KB chặn mất cả src/.
   */
  async #readSource(
    sandbox: NonNullable<AgentContext['sandbox']>,
    files: string[],
  ): Promise<string> {
    const chunks: string[] = [];
    const skipped: string[] = [];
    let total = 0;

    for (const path of reviewOrder(files)) {
      const content = await sandbox.readFile(path).catch(() => null);
      if (content === null) continue;

      const body = content.length > ReviewAgent.#MAX_FILE_CHARS
        ? `${content.slice(0, ReviewAgent.#MAX_FILE_CHARS)}\n… (cắt bớt, file dài ${content.length} ký tự)`
        : content;
      const chunk = `--- ${path} ---\n${body}`;
      if (total + chunk.length > ReviewAgent.#MAX_SOURCE_CHARS) {
        skipped.push(path);
        continue;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
    if (chunks.length > 0 && skipped.length > 0) {
      chunks.push(
        `--- Các file sau CÓ trong workspace nhưng không kèm nội dung vì hết chỗ — không được báo là thiếu ---\n` +
          skipped.join('\n'),
      );
    }
    return chunks.join('\n\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Đăng ký                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Mười hai agent lõi §3.1–§3.12. Phòng Web (§93–§97) và Knowledge & R&D (§99)
 * đăng ký thêm vào cùng registry này.
 */
export function coreAgents(): Agent[] {
  return [
    new CtoAgent(),
    new PlanningAgent('PRODUCT_MANAGER'),
    new PlanningAgent('BUSINESS_ANALYST'),
    new PlanningAgent('SOLUTION_ARCHITECT'),
    new PlanningAgent('UIUX_DESIGNER'),
    new DeveloperAgent('BACKEND_DEVELOPER'),
    new DeveloperAgent('FRONTEND_DEVELOPER'),
    new DeveloperAgent('MOBILE_DEVELOPER'),
    new DeveloperAgent('DEVOPS'),
    new QaAgent(),
    new ReviewAgent('SECURITY'),
    new ReviewAgent('RED_TEAM'),
  ];
}

/**
 * §93–§97 — phòng Web Development. Tách khỏi `coreAgents()` vì bốn vai trò này
 * chỉ có việc khi sản phẩm là website; dự án backend thuần không cần tới.
 */
export function webAgents(): Agent[] {
  return [
    new PlanningAgent('WEB_PRODUCT_LEAD'),
    new ReviewAgent('SEO'),
    new ReviewAgent('WEB_PERFORMANCE'),
    new ReviewAgent('ACCESSIBILITY'),
  ];
}
