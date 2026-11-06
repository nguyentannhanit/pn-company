/**
 * P&N — Xử lý tin nhắn và nút bấm từ Telegram (§5, §58).
 *
 * Nguyên tắc xuyên suốt: bot không nghĩ hộ CEO và không tự quyết. Văn bản tự do
 * được chuyển thẳng cho CTO Orchestrator (§2.2, §5.1); lệnh chỉ là lối tắt gọi
 * đúng endpoint tương ứng.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';

import type { PnApiClient, Session } from './api.js';
import { ApiError } from './api.js';
import { describeFiles, formatSize, storeAttachment, takePendingFiles } from './files.js';
import * as fmt from './format.js';
import type { InlineButton, TelegramClient, TelegramMessage } from './telegram.js';

/** §58 — hai lớp chặn: allowlist chat, và phiên theo đúng vai trò người dùng. */
export interface BotDeps {
  telegram: TelegramClient;
  api: PnApiClient;
  allowedChatIds: Set<string>;
  /** Gọi khi một chat vừa nối xong (đặt nút "Mở P&N" cho chat đó). */
  onLinked?: (chatId: string) => void;
}

/**
 * Ghi nhớ dự án mà mỗi CEO đang nói tới, để lệnh ngắn như /tasks không phải
 * kèm id. Chỉ là tiện ích hiển thị nên giữ trong bộ nhớ là đủ.
 */
const lastProject = new Map<string, { id: string; name: string }>();

/**
 * Đề nghị tạo dự án đang chờ CEO bấm "Tạo" (mã ngắn trên nút → nội dung).
 *
 * Ghi ra file vì bot khởi động lại là mất sạch: CEO bấm nút của tin cũ thì chỉ
 * nhận được "đề nghị đã hết hạn" mà không hiểu vì sao.
 */
interface Proposal {
  chatId: string;
  goal: string;
  name: string;
  productType: string;
  at: number;
}

const PROPOSAL_FILE = 'logs/bot-proposals.json';
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const proposals = new Map<string, Proposal>();

/** Đọc lại lúc khởi động; hỏng file thì coi như chưa có gì, không làm chết bot. */
export async function loadProposals(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(PROPOSAL_FILE, 'utf8')) as Record<string, Proposal>;
    const now = Date.now();
    for (const [code, value] of Object.entries(saved)) {
      if (now - (value.at ?? 0) < PROPOSAL_TTL_MS) proposals.set(code, value);
    }
  } catch {
    /* chưa có file hoặc file hỏng */
  }
}

async function saveProposals(): Promise<void> {
  try {
    await mkdir('logs', { recursive: true });
    await writeFile(PROPOSAL_FILE, JSON.stringify(Object.fromEntries(proposals)));
  } catch {
    /* không ghi được thì vẫn chạy, chỉ mất khi khởi động lại */
  }
}

/** Chống spam: mỗi chat tối đa 20 lệnh mỗi phút (§78). */
const rateLimit = new Map<string, number[]>();

function withinRateLimit(chatId: string): boolean {
  const now = Date.now();
  const recent = (rateLimit.get(chatId) ?? []).filter((time) => now - time < 60_000);
  recent.push(now);
  rateLimit.set(chatId, recent);
  return recent.length <= 20;
}

