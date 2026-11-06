/**
 * P&N — Hợp đồng điều phối và định nghĩa workflow (§3.1, §4, §92).
 *
 * CTO Orchestrator là bộ não: biến mục tiêu của CEO thành dự án, chọn workflow
 * theo loại sản phẩm (§92), đẩy các stage chạy, và đưa lỗi QA quay lại fix loop
 * (§4).
 *
 * Phase 0 khai báo dữ liệu workflow và interface của engine; phần engine được
 * hiện thực ở Phase 1 (§35).
 */

import type { AgentRole, ApprovalKind, ProductType, Uuid } from '@pn/shared';

/* -------------------------------------------------------------------------- */
/* Định nghĩa workflow                                                         */
/* -------------------------------------------------------------------------- */

export interface WorkflowStage {
  id: string;
  /** Các vai trò làm stage này. Nhiều hơn một nghĩa là chạy song song (§4). */
  roles: AgentRole[];
  /** Các stage phải xong trước. */
  dependsOn: string[];
  /** §27 — stage chỉ được bắt đầu sau khi CEO duyệt. */
  requiresApproval?: boolean;
  /** Loại phiếu duyệt sinh ra cho stage này; chỉ có nghĩa khi `requiresApproval`. */
  approvalKind?: ApprovalKind;
  description: string;
}

/** §4 — pipeline chuẩn cho một sản phẩm phần mềm đầy đủ. */
export const STANDARD_WORKFLOW: WorkflowStage[] = [
  { id: 'intake', roles: ['CTO_ORCHESTRATOR'], dependsOn: [], description: 'Hiểu yêu cầu CEO, tạo project' },
  { id: 'product', roles: ['PRODUCT_MANAGER'], dependsOn: ['intake'], description: 'Phạm vi, milestone, backlog' },
  { id: 'analysis', roles: ['BUSINESS_ANALYST'], dependsOn: ['product'], description: 'Yêu cầu chi tiết, acceptance criteria' },
  {
    id: 'architecture',
    roles: ['SOLUTION_ARCHITECT'],
    dependsOn: ['analysis'],
    // Không còn cổng CEO duyệt kiến trúc: Phòng điều hành chốt (CEO chỉ duyệt chi phí phát sinh và phát hành chính thức).
    description: 'Kiến trúc hệ thống',
  },
  { id: 'design', roles: ['UIUX_DESIGNER'], dependsOn: ['architecture'], description: 'UI/UX' },
  {
    id: 'build',
    roles: ['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER', 'MOBILE_DEVELOPER'],
    dependsOn: ['design'],
    description: 'Triển khai song song',
  },
  { id: 'qa', roles: ['QA'], dependsOn: ['build'], description: 'Kiểm thử — fail thì vào fix loop' },
  { id: 'security', roles: ['SECURITY'], dependsOn: ['qa'], description: 'Rà soát bảo mật' },
  { id: 'red_team', roles: ['RED_TEAM'], dependsOn: ['security'], description: 'Tấn công thử' },
  { id: 'devops', roles: ['DEVOPS'], dependsOn: ['red_team'], description: 'CI/CD, staging' },
  { id: 'staging', roles: ['DEVOPS'], dependsOn: ['devops'], description: 'Deploy staging' },
  {
    id: 'production',
    roles: ['DEVOPS'],
    dependsOn: ['staging'],
    requiresApproval: true, // §20, §38 — production luôn có cổng kiểm soát
    approvalKind: 'PRODUCTION_DEPLOY',
    description: 'Deploy production sau khi CEO duyệt',
  },
];

/**
 * §92, §93 — pipeline cho sản phẩm web. Khác pipeline chuẩn ở hai chỗ:
 * Web Product Lead chốt sơ đồ trang và mục tiêu chuyển đổi trước khi dựng, và
 * sau khi QA xong có thêm một vòng rà SEO / hiệu năng / tiếp cận chạy song song.
 *
 * Không có Mobile Developer và không có Red Team: website tĩnh không có bề mặt
 * tấn công để Red Team làm việc, và đưa vai trò vào pipeline mà nó không có gì
 * để làm chỉ tốn một lượt gọi model.
 */
