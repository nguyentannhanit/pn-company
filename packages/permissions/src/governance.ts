/**
 * P&N — Ranh giới tự cải thiện (§147, §149.27, §149.28).
 *
 * §38 muốn công ty tự chạy: CEO đưa mục tiêu, đội tự lập kế hoạch, viết mã,
 * kiểm thử, sửa lỗi, viết tài liệu và triển khai staging. §147 nói ngay sau đó
 * rằng có bốn thứ nó KHÔNG được tự làm:
 *
 *   1. không tự sửa chính sách hệ thống
 *   2. không tự cấp quyền cho mình
 *   3. không tự nạp kỹ năng chưa kiểm chứng
 *   4. không tự nâng cấp agent production ngoài quy trình
 *
 * Bốn điều đó không thể là một đoạn văn trong tài liệu. Một hệ thống tự sửa
 * được chính mình mà chỉ bị chặn bởi lời dặn thì không bị chặn gì cả. File này
 * biến chúng thành hàm, và bộ test cạnh nó là bằng chứng chúng còn hiệu lực.
 */

import type { RbacRole } from '@pn/shared';

/** Hành động đụng tới chính hệ thống, không phải tới sản phẩm của khách. */
export type SelfModifyingAction =
  /** Sửa chính sách: RBAC, ngân sách, cấu hình nền tảng (§147.1). */
  | 'policy:write'
  /** Cấp thêm quyền cho một vai trò (§147.2). */
  | 'permission:grant'
  /** Kích hoạt kiến thức lấy từ ngoài vào cho agent (§147.3). */
  | 'knowledge:activate'
  /** Đổi hồ sơ/prompt của agent đang chạy production (§147.4). */
  | 'agent_profile:upgrade'
  /** Ghi đè mã nguồn của chính nền tảng P&N (§149.27). */
  | 'platform_code:write';

export interface GovernanceRequest {
  action: SelfModifyingAction;
  /** Ai đang yêu cầu. Vai trò `AGENT` là tự động; `CEO`/`CTO` là người. */
  actorRole: RbacRole;
  /** Đã có phiếu duyệt được người quyết định cho chính hành động này chưa. */
  hasHumanApproval: boolean;
  /** §116 — đã chạy thử trong sandbox và đạt chưa (chỉ có nghĩa với kiến thức). */
  sandboxEvaluated?: boolean;
  /** §117 — đã qua rà soát bảo mật chưa. */
  securityReviewed?: boolean;
}

export interface GovernanceVerdict {
  allowed: boolean;
  /** Câu giải thích cho người đọc; rỗng khi được phép. */
  reason: string;
  /** Mục spec đang bị chạm tới, để tra lại nhanh. */
  spec: string;
}

/**
 * §147 — không hành động nào trong danh sách này được chạy tự động, bất kể
 * agent thuyết phục hay hoàn cảnh cấp bách tới đâu.
 *
 * `SYSTEM` cũng nằm trong diện chặn. Đó là điểm dễ bị bỏ sót nhất: một tiến
 * trình nền mang vai trò SYSTEM mà được phép sửa chính sách thì §147 trở thành
 * vô nghĩa — chỉ cần đi vòng qua tiến trình đó.
 */
const HUMAN_ONLY: Record<SelfModifyingAction, { spec: string; what: string }> = {
  'policy:write': {
    spec: '§147.1',
    what: 'sửa chính sách hệ thống',
  },
  'permission:grant': {
    spec: '§147.2',
    what: 'tự cấp thêm quyền',
  },
  'knowledge:activate': {
    spec: '§147.3, §108',
    what: 'kích hoạt kiến thức lấy từ ngoài vào',
  },
  'agent_profile:upgrade': {
    spec: '§147.4, §114',
    what: 'nâng cấp hồ sơ agent đang chạy',
  },
  'platform_code:write': {
    spec: '§149.27',
    what: 'sửa mã nguồn của chính nền tảng',
  },
};

/** Vai trò của con người. Chỉ hai vai trò này mới ký được một quyết định. */
const HUMAN_ROLES = new Set<RbacRole>(['CEO', 'CTO']);

/**
 * Trả lời một câu duy nhất: hành động này có được phép chạy bây giờ không.
 *
 * Thứ tự kiểm tra đi từ điều kiện tuyệt đối tới điều kiện có thể bù được, để
 * thông báo luôn chỉ vào rào cản gần nhất.
 */
export function checkGovernance(request: GovernanceRequest): GovernanceVerdict {
  const rule = HUMAN_ONLY[request.action];

  // §149.27 — mã nguồn nền tảng không sửa được kể cả khi có người duyệt. Một
  // hệ thống tự viết lại được luật của chính nó thì không còn luật nào cả.
  if (request.action === 'platform_code:write') {
    return {
      allowed: false,
      spec: rule.spec,
      reason:
        'P&N không tự sửa mã nguồn của chính nó. Thay đổi nền tảng đi qua người ' +
        'và qua quy trình phát triển bình thường, không qua agent.',
    };
  }

  if (!HUMAN_ROLES.has(request.actorRole)) {
    return {
      allowed: false,
      spec: rule.spec,
      reason: `Chỉ CEO hoặc CTO mới được ${rule.what}. Vai trò ${request.actorRole} thì không.`,
    };
  }

  if (!request.hasHumanApproval) {
    return {
      allowed: false,
      spec: rule.spec,
      reason: `Hành động "${rule.what}" cần một quyết định tường minh của người, chưa có.`,
    };
  }

  // §117 — kiến thức từ ngoài phải qua rà soát bảo mật, kể cả khi CEO đã bấm.
  if (request.action === 'knowledge:activate' && request.securityReviewed !== true) {
    return {
      allowed: false,
      spec: '§117',
      reason: 'Kiến thức chưa qua rà soát bảo mật thì không kích hoạt được, kể cả khi CEO duyệt.',
    };
  }

  // §116 — nâng cấp hồ sơ agent phải chạy thử trong sandbox trước.
  if (request.action === 'agent_profile:upgrade' && request.sandboxEvaluated !== true) {
    return {
      allowed: false,
      spec: '§116',
      reason: 'Hồ sơ agent mới phải chạy thử trong sandbox và đạt trước khi áp dụng.',
    };
  }

  return { allowed: true, reason: '', spec: rule.spec };
}

export class GovernanceDeniedError extends Error {
  constructor(readonly verdict: GovernanceVerdict) {
    super(`${verdict.reason} (spec ${verdict.spec})`);
    this.name = 'GovernanceDeniedError';
  }
}

/** Dùng ở call site khi muốn chặn thẳng thay vì tự xử lý verdict. */
export function assertGovernance(request: GovernanceRequest): void {
  const verdict = checkGovernance(request);
  if (!verdict.allowed) throw new GovernanceDeniedError(verdict);
}

/* -------------------------------------------------------------------------- */
/* Vòng tự chủ — §38                                                           */
/* -------------------------------------------------------------------------- */

/**
 * §38 — các bước công ty được tự chạy hết, không cần CEO chạm vào từng bước.
 * `production` cố tình vắng mặt: "Production vẫn có governance."
 */
export const AUTONOMOUS_STAGES: readonly string[] = [
  'intake',
  'product',
  'analysis',
  'web_scope',
  'architecture',
  'design',
  'build',
  'qa',
  'web_review',
  'security',
  'red_team',
  'devops',
  'staging',
];

/** Stage nào chỉ chạy sau khi có người duyệt (§38, §20). */
export function stageNeedsHuman(stageId: string): boolean {
  return !AUTONOMOUS_STAGES.includes(stageId);
}