export async function handleMessage(deps: BotDeps, message: TelegramMessage): Promise<void> {
  const chatId = String(message.chat.id);
  // Một dòng cho mỗi tin nhận được: không có nó thì "bấm mà không thấy gì" chỉ còn cách đoán.
  console.log(`[bot] nhận tin từ ${chatId}: ${(message.text ?? message.caption ?? '(không có chữ)').slice(0, 80)}`);

  // Người được mời mở link t.me/<bot>?start=link_<mã> — phải xử lý TRƯỚC allowlist vì chat này chưa có trong đó.
  const linkCode = /^\/start(?:@\w+)?\s+link_([A-Za-z0-9_-]{10,64})$/.exec((message.text ?? '').trim())?.[1];
  if (linkCode) {
    if (!withinRateLimit(chatId)) return;
    await linkChat(deps, chatId, linkCode);
    return;
  }

  // §58 — chat ngoài allowlist bị bỏ qua hoàn toàn. Không trả lời để không xác
  // nhận với người lạ rằng bot này thuộc hệ thống nào.
  if (deps.allowedChatIds.size > 0 && !deps.allowedChatIds.has(chatId)) return;

  if (!withinRateLimit(chatId)) {
    await deps.telegram.sendMessage(chatId, fmt.error('Bạn gửi quá nhanh, thử lại sau một phút.'));
    return;
  }

  let session: Session;
  try {
    session = await deps.api.session(chatId);
  } catch (error) {
    // API nói rõ lý do (chat chưa gắn tài khoản, sai secret…); chuyển nguyên
    // câu đó cho CEO thay vì một câu chung chung không sửa được.
    await deps.telegram.sendMessage(
      chatId,
      fmt.error(
        error instanceof ApiError ? error.message : 'Không kết nối được tới P&N. Thử lại sau.',
      ),
    );
    return;
  }

  const text = (message.text ?? message.caption ?? '').trim();

  // §5.3 — tệp đính kèm tải về kho trên máy chủ và đi theo dự án tạo kế tiếp.
  if (message.document ?? message.photo ?? message.voice ?? message.audio) {
    await handleAttachment(deps, chatId, message);
    if (!text) return;
  }

  if (!text) return;

  try {
    if (text.startsWith('/')) {
      await handleCommand(deps, session, chatId, text);
    } else {
      // §5.1 — văn bản tự do là yêu cầu giao cho CTO, không phải chat chit.
      await handleNaturalLanguage(deps, session, chatId, text);
    }
  } catch (error) {
    await deps.telegram.sendMessage(
      chatId,
      fmt.error(error instanceof Error ? error.message : 'Có lỗi không xác định.'),
    );
  }
}

/**
 * Nối chat với tài khoản theo mã trong link mời. Mã sai hay hết hạn thì nói thẳng — người bấm link là
 * người CEO đã mời, không phải người lạ dò bot, nên trả lời giúp họ biết phải xin link mới.
 */
