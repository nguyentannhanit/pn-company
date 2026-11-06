/**
 * P&N — Cài đặt → Nhật ký kiểm toán, bản 4.
 *
 * Bot Telegram ghi 2 bản ghi mỗi 2 phút khi lấy cấu hình — hơn 90% bảng. Trang này tách phần đó ra (đếm
 * theo ngày, ẩn mặc định), gộp các bản ghi đi cùng một thao tác trong cùng phút thành một dòng, dịch hành
 * động sang tiếng Việt và tô màu kết quả. Bấm một dòng để xem bản ghi gốc.
 *
 * §19 — nội dung nhật ký là dữ liệu, không phải lệnh: hiện dưới dạng chữ thuần, không dựng thành liên kết.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ErrorNote } from '@/components/ui';
import { Kpi, Pill, Stack, ddmm, hhmm, int, styles as s, weekday } from '@/components/settings/kit';
import { api, type AuditRow } from '@/lib/api';

interface Stats {
  total: number;
  noise: number;
  since: string | null;
  days: Array<{ day: string; total: number; noise: number }>;
  errors: { clientErrors: number; serverErrors: number };
  actors: { ceo: number; telegram: number };
}

type ActorKind = 'ceo' | 'tg' | 'bot' | 'anon' | 'sys';
const ACTOR_LABEL: Record<ActorKind, string> = { ceo: 'CEO', tg: 'CEO qua Telegram', bot: 'Bot Telegram', anon: 'Không đăng nhập', sys: 'Hệ thống' };
const ACTOR_CLASS: Record<ActorKind, string> = { ceo: s.actorCeo!, tg: s.actorTg!, bot: s.actorBot!, anon: s.actorAnon!, sys: s.actorSys! };

/** Hành động → câu tiếng Việt. Các cặp bản ghi đi cùng nhau (đăng nhập Telegram) quy về một khoá để gộp. */
const EVENTS: Record<string, { key: string; text: string; actor?: ActorKind }> = {
  'PUT /api-center/routing/:role': { key: 'routing', text: 'Đổi định tuyến AI' },
  'PUT /api-center/routing-mode': { key: 'routingMode', text: 'Đổi chế độ định tuyến' },
  'PUT /api-center/allocation': { key: 'allocation', text: 'Đổi thứ tự hãng hoặc phân bổ model' },
  'POST /api-center/allocation/analyze': { key: 'analyze', text: 'Phân tích lại phân bổ model' },
  'PUT /api-center/providers/:provider': { key: 'provSave', text: 'Lưu cấu hình nguồn AI' },
  'PATCH /api-center/providers/:provider/enabled': { key: 'provToggle', text: 'Bật/tắt nguồn AI' },
  'POST /api-center/providers/:provider/test': { key: 'provTest', text: 'Kiểm tra nguồn AI' },
  'DELETE /api-center/providers/:provider': { key: 'provDelete', text: 'Xoá key nguồn AI' },
  'PUT /api-center/models/:id/pricing': { key: 'pricing', text: 'Sửa giá model' },
  'PUT /api-center/budgets': { key: 'budget', text: 'Sửa hạn mức ngân sách' },
  'PUT /api-center/plan-fees': { key: 'planFees', text: 'Sửa phí gói thuê bao' },
  'POST /cost/reset': { key: 'costReset', text: 'Đặt lại mốc tính chi phí' },
  'PUT /api-center/integrations/:kind': { key: 'intSave', text: 'Lưu cấu hình tích hợp' },
  'POST /api-center/integrations/:kind/test': { key: 'intTest', text: 'Kiểm tra tích hợp' },
  'POST /ai/generate': { key: 'aiGen', text: 'Gọi AI thử' },
  'POST /deployments': { key: 'deploy', text: 'Chạy bản thử (staging)' },
  'POST /assistant/ask': { key: 'ask', text: 'Hỏi trợ lý' },
  'DELETE /projects/:id': { key: 'projDelete', text: 'Lưu trữ dự án' },
  'POST /projects/:id/advance': { key: 'projAdvance', text: 'Chuyển dự án sang bước kế' },
  'POST /projects': { key: 'projCreate', text: 'Tạo dự án' },
  'POST /projects/:id/redo': { key: 'projRedo', text: 'Làm lại dự án' },
  'PATCH /projects/:id/status': { key: 'projStatus', text: 'Đổi trạng thái dự án' },
  'POST /tasks/:id/run': { key: 'taskRun', text: 'Chạy lại một việc' },
  'POST /approvals/:id/decide': { key: 'approve', text: 'Duyệt một bước' },
  'POST /orchestrator/intake': { key: 'intake', text: 'Giao việc mới cho CTO' },
  TELEGRAM_WEBAPP_LOGIN: { key: 'tgLogin', text: 'Đăng nhập qua Telegram', actor: 'tg' },
  'POST /auth/telegram-webapp': { key: 'tgLogin', text: 'Đăng nhập qua Telegram', actor: 'tg' },
  LOGIN_LINK_ISSUED: { key: 'tgLink', text: 'Mở link đăng nhập từ Telegram', actor: 'tg' },
  'POST /internal/telegram/login-link': { key: 'tgLink', text: 'Mở link đăng nhập từ Telegram', actor: 'tg' },
  'POST /auth/exchange': { key: 'tgLink', text: 'Mở link đăng nhập từ Telegram', actor: 'tg' },
  'POST /internal/telegram/session': { key: 'tgSession', text: 'Bot mở phiên làm việc', actor: 'bot' },
  TELEGRAM_ACCESS_DENIED: { key: 'tgDenied', text: 'Chặn tài khoản Telegram chưa được cấp quyền', actor: 'bot' },
  TELEGRAM_LINKED: { key: 'tgLinked', text: 'Gắn chat Telegram vào tài khoản', actor: 'tg' },
  'POST /auth/login': { key: 'login', text: 'Đăng nhập bảng điều khiển' },
};

