/**
 * P&N — Danh mục model và bảng giá (§15, §16, §49).
 *
 * Đây là danh mục **khởi tạo**, không phải nguồn chân lý. §49 yêu cầu lấy danh
 * sách model trực tiếp từ từng provider; model lấy được sẽ ghi đè lên các mục ở
 * đây, và người vận hành có thể sửa giá từ API Center (§54). Model nào không có
 * giá thì trả `costUsd: null` chứ không bịa số (§89 — không fake).
 *
 * Giá Anthropic bên dưới là giá niêm yết API chính hãng. Amazon Bedrock và
 * Vertex AI do đối tác vận hành với bảng giá riêng — nếu route qua đó thì phải
 * tự nhập giá dạng override.
 */

import { CLAUDE_CODE_MODELS } from './providers/claude-code.js';
import type { ModelInfo } from './types.js';

/** Ngày cuối cùng đối chiếu giá khởi tạo với trang giá của provider. */
const SEED_AS_OF = '2026-06-24';

/* -------------------------------------------------------------------------- */
/* Anthropic — giá niêm yết đã đối chiếu                                       */
/* -------------------------------------------------------------------------- */

const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5',
    tier: 'strong',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cachedInputPerMTok: 0.5 },
    pricingSource: 'seed',
    pricingAsOf: SEED_AS_OF,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5',
    tier: 'medium',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.2 },
    pricingSource: 'seed',
    pricingAsOf: SEED_AS_OF,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    tier: 'cheap',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5, cachedInputPerMTok: 0.1 },
    pricingSource: 'seed',
    pricingAsOf: SEED_AS_OF,
  },
];

/* -------------------------------------------------------------------------- */
/* OpenAI / Google — có sẵn model id, giá do discovery hoặc người vận hành nhập */
/* -------------------------------------------------------------------------- */

/**
 * §45 yêu cầu hỗ trợ OpenAI và Google, nhưng bảng giá của họ thay đổi độc lập
 * với repo này. Thay vì ghi sẵn con số có thể sai, các mục này để
 * `pricing: null`: hệ thống vẫn route tới được và vẫn đếm token (§16), còn API
 * Center hiển thị "chưa cấu hình giá" cho tới khi người vận hành nhập hoặc
 * discovery điền vào (§49, §54).
 */
const OPENAI_MODELS: ModelInfo[] = [
  {
    id: 'gpt-5',
    provider: 'openai',
    displayName: 'GPT-5',
    tier: 'strong',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: null,
    pricingSource: 'seed',
    pricingAsOf: null,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    displayName: 'GPT-5 mini',
    tier: 'medium',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: null,
    pricingSource: 'seed',
    pricingAsOf: null,
  },
];

/**
 * Google ngừng cấp model cũ cho tài khoản mới mà không báo trước (09/2026:
 * `gemini-2.5-*` trả 404 kèm lời khuyên dùng `gemini-3.6-flash`). Giá đối chiếu
 * với trang giá Gemini API ngày 2026-09-16 (bậc Standard, mức ≤200k token cho
 * model tính theo cỡ prompt; dòng 3.6–3.8 Flash giữ giá này tới hết 2026, từ
 * 2027 Google đã báo tăng gấp đôi). Test Connection vẫn hỏi danh sách thật.
 */
const GOOGLE_AS_OF = '2026-09-16';
const FLASH_3X_PRICING = { inputPerMTok: 0.75, outputPerMTok: 3.75, cachedInputPerMTok: 0.075 };