async function linkChat(deps: BotDeps, chatId: string, code: string): Promise<void> {
  try {
    const { user } = await deps.api.linkChat(code, chatId);
    deps.allowedChatIds.add(chatId);
    deps.onLinked?.(chatId);
    await deps.telegram.sendMessage(chatId, fmt.welcome(user.displayName, user.role));
  } catch (error) {
    await deps.telegram.sendMessage(
      chatId,
      fmt.error(error instanceof ApiError ? error.message : 'Không kết nối được tới P&N. Thử lại sau.'),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Lệnh — §5.1                                                                 */
/* -------------------------------------------------------------------------- */

async function handleCommand(
  deps: BotDeps,
  session: Session,
  chatId: string,
  text: string,
): Promise<void> {
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand!.split('@')[0]!.toLowerCase();
  const args = rest.join(' ').trim();

  switch (command) {
    case '/start':
      await deps.telegram.sendMessage(chatId, fmt.welcome(session.user.displayName, session.user.role));
      return;

    case '/help':
      await deps.telegram.sendMessage(chatId, fmt.help());
      return;

    case '/newproject':
      if (!args) {
        await deps.telegram.sendMessage(
          chatId,
          'Mô tả dự án bạn muốn làm, ví dụ:\n<i>/newproject Web bán hàng có giỏ hàng và thanh toán</i>',
        );
        return;
      }
      await createProject(deps, session, chatId, args);
      return;

    case '/projects': {
      const { projects } = await deps.api.listProjects(session);
      await deps.telegram.sendMessage(chatId, fmt.projectList(projects));
      return;
    }

    case '/status': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      const detail = await deps.api.projectDetail(session, project.id);
      await deps.telegram.sendMessage(chatId, fmt.projectStatus(detail));
      return;
    }

    case '/tasks': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      const detail = await deps.api.projectDetail(session, project.id);
      await deps.telegram.sendMessage(
        chatId,
        fmt.taskList((detail['tasks'] ?? []) as Array<Record<string, unknown>>, project.name),
      );
      return;
    }

    case '/bugs': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      const detail = await deps.api.projectDetail(session, project.id);
      await deps.telegram.sendMessage(
        chatId,
        fmt.bugList((detail['bugs'] ?? []) as Array<Record<string, unknown>>),
      );
      return;
    }

    case '/agents': {
      const { agents } = await deps.api.listAgents(session);
      await deps.telegram.sendMessage(chatId, fmt.agentList(agents));
      return;
    }

    // Bản tin sức khoẻ ngay lúc này, cùng nội dung bản tự gửi mỗi sáng.
    case '/brief':
    case '/suckhoe': {
      const { text } = await deps.api.brief(session);
      await deps.telegram.sendMessage(chatId, text);
      return;
    }

    case '/cost': {
      const summary = await deps.api.costSummary(session);
      await deps.telegram.sendMessage(chatId, fmt.costReport(summary));
      return;
    }

    case '/report': {
      const [summary, health, status] = await Promise.all([
        deps.api.costSummary(session),
        deps.api.health(session),
        deps.api.orchestratorStatus(session),
      ]);
      await deps.telegram.sendMessage(chatId, fmt.costReport(summary));
      await deps.telegram.sendMessage(
        chatId,
        `${fmt.healthReport(health)}\n\nHàng đợi công việc: ${status.queueSize}`,
      );
      return;
    }

    case '/approve':
    case '/reject':
      await showApprovals(deps, session, chatId);
      return;

    case '/pause': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      // Trước đây lệnh này chỉ đổi nhãn nên việc vẫn chạy; nay cắt thật các lượt đang chạy.
      const { aborted } = await deps.api.stopProject(session, project.id);
      await deps.telegram.sendMessage(
        chatId,
        `⏸ Đã dừng <b>${fmt.esc(project.name)}</b>` +
          (aborted > 0 ? ` — cắt ${aborted} lượt đang chạy, tiến độ đã lưu.` : '.') +
          ' Gõ /resume để làm tiếp.',
      );
      return;
    }

    // Dừng hẳn: cắt mọi thứ, dự án không tự chạy nữa; mã giữ nguyên để "Làm lại dự án" trên web.
    case '/huy':
    case '/stop': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      const { aborted } = await deps.api.stopProject(session, project.id, 'cancel');
      await deps.telegram.sendMessage(
        chatId,
        `⏹ Đã dừng hẳn <b>${fmt.esc(project.name)}</b>` +
          (aborted > 0 ? ` — cắt ${aborted} lượt đang chạy.` : '.') +
          ' Mã đã viết vẫn giữ; muốn làm tiếp thì mở dự án trên web, bấm "Làm lại dự án".',
      );
      return;
    }

    case '/resume': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      // Dự án dừng bằng /pause kiểu cũ (chỉ ghi "kẹt") không qua được /resume mới: chạy tiếp như trước.
      const { queued } = await deps.api.resumeProject(session, project.id).catch(async (error: unknown) => {
        // Dự án đã dừng hẳn thì không có /resume — không được lách bằng cách đổi nhãn rồi chạy tiếp.
        if (!(error instanceof ApiError) || error.status !== 409 || error.message.includes('dừng hẳn')) throw error;
        await deps.api.setProjectStatus(session, project.id, 'IN_PROGRESS');
        return deps.api.advance(session, project.id);
      });
      await deps.telegram.sendMessage(
        chatId,
        `▶️ Chạy tiếp <b>${fmt.esc(project.name)}</b>. Đã xếp ${queued} task vào hàng đợi.`,
      );
      return;
    }

    // Mở dashboard trên điện thoại không cần gõ mật khẩu: link dùng một lần, 2 phút.
    case '/dashboard':
    case '/web': {
      const link = await deps.api.loginLink(chatId);
      await deps.telegram.sendMessage(chatId, fmt.dashboardLink(link.expiresInSeconds), {
        buttons: [[{ text: '🖥 Mở dashboard (đã đăng nhập sẵn)', url: link.url }]],
      });
      return;
    }

    case '/deploy': {
      const project = await resolveProject(deps, session, chatId);
      if (!project) return;
      await requestDeploy(deps, session, chatId, project.id, args.toLowerCase().includes('production'));
      return;
    }

    default:
      await deps.telegram.sendMessage(
        chatId,
        `Không có lệnh <code>${fmt.esc(command)}</code>. Gõ /help để xem danh sách.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Ngôn ngữ tự nhiên — §5.1                                                    */
/* -------------------------------------------------------------------------- */

/**
 * §5.1: "Bot phải hỗ trợ cả natural language… CTO phải tự hiểu và tạo project."
 * Bot không phân tích ý định — nó chuyển nguyên văn cho CTO Orchestrator, vì
 * việc hiểu yêu cầu là công việc của CTO chứ không phải của cổng giao tiếp (§2.2).
 */
/**
 * Văn bản tự do đi qua trợ lý: câu hỏi thì trả lời bằng số liệu thật; yêu cầu
 * làm sản phẩm thì đề nghị tạo dự án kèm nút — trước đây mọi câu đều thành
 * dự án mới, hỏi "hôm nay tiêu bao nhiêu?" cũng mở một dự án.
 */
async function handleNaturalLanguage(
  deps: BotDeps,
  session: Session,
  chatId: string,
  text: string,
): Promise<void> {
  const reply = await deps.api.ask(session, text);
  if (reply.intent === 'answer') {
    await deps.telegram.sendMessage(chatId, fmt.assistantAnswer(reply.text));
    return;
  }
  const code = Math.random().toString(36).slice(2, 10);
  proposals.set(code, { chatId, goal: reply.goal, name: reply.name, productType: reply.productType, at: Date.now() });
  await saveProposals();
  await deps.telegram.sendMessage(chatId, fmt.projectProposal(reply.name, reply.goal, reply.productType), {
    buttons: [
      [
        { text: '🚀 Tạo dự án', callback_data: `newproject:${code}` },
        { text: '✖ Bỏ qua', callback_data: `cancel:${code}` },
      ],
    ],
  });
}

async function createProject(
  deps: BotDeps,
  session: Session,
  chatId: string,
  goal: string,
  productType: string = guessProductType(goal),
): Promise<void> {
  await deps.telegram.sendMessage(chatId, '📥 Đã nhận yêu cầu. CTO đang phân rã công việc…');

  // Tệp CEO gửi trước đó đi theo dự án này (đường dẫn trên máy chủ, trong mục tiêu).
  const files = takePendingFiles(chatId);
  const result = await deps.api.createProject(session, {
    goal: goal + describeFiles(files),
    // Loại sản phẩm do trợ lý hoặc từ khoá suy ra; CTO vẫn có toàn quyền chọn workflow (§92).
    productType,
  });

  lastProject.set(chatId, { id: result.project.id, name: result.project.name });
  await deps.telegram.sendMessage(
    chatId,
    fmt.projectCreated(result.project, result.plan, result.tasks.length, files.length),
  );
}

/** Đoán thô loại sản phẩm từ câu chữ; đoán sai không gây hại vì CTO quyết cuối. */
/**
 * Đoán loại sản phẩm từ câu của CEO. Thứ tự có chủ ý: nói tới web thì là web
 * dù có chữ "app"; "phần mềm", ".exe", "desktop", "máy tính" là phần mềm chạy
 * trên máy — trước đây không có ngăn này nên "phần mềm ghi chú" bị
 * dựng thành trang web.
 */
export function guessProductType(goal: string): string {
  const text = goal.toLowerCase();
  if (/(landing|trang đích|one ?page)/.test(text)) return 'LANDING_PAGE';
  if (/(website giới thiệu|web công ty|corporate)/.test(text)) return 'CORPORATE_WEBSITE';
  if (/(\bweb\b|website|webapp|trang web)/.test(text)) return 'WEB_APPLICATION';
  if (/(điện thoại|android|ios|mobile|di động)/.test(text)) return 'MOBILE_APPLICATION';
  if (/(\bexe\b|desktop|windows|phần mềm|máy tính|\bpc\b|ứng dụng cho máy)/.test(text)) return 'DESKTOP_APPLICATION';
  if (/\bapp\b/.test(text)) return 'MOBILE_APPLICATION';
  return 'WEB_APPLICATION';
}

/* -------------------------------------------------------------------------- */
/* Phê duyệt — §5.2, §27                                                       */
/* -------------------------------------------------------------------------- */

async function showApprovals(deps: BotDeps, session: Session, chatId: string): Promise<void> {
  const { approvals } = await deps.api.listApprovals(session);

  if (approvals.length === 0) {
    await deps.telegram.sendMessage(chatId, '✅ Không có việc nào đang chờ bạn duyệt.');
    return;
  }

  for (const approval of approvals.slice(0, 5)) {
    const id = String(approval['id']);
    const buttons: InlineButton[][] = [
      [
        { text: '✅ Duyệt', callback_data: `approve:${id}` },
        { text: '❌ Từ chối', callback_data: `reject:${id}` },
      ],
    ];
    await deps.telegram.sendMessage(chatId, fmt.approvalCard(approval), { buttons });
  }
}

/** Xử lý CEO bấm nút trên thẻ phê duyệt. */
export async function handleCallback(
  deps: BotDeps,
  callback: { id: string; data?: string; from: { id: number }; message?: TelegramMessage },
): Promise<void> {
  const chatId = String(callback.message?.chat.id ?? callback.from.id);
  console.log(`[bot] nhận nút từ ${chatId}: ${callback.data ?? '(trống)'}`);

  if (deps.allowedChatIds.size > 0 && !deps.allowedChatIds.has(chatId)) {
    await deps.telegram.answerCallbackQuery(callback.id, 'Không có quyền');
    return;
  }

  const [action, approvalId, ...extra] = (callback.data ?? '').split(':');
  if (!action || !approvalId) {
    await deps.telegram.answerCallbackQuery(callback.id);
    return;
  }

  // Lựa chọn của CEO cho một câu hỏi thiết kế/phương án (nút "pick:<chủ đề>:<giá trị>").
  // Không đi qua API: chỉ ghi vào logs/lua-chon.log để người làm tiếp đọc lại.
  if (action === 'pick') {
    const value = extra.join(':');
    await appendFile('logs/lua-chon.log', `${new Date().toISOString()}\t${chatId}\t${approvalId}\t${value}\n`).catch(() => undefined);
    await deps.telegram.answerCallbackQuery(callback.id, `Đã ghi nhận: ${value}`);
    if (callback.message) {
      await deps.telegram.editMessageText(
        chatId,
        callback.message.message_id,
        `✅ <b>Anh đã chọn: ${fmt.esc(value)}</b>\n\n${fmt.esc(callback.message.text ?? '')}`,
      );
    }
    return;
  }

  if (action === 'retry') {
    await retryTask(deps, callback, chatId, approvalId);
    return;
  }

  // Đề nghị tạo dự án từ trợ lý: chỉ tạo khi CEO bấm.
  if (action === 'newproject' || action === 'cancel') {
    const proposal = proposals.get(approvalId);
    proposals.delete(approvalId);
    await saveProposals();
    if (!proposal) {
      await deps.telegram.answerCallbackQuery(callback.id, 'Đề nghị này không còn nữa');
      await deps.telegram.sendMessage(
        chatId,
        fmt.error(
          'Đề nghị tạo dự án này không còn nữa (đã bấm rồi, hoặc quá 24 giờ). ' +
            'Gõ lại mô tả dự án trong một tin nhắn mới, tôi sẽ đề nghị lại kèm nút Tạo.',
        ),
      );
      return;
    }
    await deps.telegram.answerCallbackQuery(callback.id, action === 'cancel' ? 'Đã bỏ qua' : 'Đang tạo dự án…');
    if (callback.message) {
      await deps.telegram.editMessageText(
        chatId,
        callback.message.message_id,
        `${action === 'cancel' ? '✖ <b>Đã bỏ qua</b>' : '🚀 <b>Đang tạo dự án</b>'}\n\n${fmt.esc(callback.message.text ?? '')}`,
      );
    }
    if (action === 'newproject') {
      try {
        const session = await deps.api.session(chatId);
        await createProject(deps, session, chatId, proposal.goal, proposal.productType);
      } catch (error) {
        await deps.telegram.sendMessage(chatId, fmt.error(error instanceof Error ? error.message : 'Không tạo được dự án.'));
      }
    }
    return;
  }

  try {
    const session = await deps.api.session(chatId);
    const decision = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const result = await deps.api.decideApproval(session, approvalId, decision);
    const approval = (result['approval'] ?? {}) as Record<string, unknown>;
    const queued = Number(result['queued'] ?? 0);

    await deps.telegram.answerCallbackQuery(
      callback.id,
      decision === 'APPROVED'
        ? queued > 0
          ? `Đã duyệt · xếp ${queued} việc chạy tiếp`
          : 'Đã duyệt'
        : 'Đã từ chối',
    );

    // Thay nội dung tin nhắn để không bấm lại được lần hai.
    if (callback.message) {
      await deps.telegram.editMessageText(
        chatId,
        callback.message.message_id,
        `${decision === 'APPROVED' ? '✅ <b>Đã duyệt</b>' : '❌ <b>Đã từ chối</b>'}\n\n` +
          `${fmt.esc(callback.message.text ?? '')}`,
      );
    }

    // Duyệt deploy production thì triển khai luôn với phiếu vừa duyệt (§20, §38);
    // không thì CEO duyệt xong vẫn phải quay lại dashboard bấm deploy lần nữa.
    if (decision === 'APPROVED' && approval['kind'] === 'PRODUCTION_DEPLOY' && approval['projectId']) {
      const deployment = await deps.api.deploy(
        session,
        String(approval['projectId']),
        'PRODUCTION',
        approvalId,
      );
      await deps.telegram.sendMessage(chatId, fmt.deployStarted(deployment));
    }
  } catch (error) {
    const message =
      error instanceof ApiError
        ? error.status === 409
          ? 'Yêu cầu này đã được quyết định trước đó.'
          : error.message
        : 'Không xử lý được, thử lại sau.';
    // Telegram giới hạn 200 ký tự cho toast; lý do dài thì gửi thành tin riêng.
    await deps.telegram.answerCallbackQuery(callback.id, message.slice(0, 190));
    if (message.length > 190) await deps.telegram.sendMessage(chatId, fmt.error(message));
  }
}

/**
 * Nút "Chạy lại" trên tin "việc bị chặn": máy chủ xếp việc vào hàng đợi của dự án rồi trả lời ngay. Kẹt nữa thì
 * tin "việc bị chặn" mới tự tới; việc đang chạy hay đã xong thì máy chủ từ chối và CEO đọc được lý do.
 */
async function retryTask(
  deps: BotDeps,
  callback: { id: string; message?: TelegramMessage },
  chatId: string,
  taskId: string,
): Promise<void> {
  let session: Session;
  try {
    session = await deps.api.session(chatId);
  } catch (error) {
    await deps.telegram.answerCallbackQuery(
      callback.id,
      (error instanceof ApiError ? error.message : 'Không kết nối được tới P&N.').slice(0, 190),
    );
    return;
  }

  try {
    await deps.api.runTask(session, taskId);
  } catch (error) {
    await deps.telegram.answerCallbackQuery(
      callback.id,
      (error instanceof Error ? error.message : 'Chạy lại không thành công.').slice(0, 190),
    );
    return;
  }

  await deps.telegram.answerCallbackQuery(callback.id, 'Đã xếp chạy lại.');
  if (callback.message) {
    await deps.telegram.editMessageText(
      chatId,
      callback.message.message_id,
      `🔁 <b>Đã xếp chạy lại</b> — kẹt nữa tôi báo ngay.

${fmt.esc(callback.message.text ?? '')}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Triển khai — §38                                                            */
/* -------------------------------------------------------------------------- */

async function requestDeploy(
  deps: BotDeps,
  session: Session,
  chatId: string,
  projectId: string,
  production: boolean,
): Promise<void> {
  const result = (await deps.api.deploy(session, projectId, production ? 'PRODUCTION' : 'STAGING')) as {
    status?: string;
    approval?: { id: string; title: string; summary: string };
  };

  // §20, §38 — production luôn phải qua CEO duyệt; API trả về yêu cầu phê duyệt.
  if (result.status === 'AWAITING_APPROVAL' && result.approval) {
    await deps.telegram.sendMessage(chatId, fmt.approvalCard(result.approval as never), {
      buttons: [
        [
          { text: '✅ Deploy', callback_data: `approve:${result.approval.id}` },
          { text: '❌ Hủy', callback_data: `reject:${result.approval.id}` },
        ],
      ],
    });
    return;
  }

  await deps.telegram.sendMessage(
    chatId,
    `🚀 Đã khởi tạo triển khai ${production ? 'production' : 'staging'}.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Tệp đính kèm — §5.3                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Phase 1 ghi nhận và xác nhận đã nhận file. Việc tải về, lưu object storage,
 * đánh index và chuyển cho agent phù hợp thuộc §65 và làm ở Phase 2 — nói rõ với
 * CEO thay vì im lặng làm ra vẻ đã xử lý (§89).
 */
async function handleAttachment(
  deps: BotDeps,
  chatId: string,
  message: TelegramMessage,
): Promise<void> {
  try {
    const saved = await storeAttachment(deps.telegram, chatId, message);
    await deps.telegram.sendMessage(
      chatId,
      `📎 Đã lưu <b>${fmt.esc(saved.name)}</b> (${formatSize(saved.size)}).\n` +
        '<i>Tệp sẽ đính kèm vào dự án bạn tạo tiếp theo trong 24 giờ.</i>',
    );
  } catch (error) {
    await deps.telegram.sendMessage(
      chatId,
      fmt.error(`Không lưu được tệp: ${error instanceof Error ? error.message : 'lỗi không rõ'}`),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tiện ích                                                                    */
/* -------------------------------------------------------------------------- */

/** Lấy dự án đang nói tới: dự án vừa thao tác, nếu không thì dự án mới nhất. */
async function resolveProject(
  deps: BotDeps,
  session: Session,
  chatId: string,
): Promise<{ id: string; name: string } | null> {
  const remembered = lastProject.get(chatId);
  if (remembered) return remembered;

  const { projects } = await deps.api.listProjects(session);
  const latest = projects[0];
  if (!latest) {
    await deps.telegram.sendMessage(chatId, 'Chưa có dự án nào. Gửi yêu cầu để bắt đầu.');
    return null;
  }

  const project = { id: String(latest['id']), name: String(latest['name']) };
  lastProject.set(chatId, project);
  return project;
}
