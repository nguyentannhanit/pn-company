/**
 * P&N — Cấu hình thương hiệu tập trung.
 *
 * §0 + §150: tên công ty luôn là **P&N**, hệ thống không được tự đổi tên.
 * §150.10 yêu cầu brand phải cấu hình tập trung, KHÔNG hard-code rải rác —
 * mọi bề mặt (login, header dashboard, Telegram bot, email, báo cáo, setup
 * wizard, biển hiệu trong văn phòng 3D, CEO Command Center) đều đọc từ đây.
 *
 * §150.12: đổi logo sau này không được đụng nhiều module, nên đường dẫn asset
 * cũng khai báo tại file này.
 */

export interface BrandingConfig {
  /** §150.11 — `company_name` */
  readonly companyName: string;
  /** §150.11 — `company_short_name` */
  readonly companyShortName: string;
  /** §150.11 — `company_tagline` */
  readonly companyTagline: string;
  /** Tagline tiếng Việt (§0). */
  readonly companyTaglineVi: string;
  /** Tên sản phẩm hiển thị trên dashboard (§0). */
  readonly productName: string;
  /** Đường dẫn logo — thay được mà không sửa module khác (§150.12). */
  readonly logo: {
    readonly mark: string;
    readonly wordmark: string;
    readonly favicon: string;
  };
  /** Dòng mở đầu Setup Wizard (§73, §150.6). */
  readonly welcomeHeadline: string;
  /** Chữ ký gắn vào mọi phản hồi của Telegram bot (§150.4). */
  readonly telegramSignature: string;
}

/**
 * Các tên demo cấm xuất hiện trong UI production (§150.9, §0).
 * Được kiểm tra bởi `assertNoDemoBranding()` và bộ test branding.
 */
export const FORBIDDEN_DEMO_NAMES: readonly string[] = [
  'AI Software Company',
  'Agent Company',
  'Demo Corp',
  'Acme',
  'Example Inc',
] as const;

const DEFAULT_BRANDING: BrandingConfig = {
  companyName: 'P&N',
  companyShortName: 'P&N',
  companyTagline: 'Build. Learn. Evolve.',
  companyTaglineVi: 'Xây dựng. Học hỏi. Tiến hóa.',
  productName: 'P&N Digital Company',
  logo: {
    mark: '/brand/pn-mark.svg',
    wordmark: '/brand/pn-wordmark.svg',
    favicon: '/brand/favicon.svg',
  },
  welcomeHeadline: 'Welcome to P&N',
  telegramSignature: 'P&N',
};

/**
 * Đọc brand từ biến môi trường (§150.11) nhưng mặc định vẫn là P&N.
 * Giá trị override rỗng hoặc chỉ có khoảng trắng bị bỏ qua, tránh trường hợp
 * cấu hình sai làm mất trắng tên thương hiệu.
 */
export function loadBranding(env: Record<string, string | undefined> = process.env): BrandingConfig {
  const pick = (value: string | undefined, fallback: string): string => {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : fallback;
  };

  const companyName = pick(env['PN_COMPANY_NAME'], DEFAULT_BRANDING.companyName);
  const companyShortName = pick(env['PN_COMPANY_SHORT_NAME'], DEFAULT_BRANDING.companyShortName);

  return {
    ...DEFAULT_BRANDING,
    companyName,
    companyShortName,
    companyTagline: pick(env['PN_COMPANY_TAGLINE'], DEFAULT_BRANDING.companyTagline),
    welcomeHeadline: `Welcome to ${companyName}`,
    telegramSignature: companyShortName,
  };
}

/** Brand đã resolve cho tiến trình đang chạy. */
export const branding: BrandingConfig = loadBranding();

/**
 * §150.9 — dùng trong test và ở lớp render để chắc chắn không còn tên demo nào
 * lọt vào UI production. Trả về danh sách tên vi phạm, rỗng nghĩa là sạch.
 */
export function findDemoBranding(text: string): string[] {
  const haystack = text.toLowerCase();
  return FORBIDDEN_DEMO_NAMES.filter((name) => haystack.includes(name.toLowerCase()));
}

/** Ném lỗi nếu phát hiện tên demo — dùng ở nơi cần chặn cứng. */
export function assertNoDemoBranding(text: string, context: string): void {
  const hits = findDemoBranding(text);
  if (hits.length > 0) {
    throw new Error(`Demo branding "${hits.join('", "')}" found in ${context} (spec §150.9)`);
  }
}