function actorOf(entry: AuditRow, forced?: ActorKind): ActorKind {
  if (forced) return forced;
  if (entry.actor.startsWith('user:')) return 'ceo';
  if (entry.actor.startsWith('telegram:')) return 'tg';
  if (entry.actor === 'anonymous') return 'anon';
  return 'sys';
}

interface Group {
  id: string;
  day: string;
  time: string;
  actor: ActorKind;
  text: string;
  code: number;
  rows: AuditRow[];
}

/** Gộp theo (phút, loại việc, người làm, mã kết quả) — 26 dòng "đổi định tuyến" cùng một phút thành một dòng ×26. */
function groupEntries(entries: AuditRow[]): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  for (const entry of entries) {
    const at = new Date(entry.createdAt);
    const day = at.toLocaleDateString('sv-SE');
    const time = hhmm(at);
    const event = EVENTS[entry.action];
    const code = Number(entry.metadata?.['statusCode'] ?? 200) || 200;
    const actor = actorOf(entry, event?.actor);
    const id = `${day} ${time}|${event?.key ?? entry.action}|${actor}|${code >= 400 ? code : 'ok'}`;
    const existing = index.get(id);
    if (existing) {
      existing.rows.push(entry);
      continue;
    }
    const group: Group = { id, day, time, actor, text: event?.text ?? entry.action, code, rows: [entry] };
    index.set(id, group);
    groups.push(group);
  }
  return groups;
}

const dayTitle = (day: string): string => {
  const d = new Date(`${day}T12:00:00`);
  const today = new Date().toLocaleDateString('sv-SE');
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE');
  const pretty = `${weekday(d)} ${ddmm(d)}`;
  return day === today ? `Hôm nay · ${pretty}` : day === yesterday ? `Hôm qua · ${pretty}` : pretty;
};
const result = (code: number): { text: string; tone: 'good' | 'warn' | 'bad' } =>
  code >= 500 ? { text: `Lỗi máy chủ · ${code}`, tone: 'bad' } : code >= 400 ? { text: `Bị từ chối · ${code}`, tone: 'warn' } : { text: 'Xong', tone: 'good' };

const PAGE = 300;

