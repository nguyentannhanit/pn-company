/**
 * Các lỗi dưới đây là lỗi thật đã gặp trong P&N, chép gần
 * nguyên văn để hàm dịch nhận đúng những gì máy chủ thật sự trả về.
 */

import { describe, expect, it } from 'vitest';

import { explainFailure } from './explain.js';

describe('dịch lý do thất bại', () => {
  it('Gemini 429 gói miễn phí: hết lượt, đọc được model và số giây phải chờ', () => {
    const raw =
      'Lần chạy thất bại: Gemini 429: { "error": { "code": 429, "message": "You exceeded your current quota ... ' +
      'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash\\nPlease retry in 25.113213719s.", "status": "RESOURCE_EXHAUSTED" } }';
    expect(explainFailure(raw)).toMatchObject({
      kind: 'quota',
      action: 'wait',
      provider: 'Google Gemini',
      model: 'gemini-3.8-flash',
      waitSeconds: 26,
    });
  });

  it('OpenAI hết tiền khác với hết lượt: phải nạp tiền, chờ không giải quyết được', () => {
    const raw = 'OpenAI 429: { "error": { "message": "You have no credits remaining.", "type": "insufficient_quota" } }';
    expect(explainFailure(raw)).toMatchObject({ kind: 'credit', action: 'settings', provider: 'OpenAI' });
  });

  it('503 high demand là quá tải phía nhà cung cấp', () => {
    const raw = 'Gemini 503: { "error": { "code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE" } }';
    expect(explainFailure(raw)).toMatchObject({ kind: 'overloaded', action: 'retry' });
  });

  it('khoá Anthropic sai', () => {
    expect(explainFailure('anthropic: auth: 401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."}}')).toMatchObject({
      kind: 'auth',
      provider: 'Anthropic',
    });
  });

  it('model trả JSON hỏng (việc lập trình giao diện dự án bán hoa)', () => {
    expect(explainFailure('Lần chạy thất bại: Model không trả về JSON hợp lệ: (gốc): Expected object, received null').kind).toBe('bad-output');
  });

  it('bộ dựng bản thử báo bằng tiếng Việt vẫn nhận ra là lỗi mã', () => {
    expect(explainFailure('Dựng staging lần 2 thất bại: npm run thất bại (exit 2):').kind).toBe('code');
  });

  it('lượt hết giờ (tin mới và tin "bị huỷ" cũ) là quá thời gian chờ, không phải lỗi chưa phân loại', () => {
    expect(explainFailure('Lần chạy thất bại: Hết giờ: lượt chạy vượt 30 phút nên đã dừng.').kind).toBe('timeout');
    expect(explainFailure('ChatGPT (gói): lượt gọi bị huỷ').kind).toBe('timeout');
  });

  it('lượt bị cắt vì máy chủ khởi động lại có nhãn riêng, không phải "lỗi chưa phân loại"', () => {
    const result = explainFailure('API khởi động lại giữa chừng, lượt chạy bị cắt');
    expect(result.kind).toBe('restart');
    expect(result.title).toContain('khởi động lại');
  });

  it('gói ChatGPT báo workspace hết credit là hết tiền, phải nạp', () => {
    expect(explainFailure('ChatGPT (gói): Your workspace is out of credits. Ask your workspace owner to refill').kind).toBe('credit');
  });

  it('không nhận ra thì giữ dòng đầu lỗi gốc, không đoán bừa', () => {
    const result = explainFailure('Lần chạy thất bại: workspace bị khoá bởi tiến trình khác\nchi tiết...');
    expect(result.kind).toBe('unknown');
    expect(result.detail).toBe('workspace bị khoá bởi tiến trình khác');
    expect(explainFailure(null).detail).toBe('Không có thông tin lỗi.');
  });
});
