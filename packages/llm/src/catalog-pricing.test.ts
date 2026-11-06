/**
 * Lỗi gặp thật: sau Model Discovery, bảng model hiện 41/41 "chưa có giá"
 * dù catalog có giá — discovery ghi đè pricing bằng null.
 */

import { describe, expect, it } from 'vitest';

import { ModelCatalog, type ModelInfo } from './catalog.js';

const discovered = (id: string): ModelInfo => ({
  id,
  provider: 'google',
  displayName: id,
  tier: 'medium',
  contextWindow: 1_000_000,
  maxOutputTokens: 65_536,
  pricing: null,
  pricingSource: 'discovered',
  pricingAsOf: null,
});

describe('catalog trộn kết quả discovery', () => {
  it('giữ giá catalog khi discovery không mang giá; model mới thì nhận như cũ', () => {
    const catalog = new ModelCatalog();
    const before = catalog.get('gemini-3.8-flash');
    expect(before?.pricing).not.toBeNull();

    catalog.upsert([discovered('gemini-3.8-flash'), discovered('gemini-moi-tinh')]);

    const after = catalog.get('gemini-3.8-flash');
    expect(after?.pricing).toEqual(before?.pricing);
    expect(after?.pricingSource).toBe(before?.pricingSource);
    expect(catalog.get('gemini-moi-tinh')?.pricing).toBeNull();
  });

  it('giá do người vận hành nhập vẫn thắng', () => {
    const catalog = new ModelCatalog();
    catalog.setPricing('gemini-3.8-flash', { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 });
    catalog.upsert([discovered('gemini-3.8-flash')]);
    expect(catalog.get('gemini-3.8-flash')).toMatchObject({ pricingSource: 'operator', pricing: { inputPerMTok: 1 } });
  });
});
