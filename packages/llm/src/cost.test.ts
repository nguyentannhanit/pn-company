/**
 * §16, §54 — chi phí phải tính được cho id snapshot mà provider trả về.
 *
 * Lỗi thật: giá nhập cho `gpt-5`, OpenAI trả `gpt-5-2025-08-07`, cost ghi null,
 * dự án tiêu hơn 200k token đầu ra mỗi ngày mà dashboard ghi $0.
 */

import { describe, expect, it } from 'vitest';

import { ModelCatalog } from './catalog.js';
import { computeCost, pricedModelId } from './cost.js';

const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 0 };

function catalogWithGpt5(): ModelCatalog {
  const catalog = new ModelCatalog();
  catalog.upsert([
    {
      id: 'gpt-5',
      provider: 'openai',
      displayName: 'GPT-5',
      tier: 'strong',
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      pricing: null,
      pricingSource: 'discovered',
      pricingAsOf: null,
    },
  ]);
  catalog.setPricing('gpt-5', { inputPerMTok: 1.25, outputPerMTok: 10, cachedInputPerMTok: 0.125 });
  return catalog;
}

describe('chi phí theo id snapshot', () => {
  it('id có ngày quy về alias đã nhập giá', () => {
    const catalog = catalogWithGpt5();
    expect(pricedModelId(catalog, 'gpt-5-2025-08-07')).toBe('gpt-5');
    expect(computeCost(catalog, 'gpt-5-2025-08-07', usage)).toBe(2.25);
  });

  it('ưu tiên model đã yêu cầu khi response báo id khác', () => {
    const catalog = catalogWithGpt5();
    expect(pricedModelId(catalog, 'gpt-5-chat-latest', 'gpt-5')).toBe('gpt-5');
  });

  it('không có giá ở đâu cả thì vẫn null, không bịa 0', () => {
    expect(computeCost(new ModelCatalog(), 'model-la-2025-01-01', usage)).toBeNull();
  });
});
