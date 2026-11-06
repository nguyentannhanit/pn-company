/**
 * P&N — Luồng khám phá kiến thức (§106).
 *
 * §106 liệt kê đúng sáu bước và đây là hiện thực của chúng:
 *
 *   1. Discover        — GitHub Scout tìm repo (§101)
 *   2. Deduplicate     — URL đã thấy thì bỏ qua (§121)
 *   3. Score           — chấm điểm, không chỉ đếm sao (§102)
 *   4. Security screen — soi dấu hiệu chèn chỉ thị (§118)
 *   5. Summarize       — Curator viết thành gói dùng được (§99)
 *   6. CEO digest      — tóm tắt gửi CEO (§107)
 *
 * Hai ràng buộc chi phối cả file:
 *
 *   §108 — không có gì được kích hoạt trước khi CEO duyệt. Bước 5 dừng ở
 *          `PENDING_APPROVAL`, không tự gắn vào phòng ban nào.
 *   §132 — R&D có ngân sách riêng và mỗi vòng có trần số ứng viên, vì bước gọi
 *          model là bước duy nhất tốn tiền và nó nằm sau cùng.
 */

import { curateKnowledge } from '@pn/agents';
import type { GitHubClient, RepoSearchHit } from '@pn/github';
import {
  runFilter,
  screenForInjection,
  scoreRepository,
  type RepoFacts,
} from '@pn/knowledge';
import type { Department } from '@pn/shared';

import type { AppContext } from '../context.js';
import { InProcessAgentGateway } from './agent-gateway.js';

/** Trần mặc định cho một vòng. Bước Curator tốn tiền nên nó phải có giới hạn. */
const DEFAULT_MAX_CURATED = 3;
const DEFAULT_SEARCH_LIMIT = 20;

export interface DiscoveryOptions {
  /** Từ khoá tìm kiếm; bỏ trống thì dùng chủ đề của các phòng ban đang cần. */
  queries?: string[];
  /** Chủ đề phòng ban đang cần, dùng để tính độ liên quan (§102). */
  wantedTopics?: string[];
  maxCurated?: number;
  searchLimit?: number;
  /** CEO bấm Dừng: dừng sau bước đang làm, trả báo cáo phần đã xong. */
  signal?: AbortSignal;
}

export interface DiscoveryReport {
  /** Bước 1 — tìm được bao nhiêu. */
  found: number;
  /** Bước 2 — bao nhiêu cái đã thấy từ trước. */
  duplicates: number;
  /** Bước 3+4 — bị loại ở tầng nào. */
  rejected: Array<{ fullName: string; stage: string; reason: string }>;
  /** Bước 5 — gói kiến thức đã viết, đang chờ CEO duyệt. */
  promoted: Array<{ itemId: string; title: string; score: number }>;
  costUsd: number;
  /** Nói thẳng khi vòng chạy bị cắt bởi trần, thay vì để người đọc tưởng đã hết. */
  note: string | null;
}

/**
 * Chạy một vòng khám phá. Trả về báo cáo đầy đủ kể cả khi không tìm được gì —
 * "hôm nay không có gì đáng học" cũng là một kết quả, và im lặng thì người dùng
 * không phân biệt được nó với "luồng bị hỏng".
 */
