/**
 * P&N — Cài đặt → Tích hợp, bản 4: dải chỉ số, "đường đi của một đơn hàng" từ lúc CEO nhắn
 * Telegram tới lúc nhận sản phẩm, rồi thẻ từng dịch vụ xếp theo chặng (nhận việc, làm và lưu, phát hành).
 *
 * Ràng buộc cũ giữ nguyên: secret nhập vào đi thẳng xuống kho mã hoá, ô nhập luôn trống khi tải lại (§88.3);
 * nút kiểm tra gọi thật tới dịch vụ ngoài và hiện nguyên văn câu trả lời (§89).
 */

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import { OFFICE_GENERAL_LINES } from '@pn/shared';

import { ErrorNote } from '@/components/ui';
import { Cells, IsoCube, Kpi, Meter, Pill, Stack, int, stamp, styles as s } from '@/components/settings/kit';
import { api, type IntegrationRow } from '@/lib/api';
import { officeVoice } from '@/lib/office-voice';

/** Mô tả một ô nhập của tích hợp: là secret hay cấu hình thường. */
interface Field {
  name: string;
  label: string;
  hint?: string;
  secret?: boolean;
  /** Nhập nhiều giá trị, ngăn bằng dấu phẩy — lưu xuống dạng mảng. */
  list?: boolean;
}

interface Kind {
  kind: string;
  label: string;
  group: 'Nhận việc và báo tin' | 'Làm và lưu' | 'Phát hành';
  color: string;
  purpose: string;
  /** Chưa nối thì công ty thiếu gì — nói bằng hậu quả, không bằng thuật ngữ. */
  without: string;
  fields: Field[];
}

