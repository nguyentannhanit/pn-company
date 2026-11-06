/**
 * P&N — Gom toàn bộ repository thành một điểm truy cập.
 */

import type { Database } from '../pool.js';
import { createApiCenterRepositories, type ApiCenterRepositories } from './api-center.js';
import { BudgetRepository, CostRepository } from './cost.js';
import { createCoreRepositories, type CoreRepositories } from './core.js';
import { createGovernanceRepositories, type GovernanceRepositories } from './governance.js';
import { createKnowledgeRepositories, type KnowledgeRepositories } from './knowledge.js';

export * from './mapper.js';
export * from './core.js';
export * from './governance.js';
export * from './cost.js';
export * from './api-center.js';
export * from './knowledge.js';

/** Toàn bộ lớp dữ liệu mà API và worker cần. */
export interface Repositories
  extends CoreRepositories,
    GovernanceRepositories,
    ApiCenterRepositories,
    KnowledgeRepositories {
  costs: CostRepository;
  budgets: BudgetRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    ...createCoreRepositories(db),
    ...createGovernanceRepositories(db),
    ...createApiCenterRepositories(db),
    ...createKnowledgeRepositories(db),
    costs: new CostRepository(db),
    budgets: new BudgetRepository(db),
  };
}
