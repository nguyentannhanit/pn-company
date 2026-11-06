/**
 * §102 — "Không được chỉ dựa vào số sao."
 *
 * Test đầu tiên là test quan trọng nhất của cả file: repo nhiều sao nhưng bỏ
 * hoang phải thua repo ít sao được chăm sóc. Nếu ngày nào đó nó đỏ, nghĩa là
 * cách chấm điểm đã trượt về đúng thứ §102 cấm.
 */

import { describe, expect, it } from 'vitest';

import { scoreRepository, type RepoFacts } from './scoring.js';

const NOW = Date.parse('2026-08-28T00:00:00Z');
const daysAgo = (days: number): string => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function repo(overrides: Partial<RepoFacts> = {}): RepoFacts {
  return {
    fullName: 'vi-du/thu-vien',
    stars: 500,
    forks: 50,
    openIssues: 10,
    lastCommitAt: daysAgo(7),
    license: 'MIT',
    language: 'TypeScript',
    hasReadme: true,
    hasTests: true,
    ...overrides,
  };
}

describe('chấm điểm repository (§102)', () => {
  it('repo 40 nghìn sao bỏ hoang thua repo 200 sao được chăm sóc', () => {
    const boHoang = scoreRepository(
      repo({ stars: 40_000, forks: 5_000, lastCommitAt: daysAgo(800) }),
      NOW,
    );
    const duocChamSoc = scoreRepository(repo({ stars: 200, forks: 20 }), NOW);

    expect(duocChamSoc.score).toBeGreaterThan(boHoang.score);
    expect(boHoang.recommendation).toBe('reject');
  });

  it('bỏ hoang hơn một năm là điều kiện loại thẳng, không phải trừ điểm', () => {
    const result = scoreRepository(repo({ lastCommitAt: daysAgo(400) }), NOW);
    expect(result.blockers).toContain('Bỏ hoang hơn một năm.');
    expect(result.recommendation).toBe('reject');
  });

  it('không khai giấy phép thì không dùng được cho sản phẩm của khách', () => {
    const result = scoreRepository(repo({ license: null }), NOW);
    expect(result.blockers.join(' ')).toContain('Không khai báo giấy phép');
    expect(result.recommendation).toBe('reject');
  });

  it('copyleft mạnh không tự động duyệt — đó là quyết định của người (§119)', () => {
    const result = scoreRepository(repo({ license: 'AGPL-3.0' }), NOW);
    expect(result.blockers.join(' ')).toContain('AGPL-3.0');
    expect(result.recommendation).toBe('reject');
  });

  it('giấy phép dễ dãi không bị chặn, viết hoa thường không quan trọng', () => {
    for (const license of ['MIT', 'mit', 'Apache-2.0', 'BSD-3-Clause']) {
      expect(scoreRepository(repo({ license }), NOW).blockers).toEqual([]);
    }
  });

  it('cảnh báo bảo mật chặn đề xuất tự động dù điểm còn lại rất cao', () => {
    const result = scoreRepository(
      repo({ stars: 30_000, securityFlags: ['CVE-2026-1234 mức nghiêm trọng'] }),
      NOW,
    );

    expect(result.recommendation).toBe('reject');
    expect(result.breakdown.security).toBe(70);
    expect(result.reasons.join(' ')).toContain('CVE-2026-1234');
  });

  it('thêm 100 sao cho repo mới có giá hơn nhiều so với thêm 100 sao cho repo 10 nghìn', () => {
    const adoption = (stars: number): number =>
      scoreRepository(repo({ stars }), NOW).breakdown.adoption;

    const tangLucDau = adoption(100) - adoption(0);
    const tangLucSau = adoption(10_100) - adoption(10_000);

    expect(tangLucDau).toBeGreaterThan(tangLucSau * 10);
  });

  it('khớp chủ đề phòng ban cần thì điểm liên quan cao, không khớp thì bằng 0', () => {
    const khop = scoreRepository(
      repo({ topics: ['react', 'performance'], wantedTopics: ['react', 'performance'] }),
      NOW,
    );
    const khongKhop = scoreRepository(
      repo({ topics: ['minecraft'], wantedTopics: ['react', 'performance'] }),
      NOW,
    );

    expect(khop.breakdown.relevance).toBe(100);
    expect(khongKhop.breakdown.relevance).toBe(0);
    expect(khongKhop.reasons.join(' ')).toContain('Không khớp chủ đề');
  });

  it('không khai chủ đề cần thì trung tính, không thưởng cũng không phạt', () => {
    expect(scoreRepository(repo(), NOW).breakdown.relevance).toBe(50);
  });

  it('thiếu test bị trừ và nói rõ lý do', () => {
    const result = scoreRepository(repo({ hasTests: false }), NOW);
    expect(result.breakdown.testQuality).toBe(0);
    expect(result.reasons.join(' ')).toContain('Không thấy bộ test');
  });

  it('repo sạch và mới được đề xuất adopt', () => {
    const result = scoreRepository(
      repo({
        stars: 12_000,
        forks: 1_500,
        openIssues: 20,
        lastCommitAt: daysAgo(3),
        topics: ['react'],
        wantedTopics: ['react'],
      }),
      NOW,
    );

    expect(result.blockers).toEqual([]);
    expect(result.recommendation).toBe('adopt');
    expect(result.score).toBeGreaterThanOrEqual(75);
  });

  it('điểm luôn nằm trong 0..100 kể cả với dữ liệu cực đoan', () => {
    const xau = scoreRepository(
      repo({ stars: 0, forks: 0, openIssues: 9999, lastCommitAt: null, hasReadme: false, hasTests: false }),
      NOW,
    );
    const tot = scoreRepository(repo({ stars: 999_999, forks: 999_999, openIssues: 0 }), NOW);

    expect(xau.score).toBeGreaterThanOrEqual(0);
    expect(tot.score).toBeLessThanOrEqual(100);
  });
});