const KINDS: Kind[] = [
  {
    kind: 'TELEGRAM', label: 'Telegram', group: 'Nhận việc và báo tin', color: '#2481cc',
    purpose: 'Đầu vào chính: CEO giao việc, duyệt từng bước bằng nút ngay trong chat và nhận sản phẩm.',
    without: 'Chưa nối: CEO không giao việc được qua chat.',
    fields: [
      { name: 'botToken', label: 'Bot token', secret: true, hint: 'Lấy từ @BotFather' },
      { name: 'allowedChatIds', label: 'Chat ID được phép', list: true, hint: 'Ngăn bằng dấu phẩy. Bỏ trống là không ai dùng được bot.' },
    ],
  },
  {
    kind: 'SMTP', label: 'Email (SMTP)', group: 'Nhận việc và báo tin', color: '#8b5cf6',
    purpose: 'Gửi email từ sản phẩm và từ công ty. Kiểm tra bằng cách đăng nhập máy chủ thư rồi thoát, không gửi thư nào.',
    without: 'Chưa nối: mọi thông báo chỉ đi qua Telegram.',
    fields: [
      { name: 'host', label: 'Máy chủ', hint: 'vd. smtp.gmail.com' },
      { name: 'port', label: 'Cổng', hint: '587 (STARTTLS) hoặc 465 (TLS)' },
      { name: 'user', label: 'Tên đăng nhập' },
      { name: 'password', label: 'Mật khẩu', secret: true, hint: 'Gmail cần mật khẩu ứng dụng' },
      { name: 'from', label: 'Địa chỉ gửi' },
    ],
  },
  {
    kind: 'WEBHOOK', label: 'Webhook', group: 'Nhận việc và báo tin', color: '#64748b',
    purpose: 'Báo sự kiện của công ty sang hệ thống khác (Zapier, n8n, máy chủ riêng). Kiểm tra bằng một gói ping.',
    without: 'Chưa nối: hệ thống ngoài không biết khi có sự kiện.',
    fields: [
      { name: 'url', label: 'Địa chỉ nhận' },
      { name: 'secret', label: 'Khoá ký', secret: true, hint: 'Có thì mỗi gói tin kèm chữ ký HMAC-SHA256 ở header X-PN-Signature' },
    ],
  },
  {
    kind: 'VOICE', label: 'Giọng nói (Vbee)', group: 'Nhận việc và báo tin', color: '#e8590c',
    purpose: 'Khang đọc thông báo văn phòng bằng giọng Vbee tự nhiên thay giọng máy. Token nằm ở máy chủ, câu hay lặp được lưu sẵn nên không tốn credit đọc lại.',
    without: 'Chưa nối: văn phòng đọc bằng giọng có sẵn trong máy (Windows phải cài gói tiếng Việt).',
    fields: [
      { name: 'appId', label: 'App ID', hint: 'studio.vbee.vn → Ứng dụng → Tích hợp API' },
      { name: 'token', label: 'Token', secret: true, hint: 'Token của ứng dụng đó; hết hạn thì tạo ứng dụng mới rồi dán lại' },
      { name: 'voiceCode', label: 'Giọng đọc', hint: 'Lưu App ID + token trước thì danh sách giọng hiện ra; bấm Nghe mẫu để nghe từng giọng (không tốn credit).' },
      { name: 'speed', label: 'Tốc độ đọc', hint: '0,25–1,9; bỏ trống = 1 (bình thường)' },
      { name: 'monthlyChars', label: 'Trần ký tự mỗi tháng', hint: 'Bỏ trống = 20.000. Chạm trần thì tự về giọng máy, không đọc thêm bằng Vbee.' },
    ],
  },
  {
    kind: 'GITHUB', label: 'GitHub', group: 'Làm và lưu', color: '#24292f',
    purpose: 'Nhân sự AI tạo nhánh, ghi mã và mở yêu cầu gộp trên kho riêng của từng dự án.',
    without: 'Chưa nối: mã chỉ nằm trong máy thử trên máy chủ.',
    fields: [
      { name: 'token', label: 'Personal access token', secret: true, hint: 'Cần quyền repo' },
      { name: 'defaultOrg', label: 'Tổ chức mặc định', hint: 'Bỏ trống thì dùng tài khoản cá nhân' },
      { name: 'protectedBranches', label: 'Branch được bảo vệ', list: true, hint: 'Nhân sự AI bị chặn cứng, không ghi thẳng vào các nhánh này.' },
    ],
  },
  {
    kind: 'DATABASE', label: 'Cơ sở dữ liệu công ty', group: 'Làm và lưu', color: '#0e7490',
    purpose: 'Postgres của chính hệ thống P&N, cấu hình bằng biến môi trường. Nút kiểm tra hỏi thử một câu truy vấn.',
    without: 'Chưa kiểm tra lần nào.',
    fields: [],
  },
  {
    kind: 'OBJECT_STORAGE', label: 'Kho tệp S3', group: 'Làm và lưu', color: '#b7791f',
    purpose: 'Lưu ảnh, video, tài liệu của sản phẩm trên dịch vụ tương thích S3 (AWS, Cloudflare R2, MinIO).',
    without: 'Chưa nối: tệp CEO gửi qua Telegram và bản dựng nằm trong ổ đĩa máy chủ.',
    fields: [
      { name: 'endpoint', label: 'Địa chỉ dịch vụ', hint: 'vd. https://s3.ap-southeast-1.amazonaws.com' },
      { name: 'region', label: 'Vùng', hint: 'Bỏ trống là us-east-1; Cloudflare R2 dùng auto' },
      { name: 'bucket', label: 'Bucket' },
      { name: 'accessKeyId', label: 'Access key ID' },
      { name: 'secretAccessKey', label: 'Secret access key', secret: true },
    ],
  },
  {
    kind: 'DEPLOYMENT', label: 'Vercel', group: 'Phát hành', color: '#1f2937',
    purpose: 'Đưa bản chính thức của sản phẩm web lên một địa chỉ công khai.',
    without: 'Chưa nối: bản thử vẫn dựng tại máy chủ P&N, chưa có địa chỉ công khai.',
    fields: [
      { name: 'token', label: 'Token', secret: true, hint: 'Vercel → Settings → Tokens' },
      { name: 'teamId', label: 'Team ID', hint: 'Bỏ trống nếu dùng tài khoản cá nhân' },
    ],
  },
  {
    kind: 'APP_STORE_CONNECT', label: 'App Store Connect', group: 'Phát hành', color: '#0a84ff',
    purpose: 'Đẩy ứng dụng iOS lên TestFlight và App Store. Kiểm tra bằng cách đăng nhập và đọc danh sách ứng dụng.',
    without: 'Chưa nối: app iOS dừng ở mã nguồn.',
    fields: [
      { name: 'issuerId', label: 'Issuer ID' },
      { name: 'keyId', label: 'Key ID' },
      { name: 'privateKey', label: 'Khoá riêng (.p8)', secret: true, hint: 'Dán toàn bộ nội dung file .p8' },
    ],
  },
  {
    kind: 'GOOGLE_PLAY', label: 'Google Play', group: 'Phát hành', color: '#01875f',
    purpose: 'Đẩy ứng dụng Android lên Google Play. Có tên gói thì kiểm cả quyền trên ứng dụng đó.',
    without: 'Chưa nối: app Android dừng ở tệp cài đặt.',
    fields: [
      { name: 'serviceAccountJson', label: 'Tài khoản dịch vụ (JSON)', secret: true, hint: 'Dán nội dung file JSON tải từ Google Cloud' },
      { name: 'packageName', label: 'Tên gói ứng dụng', hint: 'vd. com.pn.app — bỏ trống thì chỉ kiểm đăng nhập' },
    ],
  },
];
const GROUPS = ['Nhận việc và báo tin', 'Làm và lưu', 'Phát hành'] as const;