const GOOGLE_MODELS: ModelInfo[] = [
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    displayName: 'Gemini 3.1 Pro',
    tier: 'strong',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 2, outputPerMTok: 12, cachedInputPerMTok: 0.2 },
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
  {
    id: 'gemini-3.8-flash',
    provider: 'google',
    displayName: 'Gemini 3.8 Flash',
    tier: 'medium',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: FLASH_3X_PRICING,
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
  {
    id: 'gemini-3.7-flash',
    provider: 'google',
    displayName: 'Gemini 3.7 Flash',
    tier: 'medium',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: FLASH_3X_PRICING,
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
  {
    id: 'gemini-3.6-flash',
    provider: 'google',
    displayName: 'Gemini 3.6 Flash',
    tier: 'medium',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: FLASH_3X_PRICING,
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
  {
    id: 'gemini-3.5-flash-lite',
    provider: 'google',
    displayName: 'Gemini 3.5 Flash Lite',
    tier: 'cheap',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 0.3, outputPerMTok: 2.5, cachedInputPerMTok: 0.03 },
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
  {
    id: 'gemini-3.1-flash-lite',
    provider: 'google',
    displayName: 'Gemini 3.1 Flash Lite',
    tier: 'cheap',
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
    pricing: { inputPerMTok: 0.25, outputPerMTok: 1.5, cachedInputPerMTok: 0.025 },
    pricingSource: 'seed',
    pricingAsOf: GOOGLE_AS_OF,
  },
];

export const SEED_CATALOG: readonly ModelInfo[] = [
  ...ANTHROPIC_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
  // Claude qua CLI gói thuê bao: bí danh cố định nên có sẵn; model của Codex tuỳ máy nên nạp lúc kiểm tra kết nối.
  ...CLAUDE_CODE_MODELS,
];

/**
 * Đoán hạng cho model discovery mang về mà catalog chưa biết, để bảng định
 * tuyến mặc định chọn hợp lý (pro/opus mạnh, mini/lite rẻ). CEO sửa lại được
 * trong API Center; đây chỉ là điểm xuất phát.
 */
export function tierFromName(id: string): ModelInfo['tier'] {
  const name = id.toLowerCase();
  // Bắt "-mini" chứ không phải "mini": "gemini" cũng chứa chuỗi đó.
  if (/-(mini|nano|lite)\b|haiku|flash-8b/.test(name)) return 'cheap';
  if (/-pro\b|opus|ultra|^gpt-\d+(\.\d+)?$|^o\d/.test(name)) return 'strong';
  return 'medium';
}

/* -------------------------------------------------------------------------- */
/* Danh mục                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Danh mục thay đổi được: khởi tạo lúc dựng đối tượng, sau đó được bổ sung bởi
 * model discovery (§49) và giá do người vận hành nhập (§54).
 */
export class ModelCatalog {
  #models = new Map<string, ModelInfo>();

  constructor(seed: readonly ModelInfo[] = SEED_CATALOG) {
    for (const model of seed) this.#models.set(model.id, model);
  }

  get(modelId: string): ModelInfo | undefined {
    return this.#models.get(modelId);
  }

  list(provider?: ModelInfo['provider']): ModelInfo[] {
    const all = [...this.#models.values()];
    return provider ? all.filter((m) => m.provider === provider) : all;
  }

  /** Model rẻ nhất có giá trong một hạng của provider — dùng cho chế độ economy (§51). */
  cheapestInTier(provider: ModelInfo['provider'], tier: ModelInfo['tier']): ModelInfo | undefined {
    return this.list(provider)
      .filter((m) => m.tier === tier && m.pricing !== null)
      .sort((a, b) => (a.pricing!.outputPerMTok ?? 0) - (b.pricing!.outputPerMTok ?? 0))[0];
  }

  /** §49 — trộn model lấy được vào, vẫn giữ giá do người vận hành nhập. */
  upsert(models: readonly ModelInfo[]): void {
    for (const model of models) {
      const existing = this.#models.get(model.id);
      if (existing?.pricingSource === 'operator') {
        this.#models.set(model.id, { ...model, pricing: existing.pricing, pricingSource: 'operator' });
      } else if (existing?.pricing && !model.pricing) {
        // Discovery chỉ mang tên model, không mang giá; không để nó xoá giá
        // catalog đã có — mất giá là cost về null và bảng "chưa có giá" đầy ắp.
        this.#models.set(model.id, {
          ...model,
          pricing: existing.pricing,
          pricingSource: existing.pricingSource,
          pricingAsOf: existing.pricingAsOf,
        });
      } else {
        this.#models.set(model.id, model);
      }
    }
  }

  /** §54 — giá do người vận hành nhập luôn thắng giá lấy tự động. */
  setPricing(modelId: string, pricing: ModelInfo['pricing']): void {
    const existing = this.#models.get(modelId);
    if (!existing) return;
    this.#models.set(modelId, {
      ...existing,
      pricing,
      pricingSource: 'operator',
      pricingAsOf: new Date().toISOString().slice(0, 10),
    });
  }
}
