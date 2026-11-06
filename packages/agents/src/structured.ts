/**
 * P&N — Nhận kết quả có cấu trúc từ model.
 *
 * Hệ thống hỗ trợ ba provider (§45) với ba cách ràng buộc output khác nhau, nên
 * lớp này chọn cách trung lập: yêu cầu model trả JSON, bóc JSON ra khỏi văn bản,
 * validate bằng zod, và nếu sai thì cho model đúng một cơ hội sửa kèm thông báo
 * lỗi cụ thể. Một vòng sửa là đủ trong thực tế và giữ chi phí có trần (§16).
 */

import type { z } from 'zod';

import type { AgentGatewayClient, AgentGenerateRequest } from './gateway-client.js';

export class StructuredOutputError extends Error {
  constructor(
    readonly raw: string,
    readonly detail: string,
  ) {
    super(`Model không trả về JSON hợp lệ: ${detail}`);
    this.name = 'StructuredOutputError';
  }
}

/**
 * Bóc JSON ra khỏi câu trả lời. Model hay bọc trong ```json … ``` hoặc kèm lời dẫn, và tài liệu
 * dài (SRS, kế hoạch) bên trong chuỗi JSON lại chứa cả ``` của riêng nó — bắt theo khối rào đầu
 * tiên thì cắt ngang giữa tài liệu, ra "không tìm thấy khối JSON nào" dù model trả đúng (CEO kẹt
 * ở Phòng sản phẩm, cả Sonnet 5 lẫn Haiku đều "sai định dạng"). Nên: thử từng vị trí mở ngoặc,
 * lấy khối cân bằng ngoặc đầu tiên mà JSON.parse chấp nhận; câu trả lời bị cắt cụt thì mới trả null.
 */
export function extractJson(text: string): string | null {
  const source = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  for (let start = source.search(/[[{]/); start !== -1; start = nextOpen(source, start + 1)) {
    const block = balancedBlock(source, start);
    if (block !== null && parses(block)) return block;
  }
  return null;
}

function nextOpen(text: string, from: number): number {
  const rest = text.slice(from).search(/[[{]/);
  return rest === -1 ? -1 : from + rest;
}

function parses(block: string): boolean {
  try {
    JSON.parse(block);
    return true;
  } catch {
    return false;
  }
}

/** Khối cân bằng ngoặc bắt đầu tại `start`, bỏ qua ngoặc nằm trong chuỗi; không đóng được thì null. */
function balancedBlock(text: string, start: number): string | null {
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export interface StructuredResult<T> {
  data: T;
  raw: string;
  costUsd: number;
  /** Số lần phải nhờ model sửa lại định dạng — hữu ích để theo dõi chất lượng. */
  repairs: number;
}

/**
 * Gọi model và ép kết quả về đúng schema.
 *
 * `schemaHint` là mô tả bằng lời của cấu trúc mong muốn, đưa vào prompt. Không
 * sinh tự động từ zod vì mô tả viết tay ngắn và rõ hơn cho model.
 */
export async function generateStructured<S extends z.ZodTypeAny>(
  gateway: AgentGatewayClient,
  request: AgentGenerateRequest,
  schema: S,
  schemaHint: string,
): Promise<StructuredResult<z.output<S>>> {
  const instruction =
    `${request.system}\n\n` +
    'ĐỊNH DẠNG BẮT BUỘC: chỉ trả về một khối JSON hợp lệ, không thêm lời dẫn, ' +
    `không thêm giải thích ngoài JSON.\nCấu trúc:\n${schemaHint}`;

  let messages = [...request.messages];
  let costUsd = 0;
  // Model đã trả lời hỏng: lượt sửa đi sang model khác trong chuỗi dự phòng thay vì hỏi lại đúng model đó.
  // Provider trả 200 OK nên cầu dao và router không coi là lỗi — không nói rõ thì Gemini bị hỏi lại mãi.
  const tried: NonNullable<AgentGenerateRequest['avoidModels']> = [...(request.avoidModels ?? [])];

  for (let attempt = 0; attempt <= 1; attempt += 1) {
    const result = await gateway.generate({
      ...request,
      system: instruction,
      messages,
      ...(tried.length > 0 ? { avoidModels: [...tried] } : {}),
    });
    costUsd += result.costUsd ?? 0;
    if (isProviderId(result.provider) && result.model) tried.push({ provider: result.provider, model: result.model });

    const json = extractJson(result.text);
    if (json) {
      const parsed = schema.safeParse(safeJsonParse(json));
      if (parsed.success) {
        return { data: parsed.data, raw: result.text, costUsd, repairs: attempt };
      }
      if (attempt === 1) {
        throw new StructuredOutputError(result.text, parsed.error.issues.map(describe).join('; '));
      }
      // Vòng sửa: nói đúng chỗ sai để model không đoán mò.
      messages = [
        ...messages,
        { role: 'assistant', content: result.text },
        {
          role: 'user',
          content:
            'JSON vừa rồi không đúng cấu trúc. Lỗi cụ thể: ' +
            parsed.error.issues.map(describe).join('; ') +
            '. Hãy trả lại đúng một khối JSON hợp lệ, không kèm lời dẫn.',
        },
      ];
      continue;
    }

    if (attempt === 1) {
      throw new StructuredOutputError(result.text, 'không tìm thấy khối JSON nào');
    }
    messages = [
      ...messages,
      { role: 'assistant', content: result.text },
      {
        role: 'user',
        content:
          'Câu trả lời không chứa khối JSON hoàn chỉnh (có thể bị cắt giữa chừng vì quá dài). ' +
          'Hãy trả lại đúng một khối JSON hợp lệ, ngắn gọn hơn, không kèm lời dẫn.',
      },
    ];
  }

  throw new StructuredOutputError('', 'hết số lần thử');
}

const PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const;
function isProviderId(value: string): value is (typeof PROVIDER_IDS)[number] {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(gốc)';
  return `${path}: ${issue.message}`;
}
