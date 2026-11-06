/**
 * P&N — Tính chi phí (§16).
 *
 * Mỗi request AI phải ghi lại số token vào/ra/cache và chi phí. Model chưa biết
 * giá thì chi phí là `null`, không bao giờ là 0 — ghi 0 sẽ khiến dashboard ngân
 * sách báo thiếu một cách âm thầm (§54, §55).
 */

import type { ModelCatalog } from './catalog.js';
import type { TokenUsage } from './types.js';

const PER_MILLION = 1_000_000;

/**
 * Tìm giá cho model mà response báo về. OpenAI trả id snapshot có ngày
 * (`gpt-5-2025-08-07`) trong khi giá nhập cho alias (`gpt-5`): không có bước
 * này thì cost là null, dự án tiêu $2/ngày mà dashboard ghi $0 và trần ngân
 * sách không bao giờ chặn (đã xảy ra thật).
 */
export function pricedModelId(catalog: ModelCatalog, modelId: string, requestedModelId?: string): string | null {
  const candidates = [modelId, requestedModelId, modelId.replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  for (const candidate of candidates) {
    if (candidate && catalog.get(candidate)?.pricing) return candidate;
  }
  return null;
}

export function computeCost(
  catalog: ModelCatalog,
  modelId: string,
  usage: TokenUsage,
  requestedModelId?: string,
): number | null {
  const priced = pricedModelId(catalog, modelId, requestedModelId);
  const pricing = priced ? catalog.get(priced)?.pricing : null;
  if (!pricing) return null;

  const cachedRate = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;
  const cost =
    (usage.inputTokens * pricing.inputPerMTok +
      usage.outputTokens * pricing.outputPerMTok +
      usage.cachedTokens * cachedRate) /
    PER_MILLION;

  // Làm tròn tới mức dashboard hiển thị, nhưng vẫn giữ được độ chính xác cho các
  // lần gọi dưới một xu (§16 cộng dồn hàng nghìn lần gọi như vậy).
  return Math.round(cost * 1e6) / 1e6;
}

export function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}