export async function runDiscovery(
  context: AppContext,
  github: GitHubClient,
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const { repos } = context;
  const maxCurated = options.maxCurated ?? DEFAULT_MAX_CURATED;
  const searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
  const wantedTopics = options.wantedTopics ?? [];

  const queries =
    options.queries && options.queries.length > 0
      ? options.queries
      : defaultQueries(wantedTopics);

  const report: DiscoveryReport = {
    found: 0,
    duplicates: 0,
    rejected: [],
    promoted: [],
    costUsd: 0,
    note: null,
  };

  /* --- Bước 1: Discover ------------------------------------------------- */

  const stopped = (): boolean => {
    if (!options.signal?.aborted) return false;
    report.note = 'Đã dừng giữa chừng theo lệnh CEO — phần đã xử lý vẫn được lưu.';
    return true;
  };

  const hits: RepoSearchHit[] = [];
  for (const query of queries) {
    if (stopped()) return report;
    const found = await github
      .searchRepositories(query, { limit: searchLimit })
      .catch(() => [] as RepoSearchHit[]);
    hits.push(...found);
  }
  report.found = hits.length;

  const source = await repos.knowledgeSources.upsert({
    kind: 'github',
    name: 'GitHub Search',
    url: 'https://github.com/search',
    trustScore: 70,
  });

  /* --- Bước 2 + 3 + 4: dedupe, chấm điểm, sàng lọc ---------------------- */

  const survivors: Array<{ hit: RepoSearchHit; candidateId: string; score: number }> = [];

  for (const hit of hits) {
    if (stopped()) return report;
    // §121 — đã thấy URL này rồi thì không xét lại. Rẻ nhất, làm trước.
    if (await repos.knowledgeCandidates.findByUrl(hit.url)) {
      report.duplicates += 1;
      continue;
    }

    const facts: RepoFacts = {
      fullName: hit.fullName,
      stars: hit.stars,
      forks: hit.forks,
      openIssues: hit.openIssues,
      lastCommitAt: hit.lastCommitAt,
      license: hit.license,
      language: hit.language,
      topics: hit.topics,
      hasReadme: true, // xác nhận thật ở bước đọc README bên dưới
      ...(wantedTopics.length > 0 ? { wantedTopics } : {}),
    };
    const scored = scoreRepository(facts);

    const candidate = await repos.knowledgeCandidates.create({
      sourceId: source.id,
      discoveredBy: 'GITHUB_SCOUT',
      title: hit.fullName,
      url: hit.url,
      summary: hit.description,
      raw: { ...hit, score: scored.score, breakdown: scored.breakdown },
    });

    await repos.githubRepos.upsert({
      fullName: hit.fullName,
      url: hit.url,
      stars: hit.stars,
      forks: hit.forks,
      openIssues: hit.openIssues,
      lastCommitAt: hit.lastCommitAt,
      license: hit.license,
      language: hit.language,
      score: scored.score,
      scoreBreakdown: { ...scored.breakdown, blockers: scored.blockers },
      candidateId: candidate.id,
    });

    if (scored.blockers.length > 0) {
      const reason = scored.blockers.join(' ');
      await repos.knowledgeCandidates.reject(candidate.id, reason);
      report.rejected.push({ fullName: hit.fullName, stage: 'score', reason });
      continue;
    }

    // Đọc README rồi mới soi được nội dung. Không có README thì không có gì để
    // Curator viết thành gói kiến thức.
    const readme = await github.readmeExcerpt(hit.fullName);
    if (!readme) {
      const reason = 'Không có README nên không đủ nội dung để viết gói kiến thức.';
      await repos.knowledgeCandidates.reject(candidate.id, reason);
      report.rejected.push({ fullName: hit.fullName, stage: 'quality', reason });
      continue;
    }

    const verdict = runFilter({
      sourceTrust: source.trustScore,
      qualityScore: scored.score,
      duplicateOf: null,
      licenseApproved: scored.blockers.length === 0,
      injection: screenForInjection(readme),
    });

    if (!verdict.passed) {
      await repos.knowledgeCandidates.reject(candidate.id, verdict.reason);
      report.rejected.push({
        fullName: hit.fullName,
        stage: verdict.stoppedAt ?? 'unknown',
        reason: verdict.reason,
      });
      continue;
    }

    await repos.knowledgeCandidates.advance(candidate.id, 'SCREENED');
    survivors.push({ hit, candidateId: candidate.id, score: scored.score });
  }

  /* --- Bước 5: Summarize ------------------------------------------------ */

  survivors.sort((a, b) => b.score - a.score);
  const toCurate = survivors.slice(0, maxCurated);

  if (survivors.length > toCurate.length) {
    report.note =
      `${survivors.length} ứng viên qua được vòng lọc nhưng chỉ ${toCurate.length} được ` +
      'viết thành gói kiến thức trong lượt này. Số còn lại vẫn ở trạng thái SCREENED ' +
      'và sẽ được xử lý ở lượt sau.';
  }

  const gateway = new InProcessAgentGateway(context.gateway);

  for (const { hit, candidateId, score } of toCurate) {
    if (stopped()) return report;
    const readme = await github.readmeExcerpt(hit.fullName);
    if (!readme) continue;

    const curated = await curateKnowledge({
      gateway,
      title: hit.fullName,
      url: hit.url,
      source: readme,
      wantedBy: wantedTopics,
    }).catch(() => null);

    if (!curated) {
      await repos.knowledgeCandidates.reject(candidateId, 'Curator không viết được gói kiến thức.');
      continue;
    }
    report.costUsd += curated.costUsd ?? 0;

    const item = await repos.knowledgeItems.create({
      candidateId,
      sourceId: source.id,
      title: curated.title,
      kind: curated.kind,
      summary: curated.summary,
      body: curated.body,
      license: hit.license,
      licenseApproved: true, // đã qua cổng giấy phép ở bước chấm điểm
    });

    // §118 — Curator thấy câu ra lệnh trong nguồn thì ghi lại thành phát hiện,
    // và gói đó KHÔNG được duyệt tự động dù còn lại đều tốt.
    const injection = screenForInjection(curated.body);
    const clean = injection.safe && curated.suspiciousInstructions.length === 0;

    await repos.knowledgeReviews.record({
      itemId: item.id,
      reviewer: 'KNOWLEDGE_SECURITY_REVIEW',
      kind: 'security',
      passed: clean,
      findings: {
        patterns: injection.findings,
        curatorFlagged: curated.suspiciousInstructions,
      },
    });

    await repos.knowledgeItems.setStatus(item.id, clean ? 'PENDING_APPROVAL' : 'REJECTED');
    await repos.knowledgeCandidates.advance(candidateId, clean ? 'PROMOTED' : 'REJECTED');

    /* §103 — đặt công nghệ lên Technology Radar. Vòng lấy từ điểm đã chấm chứ
       không hỏi model: `adopt` là repo sạch điểm cao, `hold` là repo bị loại.
       Một model đoán "nên dùng hay không" thì không đáng tin bằng số đã đo. */
    if (clean && curated.technology) {
      const ring =
        score >= 75 ? 'adopt' : score >= 55 ? 'trial' : ('assess' as 'adopt' | 'trial' | 'assess');
      await repos.technologyRadar.upsert({
        name: curated.technology,
        category: curated.kind,
        ring,
        rationale: `Điểm chất lượng ${score}/100 từ ${hit.fullName}.`,
        itemId: item.id,
      });
    }

    /* §104 — kỹ năng gói này mang lại. Chưa `is_active`: kỹ năng chỉ thật sự
       có khi CEO kích hoạt gói kiến thức mang nó. */
    if (clean) {
      for (const skill of curated.skills) {
        await repos.skills.upsert({
          name: skill,
          description: curated.summary.slice(0, 300),
          itemId: item.id,
          department: curated.departments[0] ?? null,
        });
      }
    }

    await repos.knowledgeAudit.record({
      actor: 'system:discovery',
      action: clean ? 'KNOWLEDGE_PROPOSED' : 'KNOWLEDGE_BLOCKED_BY_SECURITY',
      itemId: item.id,
      metadata: { source: hit.url, score },
    });

    if (!clean) {
      report.rejected.push({
        fullName: hit.fullName,
        stage: 'security',
        reason: 'Nội dung có dấu hiệu chèn chỉ thị sau khi biên tập.',
      });
      continue;
    }

    // §108 — phiếu duyệt là cổng bắt buộc; không có nó thì không gắn vào phòng ban.
    const approval = await context.repos.approvals.create({
      kind: 'KNOWLEDGE_ITEM',
      title: `Kiến thức mới: ${curated.title}`,
      summary:
        `${curated.summary}\n\nNguồn: ${hit.url}\nĐiểm chất lượng: ${score}/100\n` +
        `Đề xuất cho: ${curated.departments.join(', ')}`,
      context: { knowledgeItemId: item.id, departments: curated.departments },
    });

    await repos.knowledgeItems.linkApproval(item.id, approval.id);

    await context.events.publish(
      'APPROVAL_REQUIRED',
      { approvalId: approval.id, kind: approval.kind, title: approval.title },
      { actor: 'system' },
    );

    report.promoted.push({ itemId: item.id, title: curated.title, score });
  }

  await repos.knowledgeSources.markScanned(source.id);
  return report;
}

