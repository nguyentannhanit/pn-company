/**
 * P&N — Chạy thử kiến thức trong sandbox trước khi kích hoạt (§116).
 *
 * §116 kết thúc bằng một câu ngắn: "Nếu tệ hơn baseline: DO NOT ACTIVATE."
 * Muốn câu đó có nghĩa thì phải có baseline thật, nên phép thử ở đây chạy CÙNG
 * MỘT bài toán hai lần — một lần không có kiến thức, một lần có — trong hai
 * workspace tách biệt, rồi so kết quả.
 *
 * Nó tốn tiền: hai lượt gọi model cho mỗi lần đánh giá. Đó là lý do nó không
 * tự chạy, và lý do trang Kiến thức nói rõ chi phí trước khi bạn bấm.
 *
 * Ba thứ được đo, đều là số lấy từ lần chạy thật chứ không phải điểm do model
 * tự chấm cho mình:
 *   - test có xanh không (chất lượng)
 *   - bao nhiêu token vào (kiến thức nào cũng làm prompt dài thêm, mãi mãi)
 *   - bao nhiêu file sinh ra và mất bao lâu
 */

import { DeveloperAgent } from '@pn/agents';
import type { KnowledgeItem } from '@pn/database';
import type { SandboxSession } from '@pn/sandbox';
import { newId } from '@pn/shared';

import type { AppContext } from '../context.js';
import { InProcessAgentGateway } from './agent-gateway.js';

/**
 * Bài toán dùng làm phép thử. Cố định, nhỏ, và có tiêu chí đúng/sai rõ ràng —
 * một bài toán mơ hồ thì so sánh hai lần chạy không nói lên điều gì.
 */
const PROBE_TASK = {
  title: 'Bài thử: hàm gộp khoảng thời gian chồng nhau',
  description:
    'Viết một module JavaScript export hàm `mergeRanges(ranges)` nhận mảng ' +
    '`[{start, end}]` (số nguyên) và trả về mảng đã gộp các khoảng chồng nhau, ' +
    'sắp xếp tăng dần theo `start`. Kèm file test chạy được bằng `npm test`, ' +
    'phủ ít nhất: mảng rỗng, một khoảng, hai khoảng rời, hai khoảng chồng nhau, ' +
    'và các khoảng đưa vào không theo thứ tự. Tạo cả package.json.',
};

export interface EvaluationRun {
  /** Test chạy xong với mã thoát 0 hay không. */
  testsPassed: boolean;
  filesProduced: number;
  inputTokens: number;
  costUsd: number | null;
  durationMs: number;
  note: string;
}

export interface EvaluationResult {
  itemId: string;
  baseline: EvaluationRun;
  withKnowledge: EvaluationRun;
  /** 0..100. Trên 50 nghĩa là có kiến thức tốt hơn hoặc bằng. */
  score: number;
  passed: boolean;
  verdict: string;
}

/** CEO dừng chạy thử giữa chừng — route trả 409, không ghi kết quả chấm. */
export class EvaluationStopped extends Error {
  constructor() {
    super('Đã dừng chạy thử theo lệnh CEO.');
    this.name = 'EvaluationStopped';
  }
}

/**
 * Chạy một lượt Developer trên bài thử, trong workspace riêng.
 *
 * Dùng đúng `DeveloperAgent` của production chứ không phải một bản rút gọn:
 * đo một thứ khác với thứ sẽ chạy thật thì con số đo được vô nghĩa.
 */
