/**
 * P&N — Tài liệu dự án: thứ các phòng ban bàn giao cho nhau.
 *
 * Trước đây bước sau chỉ đọc được "tóm tắt" 1500 ký tự của bước trước — và
 * vì một lỗi thứ tự tin nhắn, thường còn chẳng phải tóm tắt mà là dòng "Đề xuất
 * N việc không được tạo thành task". App tắt/mở máy ra rỗng một phần vì lập
 * trình viên chưa từng thấy đặc tả giao diện (303 ký tự) hay tiêu chí nghiệm thu.
 *
 * Nay mỗi phòng lập kế hoạch ghi tài liệu đầy đủ vào `docs/` của workspace dự
 * án, và mọi bước sau đọc nguyên văn các tài liệu đó.
 */

import type { AgentRole } from '@pn/shared';

import type { AgentContext } from './contract.js';

export interface ProjectDoc {
  path: string;
  title: string;
}

/** Tài liệu của từng phòng, theo đúng thứ tự quy trình (đọc từ trên xuống). */
export const DEPARTMENT_DOCS: Partial<Record<AgentRole, ProjectDoc>> = {
  CTO_ORCHESTRATOR: { path: 'docs/ke-hoach.md', title: 'Kế hoạch dự án (Phòng điều hành)' },
  PRODUCT_MANAGER: { path: 'docs/pham-vi.md', title: 'Phạm vi & backlog (Phòng sản phẩm)' },
  BUSINESS_ANALYST: { path: 'docs/yeu-cau.md', title: 'Yêu cầu & tiêu chí nghiệm thu (Phòng phân tích)' },
  WEB_PRODUCT_LEAD: { path: 'docs/website.md', title: 'Mục tiêu & sơ đồ trang (Phòng web)' },
  SOLUTION_ARCHITECT: { path: 'docs/kien-truc.md', title: 'Kiến trúc (Phòng kiến trúc)' },
  UIUX_DESIGNER: { path: 'docs/thiet-ke.md', title: 'Thiết kế giao diện (Phòng thiết kế)' },
};

/** Sổ quyết định: câu trả lời của Phòng điều hành (và của CEO về chi phí) cho các câu hỏi của phòng ban. */
export const DECISIONS_DOC: ProjectDoc = { path: 'docs/quyet-dinh.md', title: 'Sổ quyết định (Phòng điều hành)' };

const ALL_DOCS: ProjectDoc[] = [...Object.values(DEPARTMENT_DOCS), DECISIONS_DOC];

/** Đọc mọi tài liệu đang có trong workspace, theo thứ tự quy trình; tài liệu chưa viết thì bỏ qua. */
export async function readProjectDocs(
  sandbox: Pick<NonNullable<AgentContext['sandbox']>, 'readFile'>,
): Promise<NonNullable<AgentContext['documents']>> {
  const found: NonNullable<AgentContext['documents']> = [];
  for (const doc of ALL_DOCS) {
    const content = await sandbox.readFile(doc.path).catch(() => null);
    if (content && content.trim()) found.push({ ...doc, content });
  }
  return found;
}

/**
 * Tài liệu đưa vào lời nhắc. Sổ quyết định luôn đủ (nó nhỏ và là luật của dự án);
 * tài liệu khác mỗi cái tối đa 12 000 ký tự, tổng 40 000 — đủ cho đặc tả thật,
 * vẫn vừa ngữ cảnh model rẻ.
 */
export function describeDocuments(documents: NonNullable<AgentContext['documents']>, limits = { perDoc: 12_000, total: 40_000 }): string {
  if (documents.length === 0) return '';
  const lines = ['', 'TÀI LIỆU DỰ ÁN (đã chốt — đọc hết và làm đúng theo; mâu thuẫn thì Sổ quyết định thắng):'];
  let budget = limits.total;
  for (const doc of documents) {
    const cap = doc.path === DECISIONS_DOC.path ? Infinity : limits.perDoc;
    const body = doc.content.length > cap ? `${doc.content.slice(0, cap)}\n…[cắt bớt — đọc bản đầy đủ ở ${doc.path}]` : doc.content;
    const chunk = `===== ${doc.title} — ${doc.path} =====\n${body}`;
    if (chunk.length > budget && doc.path !== DECISIONS_DOC.path) continue;
    budget -= chunk.length;
    lines.push(chunk);
  }
  return lines.join('\n');
}