export const WEB_WORKFLOW: WorkflowStage[] = [
  { id: 'intake', roles: ['CTO_ORCHESTRATOR'], dependsOn: [], description: 'Hiểu yêu cầu CEO, tạo project' },
  { id: 'product', roles: ['PRODUCT_MANAGER'], dependsOn: ['intake'], description: 'Phạm vi và mục tiêu' },
  {
    id: 'web_scope',
    roles: ['WEB_PRODUCT_LEAD'],
    dependsOn: ['product'],
    description: 'Mục tiêu chuyển đổi, sơ đồ trang, yêu cầu từng trang',
  },
  { id: 'design', roles: ['UIUX_DESIGNER'], dependsOn: ['web_scope'], description: 'Giao diện từng trang' },
  { id: 'build', roles: ['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER'], dependsOn: ['design'], description: 'Dựng trang' },
  { id: 'qa', roles: ['QA'], dependsOn: ['build'], description: 'Kiểm thử — fail thì vào fix loop' },
  {
    id: 'web_review',
    roles: ['SEO', 'WEB_PERFORMANCE', 'ACCESSIBILITY'],
    dependsOn: ['qa'],
    description: 'Rà SEO, hiệu năng và khả năng tiếp cận',
  },
  { id: 'devops', roles: ['DEVOPS'], dependsOn: ['web_review'], description: 'CI/CD, staging' },
  { id: 'staging', roles: ['DEVOPS'], dependsOn: ['devops'], description: 'Deploy staging' },
  {
    id: 'production',
    roles: ['DEVOPS'],
    dependsOn: ['staging'],
    requiresApproval: true,
    approvalKind: 'PRODUCTION_DEPLOY',
    description: 'Deploy production sau khi CEO duyệt',
  },
];

/** §35 — MVP chạy pipeline rút gọn với năm agent của Phase 1. */
export const MVP_WORKFLOW: WorkflowStage[] = [
  { id: 'intake', roles: ['CTO_ORCHESTRATOR'], dependsOn: [], description: 'Nhận yêu cầu, tạo project' },
  { id: 'product', roles: ['PRODUCT_MANAGER'], dependsOn: ['intake'], description: 'Phân rã task' },
  { id: 'build', roles: ['BACKEND_DEVELOPER', 'FRONTEND_DEVELOPER'], dependsOn: ['product'], description: 'Code trong sandbox' },
  { id: 'qa', roles: ['QA'], dependsOn: ['build'], description: 'Test + fix loop' },
];

/**
 * §92 — CTO chọn workflow dựa trên loại sản phẩm.
 *
 * Landing page dùng pipeline web rút gọn: một trang thì không cần Backend và
 * không cần bước dựng riêng cho từng phần.
 */
/**
 * Phần mềm desktop (.exe): như pipeline chuẩn nhưng không có Mobile và không
 * có Red Team (app chạy máy người dùng, bề mặt tấn công là file và cập nhật,
 * Security rà là đủ cho vòng đầu). Stage staging = hệ thống dựng ra .exe.
 */
export const DESKTOP_WORKFLOW: WorkflowStage[] = STANDARD_WORKFLOW.filter(
  (stage) => stage.id !== 'red_team',
).map((stage) =>
  stage.id === 'build'
    ? { ...stage, roles: ['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER'] as AgentRole[], description: 'Dựng ứng dụng desktop' }
    : stage.id === 'devops'
      ? { ...stage, dependsOn: ['security'], description: 'Cấu hình đóng gói .exe' }
      : stage.id === 'staging'
        ? { ...stage, description: 'Dựng file .exe' }
        : stage,
);

export function workflowFor(productType: ProductType): WorkflowStage[] {
  switch (productType) {
    case 'DESKTOP_APPLICATION':
      return DESKTOP_WORKFLOW;
    case 'LANDING_PAGE':
      return WEB_WORKFLOW.filter((stage) => stage.id !== 'devops').map((stage) =>
        stage.id === 'build'
          ? { ...stage, roles: ['FRONTEND_DEVELOPER'] as AgentRole[], dependsOn: ['design'] }
          : stage.id === 'staging'
            ? { ...stage, dependsOn: ['web_review'] }
            : stage,
      );
    case 'CORPORATE_WEBSITE':
      return WEB_WORKFLOW;
    case 'WEB_APPLICATION':
      // Web app không có Mobile Developer: tách task mobile cho một trang web
      // là đốt tiền và sinh file đè lên nhau (đã từng xảy ra).
      return STANDARD_WORKFLOW.map((stage) =>
        stage.id === 'build'
          ? { ...stage, roles: ['FRONTEND_DEVELOPER', 'BACKEND_DEVELOPER'] as AgentRole[] }
          : stage,
      );
    case 'MOBILE_APPLICATION':
      return STANDARD_WORKFLOW;
  }
}