/** Chủ đề mặc định khi CEO chưa nêu gì cụ thể. */
function defaultQueries(wantedTopics: string[]): string[] {
  if (wantedTopics.length > 0) {
    return wantedTopics.map((topic) => `${topic} stars:>200 pushed:>2026-01-01`);
  }
  return ['typescript stars:>1000 pushed:>2026-01-01'];
}

/**
 * §107 — bản tóm tắt gửi CEO. Ngắn, và nói cả phần bị loại: biết vì sao một thứ
 * bị loại có ích ngang biết thứ gì được chọn.
 */
export function formatDigest(report: DiscoveryReport, departments: Department[] = []): string {
  const lines = ['*P&N — Khám phá kiến thức hôm nay*', ''];

  if (report.promoted.length === 0) {
    lines.push('Không có kiến thức mới nào đáng đưa lên để duyệt.');
  } else {
    lines.push(`*${report.promoted.length} gói kiến thức chờ bạn duyệt*`);
    for (const item of report.promoted) {
      lines.push(`• ${item.title} — ${item.score}/100`);
    }
  }

  lines.push(
    '',
    `Đã quét ${report.found} repo · ${report.duplicates} đã biết từ trước · ` +
      `${report.rejected.length} bị loại`,
  );

  if (report.rejected.length > 0) {
    const byStage = new Map<string, number>();
    for (const item of report.rejected) {
      byStage.set(item.stage, (byStage.get(item.stage) ?? 0) + 1);
    }
    lines.push(
      `Loại ở: ${[...byStage.entries()].map(([stage, count]) => `${stage} (${count})`).join(', ')}`,
    );
  }

  lines.push(`Chi phí vòng này: $${report.costUsd.toFixed(4)}`);
  if (report.note) lines.push('', report.note);
  if (departments.length > 0) lines.push('', `Phòng ban đang cần: ${departments.join(', ')}`);

  return lines.join('\n');
}
