/**
 * P&N — Schema kiểm tra dữ liệu đi qua API.
 *
 * Mọi DTO vượt ranh giới API đều được validate ở đây. §89 cấm API trả về secret
 * thô, nên schema phía response chỉ lộ `keyPreview` / `secretRef`, không bao giờ
 * lộ chính credential.
 */

import { z } from 'zod';

import {
  AGENT_ROLES,
  AGENT_STATES,
  AI_PROVIDERS,
  APPROVAL_KINDS,
  BUG_SEVERITIES,
  DEPLOY_ENVIRONMENTS,
  ENVIRONMENTS,
  INTEGRATION_KINDS,
  MODEL_TIERS,
  PRODUCT_TYPES,
  ROUTING_MODES,
  TASK_PRIORITIES,
  TASK_STATUSES,
} from './enums.js';

export const uuidSchema = z.string().uuid();

/* -------------------------------------------------------------------------- */
/* Đăng nhập — §1.2                                                            */
/* -------------------------------------------------------------------------- */

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

/* -------------------------------------------------------------------------- */
/* Dự án — §12, §92                                                            */
/* -------------------------------------------------------------------------- */

export const createProjectSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().min(1).max(20_000),
  productType: z.enum(PRODUCT_TYPES),
  repoFullName: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/repo')
    .nullish(),
  budgetUsd: z.number().positive().max(100_000).default(20),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/* -------------------------------------------------------------------------- */
/* Task — §13                                                                  */
/* -------------------------------------------------------------------------- */

export const createTaskSchema = z.object({
  projectId: uuidSchema,
  title: z.string().min(2).max(200),
  description: z.string().max(20_000).default(''),
  priority: z.enum(TASK_PRIORITIES).default('MEDIUM'),
  assignedRole: z.enum(AGENT_ROLES).nullish(),
  parentTaskId: uuidSchema.nullish(),
  estimateMinutes: z.number().int().positive().max(10_000).nullish(),
  dependsOn: z.array(uuidSchema).default([]),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskStatusSchema = z.object({
  status: z.enum(TASK_STATUSES),
  note: z.string().max(2000).optional(),
});

/* -------------------------------------------------------------------------- */
/* Trạng thái agent — §9                                                       */
/* -------------------------------------------------------------------------- */

export const agentStateUpdateSchema = z.object({
  state: z.enum(AGENT_STATES),
  currentTaskId: uuidSchema.nullish(),
  currentProjectId: uuidSchema.nullish(),
});

/* -------------------------------------------------------------------------- */
/* Lỗi và phê duyệt — §27                                                      */
/* -------------------------------------------------------------------------- */

export const createBugSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.nullish(),
  title: z.string().min(2).max(200),
  description: z.string().max(20_000).default(''),
  severity: z.enum(BUG_SEVERITIES).default('MEDIUM'),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  note: z.string().max(2000).optional(),
});

export const createApprovalSchema = z.object({
  kind: z.enum(APPROVAL_KINDS),
  title: z.string().min(2).max(200),
  summary: z.string().min(1).max(4000),
  projectId: uuidSchema.nullish(),
  taskId: uuidSchema.nullish(),
  context: z.record(z.unknown()).default({}),
  expiresInMinutes: z.number().int().positive().max(20_160).nullish(),
});

/* -------------------------------------------------------------------------- */
/* Triển khai — §62                                                            */
/* -------------------------------------------------------------------------- */

export const createDeploymentSchema = z.object({
  projectId: uuidSchema,
  environment: z.enum(DEPLOY_ENVIRONMENTS),
  commitSha: z.string().min(7).max(40).nullish(),
});

/* -------------------------------------------------------------------------- */
/* API Center — §45, §47, §50, §51, §54                                        */
/* -------------------------------------------------------------------------- */

/** Phía request nhận key thô; key được ghi thẳng vào kho secret, không lưu nơi khác. */
export const upsertProviderSchema = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: z.string().min(8).max(500).optional(),
  baseUrl: z.string().url().nullish(),
  defaultModel: z.string().max(120).nullish(),
  isEnabled: z.boolean().default(true),
  environment: z.enum(ENVIRONMENTS).default('development'),
});
export type UpsertProviderInput = z.infer<typeof upsertProviderSchema>;

