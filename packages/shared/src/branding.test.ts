/** §150 — tiêu chí nghiệm thu thương hiệu. */

import { describe, expect, it } from 'vitest';

import { branding, findDemoBranding, loadBranding, assertNoDemoBranding } from './branding.js';

describe('branding (§150)', () => {
  it('mặc định tên công ty là P&N (§150.1, §150.13)', () => {
    expect(branding.companyName).toBe('P&N');
    expect(branding.companyShortName).toBe('P&N');
  });

  it('mang đúng tagline ở §0', () => {
    expect(branding.companyTagline).toBe('Build. Learn. Evolve.');
    expect(branding.companyTaglineVi).toBe('Xây dựng. Học hỏi. Tiến hóa.');
  });

  it('mở setup wizard bằng "Welcome to P&N" (§150.6)', () => {
    expect(branding.welcomeHeadline).toBe('Welcome to P&N');
  });

  it('ký tên P&N trong phản hồi Telegram (§150.4)', () => {
    expect(branding.telegramSignature).toBe('P&N');
  });

  it('đọc override từ cấu hình thay vì chuỗi hard-code (§150.10, §150.11)', () => {
    const custom = loadBranding({
      PN_COMPANY_NAME: 'P&N Vietnam',
      PN_COMPANY_TAGLINE: 'Xây dựng. Học hỏi. Tiến hóa.',
    });
    expect(custom.companyName).toBe('P&N Vietnam');
    expect(custom.welcomeHeadline).toBe('Welcome to P&N Vietnam');
  });

  it('bỏ qua override rỗng thay vì làm mất tên thương hiệu', () => {
    expect(loadBranding({ PN_COMPANY_NAME: '   ' }).companyName).toBe('P&N');
  });

  it('phát hiện tên demo còn sót (§150.9)', () => {
    expect(findDemoBranding('Welcome to AI Software Company')).toEqual(['AI Software Company']);
    expect(findDemoBranding('Welcome to P&N')).toEqual([]);
    expect(() => assertNoDemoBranding('Demo Corp dashboard', 'login screen')).toThrow(/§150.9/);
  });
});