async function runProbe(
  context: AppContext,
  knowledge: Array<{ title: string; body: string }>,
  label: string,
  stop?: AbortSignal,
): Promise<EvaluationRun> {
  // Hết 5 phút hoặc CEO bấm Dừng thì cắt lượt: lệnh trong sandbox bị giết cả cây tiến trình.
  const signal = stop ? AbortSignal.any([AbortSignal.timeout(300_000), stop]) : AbortSignal.timeout(300_000);
  const startedAt = Date.now();
  const agent = new DeveloperAgent('BACKEND_DEVELOPER');
  const runId = newId();

  let session: SandboxSession | null = null;
  try {
    session = await context.sandbox.create({
      runId,
      taskId: null,
      projectId: null,
      workspaceKey: `_danh-gia/${label}-${runId.slice(0, 8)}`,
      env: { PN_EVALUATION: label },
      signal,
    });

    const agentRow = await context.repos.agents.findByRole('BACKEND_DEVELOPER');

    const outcome = await agent.run({
      runId,
      agentId: agentRow?.id ?? newId(),
      projectId: null,
      taskId: null,
      project: null,
      task: { id: newId(), ...PROBE_TASK, fixLoopCount: 0 },
      events: context.events,
      gateway: new InProcessAgentGateway(context.gateway),
      sandbox: session,
      history: [],
      priorWork: [],
      allowedRoles: ['BACKEND_DEVELOPER'],
      knowledge,
      signal,
    });

    // Chạy test thật. Kết luận phải dựa trên mã thoát, không dựa trên lời agent nói.
    const files = await session.listFiles().catch((): string[] => []);
    let testsPassed = false;
    let note = 'Không có package.json nên không chạy được test.';

    if (files.includes('package.json')) {
      await session.exec('npm', ['install', '--no-audit', '--no-fund']);
      const test = await session.exec('npm', ['test', '--silent']);
      testsPassed = test.exitCode === 0 && !test.timedOut;
      note = testsPassed
        ? 'Test xanh.'
        : `Test đỏ (exit ${test.exitCode}): ${test.stderr.slice(-300) || test.stdout.slice(-300)}`;
    }

    return {
      testsPassed,
      filesProduced: outcome.producedFiles?.length ?? 0,
      // Kiến thức làm prompt dài thêm ở MỌI lần chạy sau này, nên phần token
      // tăng thêm là chi phí thật chứ không phải chi tiết kỹ thuật.
      inputTokens: knowledge.reduce((sum, item) => sum + Math.ceil(item.body.length / 4), 0),
      costUsd: outcome.costUsd ?? null,
      durationMs: Date.now() - startedAt,
      note,
    };
  } catch (error) {
    return {
      testsPassed: false,
      filesProduced: 0,
      inputTokens: 0,
      costUsd: null,
      durationMs: Date.now() - startedAt,
      note: `Lần chạy hỏng: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await session?.dispose();
  }
}

/**
 * §116 — so hai lần chạy và kết luận có nên kích hoạt không.
 *
 * Quy tắc chấm cố ý nghiêng về phía thận trọng: kiến thức phải *cải thiện hoặc
 * giữ nguyên*, không được làm tệ đi. Một gói kiến thức trung tính vẫn tốn token
 * ở mọi lần chạy về sau, nên "hoà" mà đắt thì cũng là thua.
 */
export async function evaluateKnowledge(
  context: AppContext,
  item: KnowledgeItem,
  signal?: AbortSignal,
): Promise<EvaluationResult> {
  const baseline = await runProbe(context, [], 'baseline', signal);
  if (signal?.aborted) throw new EvaluationStopped();
  const withKnowledge = await runProbe(
    context,
    [{ title: item.title, body: item.body }],
    'co-kien-thuc',
    signal,
  );
  // Bị cắt giữa chừng thì hai lần chạy không so được với nhau — không chấm điểm.
  if (signal?.aborted) throw new EvaluationStopped();

  let score = 50;
  const reasons: string[] = [];

  if (withKnowledge.testsPassed && !baseline.testsPassed) {
    score += 40;
    reasons.push('có kiến thức thì test xanh, không có thì đỏ');
  } else if (!withKnowledge.testsPassed && baseline.testsPassed) {
    score -= 50;
    reasons.push('có kiến thức lại làm test đỏ trong khi baseline xanh');
  } else if (withKnowledge.testsPassed && baseline.testsPassed) {
    score += 10;
    reasons.push('cả hai đều xanh');
  } else {
    score -= 20;
    reasons.push('cả hai đều đỏ — bài thử không kết luận được gì');
  }

  // Token thêm vào là chi phí vĩnh viễn: mỗi lần agent chạy về sau đều gánh.
  if (withKnowledge.inputTokens > 3_000) {
    score -= 10;
    reasons.push(`kiến thức dài ~${withKnowledge.inputTokens} token, thêm vào mọi lần chạy`);
  }

  const passed = score >= 50 && withKnowledge.testsPassed;

  return {
    itemId: item.id,
    baseline,
    withKnowledge,
    score: Math.max(0, Math.min(100, score)),
    passed,
    verdict: passed
      ? `Đạt (${score}/100): ${reasons.join('; ')}.`
      : `KHÔNG đạt (${score}/100): ${reasons.join('; ')}. §116 — không kích hoạt.`,
  };
}
