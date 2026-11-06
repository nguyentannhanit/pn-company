/**
 * P&N — Dịch lý do một việc thất bại sang tiếng người.
 *
 * Lỗi thô từ nhà cung cấp AI là cả khối JSON tiếng Anh (`Gemini 429: { "error":
 * ...`). CEO không đọc được, và vì không hiểu nên dự án bán hoa đứng im nhiều
 * ngày. Hàm này xếp lỗi vào vài loại quen thuộc, nói rõ chuyện gì xảy ra
 * và việc nên làm. Không nhận ra loại nào thì giữ dòng đầu của lỗi gốc — thà thô
 * còn hơn đoán sai.
 */

export type FailureKind =
  | 'quota'
  | 'credit'
  | 'overloaded'
  | 'auth'
  | 'bad-output'
  | 'budget'
  | 'timeout'
  | 'restart'
  | 'no-route'
  | 'code'
  | 'unknown';

/** Việc nên làm tiếp theo — giao diện đổi thành nút tương ứng. */
export type FailureAction = 'retry' | 'wait' | 'settings' | 'budget';

export interface ExplainedFailure {
  kind: FailureKind;
  /** Một câu ngắn, hiện trên cờ đỏ và trong thẻ phòng. */
  title: string;
  /** Giải thích thêm và việc nên làm. */
  detail: string;
  action: FailureAction;
  provider: string | null;
  model: string | null;
  /** Nhà cung cấp bảo đợi bao lâu rồi hãy thử lại, nếu có. */
  waitSeconds: number | null;
}

const PROVIDERS: Array<[RegExp, string]> = [
  [/claude \(gói\)|claude-code/i, 'Claude (gói thuê bao)'],
  [/chatgpt \(gói\)|codex/i, 'ChatGPT (gói thuê bao)'],
  [/gemini|google/i, 'Google Gemini'],
  [/openai|gpt-/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic'],
];

/** Nhận diện loại lỗi theo thứ tự: loại cụ thể trước, loại chung sau. */
const RULES: Array<{ kind: FailureKind; test: RegExp }> = [
  { kind: 'credit', test: /insufficient_quota|credit_balance|no credits|out of credits|billing hard limit/i },
  { kind: 'quota', test: /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit|usage limit|hit your (?:\w+ )?limit/i },
  { kind: 'overloaded', test: /\b50[23]\b|\b529\b|UNAVAILABLE|high demand|overloaded/i },
  { kind: 'auth', test: /\b40[13]\b|authenticat|invalid.{0,20}(api.?)?key|permission_denied|oauth|not logged in|chưa cài hoặc không tìm thấy|is not configured/i },
  { kind: 'no-route', test: /no model route/i },
  { kind: 'budget', test: /ngân sách|budget|PAUSED_BUDGET/i },
  { kind: 'bad-output', test: /JSON hợp lệ|invalid json|Expected object|Unexpected token|could not parse/i },
  { kind: 'restart', test: /khởi động lại giữa chừng/i },
  { kind: 'timeout', test: /timed? ?out|ETIMEDOUT|aborted|quá thời gian|hết giờ|lượt gọi bị huỷ/i },
  // Lỗi dựng/kiểm thử: cả thông báo tiếng Anh của npm lẫn câu tiếng Việt do bộ dựng P&N ghi.
  { kind: 'code', test: /exit code|\(exit \d+\)|npm ERR|npm run thất bại|tests? failed|build failed|dựng .{0,40}thất bại|SyntaxError|TypeError/i },
];

const TEXT: Record<FailureKind, { title: string; detail: string; action: FailureAction }> = {
  quota: {
    title: 'Hết lượt gọi model trong phút này',
    detail: 'Gói miễn phí giới hạn số lượt mỗi phút. Chờ một chút rồi chạy lại; muốn hết hẳn thì bật thanh toán ở nhà cung cấp.',
    action: 'wait',
  },
  credit: {
    title: 'Tài khoản nhà cung cấp AI hết tiền',
    detail: 'Nạp thêm tiền ở trang thanh toán của nhà cung cấp, hoặc chuyển vai trò này sang nhà cung cấp khác trong Cài đặt.',
    action: 'settings',
  },
  overloaded: {
    title: 'Nhà cung cấp AI đang quá tải',
    detail: 'Máy chủ của họ bận, không phải lỗi của P&N. Thường vài phút là hết — chạy lại sau.',
    action: 'retry',
  },
  auth: {
    title: 'Khoá API sai hoặc đã hết hạn',
    detail: 'Dán lại khoá mới trong Cài đặt → Nhà cung cấp AI rồi bấm Test Connection.',
    action: 'settings',
  },
  'no-route': {
    title: 'Chưa chọn model cho vai trò này',
    detail: 'Vào Cài đặt → Định tuyến model và chọn model cho vai trò.',
    action: 'settings',
  },
  budget: {
    title: 'Dự án chạm trần ngân sách',
    detail: 'Tăng ngân sách dự án hoặc duyệt tiếp để đội làm tiếp.',
    action: 'budget',
  },
  'bad-output': {
    title: 'Model trả lời sai định dạng',
    detail: 'Thường do câu trả lời quá dài bị cắt giữa chừng. Chạy lại; lặp lại nhiều lần thì nên đổi sang model mạnh hơn.',
    action: 'retry',
  },
  timeout: {
    title: 'Quá thời gian chờ',
    detail: 'Việc chạy lâu hơn giới hạn cho phép. Chạy lại; nếu vẫn vậy thì việc nên được chia nhỏ.',
    action: 'retry',
  },
  restart: {
    title: 'Máy chủ P&N khởi động lại giữa chừng',
    detail: 'Lượt chạy bị cắt khi hệ thống khởi động lại, không phải lỗi của nhân viên. Việc đang làm dở tự chạy lại; còn kẹt thì bấm Chạy lại.',
    action: 'retry',
  },
  code: {
    title: 'Mã chạy thử bị lỗi',
    detail: 'Mã do nhân viên viết chưa chạy được. Chạy lại để họ tự sửa, hoặc mở việc xem chi tiết.',
    action: 'retry',
  },
  unknown: {
    title: 'Lỗi chưa phân loại',
    detail: '',
    action: 'retry',
  },
};

export function explainFailure(raw: string | null | undefined): ExplainedFailure {
  const text = (raw ?? '').replace(/^Lần chạy thất bại:\s*/i, '');
  const kind = RULES.find((rule) => rule.test.test(text))?.kind ?? 'unknown';
  const base = TEXT[kind];
  const provider = PROVIDERS.find(([test]) => test.test(text))?.[1] ?? null;
  const model =
    /model:\s*([\w.-]+)/i.exec(text)?.[1] ?? /\b((?:gemini|gpt|claude)-[\w.-]+)/i.exec(text)?.[1] ?? null;
  const wait = /retry in ([\d.]+)s/i.exec(text)?.[1];
  const firstLine = text.split('\n')[0]?.trim().slice(0, 160) ?? '';
  return {
    kind,
    title: base.title,
    detail: kind === 'unknown' ? firstLine || 'Không có thông tin lỗi.' : base.detail,
    action: base.action,
    provider,
    model,
    waitSeconds: wait ? Math.ceil(Number(wait)) : null,
  };
}