/**
 * Phía response — §88.3: tải lại trang không bao giờ được trả về key thô.
 * Đây là đúng những gì API được phép serialize ra ngoài.
 */
export const providerResponseSchema = z.object({
  id: uuidSchema,
  provider: z.enum(AI_PROVIDERS),
  displayName: z.string(),
  isEnabled: z.boolean(),
  status: z.enum(['NOT_CONFIGURED', 'CONNECTED', 'ERROR', 'DISABLED']),
  keyPreview: z.string().nullable(),
  baseUrl: z.string().nullable(),
  defaultModel: z.string().nullable(),
  lastTestedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  environment: z.enum(ENVIRONMENTS),
});
export type ProviderResponse = z.infer<typeof providerResponseSchema>;

export const modelRouteSchema = z.object({
  agentRole: z.enum(AGENT_ROLES),
  mode: z.enum(ROUTING_MODES).default('balanced'),
  tier: z.enum(MODEL_TIERS),
  provider: z.enum(AI_PROVIDERS),
  model: z.string().min(1).max(120),
  fallbacks: z
    .array(z.object({ provider: z.enum(AI_PROVIDERS), model: z.string().min(1).max(120) }))
    .default([]),
  maxInputTokens: z.number().int().positive().nullish(),
  maxOutputTokens: z.number().int().positive().nullish(),
  environment: z.enum(ENVIRONMENTS).default('development'),
});
export type ModelRouteInput = z.infer<typeof modelRouteSchema>;

export const upsertIntegrationSchema = z.object({
  kind: z.enum(INTEGRATION_KINDS),
  isEnabled: z.boolean().default(true),
  /** Chỉ chứa cấu hình không nhạy cảm. */
  settings: z.record(z.unknown()).default({}),
  /** Secret thô theo tên — chuyển vào kho secret, không lưu lại ở bảng này. */
  secrets: z.record(z.string()).default({}),
  environment: z.enum(ENVIRONMENTS).default('development'),
});

export const budgetPolicySchema = z.object({
  scope: z.enum(['GLOBAL', 'PROJECT', 'AGENT', 'RND']),
  scopeId: uuidSchema.nullish(),
  limitUsd: z.number().positive().max(1_000_000),
  period: z.enum(['DAY', 'MONTH', 'PROJECT']),
  warnThreshold: z.number().min(0.1).max(1).default(0.8),
  hardStop: z.boolean().default(true),
});

/* -------------------------------------------------------------------------- */
/* AI Gateway — §89: mọi lưu lượng LLM phải đi qua backend                      */
/* -------------------------------------------------------------------------- */

export const aiGenerateSchema = z.object({
  agentRole: z.enum(AGENT_ROLES),
  projectId: uuidSchema.nullish(),
  taskId: uuidSchema.nullish(),
  runId: uuidSchema.nullish(),
  system: z.string().max(200_000).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(500_000),
      }),
    )
    .min(1),
  maxOutputTokens: z.number().int().positive().max(64_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  /** Ghi đè routing cho một lần gọi — có ghi audit (§71). */
  overrideModel: z.string().max(120).optional(),
  /**
   * Model đã thử và trả JSON hỏng ở lượt trước — router bỏ qua các model này khi
   * chọn lại, để lượt "sửa JSON" đi sang model khác thay vì hỏi lại đúng model đã sai (§53).
   */
  avoidModels: z.array(z.object({ provider: z.enum(AI_PROVIDERS), model: z.string() })).optional(),
});
export type AiGenerateInput = z.infer<typeof aiGenerateSchema>;

/* -------------------------------------------------------------------------- */
/* Tiếp nhận từ Telegram — §5                                                  */
/* -------------------------------------------------------------------------- */

export const telegramCommandSchema = z.object({
  chatId: z.string().min(1),
  userId: z.string().min(1),
  command: z.string().min(1).max(64),
  args: z.string().max(20_000).default(''),
  messageId: z.number().int().optional(),
});
