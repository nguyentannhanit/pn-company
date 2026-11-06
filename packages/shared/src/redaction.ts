/**
 * P&N — Che giấu secret (redaction).
 *
 * §19: không render secret ra frontend, không gửi secret vào Telegram.
 * §89: bắt buộc có test chứng minh secret không xuất hiện trong API response
 * và trong log. Module này là primitive dùng chung cho các test đó và cho lớp
 * API / logger.
 */

/** Tên field mà giá trị luôn bị thay, bất kể kiểu dữ liệu. */
const SENSITIVE_KEY_PATTERN =
  /(pass(word)?|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|authorization|auth|session|cookie|signature|master[_-]?key|salt|refresh)/i;

/** Chuỗi có hình dạng credential, kể cả khi nằm dưới tên field vô hại. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
  /sk-[A-Za-z0-9]{20,}/g, // kiểu OpenAI
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub token
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]*@[^\s"']+/gi, // DB URL có mật khẩu
  /redis:\/\/[^\s"']*:[^\s"'@]*@[^\s"']+/gi,
];

export const REDACTED = '[REDACTED]';

/** Chặn độ sâu để object vòng lặp hoặc quá sâu không làm treo tiến trình. */
const MAX_DEPTH = 12;

/**
 * Che credential để hiển thị: giữ vài ký tự đầu và cuối đủ để người dùng nhận ra
 * key nào đang được cấu hình, nhưng không dùng lại được (§47, §88.3).
 *
 * `sk-ant-api03-abcdef...wxyz` → `sk-ant…wxyz`
 */
export function maskSecret(value: string, keepEnd = 4): string {
  if (value.length === 0) return '';
  if (value.length <= keepEnd + 2) return '•'.repeat(value.length);
  const head = value.slice(0, Math.min(6, Math.max(0, value.length - keepEnd - 1)));
  const tail = value.slice(-keepEnd);
  return `${head}…${tail}`;
}

/** Quét và thay mọi đoạn có hình dạng credential trong văn bản tự do. */
export function redactText(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * Redact sâu một giá trị bất kỳ: field nhạy cảm bị thay nguyên giá trị, chuỗi
 * có hình dạng credential ở mọi vị trí khác đều bị quét. Dùng bởi serializer
 * của API và bởi logger.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return REDACTED as unknown as T;

  if (typeof value === 'string') {
    return redactText(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1)) as unknown as T;
  }

  if (value instanceof Error) {
    const err = new Error(redactText(value.message));
    err.name = value.name;
    if (value.stack) err.stack = redactText(value.stack);
    return err as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = typeof item === 'string' && item.length === 0 ? '' : REDACTED;
      } else {
        result[key] = redactDeep(item, depth + 1);
      }
    }
    return result as unknown as T;
  }

  return value;
}

/**
 * Hàm hỗ trợ test (§89): trả về true nếu payload sau khi serialize vẫn còn thứ
 * gì trông giống credential thật.
 */
export function containsSecret(payload: unknown): boolean {
  const serialised = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
  return SECRET_VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(serialised);
  });
}