/* -------------------------------------------------------------------------- */
/* Tra cứu stage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * §4 — stage nào phụ trách vai trò này. Engine dùng để gắn task CTO đề xuất vào
 * đúng chỗ trong pipeline: CTO nghĩ theo đầu việc, pipeline nghĩ theo thứ tự.
 *
 * Một vai trò chỉ xuất hiện ở một stage, trừ DEVOPS nằm ở ba stage cuối; lấy
 * stage đầu tiên khớp là đúng vì đó là stage sớm nhất vai trò đó được phép chạy.
 */
export function stageForRole(workflow: WorkflowStage[], role: AgentRole): WorkflowStage | null {
  return workflow.find((stage) => stage.roles.includes(role)) ?? null;
}

/** Các vai trò được phép nhận việc trong workflow này — dùng để ràng buộc CTO. */
export function rolesFor(productType: ProductType): AgentRole[] {
  return [...new Set(workflowFor(productType).flatMap((stage) => stage.roles))];
}

/**
 * Các stage phải xong trước stage này, tính bắc cầu. Task của stage sau phụ
 * thuộc vào mọi task của các stage trước — không có nó thì "thứ tự" chỉ nằm
 * trong dữ liệu chứ không cưỡng chế được lúc chạy.
 */
export function stagesBefore(workflow: WorkflowStage[], stageId: string): string[] {
  const byId = new Map(workflow.map((stage) => [stage.id, stage]));
  const collected = new Set<string>();

  const walk = (id: string): void => {
    for (const parent of byId.get(id)?.dependsOn ?? []) {
      if (collected.has(parent)) continue;
      collected.add(parent);
      walk(parent);
    }
  };
  walk(stageId);

  return [...collected];
}

/* -------------------------------------------------------------------------- */
/* Vòng sửa lỗi — §4, §43.6                                                    */
/* -------------------------------------------------------------------------- */

/** Có giới hạn để một test hỏng không đốt sạch ngân sách dự án (§55). */
export const MAX_FIX_LOOP_ITERATIONS = 3;

export interface FixLoopDecision {
  action: 'reassign' | 'escalate_to_ceo' | 'abandon';
  reason: string;
  assignTo?: AgentRole;
}

export function decideFixLoop(iteration: number, ownerRole: AgentRole): FixLoopDecision {
  if (iteration < MAX_FIX_LOOP_ITERATIONS) {
    return { action: 'reassign', reason: `fix loop ${iteration + 1}/${MAX_FIX_LOOP_ITERATIONS}`, assignTo: ownerRole };
  }
  return {
    action: 'escalate_to_ceo',
    reason: `QA still failing after ${MAX_FIX_LOOP_ITERATIONS} fix attempts — CEO decision required`,
  };
}

/* -------------------------------------------------------------------------- */
/* Hợp đồng engine                                                             */
/* -------------------------------------------------------------------------- */

export interface OrchestrationRequest {
  /** Yêu cầu thô của CEO, thường đến từ Telegram (§2.2). */
  goal: string;
  productType: ProductType;
  requestedByUserId: Uuid;
  attachmentIds?: Uuid[];
}

export interface Orchestrator {
  /** §3.1 — biến mục tiêu thành dự án kèm đồ thị task. */
  intake(request: OrchestrationRequest): Promise<{ projectId: Uuid; taskIds: Uuid[] }>;
  /** Đẩy dự án tiến lên: khởi động stage nào vừa hết bị chặn. */
  advance(projectId: Uuid): Promise<void>;
  /** Đưa một lần QA fail trở lại fix loop (§4). */
  handleQaFailure(taskId: Uuid, bugId: Uuid): Promise<FixLoopDecision>;
}
