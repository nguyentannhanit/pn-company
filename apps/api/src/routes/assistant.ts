/**
 * P&N — Trợ lý điều hành: CEO hỏi gì về công ty cũng trả lời được (§5.1, §57).
 *
 * Bot Telegram và tab Trợ lý trên web dùng chung đường này. Trước đây mọi câu
 * chữ tự do gửi cho bot đều bị coi là "giao việc mới" — hỏi "hôm nay tiêu bao
 * nhiêu?" là bot mở một dự án. Giờ model đọc SNAPSHOT (báo cáo CEO + đội ngũ
 * + phiếu chờ) rồi hoặc trả lời, hoặc nhận ra đây là yêu cầu làm sản phẩm và
 * đề nghị tạo dự án — tạo hay không vẫn là CEO bấm.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { PRODUCT_TYPES, type ProductType } from '@pn/shared';

import type { AppContext } from '../context.js';
import { buildCeoReport } from '../services/report.js';

export type AssistantReply =
  | { intent: 'answer'; text: string }
  | { intent: 'project'; goal: string; productType: ProductType; name: string };

const SYSTEM = `Bạn là trợ lý điều hành của P&N, công ty phần mềm vận hành bằng AI agent. Người hỏi là CEO.
Chỉ dùng số liệu trong SNAPSHOT; không có thì nói "chưa có dữ liệu". Tiền ghi dạng $1.23. Trả lời tiếng Việt, ngắn, đi thẳng vào con số và tên phòng/dự án; câu hỏi so sánh thì kê bảng ngắn bằng gạch đầu dòng.
Nếu tin nhắn là YÊU CẦU LÀM SẢN PHẨM MỚI (ví dụ "làm web...", "tạo app...", "viết phần mềm...") thì KHÔNG trả lời, mà đề nghị tạo dự án.
Luôn trả về đúng MỘT khối JSON, không kèm chữ ngoài JSON:
- trả lời: {"intent":"answer","text":"..."}
- yêu cầu làm sản phẩm: {"intent":"project","name":"tên dự án ngắn","goal":"mục tiêu viết lại đầy đủ, rõ ràng","productType":"WEB_APPLICATION|LANDING_PAGE|CORPORATE_WEBSITE|MOBILE_APPLICATION|DESKTOP_APPLICATION"}
Loại sản phẩm: phần mềm máy tính/.exe/Windows → DESKTOP_APPLICATION; điện thoại/Android/iOS → MOBILE_APPLICATION; landing/trang đích → LANDING_PAGE; website giới thiệu công ty → CORPORATE_WEBSITE; còn lại web → WEB_APPLICATION.`;

/** Ảnh chụp công ty tại thời điểm hỏi: đủ để trả lời tiền, phòng ban, dự án, phiếu chờ, sản phẩm. */
export async function companySnapshot(context: AppContext): Promise<Record<string, unknown>> {
  const [report, agents, pending, deployments] = await Promise.all([
    buildCeoReport(context.repos),
    context.repos.agents.list(),
    context.repos.approvals.listPending(),
    context.repos.deployments.listRecent(10),
  ]);
  const byState = new Map<string, string[]>();
  for (const agent of agents) {
    byState.set(agent.state, [...(byState.get(agent.state) ?? []), `${agent.displayName} (${agent.department})`]);
  }
  return {
    gioHienTai: new Date().toISOString(),
    chiPhi: { homNayUsd: report.costs.todayUsd, thangNayUsd: report.costs.monthUsd, luotGoiChuaCoGia: report.costs.unpricedCalls },
    duAn: report.projects,
    task: report.tasks,
    bug: report.bugs,
    baoMat: report.security,
    doiNgu: { tongAgent: agents.length, theoTrangThai: Object.fromEntries(byState) },
    phieuChoDuyet: pending.map((item) => ({ id: item.id, loai: item.kind, tieuDe: item.title, tomTat: item.summary.slice(0, 300), tuLuc: item.createdAt })),
    trienKhaiGanDay: deployments.map((item) => ({ duAnId: item.projectId, moiTruong: item.environment, trangThai: item.status, url: item.url, luc: item.createdAt })),
    ruiRo: report.risks,
    viecCeoCanLam: report.nextActions,
  };
}

/** Ép câu trả lời của model về một trong hai dạng; model nói lung tung thì coi là câu trả lời thường. */
export function parseAssistantReply(text: string): AssistantReply {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        intent?: string;
        text?: string;
        goal?: string;
        name?: string;
        productType?: string;
      };
      if (parsed.intent === 'project' && parsed.goal) {
        const productType = (PRODUCT_TYPES as readonly string[]).includes(parsed.productType ?? '')
          ? (parsed.productType as ProductType)
          : 'WEB_APPLICATION';
        return { intent: 'project', goal: parsed.goal, name: parsed.name?.trim() || parsed.goal.slice(0, 60), productType };
      }
      if (typeof parsed.text === 'string' && parsed.text.trim()) return { intent: 'answer', text: parsed.text.trim() };
    } catch {
      // không phải JSON — dùng nguyên văn
    }
  }
  return { intent: 'answer', text: text.trim() || 'Tôi chưa trả lời được câu này.' };
}

export async function assistantRoutes(app: FastifyInstance, context: AppContext): Promise<void> {
  app.post('/assistant/ask', { preHandler: app.authenticate }, async (request, reply) => {
    const { question } = z.object({ question: z.string().min(1).max(4000) }).parse(request.body);
    const snapshot = await companySnapshot(context);
    const result = await context.gateway.generate({
      agentRole: 'CTO_ORCHESTRATOR',
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: `SNAPSHOT (JSON):\n${JSON.stringify(snapshot)}\n\nTIN NHẮN CỦA CEO:\n${question}`,
        },
      ],
      // Hạng rẻ là đủ: việc là đọc số liệu có sẵn, không phải suy luận; hạng
      // mạnh vừa chậm (12s) vừa tiêu hết token vào suy nghĩ rồi trả về rỗng.
      taskKind: 'summarization',
      maxOutputTokens: 4_000,
    });
    let parsed = parseAssistantReply(result.text);
    let costUsd = result.costUsd ?? 0;
    if (!result.text.trim()) {
      // Model trả rỗng (hết token suy luận) thì hỏi lại một lần, ngắn hơn.
      const retry = await context.gateway.generate({
        agentRole: 'CTO_ORCHESTRATOR',
        system: SYSTEM,
        messages: [{ role: 'user', content: `SNAPSHOT (JSON):
${JSON.stringify(snapshot)}

TIN NHẮN CỦA CEO:
${question}

Trả lời tối đa 3 câu.` }],
        taskKind: 'summarization',
        maxOutputTokens: 4_000,
      });
      parsed = parseAssistantReply(retry.text);
      costUsd += retry.costUsd ?? 0;
    }
    return reply.send({ ...parsed, costUsd });
  });
}