interface AuditStats {
  days: Array<{ day: string; total: number; noise: number }>;
  monthActions: Record<string, number>;
}
interface Summary {
  ai: { usable: number; total: number };
}

export default function IntegrationsPage(): React.JSX.Element {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ integrations: IntegrationRow[] }>('/api-center/integrations')
      .then((result) => setRows(result.integrations))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không tải được cấu hình'));
    // Số liệu phụ (lượt đăng nhập Telegram, nguồn AI) hỏng thì trang vẫn dùng được.
    api<AuditStats>('/audit/stats?days=1').then(setStats, () => undefined);
    api<Summary>('/api-center/settings-summary').then(setSummary, () => undefined);
  }, []);
  useEffect(load, [load]);

  const on = (kind: string): boolean => rows?.find((row) => row.kind === kind)?.status === 'CONNECTED';
  const telegram = rows?.find((row) => row.kind === 'TELEGRAM') ?? null;
  const connected = KINDS.filter((k) => on(k.kind)).length;
  const logins = (stats?.monthActions['TELEGRAM_WEBAPP_LOGIN'] ?? 0) + (stats?.monthActions['LOGIN_LINK_ISSUED'] ?? 0);
  const polls = Math.round((stats?.days.at(-1)?.noise ?? 0) / 2);
  const releases = ['DEPLOYMENT', 'APP_STORE_CONNECT', 'GOOGLE_PLAY'].filter(on);

  // Sáu chặng một đơn hàng đi qua; chặng nối liền khi cả hai đầu đều chạy.
  const steps = [
    { k: '01', title: 'Nhận việc', sub: on('TELEGRAM') ? 'Telegram' : 'Telegram chưa nối', ok: on('TELEGRAM'), color: '#2481cc' },
    { k: '02', title: 'Phân tích và làm', sub: summary ? `26 nhân viên AI · ${summary.ai.usable} nguồn AI chạy` : '26 nhân viên AI', ok: (summary?.ai.usable ?? 1) > 0, color: '#5b48e6' },
    { k: '03', title: 'Lưu code', sub: on('GITHUB') ? 'GitHub' : 'GitHub chưa nối · lưu trên máy chủ', ok: on('GITHUB'), color: '#24292f' },
    { k: '04', title: 'Chạy thử', sub: 'Bản thử dựng tại máy chủ P&N', ok: true, color: '#0e7490' },
    { k: '05', title: 'Phát hành', sub: releases.length ? releases.map((kind) => KINDS.find((k) => k.kind === kind)!.label).join(', ') : 'Vercel, App Store, Google Play chưa nối', ok: releases.length > 0, color: '#1f2937' },
    { k: '06', title: 'Báo tin', sub: ['TELEGRAM', 'SMTP', 'WEBHOOK'].filter(on).map((kind) => KINDS.find((k) => k.kind === kind)!.label).join(', ') || 'Chưa có kênh nào', ok: ['TELEGRAM', 'SMTP', 'WEBHOOK'].some(on), color: '#2481cc' },
  ];

  return (
    <div className="pb-8">
      <ErrorNote error={error} />

      <div className={s.root}>
        <section className={s.kpis} aria-label="Tình trạng tích hợp">
          <Kpi label="Đã kết nối" value={<>{connected}<small>/ {KINDS.length}</small></>} sub="Nguồn AI tính riêng ở mục Kết nối AI">
            <Cells total={KINDS.length} on={connected} />
          </Kpi>
          <Kpi
            label="Kênh nhận việc"
            value="Telegram"
            sub={<>{on('TELEGRAM') ? <Pill tone="good">Chạy được</Pill> : <Pill tone="off">Chưa nối</Pill>}{telegram?.lastTestedAt && ` kiểm tra ${stamp(telegram.lastTestedAt)}`}</>}
          />
          <Kpi label="Đăng nhập qua Telegram tháng này" value={stats ? int(logins) : '—'} sub={stats ? `${int(stats.monthActions['TELEGRAM_WEBAPP_LOGIN'] ?? 0)} lần mở web app, ${int(stats.monthActions['LOGIN_LINK_ISSUED'] ?? 0)} lần mở link đăng nhập` : undefined}>
            {stats && <Stack parts={[{ value: stats.monthActions['TELEGRAM_WEBAPP_LOGIN'] ?? 0, color: 'var(--st-tg)' }, { value: stats.monthActions['LOGIN_LINK_ISSUED'] ?? 0, color: 'color-mix(in srgb, var(--st-tg) 45%, transparent)' }]} />}
          </Kpi>
          <Kpi label="Chặn tài khoản lạ tháng này" value={stats ? int(stats.monthActions['TELEGRAM_ACCESS_DENIED'] ?? 0) : '—'} sub="Lần nhắn bot từ tài khoản chưa được cấp quyền" />
        </section>

        <section className={`${s.card} ${s.sec}`} aria-labelledby="flow-title">
          <div className={s.secHead}>
            <div>
              <h2 id="flow-title">Đường đi của một đơn hàng</h2>
              <div className={s.sub}>Từ lúc CEO nhắn Telegram tới lúc nhận sản phẩm. Khối đặc là đã nối, khối viền đứt là chưa.</div>
            </div>
          </div>
          <div className={s.flow}>
            {steps.map((step, index) => {
              const next = steps[index + 1];
              return (
                <div key={step.k} className={`${s.fstep} ${next && !(step.ok && next.ok) ? s.fstepCut : ''}`}>
                  <IsoCube color={step.color} on={step.ok} />
                  <span className={s.fstepK}>{step.k}</span>
                  <b>{step.title}</b>
                  <small>{step.sub}</small>
                </div>
              );
            })}
          </div>
        </section>

        <section className={s.igroups}>
          {GROUPS.map((group) => (
            <div key={group}>
              <h3 className={s.igroupTitle}>{group}</h3>
              <div className={s.icards}>
                {KINDS.filter((k) => k.group === group).map((meta) => (
                  <IntegrationCard key={meta.kind} meta={meta} row={rows?.find((row) => row.kind === meta.kind) ?? null} polls={meta.kind === 'TELEGRAM' ? polls : null} onSaved={load} />
                ))}
              </div>
            </div>
          ))}
          <div>
            <h3 className={s.igroupTitle}>Nguồn AI</h3>
            <div className={s.icards}>
              <Link href="/settings" className={`${s.card} ${s.icard} ${s.icardOn}`}>
                <div className={s.icardTop}>
                  <IsoCube color="#5b48e6" on={(summary?.ai.usable ?? 0) > 0} size={40} />
                  <div>
                    <b>Kết nối AI</b>
                    {summary && <Pill tone={summary.ai.usable > 0 ? 'good' : 'warn'}>{summary.ai.usable}/{summary.ai.total} dùng được</Pill>}
                  </div>
                </div>
                <p>Gói thuê bao và key API, thứ tự dùng hãng, phân bổ model cho nhân viên nằm ở mục Kết nối AI.</p>
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

const STATUS: Record<string, { text: string; tone: 'good' | 'bad' | 'off' }> = {
  CONNECTED: { text: 'Đã nối', tone: 'good' },
  ERROR: { text: 'Lỗi', tone: 'bad' },
  NOT_CONFIGURED: { text: 'Chưa nối', tone: 'off' },
  DISABLED: { text: 'Đã tắt', tone: 'off' },
};

/** Thẻ một dịch vụ: trạng thái, dùng để làm gì, thiếu thì sao; mở "Cấu hình" để nhập và kiểm tra thật. */
function IntegrationCard({ meta, row, polls, onSaved }: { meta: Kind; row: IntegrationRow | null; polls: number | null; onSaved: () => void }): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  const status = row?.status ?? 'NOT_CONFIGURED';
  const connected = status === 'CONNECTED';

  // Cấu hình thường đổ lại vào ô nhập được; secret thì không, vì API không trả nó về (§88.3).
  useEffect(() => {
    const settings = row?.settings ?? {};
    const initial: Record<string, string> = {};
    for (const field of meta.fields) {
      if (field.secret) continue;
      const value = settings[field.name];
      initial[field.name] = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    }
    setValues(initial);
  }, [row, meta.fields]);

  async function save(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const settings: Record<string, unknown> = {};
      const secrets: Record<string, string> = {};
      for (const field of meta.fields) {
        const raw = (values[field.name] ?? '').trim();
        if (field.secret) {
          if (raw) secrets[field.name] = raw;
          continue;
        }
        settings[field.name] = field.list ? raw.split(',').map((item) => item.trim()).filter(Boolean) : raw || null;
      }
      await api(`/api-center/integrations/${meta.kind}`, { method: 'PUT', body: { isEnabled: true, settings, secrets } });
      // Xoá ô secret ngay sau khi lưu để nó không nằm lại trong DOM.
      setValues((current) => {
        const next = { ...current };
        for (const field of meta.fields) if (field.secret) delete next[field.name];
        return next;
      });
      setResult({ text: 'Đã lưu. Bấm Kiểm tra kết nối để chắc chắn dùng được.', bad: false });
      onSaved();
    } catch (caught) {
      setResult({ text: caught instanceof Error ? caught.message : 'Không lưu được', bad: true });
    } finally {
      setBusy(false);
    }
  }

  /** Nghe thử giọng Vbee bằng đúng cấu hình đã lưu (tốn vài chục ký tự credit). */
  async function listen(): Promise<void> {
    setBusy(true);
    setResult(null);
    setResult({ text: 'Đang nhờ Vbee đọc… thường vài giây, lượt đầu trong ngày có thể tới vài phút.', bad: false });
    const error = await officeVoice.preview(OFFICE_GENERAL_LINES.preview);
    setResult(error ? { text: error, bad: true } : { text: 'Đã phát xong. Không nghe thấy thì kiểm tra loa hoặc âm lượng trình duyệt.', bad: false });
    setBusy(false);
  }

  async function test(): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const response = await api<{ ok: boolean; detail?: string; error: string | null }>(`/api-center/integrations/${meta.kind}/test`, { method: 'POST' });
      setResult(response.ok ? { text: response.detail ?? 'Kết nối được.', bad: false } : { text: response.error ?? 'Không kết nối được', bad: true });
      onSaved();
    } catch (caught) {
      setResult({ text: caught instanceof Error ? caught.message : 'Không kết nối được', bad: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${s.card} ${s.icard} ${connected ? s.icardOn : s.icardOff}`}>
      <div className={s.icardTop}>
        <IsoCube color={meta.color} on={connected} size={40} />
        <div>
          <b>{meta.label}</b>
          <Pill tone={STATUS[status]?.tone ?? 'off'}>{STATUS[status]?.text ?? status}</Pill>
        </div>
      </div>
      <p>{meta.purpose}</p>
      {!connected && <p className={s.without}>{meta.without}</p>}
      {polls !== null && connected && <Meter label="Bot lấy cấu hình hôm nay" value={`${int(polls)} lần · mỗi 2 phút`} ratio={polls / 720} tone="off" />}
      {meta.fields.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-semibold text-ink-300">{connected ? 'Sửa cấu hình' : 'Cấu hình để kết nối'}</summary>
          <div className={s.form} style={{ marginTop: 10 }}>
            {meta.fields.map((field) => (
              <label key={field.name}>
                <span>
                  {field.label}
                  {field.secret && row?.hasSecrets && <span className="ml-2 text-state-completed">đã lưu</span>}
                </span>
                {meta.kind === 'VOICE' && field.name === 'voiceCode' && row?.hasSecrets ? (
                  <VoicePicker value={values[field.name] ?? ''} onChange={(code) => setValues((current) => ({ ...current, [field.name]: code }))} />
                ) : (
                  <input
                    className={s.field}
                    type={field.secret ? 'password' : 'text'}
                    value={values[field.name] ?? ''}
                    onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
                    placeholder={field.secret && row?.hasSecrets ? 'Nhập giá trị mới để thay thế' : ''}
                    autoComplete="off"
                  />
                )}
                {field.hint && <small>{field.hint}</small>}
              </label>
            ))}
            <div className={s.actions}>
              <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} disabled={busy} onClick={() => void save()}>Lưu</button>
            </div>
          </div>
        </details>
      )}
      <div className={s.foot}>
        <span>{row?.lastTestedAt ? `Kiểm tra ${stamp(row.lastTestedAt)}` : 'Chưa kiểm tra'}</span>
        <span className="flex gap-2">
          {meta.kind === 'VOICE' && connected && (
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} disabled={busy} onClick={() => void listen()}>Nghe thử</button>
          )}
          <button type="button" className={`${s.btn} ${s.btnQuiet} ${s.btnSmall}`} disabled={busy} onClick={() => void test()}>Kiểm tra kết nối</button>
        </span>
      </div>
      {result && <p className={`${s.toast} ${result.bad ? s.toastBad : ''}`}>{result.text}</p>}
      {!result && status === 'ERROR' && row?.lastError && <p className={`${s.toast} ${s.toastBad}`}>{row.lastError}</p>}
    </div>
  );
}

interface VbeeVoice { code: string; name: string; gender: string; demo: string | null; creditFactor: number }

/**
 * Chọn giọng Vbee từ danh sách thật của tài khoản ("làm thêm giọng đọc hiện ra") thay vì gõ mã giọng.
 * "Nghe mẫu" phát bản mẫu Vbee có sẵn cho giọng đó — không qua P&N, không tốn credit.
 */
function VoicePicker({ value, onChange }: { value: string; onChange: (code: string) => void }): React.JSX.Element {
  const [voices, setVoices] = useState<VbeeVoice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<HTMLAudioElement | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);

  useEffect(() => {
    // Giọng đang chọn từng bị Vbee từ chối qua API (vài giọng "2.0"/"Pro" không có trong gói) → báo để chọn giọng khác.
    api<{ rejectedVoice: string | null }>('/voice/status').then((status) => setRejected(status.rejectedVoice), () => undefined);
    api<{ voices: VbeeVoice[] }>('/voice/voices').then(
      (result) => setVoices(result.voices),
      (caught: unknown) => setError(caught instanceof Error ? caught.message : 'Không lấy được danh sách giọng'),
    );
  }, []);
  useEffect(() => () => playing?.pause(), [playing]);

  if (error) {
    return (
      <>
        <input className={s.field} value={value} onChange={(event) => onChange(event.target.value)} placeholder="Mã giọng, vd. hn_female_ngochuyen_full_48k-fhg" autoComplete="off" />
        <small className="text-state-alert">{error}</small>
      </>
    );
  }
  if (!voices) return <input className={s.field} disabled value="Đang lấy danh sách giọng từ Vbee…" readOnly />;

  const current = voices.find((voice) => voice.code === value) ?? voices.find((voice) => voice.code === 'hn_female_ngochuyen_full_48k-fhg') ?? null;
  const group = (gender: string) => voices.filter((voice) => voice.gender === gender);
  const label = (voice: VbeeVoice) => `${voice.name}${voice.creditFactor > 1 ? ` · tốn ×${voice.creditFactor} credit` : ''}`;
  const listen = (): void => {
    if (!current?.demo) return;
    playing?.pause();
    const audio = new Audio(current.demo);
    void audio.play().catch(() => setError('Trình duyệt chặn phát âm thanh — bấm lại một lần nữa.'));
    setPlaying(audio);
  };

  return (
    <>
      <span className="flex gap-2">
        <select className={s.field} value={current?.code ?? ''} onChange={(event) => onChange(event.target.value)}>
          {[['female', 'Giọng nữ'], ['male', 'Giọng nam']].map(([gender, title]) => (
            <optgroup key={gender} label={title}>
              {group(gender!).map((voice) => <option key={voice.code} value={voice.code}>{label(voice)}</option>)}
            </optgroup>
          ))}
        </select>
        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} disabled={!current?.demo} onClick={listen}>Nghe mẫu</button>
      </span>
      {rejected && rejected === value && (
        <small className="text-state-alert">
          Vbee không cho dùng giọng {voices.find((voice) => voice.code === rejected)?.name ?? rejected} qua API với gói hiện tại — văn phòng đang
          tạm đọc bằng HN - Ngọc Huyền. Chọn giọng khác, bấm Lưu rồi Nghe thử.
        </small>
      )}
    </>
  );
}
