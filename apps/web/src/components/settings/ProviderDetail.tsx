/**
 * P&N — Bảng chi tiết một nguồn AI (cột phải của sơ đồ 3D): trạng thái, mức dùng, cách đăng nhập và mọi thao
 * tác trước đây nằm ở thẻ CLI / thẻ API key — bật và kiểm tra, dán token/key, tắt, xoá key, đưa lên ô 1.
 *
 * §88.3 vẫn giữ nguyên: ô nhập luôn trống sau khi lưu, chỉ hiện chuỗi preview đã che.
 */

'use client';

import { useCallback, useRef, useState } from 'react';

import { api } from '@/lib/api';

import { CliLogin } from './CliLogin';
import { Bar, Pill, PROVIDER_META, hhmm, int, okTone, pct, seconds, shortModel, stamp, styles as s, TIER_ORDER, TIER_WORD, type ProviderState } from './kit';

export function ProviderDetail({
  provider,
  slot,
  rank,
  onChanged,
  onMoveTop,
}: {
  provider: ProviderState;
  /** Ô đang đứng (0 = ô trên cùng). */
  slot: number;
  /** Vị trí trong số hãng dùng được (0 = hãng chính), -1 nếu bị bỏ qua. */
  rank: number;
  onChanged: () => void;
  onMoveTop: (id: string) => void;
}): React.JSX.Element {
  const meta = PROVIDER_META[provider.provider];
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; bad: boolean } | null>(null);
  const plan = provider.kind === 'plan';
  const label = meta.long;

  // Một câu hỏi thật tới hãng: chứng minh key/đăng nhập còn dùng được. CLI mất 5–20 giây.
  const test = async (): Promise<boolean> => {
    setResult({ text: plan ? 'Đang hỏi thử một câu qua CLI…' : 'Đang gọi thử…', bad: false });
    const response = await api<{ ok: boolean; latencyMs: number; error: string | null }>(`/api-center/providers/${provider.provider}/test`, { method: 'POST', body: {} });
    setResult(response.ok ? { text: `Chạy được — trả lời sau ${seconds(response.latencyMs)}.`, bad: false } : { text: response.error ?? 'Lỗi', bad: true });
    return response.ok;
  };

  // Lỗi hiện ngay trong bảng: báo ở đầu trang thì người đang nhìn bảng không thấy ("dán mà không nhận").
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      setResult({ text: `Không thực hiện được: ${caught instanceof Error ? caught.message : 'lỗi không rõ'}`, bad: true });
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  // Token của `claude setup-token` dài cả trăm ký tự; terminal hay ngắt dòng khi copy nên bỏ hết khoảng trắng,
  // và dán cả đoạn chat/terminal cũng được: lấy đúng phần sk-ant-… bên trong. Chuỗi ngắn thường là mã xác nhận
  // trên trình duyệt — mã đó dán vào terminal, không phải vào đây.
  const saveAndTest = (): Promise<void> =>
    run(async () => {
      const compact = secret.replace(/\s+/g, '');
      const cleaned = provider.provider === 'claude-code' ? (/sk-ant-[A-Za-z0-9_-]{20,}/.exec(compact)?.[0] ?? compact) : compact;
      if (cleaned && cleaned.length < 40) {
        setResult({
          text:
            `Chuỗi vừa dán chỉ có ${cleaned.length} ký tự nên chưa phải ${plan ? 'token' : 'key'}.` +
            (plan ? ' Mã xác nhận ngắn trên trình duyệt thì dán vào terminal đang chạy claude setup-token; token là dòng dài bắt đầu bằng sk-ant-oat.' : ''),
          bad: true,
        });
        return;
      }
      if (!plan && !cleaned && !provider.hasKey) {
        setResult({ text: 'Dán API key trước đã.', bad: true });
        return;
      }
      await api(`/api-center/providers/${provider.provider}`, { method: 'PUT', body: { isEnabled: true, ...(cleaned ? { apiKey: cleaned } : {}) } });
      setSecret('');
      await test();
    });
  const check = (): Promise<void> => run(async () => void (await test()));
  // Đăng nhập CLI xong (nút Đăng nhập): bật nguồn này rồi gọi thử một câu. Ổn định qua các lần vẽ để khối đăng nhập
  // chỉ báo một lần.
  const afterLogin = useRef(saveAndTest);
  afterLogin.current = saveAndTest;
  const onLoggedIn = useCallback(() => void afterLogin.current(), []);
  const disable = (): Promise<void> =>
    run(async () => {
      await api(`/api-center/providers/${provider.provider}/enabled`, { method: 'PATCH', body: { isEnabled: false } });
      setResult({ text: `Đã tắt ${label}. Vai trò đang dùng sẽ chạy bằng hãng kế tiếp.`, bad: false });
    });
  // Xoá hẳn key/token: hỏi lại một lần vì không hoàn tác được — muốn dùng lại phải dán mới.
  const remove = (): Promise<void> =>
    run(async () => {
      if (!window.confirm(`Xoá ${plan ? 'token' : 'key'} của ${label}? Công ty ngừng dùng hãng này ngay; muốn dùng lại phải dán mới.`)) return;
      await api(`/api-center/providers/${provider.provider}`, { method: 'DELETE' });
      setResult({ text: `Đã xoá ${plan ? 'token' : 'key'} ${label}.`, bad: false });
    });

  const w = provider.usage.window;
  const okRatio = w.calls ? w.ok / w.calls : 0;
  const position = !provider.usable ? `Ô ${slot + 1} · bị bỏ qua` : rank === 0 ? `Ô ${slot + 1} · hãng chính` : `Ô ${slot + 1} · dự phòng ${rank}`;
  const statusPill = provider.usable
    ? <Pill tone="good"><i className={s.dot} />Chạy được</Pill>
    : provider.status === 'ERROR'
      ? <Pill tone="bad"><i className={`${s.dot} ${s.dotBad}`} />Lỗi</Pill>
      : <Pill tone="off"><i className={`${s.dot} ${s.dotOff}`} />{plan ? (provider.isEnabled ? 'Chưa dùng được' : 'Chưa bật') : provider.hasKey ? 'Đang tắt' : 'Chưa có key'}</Pill>;
  const open = provider.breakers.filter((b) => b.state === 'open');

  return (
    <aside className={`${s.card} ${s.detail}`} aria-live="polite">
      <div className={s.detailHead}>
        <div className={`${s.swatch} ${provider.usable ? '' : s.swatchDead}`} style={{ background: meta.color }}>{meta.mark}</div>
        <div>
          <h2>{label}</h2>
          <div className={s.pills} style={{ marginTop: 5 }}>
            {statusPill}
            <Pill tone="brand">{plan ? 'CLI · gói thuê bao · $0 mỗi lượt' : 'API · dán khoá · trả theo token'}</Pill>
          </div>
        </div>
      </div>
      <p className={s.note}>{meta.note}</p>
      <dl className={s.facts}>
        <dt>Vị trí</dt>
        <dd>{position} · kiểm tra {provider.lastTestedAt ? stamp(provider.lastTestedAt) : 'chưa lần nào'}</dd>
        <dt>Model theo bậc</dt>
        <dd>
          {TIER_ORDER.map((tier, index) => (
            <span key={tier}>
              {index > 0 && ', '}
              {shortModel(provider.provider, provider.models[tier])} <span className={s.muted}>({TIER_WORD[tier]})</span>
            </span>
          ))}
        </dd>
      </dl>

      {/* Mức dùng: một hàng ô số (bảng khỏi phải cuộn). */}
      <div className={s.stats}>
        <div>
          <span>Thành công 30 ngày</span>
          <b>{w.calls ? pct(okRatio) : '—'}</b>
          <small>{w.calls ? `${int(w.ok)}/${int(w.calls)} lượt` : 'Chưa gọi lần nào'}</small>
          {w.calls > 0 && <Bar ratio={okRatio} tone={okTone(okRatio)} />}
        </div>
        <div>
          <span>Trả lời trung bình</span>
          <b>{seconds(w.avgLatencyMs)}</b>
        </div>
        {plan && (
          <div>
            <span>Lượt gọi 5 giờ · 7 ngày</span>
            <b>{int(provider.usage.hours5.calls)} · {int(provider.usage.week.calls)}</b>
          </div>
        )}
      </div>
      {plan && (
        <p className={s.fine}>
          Hạn mức 5 giờ / tuần của gói CLI chưa đọc được; chạm hạn mức thì công ty tự chuyển hãng kế tiếp 6 giờ và nhắn Telegram.
        </p>
      )}
      {open.map((b) => (
        <p key={b.key} className={`${s.note} ${s.toastBad}`}>
          Đang tạm né {b.key.split(':').slice(1).join(':')} tới {hhmm(b.reopensAt)} vì lỗi liên tiếp hoặc hết lượt.
        </p>
      ))}

      {/* Đăng nhập / dán token / dán key: gập lại khi nguồn đã chạy được, mở sẵn khi chưa — bảng khỏi dài vô ích. */}
      <details className={s.more2} open={!provider.usable || Boolean(secret) || undefined}>
        <summary>{plan ? 'Đăng nhập tài khoản gói · dán token' : provider.hasKey ? 'Đổi key API' : 'Dán key API'}</summary>
        <div>
          {plan && (
            <CliLogin
              provider={provider.provider as 'claude-code' | 'codex'}
              account={provider.provider === 'codex' ? 'ChatGPT' : 'Claude'}
              usingToken={provider.provider === 'claude-code' && provider.hasKey && provider.status !== 'ERROR'}
              onLoggedIn={onLoggedIn}
            />
          )}
          {plan ? (
            <div className={s.howto}>
              <p className={s.muted}>Cách khác: chạy lệnh trong terminal ngay trên máy chủ.</p>
              <div className={s.howtoRow}>
                <code>{meta.login}</code>
                <button
                  type="button"
                  className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`}
                  onClick={() => navigator.clipboard?.writeText(meta.login ?? '').then(() => setResult({ text: 'Đã chép lệnh.', bad: false }), () => setResult({ text: 'Không chép được, bôi đen lệnh để chép.', bad: true }))}
                >
                  Chép lệnh
                </button>
              </div>
              <p>{meta.loginNote}</p>
              {meta.tokenHint && (
                <>
                  {provider.hasKey && <p className="font-mono">Token hiện tại: {provider.keyPreview}</p>}
                  <input className={`${s.field} ${s.mono}`} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={provider.hasKey ? 'Dán token mới để thay' : meta.tokenHint} autoComplete="off" />
                </>
              )}
            </div>
          ) : (
            <div className={s.howto}>
              <p>
                {provider.hasKey ? <>Key hiện tại: <span className="font-mono">{provider.keyPreview}</span>. Dán key mới để thay.</> : 'Chưa có key. Dán key để có lưới an toàn khi các gói hết lượt.'}
              </p>
              <input className={`${s.field} ${s.mono}`} type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder={`Dán khoá ${meta.name}`} autoComplete="off" />
            </div>
          )}
        </div>
      </details>

      <div className={s.actions}>
        {!provider.isEnabled || secret ? (
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void saveAndTest()}>
            {plan ? (provider.isEnabled ? 'Lưu token và kiểm tra' : 'Bật và kiểm tra') : 'Lưu và kiểm tra'}
          </button>
        ) : (
          <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void check()}>Kiểm tra</button>
        )}
        {slot > 0 && (
          <button type="button" className={`${s.btn} ${s.btnQuiet}`} disabled={busy} onClick={() => onMoveTop(provider.provider)}>Đưa lên ô 1</button>
        )}
        {provider.isEnabled && (plan || provider.hasKey) && (
          <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void disable()}>Tắt</button>
        )}
        {provider.hasKey && (
          <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={busy} onClick={() => void remove()}>{plan ? 'Xoá token' : 'Xoá key'}</button>
        )}
      </div>
      {result && <p className={`${s.toast} ${result.bad ? s.toastBad : ''}`}>{result.text}</p>}
      {!result && provider.status === 'ERROR' && provider.lastError && <p className={`${s.toast} ${s.toastBad}`}>{provider.lastError}</p>}
    </aside>
  );
}
