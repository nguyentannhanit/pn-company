/**
 * P&N — Nút "Đăng nhập" cho CLI gói thuê bao trong bảng chi tiết nguồn AI.
 *
 * Máy chủ chạy lệnh đăng nhập và trả về đường link (và mã) — mở được trên điện thoại, không cần ngồi ở máy chủ.
 * Claude: đăng nhập xong trang Claude hiện một mã, dán vào ô ở đây. ChatGPT: nhập mã thiết bị trên trang OpenAI, xong
 * là tự nhận. Nút chỉ hiện khi CLI chưa đăng nhập: đăng nhập lại sẽ xoá phiên đang dùng.
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

import { api } from '@/lib/api';

import { styles as s } from './kit';

interface LoginSession {
  state: 'starting' | 'waiting' | 'done' | 'failed';
  url: string | null;
  userCode: string | null;
  needsCode: boolean;
  message: string | null;
}

const ACTIVE = new Set(['starting', 'waiting']);

export function CliLogin({
  provider,
  account,
  usingToken,
  onLoggedIn,
}: {
  provider: 'claude-code' | 'codex';
  /** Tên tài khoản gói: "Claude", "ChatGPT". */
  account: string;
  /** Claude CLI đang chạy bằng token đã dán (được ưu tiên hơn đăng nhập tài khoản). */
  usingToken: boolean;
  /** Đăng nhập xong: bảng cha bật nguồn này và gọi thử một câu. */
  onLoggedIn: () => void;
}): React.JSX.Element {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [session, setSession] = useState<LoginSession | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const result = await api<{ loggedIn: boolean; session: LoginSession | null }>(`/api-center/providers/${provider}/login`);
    setLoggedIn(result.loggedIn);
    setSession(result.session);
  }, [provider]);

  useEffect(() => {
    load().catch((caught: unknown) => setNote({ text: caught instanceof Error ? caught.message : 'Không hỏi được trạng thái đăng nhập', bad: true }));
  }, [load]);

  // Đang chờ CEO đăng nhập: hỏi lại mỗi 3 giây tới khi xong hoặc hỏng.
  const waiting = session !== null && ACTIVE.has(session.state);
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => void load().catch(() => undefined), 3000);
    return () => clearInterval(id);
  }, [waiting, load]);

  // Xong thì báo bảng cha một lần.
  const done = session?.state === 'done';
  useEffect(() => {
    if (done) onLoggedIn();
  }, [done, onLoggedIn]);

  const act = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (caught) {
      setNote({ text: caught instanceof Error ? caught.message : 'Không thực hiện được', bad: true });
    } finally {
      setBusy(false);
    }
  };
  const start = (): Promise<void> =>
    act(async () => setSession((await api<{ session: LoginSession }>(`/api-center/providers/${provider}/login`, { method: 'POST', body: {} })).session));
  const sendCode = (): Promise<void> =>
    act(async () => {
      setSession((await api<{ session: LoginSession }>(`/api-center/providers/${provider}/login/code`, { method: 'POST', body: { code: code.replace(/\s+/g, '') } })).session);
      setCode('');
    });
  const cancel = (): Promise<void> =>
    act(async () => {
      await api(`/api-center/providers/${provider}/login`, { method: 'DELETE' });
      setSession(null);
    });
  const copy = (text: string): void =>
    void navigator.clipboard?.writeText(text).then(
      () => setNote({ text: 'Đã chép mã.', bad: false }),
      () => setNote({ text: 'Không chép được, bôi đen mã để chép.', bad: true }),
    );

  if (loggedIn === null && !session) return <p className={s.note}>Đang hỏi máy chủ đã đăng nhập {account} chưa…</p>;

  return (
    <div className={s.howto}>
      {waiting && session ? (
        <>
          <p><b>Đăng nhập {account} cho máy chủ</b></p>
          {session.url ? (
            <p>
              1. Mở{' '}
              <a href={session.url} target="_blank" rel="noopener noreferrer" className="font-semibold underline">
                trang đăng nhập {account}
              </a>{' '}
              (trên máy tính hay điện thoại đều được) và đăng nhập tài khoản gói.
            </p>
          ) : (
            <p>Đang lấy đường link đăng nhập…</p>
          )}
          {provider === 'codex' && session.userCode && (
            <div className={s.howtoRow}>
              <span>2. Nhập mã:</span>
              <code>{session.userCode}</code>
              <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={() => copy(session.userCode!)}>Chép mã</button>
            </div>
          )}
          {provider === 'claude-code' && session.url && (
            <>
              <p>2. Đăng nhập xong, trang Claude hiện một mã. Dán mã đó vào đây:</p>
              <div className={s.howtoRow}>
                <input className={`${s.field} ${s.mono}`} value={code} onChange={(event) => setCode(event.target.value)} placeholder="Dán mã từ trang Claude" autoComplete="off" />
                <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} disabled={busy || code.trim().length < 8} onClick={() => void sendCode()}>Xác nhận</button>
              </div>
            </>
          )}
          {session.message && <p>{session.message}</p>}
          <p className={s.muted}>Mã và link dùng được 15 phút. {provider === 'codex' ? 'Nhập mã xong, trang này tự nhận.' : ''}</p>
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} disabled={busy} onClick={() => void cancel()}>Huỷ đăng nhập</button>
          </div>
        </>
      ) : loggedIn || done ? (
        <p>Máy chủ đã đăng nhập tài khoản {account}.{usingToken ? ' Công ty đang ưu tiên token đã dán bên dưới.' : ''}</p>
      ) : usingToken ? (
        <p>Công ty đang chạy bằng token đã dán bên dưới, chưa cần đăng nhập tài khoản {account}.</p>
      ) : (
        <>
          <p>Máy chủ chưa đăng nhập tài khoản {account}. Bấm Đăng nhập, máy chủ sẽ đưa link để anh đăng nhập — mở trên điện thoại cũng được.</p>
          {session?.state === 'failed' && session.message && <p className={s.toastBad}>{session.message}</p>}
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void start()}>
              {busy ? 'Đang mở…' : `Đăng nhập ${account}`}
            </button>
          </div>
        </>
      )}
      {note && <p className={`${s.toast} ${note.bad ? s.toastBad : ''}`}>{note.text}</p>}
    </div>
  );
}