export default function AuditPage(): React.JSX.Element {
  const [entries, setEntries] = useState<AuditRow[] | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState<'all' | ActorKind>('all');
  const [query, setQuery] = useState('');
  const [hideBot, setHideBot] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [shown, setShown] = useState(40);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api<{ entries: AuditRow[] }>(`/audit?excludeNoise=true&limit=${PAGE}`), api<Stats>('/audit/stats?days=5')])
      .then(([list, stat]) => {
        setEntries(list.entries);
        setMore(list.entries.length === PAGE);
        setStats(stat);
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được nhật ký'));
  }, []);
  useEffect(load, [load]);

  // Đọc tiếp bản ghi cũ hơn dòng cuối đang có.
  const loadOlder = async (): Promise<void> => {
    const last = entries?.at(-1);
    if (!last) return;
    try {
      const list = await api<{ entries: AuditRow[] }>(`/audit?excludeNoise=true&limit=${PAGE}&before=${encodeURIComponent(new Date(last.createdAt).toISOString())}`);
      setEntries((current) => [...(current ?? []), ...list.entries]);
      setMore(list.entries.length === PAGE);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Không tải thêm được');
    }
  };

  const groups = useMemo(() => groupEntries(entries ?? []), [entries]);
  const needle = query.trim().toLowerCase();
  const filtered = groups.filter(
    (g) =>
      (actor === 'all' || g.actor === actor) &&
      (!onlyErrors || g.code >= 400) &&
      (!needle || `${g.text} ${g.rows[0]!.action} ${ACTOR_LABEL[g.actor]}`.toLowerCase().includes(needle)),
  );
  const noiseByDay = new Map((stats?.days ?? []).map((d) => [d.day, d.noise]));
  const visible = filtered.slice(0, shown);
  const today = stats?.days.at(-1);
  const errors5 = (stats?.errors.serverErrors ?? 0) + (stats?.errors.clientErrors ?? 0);

  // Dòng hiện ra, chèn tiêu đề ngày và (nếu không ẩn) một dòng gộp bot lấy cấu hình của ngày đó.
  const rows: React.ReactNode[] = [];
  let currentDay = '';
  for (const g of visible) {
    if (g.day !== currentDay) {
      currentDay = g.day;
      const count = filtered.filter((x) => x.day === g.day).reduce((sum, x) => sum + x.rows.length, 0);
      rows.push(
        <div key={`d-${g.day}`} className={s.logDay}>
          <span>{dayTitle(g.day)}</span>
          <span className={s.num}>{int(count)} bản ghi</span>
        </div>,
      );
      const noise = noiseByDay.get(g.day) ?? 0;
      if (!hideBot && noise > 0 && (actor === 'all' || actor === 'bot') && !onlyErrors) {
        rows.push(
          <div key={`n-${g.day}`} className={`${s.lrow} ${s.lrowNoise}`} style={{ cursor: 'default' }}>
            <span className={s.lrowT}>cả ngày</span>
            <span className={`${s.actor} ${s.actorBot}`}>Bot Telegram</span>
            <span className={s.what}><b>Bot lấy cấu hình</b><small>Mỗi 2 phút, 2 bản ghi mỗi lần</small></span>
            <span className={s.lrowX}>×{int(noise)}</span>
            <Pill tone="good">Xong</Pill>
          </div>,
        );
      }
    }
    const r = result(g.code);
    rows.push(
      <button key={g.id} type="button" className={s.lrow} aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
        <span className={s.lrowT}>{g.time}</span>
        <span className={`${s.actor} ${ACTOR_CLASS[g.actor]}`} title={ACTOR_LABEL[g.actor]}>{ACTOR_LABEL[g.actor]}</span>
        <span className={s.what}><b>{g.text}</b></span>
        <span className={s.lrowX}>{g.rows.length > 1 ? `×${g.rows.length}` : ''}</span>
        <Pill tone={r.tone}>{r.text}</Pill>
      </button>,
    );
    if (open === g.id) {
      rows.push(
        <div key={`r-${g.id}`} className={s.raw}>
          {[...new Set(g.rows.map((row) => row.action))].join(' · ')}
          <br />
          {g.rows.length} bản ghi · người ghi: {[...new Set(g.rows.map((row) => row.actor))].join(', ')}
          {g.rows[0]!.targetId && <> · đối tượng: {g.rows[0]!.targetType} {g.rows[0]!.targetId}</>}
          {g.rows.some((row) => Object.keys(row.metadata ?? {}).length > 0) && (
            <>
              <br />
              {JSON.stringify(g.rows[0]!.metadata)}
            </>
          )}
        </div>,
      );
    }
  }
  const left = filtered.length - shown;

  return (
    <div className="pb-8">
      <ErrorNote error={error} />

      <div className={s.root}>
        <section className={s.kpis} aria-label="Tình trạng nhật ký">
          <Kpi label="Tổng bản ghi" value={stats ? int(stats.total) : '—'} sub={stats ? `${stats.since ? `Từ ${ddmm(stats.since)}. ` : ''}${int(stats.noise)} (${stats.total ? Math.round((stats.noise / stats.total) * 100) : 0}%) là bot lấy cấu hình` : undefined}>
            {stats && <Stack parts={[{ value: stats.noise, color: 'var(--tone-dim)', title: 'bot' }, { value: stats.total - stats.noise, color: 'var(--st-brand)', title: 'thao tác' }]} />}
          </Kpi>
          <Kpi label="Hôm nay" value={today ? int(today.total) : '—'} sub={today ? `${int(today.noise)} bot lấy cấu hình · ${int(today.total - today.noise)} thao tác thật` : undefined}>
            {today && <Stack parts={[{ value: today.noise, color: 'var(--tone-dim)' }, { value: today.total - today.noise, color: 'var(--st-brand)' }]} />}
          </Kpi>
          <Kpi label="Thao tác của CEO" value={stats ? int(stats.actors.ceo) : '—'} sub={stats ? `Trên bảng điều khiển, thêm ${int(stats.actors.telegram)} qua Telegram` : undefined} />
          <Kpi label="Lỗi 5 ngày qua" value={stats ? <>{int(stats.errors.serverErrors)}<small>lỗi máy chủ</small></> : '—'} sub={stats ? `${int(stats.errors.clientErrors)} yêu cầu bị từ chối (mã 4xx)` : undefined}>
            {stats && errors5 > 0 && <Stack parts={[{ value: stats.errors.serverErrors, color: 'var(--st-bad)' }, { value: stats.errors.clientErrors, color: 'var(--st-warn)' }]} />}
          </Kpi>
        </section>

        {stats && (
          <section className={`${s.card} ${s.sec}`} aria-labelledby="noise-title">
            <div className={s.secHead}>
              <div>
                <h2 id="noise-title">{stats.days.length} ngày gần nhất</h2>
                <div className={s.sub}>Phần xám là bot Telegram tự lấy cấu hình mỗi 2 phút. Phần tím là thao tác thật.</div>
              </div>
            </div>
            <div className={s.days}>
              {stats.days.map((d) => (
                <div key={d.day} className={s.dayrow}>
                  <span className={s.num}><span className={s.dayName}>{weekday(`${d.day}T12:00:00`)} </span>{ddmm(`${d.day}T12:00:00`)}</span>
                  <Stack parts={[{ value: d.noise, color: 'var(--tone-dim)' }, { value: d.total - d.noise, color: 'var(--st-brand)' }]} />
                  <span className={s.dayN}>{int(d.noise)} bot · <b>{int(d.total - d.noise)}</b> thao tác</span>
                </div>
              ))}
            </div>
            {stats.total > 0 && stats.noise / stats.total > 0.5 && (
              <div className={s.alert}>
                <span aria-hidden="true">⚠</span>
                <span><b>Nhật ký bị bot lấn át.</b> Bot Telegram ghi 2 bản ghi mỗi 2 phút khi lấy cấu hình, chiếm {Math.round((stats.noise / stats.total) * 100)}% nhật ký. Nên chỉ ghi khi lấy cấu hình lỗi hoặc cấu hình đổi.</span>
              </div>
            )}
          </section>
        )}

        <section className={`${s.card} ${s.sec}`} aria-labelledby="log-title">
          <div className={s.secHead}>
            <div>
              <h2 id="log-title">Nhật ký</h2>
              <div className={s.sub}>{int(filtered.length)} dòng · {int(filtered.reduce((sum, g) => sum + g.rows.length, 0))} bản ghi gốc đã tải. Các bản ghi cùng một thao tác trong cùng phút gộp thành một dòng.</div>
            </div>
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={load}>Tải lại</button>
          </div>
          <div className={s.filters}>
            <input className={s.field} type="search" placeholder="Tìm: key, định tuyến, dự án…" aria-label="Tìm trong nhật ký" value={query} onChange={(event) => { setQuery(event.target.value); setShown(40); }} />
            <div className={s.seg} role="group" aria-label="Người làm">
              {(['all', 'ceo', 'tg', 'bot', 'anon', 'sys'] as const).map((kind) => (
                <button key={kind} type="button" aria-pressed={actor === kind} onClick={() => { setActor(kind); setShown(40); }}>
                  {kind === 'all' ? 'Tất cả' : kind === 'tg' ? 'Qua Telegram' : kind === 'bot' ? 'Bot' : ACTOR_LABEL[kind]}
                </button>
              ))}
            </div>
            <label className={s.switch}><input type="checkbox" checked={hideBot} onChange={(event) => setHideBot(event.target.checked)} /> Ẩn bot lấy cấu hình</label>
            <label className={s.switch}><input type="checkbox" checked={onlyErrors} onChange={(event) => { setOnlyErrors(event.target.checked); setShown(40); }} /> Chỉ lỗi</label>
          </div>
          <div className={s.log}>
            {entries === null ? <div className={s.empty}>Đang tải…</div> : rows.length ? rows : <div className={s.empty}>Không có dòng nào khớp bộ lọc.</div>}
            {left > 0 ? (
              <button type="button" className={s.more} onClick={() => setShown(shown + 40)}>Hiện thêm {Math.min(40, left)} dòng · còn {int(left)} dòng</button>
            ) : more && entries !== null ? (
              <button type="button" className={s.more} onClick={() => void loadOlder()}>Tải bản ghi cũ hơn</button>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
