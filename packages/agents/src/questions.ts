/**
 * P&N — Hỏi đáp nội bộ: phòng ban hỏi, Phòng điều hành quyết.
 *
 * App tắt/mở máy ra rỗng vì chỗ chưa rõ ("tự bật máy từ tắt hẳn hay từ ngủ?",
 * "cần quyền quản trị không?") bị đoán bừa rồi ghi vào "rủi ro". Nay phòng nào
 * gặp chỗ chưa rõ thì hỏi; Phòng điều hành trả lời ngay theo mục tiêu của CEO và
 * ghi vào Sổ quyết định, phòng đó làm lại với câu trả lời. CEO chỉ bị hỏi khi câu
 * hỏi làm phát sinh chi phí thật.
 */

import type { AgentRole } from '@pn/shared';
import { z } from 'zod';

import type { AgentGatewayClient } from './gateway-client.js';
import { buildSystemPrompt } from './prompts.js';
import { generateStructured } from './structured.js';
import { clipped } from './clip.js';

const questionShape = z.object({
  question: clipped(500, 5),
  /** Vì sao phải hỏi: câu trả lời đổi điều gì trong sản phẩm. */
  why: clipped(500).default(''),
  /** 2–4 phương án cụ thể. Câu hỏi chi phí: phương án đầu là cách tốn tiền, phương án sau là cách không tốn. */
  options: z.array(clipped(300, 1)).min(2).max(4),
  /** Chỉ số phương án phòng hỏi đề xuất. */
  recommended: z.number().int().min(0).default(0),
  /** Có làm phát sinh chi phí thật (dịch vụ trả phí, mua bản quyền, vượt ngân sách) không. */
  costImpact: z.boolean().default(false),
});

/** Chữ đầu tiên có nội dung trong một object mô hình trả về thay cho chuỗi (label, text, title…). */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const main = ['label', 'text', 'title', 'option', 'name', 'value', 'answer'].map((k) => record[k]).find((v) => typeof v === 'string' && v.trim());
  const detail = ['description', 'detail', 'details'].map((k) => record[k]).find((v) => typeof v === 'string' && v.trim());
  if (typeof main === 'string' && typeof detail === 'string') return `${main.trim()} — ${detail.trim()}`;
  return typeof main === 'string' ? main.trim() : typeof detail === 'string' ? detail.trim() : null;
}

/**
 * Model hay trả câu hỏi lệch dạng: khoá "text" thay "question", phương án là object {label, description},
 * "recommended" là chữ "B" hay chuỗi "1". Đọc rộng ở đây
 * thay vì bắt model làm lại: nội dung câu hỏi vẫn đủ, chỉ hình thức lệch.
 */
function normalizeQuestion(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const raw = input as Record<string, unknown>;
  const options = Array.isArray(raw['options'])
    ? raw['options'].map(textOf).filter((o): o is string => o !== null)
    : raw['options'];

  let recommended = raw['recommended'];
  if (typeof recommended === 'string' && Array.isArray(options)) {
    const trimmed = recommended.trim();
    const letter = /^[A-Da-d]$/.test(trimmed) ? trimmed.toUpperCase().charCodeAt(0) - 65 : Number.NaN;
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
    const byText = options.indexOf(trimmed);
    recommended = !Number.isNaN(numeric) ? numeric : !Number.isNaN(letter) ? letter : byText >= 0 ? byText : 0;
  }
  if (typeof recommended === 'number' && Array.isArray(options) && recommended >= options.length) recommended = 0;

  const question = raw['question'] ?? raw['text'] ?? raw['title'] ?? raw['q'] ?? raw['content'];
  return { ...raw, question, options: withFallbackOptions(options, raw['costImpact'] === true), recommended };
}

/**
 * Câu hỏi quên kèm phương án (hoặc chỉ một) thì điền cho đủ hai: câu hỏi vẫn đáng hỏi, Phòng điều hành được tự viết
 * phương án mới. Trước đây cả lượt làm việc bị coi là trả sai khuôn (Frontend, Backend). Câu hỏi chi phí
 * giữ quy ước: phương án đầu là cách tốn tiền, phương án sau là cách không tốn.
 */
function withFallbackOptions(options: unknown, costImpact: boolean): unknown {
  if (options !== undefined && options !== null && !Array.isArray(options)) return options;
  const given = (options ?? []) as unknown[];
  if (given.length >= 2) return given;
  const defaults = costImpact
    ? ['Chi thêm theo đề xuất của phòng', 'Không chi thêm — làm theo cách không tốn tiền']
    : ['Làm theo cách phổ biến của ngành', 'Để Phòng điều hành chọn cách phù hợp nhất'];
  return [...given, ...defaults].slice(0, Math.max(2, given.length));
}

export const questionSchema = z.preprocess(normalizeQuestion, questionShape);
export type AgentQuestion = z.infer<typeof questionSchema>;

/** Trường `questions` gắn vào schema đầu ra của mọi phòng; tối đa 5 câu một lần. */
export const questionsField = z.array(questionSchema).max(5).default([]);

