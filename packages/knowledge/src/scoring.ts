/**
 * P&N — Chấm điểm repository GitHub (§102).
 *
 * Câu đầu tiên của §102: "Không được chỉ dựa vào số sao." Đó là toàn bộ lý do
 * file này tồn tại. Một repo 40 nghìn sao bỏ hoang hai năm, giấy phép AGPL và
 * ba lỗ hổng đã biết thì tệ hơn một repo 200 sao được chăm sóc đều.
 *
 * Điểm là hàm thuần: cùng dữ liệu vào thì cùng điểm ra, không gọi model, không
 * gọi mạng. Nhờ vậy nó kiểm chứng được, và một thay đổi cách chấm luôn lộ ra
 * trong test chứ không âm thầm đổi thứ hệ thống đề xuất cho CEO.
 */

/** Số liệu thô lấy từ GitHub API, cộng vài thứ suy ra được từ nội dung repo. */
export interface RepoFacts {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  /** Ngày commit gần nhất, ISO. `null` nghĩa là không biết — bị trừ điểm. */
  lastCommitAt: string | null;
  license: string | null;
  language: string | null;
  topics?: string[];
  /** Có README đủ dài để dùng được không. */
  hasReadme?: boolean;
  hasTests?: boolean;
  /** Cảnh báo bảo mật đã biết (advisory, dependency lỗ hổng). */
  securityFlags?: string[];
  /** Từ khoá mà phòng ban đang cần; dùng để tính độ liên quan. */
  wantedTopics?: string[];
}

export interface ScoreBreakdown {
  relevance: number;
  maintenance: number;
  documentation: number;
  adoption: number;
  security: number;
  testQuality: number;
  recency: number;
  community: number;
}

export type Recommendation = 'adopt' | 'trial' | 'assess' | 'reject';

export interface RepoScore {
  /** 0..100, tổng có trọng số của các mặt. */
  score: number;
  breakdown: ScoreBreakdown;
  recommendation: Recommendation;
  /** Lý do người đọc hiểu được, để CEO không phải tin một con số trần trụi. */
  reasons: string[];
  /** Điều kiện loại thẳng, bất kể điểm cao đến đâu (§102, §119). */
  blockers: string[];
}

/**
 * Trọng số. Bảo trì và bảo mật nặng hơn độ phổ biến, vì §102 nói thẳng: repo
 * nhiều sao mà không được maintain thì không được đề xuất tự động.
 */
const WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  relevance: 20,
  maintenance: 20,
  security: 15,
  recency: 15,
  documentation: 10,
  testQuality: 10,
  adoption: 5,
  community: 5,
};

/**
 * Giấy phép dùng được cho sản phẩm thương mại (§119).
 *
 * Copyleft mạnh (GPL, AGPL) không nằm ở đây: không phải vì nó xấu, mà vì nó
 * kéo theo nghĩa vụ mở mã cho sản phẩm của khách — quyết định đó thuộc về
 * người, không thuộc về một agent quét repo lúc nửa đêm.
 */
export const PERMISSIVE_LICENSES = new Set([
  'MIT',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  'UNLICENSE',
  'CC0-1.0',
  '0BSD',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Quy về 0..100, kẹp hai đầu. */
function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Số ngày kể từ mốc thời gian; `null` coi như rất cũ. */
function daysSince(iso: string | null, now: number): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : (now - parsed) / DAY_MS;
}

/**
 * Thang loga cho các đại lượng "càng nhiều càng tốt nhưng bão hoà nhanh":
 * thêm 100 sao cho repo mới đáng giá hơn nhiều so với thêm 100 sao cho repo đã
 * có 10 nghìn. Một dự án 200 sao đang sống không nên bị một dự án 40 nghìn sao
 * đã chết đè bẹp chỉ vì con số.
 */
function logScale(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return clamp((Math.log10(1 + value) / Math.log10(1 + saturateAt)) * 100);
}

export function scoreRepository(facts: RepoFacts, now: number = Date.now()): RepoScore {
  const reasons: string[] = [];
  const blockers: string[] = [];

  const age = daysSince(facts.lastCommitAt, now);

  /* Độ liên quan — có bao nhiêu phần trăm chủ đề phòng ban đang cần. Không khai
     `wantedTopics` thì coi như trung tính, không thưởng cũng không phạt. */
  const wanted = facts.wantedTopics ?? [];
  const topics = (facts.topics ?? []).map((topic) => topic.toLowerCase());
  const matched = wanted.filter((topic) => topics.includes(topic.toLowerCase()));
  const relevance = wanted.length === 0 ? 50 : clamp((matched.length / wanted.length) * 100);
  if (wanted.length > 0 && matched.length === 0) {
    reasons.push('Không khớp chủ đề nào phòng ban đang cần.');
  }

  /* Bảo trì — commit gần đây và tỷ lệ issue mở so với quy mô cộng đồng. */
  const commitFreshness = age <= 30 ? 100 : age <= 90 ? 80 : age <= 180 ? 55 : age <= 365 ? 25 : 0;
  const issuePressure = facts.stars > 0 ? facts.openIssues / Math.max(facts.stars, 1) : 0;
  const issueHealth = clamp(100 - issuePressure * 500);
  const maintenance = clamp(commitFreshness * 0.7 + issueHealth * 0.3);
  if (age > 365) reasons.push('Hơn một năm không có commit mới.');
  else if (age > 180) reasons.push('Nửa năm nay không có commit mới.');

  /* Tài liệu và test — hai thứ quyết định người khác có dùng lại được không. */
  const documentation = facts.hasReadme === undefined ? 50 : facts.hasReadme ? 100 : 0;
  const testQuality = facts.hasTests === undefined ? 50 : facts.hasTests ? 100 : 0;
  if (facts.hasTests === false) reasons.push('Không thấy bộ test trong repo.');

  /* Mức được dùng và cộng đồng. */
  const adoption = logScale(facts.stars, 20_000);
  const community = logScale(facts.forks, 3_000);

  /* Bảo mật — mỗi cảnh báo trừ 30 điểm. */
  const flags = facts.securityFlags ?? [];
  const security = clamp(100 - flags.length * 30);
  for (const flag of flags) reasons.push(`Cảnh báo bảo mật: ${flag}`);

  const recency = clamp(commitFreshness);

  const breakdown: ScoreBreakdown = {
    relevance,
    maintenance,
    documentation,
    adoption,
    security,
    testQuality,
    recency,
    community,
  };

  const total = Object.entries(WEIGHTS).reduce(
    (sum, [key, weight]) => sum + breakdown[key as keyof ScoreBreakdown] * (weight / 100),
    0,
  );
  const score = Math.round(total * 100) / 100;

  /* Điều kiện loại thẳng. §102: repo nhiều sao mà dính một trong những thứ này
     "thì không được đề xuất tự động" — nên chúng chặn ở đây, không phải trừ điểm. */
  if (!facts.license) {
    blockers.push('Không khai báo giấy phép — không dùng được cho sản phẩm của khách.');
  } else if (!PERMISSIVE_LICENSES.has(facts.license.toUpperCase())) {
    blockers.push(
      `Giấy phép ${facts.license} cần người quyết định, không tự động duyệt được (§119).`,
    );
  }
  if (flags.length > 0) blockers.push(`${flags.length} cảnh báo bảo mật chưa xử lý.`);
  if (age > 365) blockers.push('Bỏ hoang hơn một năm.');

  const recommendation: Recommendation =
    blockers.length > 0 ? 'reject' : score >= 75 ? 'adopt' : score >= 55 ? 'trial' : 'assess';

  return { score, breakdown, recommendation, reasons, blockers };
}
