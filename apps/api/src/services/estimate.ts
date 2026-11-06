/**
 * P&N — Ước tính chi phí của một kế hoạch (§26).
 *
 * §26 vẽ ra màn hình Command Center có dòng "Estimated cost: $1.40" ngay cạnh
 * nút APPROVE. Con số đó phải dựng từ giá thật của model được định tuyến cho
 * từng vai trò, không phải một số cho đẹp.
 *
 * §89 cấm làm giả: model chưa có giá thì đếm riêng và nói ra, chứ không lặng lẽ
 * cộng 0 vào tổng rồi để CEO tưởng dự án rẻ.
 */

import type { AgentRole, Environment } from '@pn/shared';

import type { AppContext } from '../context.js';

/**
 * Lượng token giả định cho MỘT lượt agent chạy.
 *
 * Đây là chỗ duy nhất của ước tính không đến từ dữ liệu thật, nên nó được nêu
 * thẳng ra ngoài qua `assumption` để CEO biết con số dựa trên cái gì. Số lấy từ
 * quan sát: prompt vai trò cộng ngữ cảnh dự án thường quanh 8k token vào, và
 * một lượt sinh mã trả về quanh 4k token ra.
 */
const ASSUMED_INPUT_TOKENS = 8_000;
const ASSUMED_OUTPUT_TOKENS = 4_000;

/** Task code hay phải sửa lại; §4 cho tối đa 3 vòng nên tính trung bình 2 lượt. */
const CODE_ROLE_RUNS = 2;
const CODE_ROLES = new Set<AgentRole>([
  'BACKEND_DEVELOPER',
  'FRONTEND_DEVELOPER',
  'MOBILE_DEVELOPER',
]);

export interface PlanEstimate {
  /** Tổng ước tính, chỉ cộng những task có giá model. */
  costUsd: number;
  /** Số task dùng model chưa có giá — không cộng vào tổng, nói riêng ra. */
  unpricedTasks: number;
  /** Số lượt agent dự kiến chạy, đã tính vòng sửa của task code. */
  estimatedRuns: number;
  /** Câu giải thích ước tính dựa trên giả định nào. */
  assumption: string;
}

/**
 * Ước tính cho một danh sách vai trò sẽ phải chạy. Mỗi phần tử là một task.
 */
export async function estimatePlanCost(
  context: AppContext,
  roles: AgentRole[],
  env: Environment,
): Promise<PlanEstimate> {
  const routes = await context.repos.routes.list(env);
  const routeByRole = new Map(routes.map((route) => [route.agentRole, route]));

  let costUsd = 0;
  let unpricedTasks = 0;
  let estimatedRuns = 0;

  for (const role of roles) {
    const runs = CODE_ROLES.has(role) ? CODE_ROLE_RUNS : 1;
    estimatedRuns += runs;

    const route = routeByRole.get(role);
    const pricing = route ? (context.catalog.get(route.model)?.pricing ?? null) : null;

    if (!pricing) {
      unpricedTasks += 1;
      continue;
    }

    const perRun =
      (ASSUMED_INPUT_TOKENS / 1_000_000) * pricing.inputPerMTok +
      (ASSUMED_OUTPUT_TOKENS / 1_000_000) * pricing.outputPerMTok;
    costUsd += perRun * runs;
  }

  return {
    costUsd: Number(costUsd.toFixed(4)),
    unpricedTasks,
    estimatedRuns,
    assumption:
      `Ước tính theo giá model đang định tuyến, giả định mỗi lượt agent dùng ` +
      `${ASSUMED_INPUT_TOKENS.toLocaleString('vi-VN')} token vào và ` +
      `${ASSUMED_OUTPUT_TOKENS.toLocaleString('vi-VN')} token ra; ` +
      `task viết mã tính ${CODE_ROLE_RUNS} lượt vì thường phải sửa lại sau khi QA kiểm.` +
      (unpricedTasks > 0
        ? ` ${unpricedTasks} task dùng model chưa có giá nên không nằm trong tổng.`
        : ''),
  };
}