/** Dặn phòng ban cách hỏi — gắn vào cuối lời nhắc của phòng lập kế hoạch, dev, QA, rà soát. */
export const ASK_INSTRUCTION =
  'HỎI KHI CHƯA RÕ: gặp điều chưa rõ mà đoán sai sẽ làm sản phẩm sai yêu cầu (nền tảng cho phép gì, người dùng ' +
  'là ai, hành vi khi lỗi, giao diện…), hãy hỏi Phòng điều hành trong trường "questions" (tối đa 5 câu, mỗi câu ' +
  'kèm "why", 2–4 "options" cụ thể và "recommended"). Mỗi câu đúng dạng: {"question":"…","why":"…",' +
  '"options":["phương án 1","phương án 2"],"recommended":0,"costImpact":false} — "options" là mảng CHUỖI (không phải ' +
  'object), "recommended" là SỐ thứ tự phương án bắt đầu từ 0. Phòng điều hành trả lời ngay, ghi vào Sổ quyết định, rồi bạn ' +
  'làm lại bước này với câu trả lời. KHÔNG hỏi điều đã có trong tài liệu dự án hoặc Sổ quyết định; không hỏi cho ' +
  'có. Câu hỏi làm phát sinh chi phí thật thì đặt "costImpact": true (phương án đầu là cách tốn tiền, phương án sau ' +
  'là cách không tốn) — chỉ loại này mới lên tới CEO. Đã rõ hết thì để "questions": [].';

const answersSchema = z.object({
  answers: z
    .array(
      z.object({
        index: z.number().int().min(0),
        answer: clipped(1500, 1),
        reason: clipped(600).default(''),
      }),
    )
    .min(1),
});

export interface Decision {
  question: string;
  answer: string;
  reason: string;
  /** Ai quyết: Phòng điều hành, CEO, hay tự lấy phương án đề xuất khi đã hỏi đủ vòng. */
  by: 'Phòng điều hành' | 'CEO' | 'Phương án đề xuất';
}

/**
 * Phòng điều hành quyết các câu hỏi không liên quan chi phí. Nguyên tắc quyết
 * nằm ngay trong lời nhắc để câu trả lời nhất quán giữa các dự án.
 */
export async function answerQuestions(
  gateway: AgentGatewayClient,
  input: {
    askedBy: AgentRole;
    project: { id: string; name: string; description: string; productType: string };
    taskId: string | null;
    documents: string;
    questions: AgentQuestion[];
    knowledge?: Array<{ title: string; body: string }>;
    signal?: AbortSignal;
  },
): Promise<{ decisions: Decision[]; costUsd: number }> {
  const list = input.questions
    .map(
      (item, index) =>
        `${index}. ${item.question}\n   Vì sao hỏi: ${item.why || '(không nêu)'}\n` +
        item.options.map((option, i) => `   ${i === item.recommended ? '*' : '-'} ${option}`).join('\n'),
    )
    .join('\n');
  const result = await generateStructured(
    gateway,
    {
      agentRole: 'CTO_ORCHESTRATOR',
      system: buildSystemPrompt('CTO_ORCHESTRATOR', input.knowledge ?? []),
      messages: [
        {
          role: 'user',
          content:
            `DỰ ÁN: ${input.project.name} (${input.project.productType})\nYêu cầu của CEO: ${input.project.description}\n` +
            `${input.documents}\n\n` +
            `PHÒNG ${input.askedBy} HỎI PHÒNG ĐIỀU HÀNH (dấu * là phương án phòng đó đề xuất):\n${list}\n\n` +
            'Bạn là Phòng điều hành. QUYẾT từng câu, không hỏi lại CEO. Nguyên tắc quyết theo thứ tự:\n' +
            '1. Bám đúng mục tiêu CEO nêu trong yêu cầu và Sổ quyết định đã có.\n' +
            '2. Chọn cách làm chuẩn của ngành, người dùng phổ thông dùng được ngay không cần hướng dẫn.\n' +
            '3. Không phát sinh chi phí.\n' +
            '4. Ưu tiên phương án dễ đổi lại về sau.\n' +
            '5. Việc nền tảng không cho phép: chọn phương án thay thế gần nhất và yêu cầu sản phẩm nói rõ giới hạn cho người dùng.\n' +
            'Được chọn phương án khác phương án đề xuất, hoặc viết phương án mới nếu tốt hơn. Trả lời cụ thể (con số, tên, lựa chọn rõ ràng) kèm lý do một câu.',
        },
      ],
      projectId: input.project.id,
      taskId: input.taskId,
      taskKind: 'general',
      ...(input.signal ? { signal: input.signal } : {}),
    },
    answersSchema,
    '{ "answers": [{ "index": 0, "answer": "quyết định cụ thể", "reason": "một câu lý do" }] }',
  );
  const decisions = input.questions.map((item, index): Decision => {
    const found = result.data.answers.find((answer) => answer.index === index);
    return found
      ? { question: item.question, answer: found.answer, reason: found.reason, by: 'Phòng điều hành' }
      : recommendedDecision(item, 'Phòng điều hành không trả lời câu này — dùng phương án phòng đề xuất.');
  });
  return { decisions, costUsd: result.costUsd };
}

/** Quyết theo phương án phòng hỏi đề xuất (khi đã hỏi đủ vòng, hoặc Phòng điều hành bỏ sót). */
export function recommendedDecision(item: AgentQuestion, reason: string): Decision {
  return { question: item.question, answer: item.options[item.recommended] ?? item.options[0]!, reason, by: 'Phương án đề xuất' };
}

/** Một đoạn Sổ quyết định cho một lượt hỏi đáp. */
export function formatDecisions(heading: string, decisions: Decision[]): string {
  return (
    `\n## ${heading}\n` +
    decisions
      .map((item) => `- **Hỏi:** ${item.question}\n  **${item.by} quyết:** ${item.answer}${item.reason ? `\n  *Lý do:* ${item.reason}` : ''}`)
      .join('\n') +
    '\n'
  );
}
