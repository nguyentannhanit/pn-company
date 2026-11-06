/**
 * P&N — Đăng nhập và bước đầu của Setup Wizard (§73, §150.2, §150.6).
 *
 * Cùng một màn hình phục vụ hai tình huống: hệ thống đã có tài khoản thì đăng
 * nhập; chưa có ai thì đây chính là bước "Welcome to P&N" của wizard, tạo tài
 * khoản CEO đầu tiên. Gộp lại vì người dùng không quan tâm mình đang ở bước nào
 * — họ chỉ muốn vào được hệ thống.
 *
 * Nay còn ba tình huống nữa cho người CEO mời vào: mở link mời (`?invite=`) thì đặt mật khẩu; đăng nhập bằng
 * mật khẩu tạm thì phải đặt mật khẩu riêng; nhận lời mời xong thì được mời nối bot Telegram của công ty.
 */

'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { enterCompany } from '@/components/CompanyEntrance';
import { LoginStage, type GreeterControl } from '@/components/LoginStage';
import { Wordmark } from '@/components/Logo';
import { MorphWordmark } from '@/components/MorphWordmark';
import { Button } from '@/components/ui';
import { api, apiUrl, rememberApiUrl, setToken } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { checkLoginInput, loginFailureKind, wrongPasswordLine, type LoginField } from '@/lib/login-check';

interface SetupStatus {
  welcome: string;
  completed: boolean;
  steps: Array<{ id: string; label: string; done: boolean }>;
}

export default function LoginPage(): React.JSX.Element {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Khang: ô đang bị nhắc, Caps Lock, hiện mật khẩu, số lần sai.
  const [invalid, setInvalid] = useState<LoginField | null>(null);
  const [capsOn, setCapsOn] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [skipGreeter, setSkipGreeter] = useState<boolean | null>(null);
  // Đăng nhập đúng, Khang đang dẫn vào văn phòng: logo mờ đi để không đứng lơ lửng trước cảnh máy quay đang tiến.
  const [entering, setEntering] = useState(false);
  // Người được mời: 'invite' đặt mật khẩu từ link mời, 'change' thay mật khẩu tạm, 'telegram' mời nối bot trước khi vào.
  const [mode, setMode] = useState<'login' | 'invite' | 'change' | 'telegram'>('login');
  const [invite, setInvite] = useState<{ token: string; displayName: string } | null>(null);
  const [telegramUrl, setTelegramUrl] = useState<string | null>(null);
  const tempPassword = useRef('');
  const greeter = useRef<GreeterControl | null>(null);
  const fails = useRef(0);
  const formRef = useRef<HTMLFormElement>(null);

  const fieldEl = (name: LoginField | 'server'): HTMLElement | null => fieldIn(formRef.current, name);

  useEffect(() => {
    api<SetupStatus>('/setup/status', { auth: false })
      .then(setStatus)
      .catch(() => {
        setError('Không kết nối được tới máy chủ P&N. Kiểm tra API đã chạy chưa.');
        const server = fieldIn(formRef.current, 'server');
        if (server) greeter.current?.remind(server, 'Em chưa gọi được máy chủ P&N. Anh xem lại địa chỉ máy chủ ở đây nhé.');
      });
  }, []);

  // Mở link mời: hỏi máy chủ link còn dùng được không và của ai, rồi chuyển khung sang "Đặt mật khẩu".
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invite');
    if (!token) return;
    api<{ displayName: string; email: string }>(`/auth/invite/${encodeURIComponent(token)}`, { auth: false })
      .then((info) => {
        setInvite({ token, displayName: info.displayName });
        setEmail(info.email);
        setMode('invite');
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Link mời không dùng được.'));
  }, []);

  // Vào bằng link Telegram (Mini App hoặc /dashboard) thì vào thẳng, không để Khang ra chào.
  useEffect(() => {
    setSkipGreeter(Boolean(telegramInitDataFromHash() || new URLSearchParams(window.location.search).get('code')));
  }, []);

  // Mở từ nút "Mở P&N" trong bot. Ưu tiên chuỗi do SDK chính thức của Telegram
  // đưa ra (mỗi nền tảng gói dữ liệu một kiểu); SDK chậm hoặc không tải được thì
  // sau 1,5 giây dùng luôn chuỗi trong phần sau dấu # — không để màn hình đứng im.
  useEffect(() => {
    const fromHash = telegramInitDataFromHash();
    if (!fromHash) return;
    setBusy(true);

    let done = false;
    const signIn = (initData: string): void => {
      if (done) return;
      done = true;
      api<{ token: string }>('/auth/telegram-webapp', { method: 'POST', body: { initData }, auth: false })
        .then((result) => {
          setToken(result.token);
          enterCompany(() => router.push('/overview'));
        })
        .catch((caught: unknown) => {
          setError(caught instanceof Error ? caught.message : 'Không đăng nhập được từ Telegram.');
          setBusy(false);
        });
    };

    const fallback = setTimeout(() => signIn(fromHash), 1500);
    const sdk = document.createElement('script');
    sdk.src = 'https://telegram.org/js/telegram-web-app.js';
    sdk.onload = () => {
      const app = (window as unknown as { Telegram?: { WebApp?: { ready: () => void; expand: () => void; initData?: string } } }).Telegram?.WebApp;
      app?.ready();
      app?.expand();
      clearTimeout(fallback);
      signIn(app?.initData && app.initData.includes('hash=') ? app.initData : fromHash);
    };
    sdk.onerror = () => {
      clearTimeout(fallback);
      signIn(fromHash);
    };
    document.head.append(sdk);
    return () => clearTimeout(fallback);
  }, [router]);

  // Link từ Telegram (/dashboard) mang mã một lần: đổi lấy phiên rồi vào thẳng.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) return;
    setBusy(true);
    api<{ token: string }>('/auth/exchange', { method: 'POST', body: { code }, auth: false })
      .then((result) => {
        setToken(result.token);
        window.history.replaceState(null, '', '/login');
        enterCompany(() => router.push('/overview'));
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'Link đăng nhập không dùng được.');
        setBusy(false);
      });
  }, [router]);

  const needsBootstrap = status ? !status.steps.find((step) => step.id === 'account')?.done : false;

  /** Đánh dấu một ô: viền đỏ, nháy hai nhịp, đặt con trỏ vào; trả về ô để Khang chỉ vào. */
  const flagField = (name: LoginField): HTMLElement | null => {
    setInvalid(name);
    const el = fieldEl(name);
    el?.focus({ preventScroll: true });
    el?.animate(
      [{ boxShadow: '0 0 0 0 transparent' }, { boxShadow: '0 0 0 6px rgb(245 158 11 / 35%)' }, { boxShadow: '0 0 0 0 transparent' }],
      { duration: 900, iterations: 2 },
    );
    return el;
  };

  /** Khang dẫn vào văn phòng rồi sang trang trong. */
  const goInside = (next: string): void => {
    const go = (): void => enterCompany(() => router.push(next));
    setEntering(true);
    if (greeter.current) greeter.current.leave(go);
    else go();
  };

  /** Đặt mật khẩu mới: nhận lời mời, hoặc thay mật khẩu tạm vừa đăng nhập. */
  const submitNewPassword = async (): Promise<void> => {
    if (password.length < 8) {
      setError('Mật khẩu cần tối thiểu 8 ký tự.');
      const el = flagField('password');
      if (el) greeter.current?.remind(el, 'Mật khẩu ngắn quá, cần ít nhất 8 ký tự nhé.');
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    try {
      if (mode === 'change') {
        await api('/auth/password', { method: 'POST', body: { currentPassword: tempPassword.current, password } });
        tempPassword.current = '';
        goInside('/overview');
        return;
      }
      const result = await api<{ token: string }>('/auth/invite/accept', { method: 'POST', body: { token: invite!.token, password }, auth: false });
      setToken(result.token);
      window.history.replaceState(null, '', '/login');
      // Mời nối bot ngay lúc này — người mới đang cầm điện thoại, bấm một cái là xong. Công ty chưa có bot thì vào luôn.
      const link = await api<{ url: string }>('/auth/telegram-link', { method: 'POST' }).catch(() => null);
      if (!link) {
        goInside('/overview');
        return;
      }
      setTelegramUrl(link.url);
      setMode('telegram');
      setBusy(false);
      greeter.current?.say('Xong rồi! Nối thêm bot Telegram để giao việc từ điện thoại nhé.', 'info', 4000);
    } catch (caught) {
      setBusy(false);
      const message = caught instanceof Error ? caught.message : 'Không đặt được mật khẩu.';
      setError(message);
      greeter.current?.say(message, 'bad', 3500);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    if (mode === 'invite' || mode === 'change') {
      await submitNewPassword();
      return;
    }
    // Kiểm tra ngay trên trang: thiếu hay sai dạng thì Khang chỉ vào ô đó, chưa cần gọi máy chủ.
    const problem = checkLoginInput({ email, password, displayName, bootstrap: needsBootstrap });
    if (problem) {
      setError(problem.message);
      const el = flagField(problem.field);
      if (el) greeter.current?.remind(el, problem.say);
      return;
    }
    setBusy(true);
    setError(null);
    setInvalid(null);
    greeter.current?.say('Để em kiểm tra…', 'info', 0);

    try {
      const path = needsBootstrap ? '/auth/bootstrap' : '/auth/login';
      const body = needsBootstrap ? { email, password, displayName } : { email, password };
      const result = await api<{ token: string; mustChangePassword?: boolean }>(path, { method: 'POST', body, auth: false });

      setToken(result.token);
      // Mật khẩu tạm CEO đưa qua tin nhắn: đặt mật khẩu riêng ngay tại đây rồi mới vào (API cũng chặn mọi việc khác).
      if (result.mustChangePassword) {
        tempPassword.current = password;
        setPassword('');
        setMode('change');
        setBusy(false);
        greeter.current?.say('Mật khẩu tạm chỉ dùng một lần — bạn đặt mật khẩu riêng nhé.', 'info', 4000);
        return;
      }
      // Nút giữ "Đang xử lý…" tới lúc chuyển trang: Khang đang xách cặp đi thì không bấm lại được.
      // Khang đi vào văn phòng, máy quay tiến theo; vào sâu thì màn hình chìm vào màu đêm, sang trang trong rồi hiện dần.
      goInside(needsBootstrap ? '/settings' : '/overview');
    } catch (caught) {
      setBusy(false);
      const kind = loginFailureKind(caught);
      if (kind === 'wrong') {
        fails.current += 1;
        setPassword('');
        flagField('password');
        setError(
          fails.current >= 3
            ? 'Sai 3 lần. Gõ /dashboard trong bot Telegram để nhận link vào thẳng.'
            : `Email hoặc mật khẩu không đúng (lần ${fails.current}/3).`,
        );
        greeter.current?.wrong(wrongPasswordLine(fails.current));
      } else if (kind === 'offline') {
        setError('Không gọi được máy chủ P&N. Kiểm tra API đã chạy chưa, hoặc đổi địa chỉ máy chủ bên dưới.');
        const server = fieldEl('server');
        if (server) greeter.current?.remind(server, 'Em chưa gọi được máy chủ. Anh xem lại địa chỉ máy chủ ở đây nhé.');
      } else {
        const message = caught instanceof Error ? caught.message : 'Không đăng nhập được';
        setError(message);
        greeter.current?.say(message, 'bad', 3500);
      }
    }
  };

  return (
    // Trang đăng nhập luôn tone đêm: `pn-force-dark` đổi toàn bộ màu của trang sang bản tối, bất kể
    // anh chọn sáng hay tối cho các trang bên trong — nên không còn nút sáng/tối ở đây.
    // Điện thoại: tên công ty nhỏ lại, lề gọn, để Khang + khung + nút lọt trọn trong màn hình có thanh Safari.
    // Mở kiểu ứng dụng trên iPhone thì không còn thanh Safari: tự chừa chỗ cho Dynamic Island/thanh trạng thái.
    <main className="pn-force-dark pn-login-glow relative flex min-h-[100dvh] flex-col items-center justify-center bg-surface-0 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)] pt-[calc(env(safe-area-inset-top)+16px)] md:py-10">
      {/* Cảnh 3D của Khang phủ kín trang ở lớp dưới cùng; logo phải nổi lên trên nó. */}
      {/* Chữ biến hình chỉ đúng cho tên "P&N" (đường nét tách sẵn); đổi tên công ty thì dùng logo thường. */}
      {BRAND.companyName === 'P&N' ? (
        <div className={`relative z-[1] mb-1 w-full max-w-[250px] transition-opacity delay-700 duration-1000 md:mb-2 md:max-w-md ${entering ? 'opacity-0' : ''}`}>
          <MorphWordmark />
        </div>
      ) : (
        <div className={`relative z-[1] mb-8 flex justify-center transition-opacity delay-700 duration-1000 ${entering ? 'opacity-0' : ''}`}>
          <Wordmark />
        </div>
      )}
      <LoginStage
        skip={skipGreeter}
        control={greeter}
        greeting={
          invite
            ? `Chào ${invite.displayName}! Đặt mật khẩu để vào công ty nhé.`
            : needsBootstrap
              ? 'Chào anh! Mình tạo tài khoản CEO đầu tiên nhé.'
              : 'Chào anh! Mời anh đăng nhập.'
        }
      >
      <div className="pn-login-glass w-full rounded-[18px] p-5 md:p-7">
        <h1 className="mb-1 text-center text-[22px] font-semibold text-ink-100">
          {mode === 'invite'
            ? `Chào ${invite?.displayName ?? ''}`
            : mode === 'change'
              ? 'Đặt mật khẩu riêng'
              : mode === 'telegram'
                ? 'Nối bot Telegram'
                : needsBootstrap
                  ? BRAND.welcomeHeadline
                  : 'Đăng nhập'}
        </h1>
        <p className="mb-5 text-center text-sm text-ink-500 md:mb-7">
          {mode === 'invite'
            ? 'Bạn được mời vào công ty. Đặt mật khẩu để vào lần đầu — link này chỉ dùng một lần.'
            : mode === 'change'
              ? 'Mật khẩu tạm chỉ để vào lần đầu. Đặt mật khẩu của riêng bạn để tiếp tục.'
              : mode === 'telegram'
                ? 'Mở bằng Telegram trên điện thoại rồi bấm Start. Bot giao việc, báo tiến độ theo đúng quyền của bạn.'
                : needsBootstrap
                  ? 'Chưa có tài khoản nào. Hãy tạo tài khoản CEO đầu tiên.'
                  : BRAND.taglineVi}
        </p>

        {mode === 'telegram' && telegramUrl ? (
          <div className="space-y-3">
            <a
              href={telegramUrl}
              target="_blank"
              rel="noreferrer"
              className="block w-full rounded-lg bg-[#229ED9] px-4 py-2.5 text-center text-[15px] font-semibold text-white hover:brightness-110"
            >
              Mở Telegram và nối bot
            </a>
            <p className="text-center text-[11px] text-ink-500">Link sống 30 phút. Để sau cũng được — nhờ CEO gửi link mới khi cần.</p>
            <Button type="button" disabled={entering} className="w-full" onClick={() => goInside('/overview')}>
              Vào phòng điều hành
            </Button>
          </div>
        ) : (
        /* noValidate: để Khang nhắc ô thiếu thay cho bong bóng mặc định của trình duyệt. */
        <form ref={formRef} noValidate onSubmit={(event) => void submit(event)} className="space-y-3">
          {needsBootstrap && mode === 'login' && (
            <Field
              label="Tên hiển thị"
              value={displayName}
              onChange={(value) => {
                setDisplayName(value);
                if (invalid === 'name') setInvalid(null);
              }}
              autoComplete="name"
              greet="name"
              invalid={invalid === 'name'}
              required
            />
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(value) => {
              // Đặt mật khẩu cho tài khoản đã có: email cố định, chỉ để người đó biết mình là ai.
              if (mode !== 'login') return;
              setEmail(value);
              if (invalid === 'email') setInvalid(null);
            }}
            autoComplete="username"
            greet="email"
            invalid={invalid === 'email'}
            required
          />
          <Field
            label={mode === 'login' ? 'Mật khẩu' : 'Mật khẩu mới'}
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(value) => {
              setPassword(value);
              if (invalid === 'password') setInvalid(null);
            }}
            onKeyUp={(event) => setCapsOn(event.getModifierState('CapsLock'))}
            autoComplete={needsBootstrap || mode !== 'login' ? 'new-password' : 'current-password'}
            hint={capsOn ? 'Caps Lock đang bật.' : needsBootstrap || mode !== 'login' ? 'Tối thiểu 8 ký tự' : undefined}
            greet="password"
            invalid={invalid === 'password'}
            trailing={
              <button
                type="button"
                data-greet="eye"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                className="absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-1 text-[11px] font-semibold text-ink-500 hover:text-ink-300"
              >
                {showPassword ? 'Ẩn' : 'Hiện'}
              </button>
            }
            required
          />

          {error && (
            <p role="alert" className="rounded-md bg-state-alert/10 px-3 py-2 text-xs text-state-alert">
              {error}
            </p>
          )}

          <Button type="submit" disabled={busy || !status} className="w-full">
            {busy ? 'Đang xử lý…' : mode !== 'login' ? 'Đặt mật khẩu và vào' : needsBootstrap ? 'Tạo tài khoản CEO' : 'Vào phòng điều hành'}
          </Button>
        </form>
        )}

        <ServerAddress />

        {/* §73 — cho CEO thấy còn thiếu bước nào ngay từ màn hình đầu tiên. Điện thoại ẩn: khung dài quá đẩy nút xuống khuất. */}
        {/* Người được mời không cần (và không nên) thấy máy công ty còn thiếu bước cài đặt nào. */}
        {status && !status.completed && mode === 'login' && !invite && (
          <div className="mt-7 hidden rounded-lg border border-base-700 bg-base-800 p-3 md:block">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-500">
              Thiết lập hệ thống
            </p>
            <ul className="space-y-1">
              {status.steps.map((step) => (
                <li key={step.id} className="flex items-center gap-2 text-xs text-ink-300">
                  <span>{step.done ? '✅' : '⬜'}</span>
                  {step.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      </LoginStage>
    </main>
  );
}

/** Ô trong khung đăng nhập theo tên `data-greet` (kể cả dòng "Máy chủ" nằm ngoài thẻ form). */
function fieldIn(form: HTMLFormElement | null, name: LoginField | 'server'): HTMLElement | null {
  return form?.parentElement?.querySelector<HTMLElement>(`[data-greet="${name}"]`) ?? null;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  hint,
  greet,
  invalid = false,
  trailing,
  ...rest
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: string;
  /** Tên ô để Khang biết người dùng đang ở đâu (`data-greet`). */
  greet?: LoginField;
  invalid?: boolean;
  /** Nút nhỏ nằm trong ô, bên phải (Hiện/Ẩn mật khẩu). */
  trailing?: React.ReactNode;
  onKeyUp?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  required?: boolean;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs text-ink-300">{label}</span>
      <span className="relative block">
        <input
          {...rest}
          type={type}
          value={value}
          data-greet={greet}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.target.value)}
          className={`w-full rounded-lg border bg-base-800 px-3.5 py-2.5 text-[15px] text-ink-100 outline-none transition-colors focus:border-produce-600 ${invalid ? 'border-state-alert' : 'border-base-600'} ${trailing ? 'pr-14' : ''}`}
        />
        {trailing}
      </span>
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}

/**
 * Địa chỉ máy chủ API — cần khi dashboard chạy trên Vercel còn API ở máy công
 * ty qua đường hầm, địa chỉ có thể đổi. Bình thường ẩn, chỉ mở khi cần sửa.
 */
function ServerAddress(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [current, setCurrent] = useState('');

  useEffect(() => {
    setCurrent(apiUrl());
  }, []);

  const save = (): void => {
    if (rememberApiUrl(value)) window.location.reload();
    else setOpen(false);
  };

  return (
    <div data-greet="server" className="mt-5 text-center text-[11px] text-ink-500">
      {open ? (
        <div className="flex gap-2">
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={current}
            className="pn-focus min-w-0 flex-1 rounded-lg border border-line bg-surface-0 px-2.5 py-2 font-mono text-[11px] text-ink-100 outline-none"
          />
          <Button size="sm" onClick={save}>Lưu</Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Huỷ</Button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)} className="hover:text-ink-300">
          Máy chủ: <span className="font-mono">{current || '…'}</span> · đổi
        </button>
      )}
    </div>
  );
}

/**
 * Chuỗi Telegram đính sau dấu # khi mở Mini App. Một số nền tảng mã hoá hai lớp,
 * nên nếu bóc một lớp mà chưa thấy `hash=` thì bóc thêm một lớp nữa.
 */
function telegramInitDataFromHash(): string | null {
  const raw = new URLSearchParams(window.location.hash.slice(1)).get('tgWebAppData');
  if (!raw) return null;
  if (raw.includes('hash=')) return raw;
  try {
    const once = decodeURIComponent(raw);
    return once.includes('hash=') ? once : raw;
  } catch {
    return raw;
  }
}
