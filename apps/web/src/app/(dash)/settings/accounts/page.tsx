/**
 * P&N — Cài đặt → Tài khoản & phân quyền (đưa vào chạy thật cùng ngày).
 *
 * Quyền nói bằng "khu" của công ty (dự án, duyệt, nhân sự AI, khoá bí mật, tiền…) với bốn nấc Không / Xem / Làm /
 * Toàn quyền, thay cho danh sách quyền kỹ thuật — người đọc là CEO, không phải lập trình viên. Mỗi tài khoản hiện
 * như một thẻ ra vào văn phòng; dải 9 ô trên thẻ cho biết chạm được tới đâu. Nấc hợp lệ và mức mặc định của từng
 * vai trò lấy từ API (`/users/roles`) để trang này không lệch với luật thật ở máy chủ.
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Kpi, Pill, ddmm, styles as s } from '@/components/settings/kit';
import a from '@/components/settings/accounts.module.css';
import { useSettingsAction } from '@/components/settings/SettingsFrame';
import { api } from '@/lib/api';
import { allowed, useMe } from '@/lib/me';

/* -------------------------------------------------------------------------- */
/* Khu quyền và vai trò                                                        */
/* -------------------------------------------------------------------------- */

type Level = 0 | 1 | 2 | 3;
type AreaId = 'projects' | 'approvals' | 'agents' | 'code' | 'deploy' | 'ai' | 'budget' | 'accounts' | 'audit';
type RoleId = 'CEO' | 'CTO' | 'PROJECT_MANAGER' | 'ACCOUNTANT' | 'VIEWER';
const LEVEL_WORD = ['Không', 'Xem', 'Làm', 'Toàn quyền'] as const;

/** Chữ hiển thị của từng khu; nấc nào dùng được thì do API nói. */
const AREA_TEXT: Record<AreaId, { name: string; note: string; sensitive?: boolean; can: [string, string, string, string]; cannot: string }> = {
  projects: { name: 'Dự án & công việc', note: 'Xem dự án, giao việc mới, chạy lại việc kẹt.',
    can: ['', 'Xem mọi dự án và tiến độ', 'Giao việc mới, chạy lại việc kẹt, báo lỗi', 'Tạo, lưu trữ và xoá dự án'], cannot: 'Không thấy dự án nào' },
  approvals: { name: 'Duyệt kế hoạch', note: 'Kế hoạch của CTO, bản thiết kế, triển khai chính thức.',
    can: ['', 'Xem các yêu cầu đang chờ duyệt', '', 'Duyệt hoặc từ chối kế hoạch, thiết kế, triển khai'], cannot: 'Không duyệt được kế hoạch' },
  agents: { name: 'Nhân sự AI', note: 'Ai đang làm gì, tạm dừng hay chạy lại nhân viên.',
    can: ['', 'Xem nhân viên AI đang làm gì', 'Tạm dừng, chạy lại, bật tắt nhân viên AI', 'Tìm và đánh giá kỹ năng mới cho nhân viên AI'], cannot: 'Không xem chi tiết nhân viên AI' },
  code: { name: 'Mã nguồn & GitHub', note: 'Mã các dự án, gộp mã trên GitHub.',
    can: ['', 'Xem mã nguồn các dự án', '', 'Gộp mã vào nhánh chính'], cannot: 'Không xem được mã nguồn' },
  deploy: { name: 'Triển khai', note: 'Bản thử (staging) và bản chính thức ra ngoài.', sensitive: true,
    can: ['', 'Xem lịch sử triển khai', 'Dựng bản thử (staging)', 'Phát hành bản chính thức ra ngoài'], cannot: 'Không triển khai được' },
  ai: { name: 'Kết nối AI & khoá bí mật', note: 'Nguồn AI, khoá API, đăng nhập CLI gói thuê bao.', sensitive: true,
    can: ['', 'Xem nguồn AI và cách chia việc', 'Đổi thứ tự hãng, bật tắt nguồn AI, chia việc', 'Dán, xoá khoá API, token và đăng nhập CLI'], cannot: 'Không thấy cài đặt AI' },
  budget: { name: 'Ngân sách & chi phí', note: 'Chi phí AI, hạn mức tháng, phí gói thuê bao.', sensitive: true,
    can: ['', 'Xem chi phí và hạn mức', 'Đặt hạn mức, nhập phí gói', 'Xoá số liệu chi phí đã ghi, đếm lại từ đầu'], cannot: 'Không thấy chi phí' },
  accounts: { name: 'Tài khoản & phân quyền', note: 'Tạo, khoá, xoá tài khoản; đổi quyền. Toàn quyền chỉ dành cho CEO.', sensitive: true,
    can: ['', 'Xem danh sách tài khoản', '', 'Tạo, khoá, xoá tài khoản và đổi quyền'], cannot: 'Không thấy danh sách tài khoản' },
  audit: { name: 'Nhật ký kiểm toán', note: 'Ai đã làm gì, lúc nào. Chỉ đọc — không ai sửa hay xoá được.',
    can: ['', 'Xem nhật ký thao tác', '', ''], cannot: 'Không xem nhật ký' },
};

const ROLE_META: Record<RoleId, { name: string; short: string; color: string; desc: string }> = {
  CEO: { name: 'Chủ công ty (CEO)', short: 'CEO', color: '#d97706', desc: 'Toàn quyền, kể cả tài khoản và ngân sách. Công ty luôn phải còn ít nhất một CEO.' },
  CTO: { name: 'Giám đốc kỹ thuật', short: 'CTO', color: '#2563eb', desc: 'Điều hành kỹ thuật: dự án, duyệt, nhân sự AI, triển khai, kết nối AI. Chỉ xem ngân sách và tài khoản.' },
  PROJECT_MANAGER: { name: 'Quản lý dự án', short: 'Quản lý', color: '#0d9488', desc: 'Tạo dự án, giao việc, duyệt kế hoạch. Không chạm khoá bí mật; chỉ xem chi phí.' },
  ACCOUNTANT: { name: 'Kế toán', short: 'Kế toán', color: '#16a34a', desc: 'Theo dõi chi phí, đặt hạn mức ngân sách. Chỉ xem dự án và nhật ký.' },
  VIEWER: { name: 'Người xem', short: 'Người xem', color: '#64748b', desc: 'Chỉ xem dự án, nhân viên AI và mã nguồn. Không thay đổi được gì.' },
};
const ROLE_ORDER: RoleId[] = ['CEO', 'CTO', 'PROJECT_MANAGER', 'ACCOUNTANT', 'VIEWER'];
const roleMeta = (id: string) => ROLE_META[id as RoleId] ?? ROLE_META.VIEWER;

/** Luật từ máy chủ: thứ tự khu, nấc dùng được, mức mặc định của năm vai trò. */
interface Rules {
  areas: AreaId[];
  levels: Record<AreaId, Level[]>;
  roles: Record<RoleId, Record<AreaId, Level>>;
}

interface Account {
  id: string;
  email: string;
  displayName: string;
  role: RoleId;
  status: 'active' | 'invited' | 'locked';
  access: Record<AreaId, Level>;
  customized: boolean;
  telegramLinked: boolean;
  mustChangePassword: boolean;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/** Thứ cần đưa tận tay người mới, hiện đúng một lần. */
interface Handoff {
  title: string;
  value: string;
  note: string;
}

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/);
  return ((words.at(-2)?.[0] ?? '') + (words.at(-1)?.[0] ?? '')).toUpperCase();
};
const roleStyle = (color: string): React.CSSProperties => ({ '--role': color } as React.CSSProperties);
const errorText = (caught: unknown): string => (caught instanceof Error ? caught.message : 'Không làm được, thử lại.');

/** "3 giờ trước", "2 ngày trước"… — đủ để biết ai còn dùng, không cần giờ phút chính xác. */
function ago(iso: string | null): string {
  if (!iso) return 'Chưa đăng nhập';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 2) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  if (minutes < 7 * 24 * 60) return `${Math.round(minutes / (24 * 60))} ngày trước`;
  return ddmm(iso);
}
const hoursLeft = (iso: string): number => Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 3_600_000));

function statusNote(account: Account): string | null {
  if (account.status === 'invited' && account.inviteExpiresAt) {
    const left = hoursLeft(account.inviteExpiresAt);
    return left > 0 ? `Lời mời còn ${left} giờ` : 'Lời mời đã hết hạn — tạo link mới';
  }
  if (account.mustChangePassword) return 'Chưa đổi mật khẩu tạm';
  return null;
}

const STATUS: Record<Account['status'], { tone: 'good' | 'warn' | 'off'; text: string }> = {
  active: { tone: 'good', text: 'Đang dùng' },
  invited: { tone: 'warn', text: 'Chờ nhận lời mời' },
  locked: { tone: 'off', text: 'Đã khoá' },
};

/* -------------------------------------------------------------------------- */
/* Mảnh nhỏ                                                                    */
/* -------------------------------------------------------------------------- */

/** Dải 9 ô "khu được vào", đậm dần theo nấc quyền. */
function Zones({ rules, access }: { rules: Rules; access: Record<AreaId, Level> }): React.JSX.Element {
  return (
    <div className={a.zones} aria-label="Khu được vào">
      {rules.areas.map((area) => (
        <i key={area} className={a.zone} data-lv={access[area]} title={`${AREA_TEXT[area].name}: ${LEVEL_WORD[access[area]]}`} />
      ))}
    </div>
  );
}

/** Ba vạch mức quyền + chữ. */
function LevelMark({ level, color }: { level: Level; color: string }): React.JSX.Element {
  return (
    <span className={a.cell} style={roleStyle(color)}>
      <span className={a.lv} data-lv={level} aria-hidden="true"><i /><i /><i /></span>
      <span className={`${a.lvWord} ${level === 0 ? a.lvNone : ''}`}>{level === 0 ? '—' : LEVEL_WORD[level]}</span>
    </span>
  );
}

/** Ô chữ chỉ đọc + nút chép (link mời, mật khẩu tạm, link nối bot). */
function HandoffBox({ handoff }: { handoff: Handoff }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const input = event.currentTarget.previousElementSibling as HTMLInputElement | null;
    navigator.clipboard.writeText(handoff.value).then(
      () => setCopied(true),
      // Trình duyệt không cho chép thì bôi đen sẵn để anh tự Ctrl+C.
      () => input?.select(),
    );
  };
  return (
    <div className={a.handoff}>
      <b>{handoff.title}</b>
      <div className={a.copyRow}>
        <input className={`${s.field} ${s.mono}`} readOnly value={handoff.value} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className={`${s.btn} ${s.btnPrimary} ${s.btnSmall}`} onClick={copy}>{copied ? 'Đã chép' : 'Chép'}</button>
      </div>
      <span className={s.note}>{handoff.note}</span>
    </div>
  );
}

/** Chọn vai trò + chỉnh riêng từng khu (dùng chung cho tạo mới và sửa). */
function PermEditor({ rules, roleId, access, onRole, onLevel }: {
  rules: Rules;
  roleId: RoleId;
  access: Record<AreaId, Level>;
  onRole: (id: RoleId) => void;
  onLevel: (area: AreaId, level: Level) => void;
}): React.JSX.Element {
  const base = rules.roles[roleId];
  const editedCount = rules.areas.filter((area) => access[area] !== base[area]).length;
  return (
    <>
      <div className={a.roles} role="radiogroup" aria-label="Vai trò">
        <span className={a.stepK}>Vai trò</span>
        {ROLE_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === roleId}
            className={`${a.roleOpt} ${id === roleId ? a.roleOptOn : ''}`}
            style={roleStyle(ROLE_META[id].color)}
            onClick={() => onRole(id)}
          >
            <i className={a.dot} />
            <b>{ROLE_META[id].name}</b>
            <Zones rules={rules} access={rules.roles[id]} />
            <span>{ROLE_META[id].desc}</span>
          </button>
        ))}
      </div>

      {/* Gập sẵn: phần lớn chỉ cần chọn vai trò; mở ra khi muốn chỉnh riêng một vài khu. CEO luôn toàn quyền. */}
      {roleId !== 'CEO' && (
        <details className={a.fold} open={editedCount > 0 || undefined}>
          <summary>
            <span className={a.stepK}>Quyền chi tiết</span>
            <span className={a.foldSum}>
              {editedCount > 0 ? <span className={a.edited}>đã chỉnh {editedCount} khu so với vai trò</span> : `Theo vai trò ${ROLE_META[roleId].name} · bấm để chỉnh riêng từng khu`}
            </span>
          </summary>
          <div className={a.perms}>
            {rules.areas.map((area) => {
              const text = AREA_TEXT[area];
              return (
                <div key={area} className={a.perm}>
                  <span className={a.permName}>
                    {text.name}
                    {text.sensitive && <span className={a.sens}>nhạy cảm</span>}
                    {access[area] !== base[area] && <span className={a.edited}>đã chỉnh</span>}
                  </span>
                  <span className={a.seg} role="group" aria-label={text.name}>
                    {([0, 1, 2, 3] as Level[]).map((level) => {
                      // Toàn quyền về tài khoản chỉ dành cho CEO: người khác có thể tạo tài khoản mạnh hơn chính mình.
                      const blocked = !rules.levels[area].includes(level) || (area === 'accounts' && level === 3);
                      return (
                        <button key={level} type="button" aria-pressed={access[area] === level} disabled={blocked} onClick={() => onLevel(area, level)}>
                          {LEVEL_WORD[level]}
                        </button>
                      );
                    })}
                  </span>
                  <span className={a.permNote}>{access[area] > 0 ? text.can[access[area]] : text.note}</span>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </>
  );
}

/** "Người này sẽ làm được / không làm được" + cảnh báo quyền nhạy cảm. */
function Preview({ rules, roleId, access }: { rules: Rules; roleId: RoleId; access: Record<AreaId, Level> }): React.JSX.Element {
  const can = rules.areas.filter((area) => access[area] > 0).map((area) => AREA_TEXT[area].can[access[area]]).filter(Boolean);
  const cannot = rules.areas.filter((area) => access[area] === 0).map((area) => AREA_TEXT[area].cannot);
  const touchy = rules.areas.filter((area) => AREA_TEXT[area].sensitive && access[area] >= 2).map((area) => AREA_TEXT[area].name.toLowerCase());
  return (
    <>
      <div className={a.preview}>
        <h3>{roleId === 'CEO' ? 'Người này sẽ có toàn quyền như anh' : 'Người này sẽ làm được'}</h3>
        <ul className={a.can}>{can.map((line) => <li key={line}>{line}</li>)}</ul>
        {cannot.length > 0 && <ul className={a.cant}>{cannot.map((line) => <li key={line}>{line}</li>)}</ul>}
      </div>
      {touchy.length > 0 && roleId !== 'CEO' && (
        <div className={s.alert}>
          <span aria-hidden="true">⚠</span>
          <span><b>Quyền nhạy cảm:</b> người này thay đổi được {touchy.join(', ')}. Chỉ cấp cho người anh tin như chính mình.</span>
        </div>
      )}
    </>
  );
}

/** Mức gửi lên API: chỉ gửi khi khác vai trò (API cũng tự bỏ phần trùng). */
function accessBody(rules: Rules, roleId: RoleId, access: Record<AreaId, Level>): Partial<Record<AreaId, Level>> | null {
  const diff = Object.fromEntries(rules.areas.filter((area) => access[area] !== rules.roles[roleId][area]).map((area) => [area, access[area]]));
  return Object.keys(diff).length > 0 ? diff : null;
}

/* -------------------------------------------------------------------------- */
/* Bảng tạo tài khoản                                                          */
/* -------------------------------------------------------------------------- */

function CreatePanel({ rules, onClose, onCreated }: { rules: Rules; onClose: () => void; onCreated: (account: Account) => void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState<RoleId>('PROJECT_MANAGER');
  const [access, setAccess] = useState(rules.roles.PROJECT_MANAGER);
  const [way, setWay] = useState<'link' | 'password'>('link');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ account: Account; handoff: Handoff } | null>(null);
  const meta = ROLE_META[roleId];

  const pickRole = (id: RoleId): void => {
    setRoleId(id);
    setAccess(rules.roles[id]);
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ user: Account; inviteUrl?: string; tempPassword?: string }>('/users', {
        method: 'POST',
        body: { email, displayName: name, role: roleId, access: accessBody(rules, roleId, access), way },
      });
      onCreated(result.user);
      setDone({
        account: result.user,
        handoff: result.inviteUrl
          ? { title: 'Link mời', value: result.inviteUrl, note: 'Gửi link này cho người đó (Zalo, Telegram…). Dùng một lần, hết hạn sau 48 giờ. Đặt mật khẩu xong, họ được mời nối bot Telegram của công ty.' }
          : { title: 'Mật khẩu tạm', value: result.tempPassword ?? '', note: `Chỉ hiện lần này. Người đó đăng nhập bằng ${email} và mật khẩu trên, rồi phải đặt mật khẩu riêng trước khi làm gì khác.` },
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <aside className={`${s.card} ${a.panel}`} style={roleStyle(roleMeta(done.account.role).color)} aria-label="Đã tạo tài khoản">
        <div className={a.panelHead}>
          <div>
            <h2>Đã tạo tài khoản cho {done.account.displayName}</h2>
            <div className={s.sub}>{roleMeta(done.account.role).name} · {done.account.email}</div>
          </div>
          <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={onClose}>Đóng</button>
        </div>
        <HandoffBox handoff={done.handoff} />
        <div className={s.actions}>
          <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={() => { setDone(null); setName(''); setEmail(''); }}>Thêm người khác</button>
        </div>
      </aside>
    );
  }

  return (
    <form className={`${s.card} ${a.panel}`} style={roleStyle(meta.color)} aria-label="Tạo tài khoản" onSubmit={(event) => void submit(event)}>
      <div className={a.panelHead}>
        <div>
          <h2>Tạo tài khoản</h2>
          <div className={s.sub}>Người mới vào công ty bằng email và mật khẩu riêng của họ.</div>
        </div>
        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={onClose}>Đóng</button>
      </div>

      <div className={a.pair}>
        <label className={a.label}>Họ tên<input className={s.field} value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
        <label className={a.label}>Email đăng nhập<input className={`${s.field} ${s.mono}`} type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
      </div>

      <PermEditor rules={rules} roleId={roleId} access={access} onRole={pickRole} onLevel={(area, level) => setAccess((current) => ({ ...current, [area]: level }))} />

      <div className={a.ways}>
        <span className={a.stepK}>Cách vào lần đầu</span>
        <label className={a.way}>
          <input type="radio" name="way" checked={way === 'link'} onChange={() => setWay('link')} />
          Tạo link mời để tôi tự gửi (Zalo, Telegram…)
          <small>Người nhận mở link, tự đặt mật khẩu. Link dùng một lần, hết hạn sau 48 giờ.</small>
        </label>
        <label className={a.way}>
          <input type="radio" name="way" checked={way === 'password'} onChange={() => setWay('password')} />
          Đặt mật khẩu tạm
          <small>Hiện mật khẩu một lần duy nhất; bắt đổi ở lần đăng nhập đầu.</small>
        </label>
        <label className={a.way}>
          <input type="radio" name="way" disabled />
          Gửi link mời qua email
          <small>Chưa dùng được: công ty chưa có máy gửi email (SMTP).</small>
        </label>
        <span className={s.note}>Người có tài khoản đều dùng được bot Telegram của công ty — bot làm đúng theo quyền ở trên, không hơn.</span>
      </div>

      <Preview rules={rules} roleId={roleId} access={access} />

      {error && <p className={`${s.toast} ${s.toastBad}`} role="alert">{error}</p>}
      <div className={s.actions}>
        <button type="submit" className={`${s.btn} ${s.btnPrimary}`} disabled={busy}>
          {busy ? 'Đang tạo…' : way === 'password' ? 'Tạo tài khoản' : 'Tạo tài khoản và lấy link mời'}
        </button>
        <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={onClose}>Huỷ</button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Bảng chi tiết một tài khoản                                                 */
/* -------------------------------------------------------------------------- */

function DetailPanel({ rules, account, canManage, isSelf, lastCeo, onClose, onChanged, onRemoved }: {
  rules: Rules;
  account: Account;
  canManage: boolean;
  isSelf: boolean;
  lastCeo: boolean;
  onClose: () => void;
  onChanged: (account: Account) => void;
  onRemoved: (id: string) => void;
}): React.JSX.Element {
  const meta = roleMeta(account.role);
  const status = STATUS[account.status];
  const [editing, setEditing] = useState(false);
  const [roleId, setRoleId] = useState<RoleId>(account.role);
  const [access, setAccess] = useState(account.access);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [message, setMessage] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Đổi sang người khác thì bỏ hết trạng thái của người trước.
  useEffect(() => {
    setEditing(false);
    setHandoff(null);
    setMessage(null);
    setConfirmDelete(false);
  }, [account.id]);
  // Quyền vừa lưu (hay đổi từ nơi khác) thì bộ chỉnh bắt đầu từ mức mới — nhưng giữ câu báo "Đã lưu".
  useEffect(() => {
    setRoleId(account.role);
    setAccess(account.access);
  }, [account.role, account.access]);

  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);

  /** Chạy một thao tác; lỗi của API (ví dụ "CEO cuối cùng") hiện nguyên câu. */
  const run = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const done = await work();
      if (done) setMessage({ bad: false, text: done });
    } catch (caught) {
      setMessage({ bad: true, text: errorText(caught) });
    } finally {
      setBusy(false);
    }
  };

  const post = (path: string): Promise<{ user: Account }> => api<{ user: Account }>(`/users/${account.id}${path}`, { method: 'POST' });

  const save = (): Promise<void> =>
    run(async () => {
      const { user } = await api<{ user: Account }>(`/users/${account.id}`, {
        method: 'PATCH',
        body: { role: roleId, access: accessBody(rules, roleId, access) },
      });
      onChanged(user);
      setEditing(false);
      return 'Đã lưu. Quyền mới có hiệu lực ngay, người đó không cần đăng nhập lại.';
    });

  const inviteLink = (): Promise<void> =>
    run(async () => {
      const { inviteUrl } = await api<{ inviteUrl: string }>(`/users/${account.id}/invite`, { method: 'POST' });
      setHandoff(
        account.status === 'invited'
          ? { title: 'Link mời mới', value: inviteUrl, note: 'Link cũ vẫn dùng được tới khi link này được dùng. Hết hạn sau 48 giờ.' }
          : { title: 'Link đặt lại mật khẩu', value: inviteUrl, note: 'Mật khẩu cũ vẫn dùng được cho tới khi người đó đặt mật khẩu mới. Hết hạn sau 48 giờ.' },
      );
      return null;
    });

  const telegramLink = (): Promise<void> =>
    run(async () => {
      const { url } = await api<{ url: string }>(`/users/${account.id}/telegram-link`, { method: 'POST' });
      setHandoff({ title: 'Link nối bot Telegram', value: url, note: 'Người đó mở link bằng Telegram của họ rồi bấm Start. Link sống 30 phút, dùng một lần.' });
      return null;
    });

  const remove = (): Promise<void> =>
    run(async () => {
      await api(`/users/${account.id}`, { method: 'DELETE' });
      onRemoved(account.id);
      return null;
    });

  const note = statusNote(account);

  return (
    <aside className={`${s.card} ${a.panel}`} style={roleStyle(meta.color)} aria-label={`Tài khoản ${account.displayName}`}>
      <div className={a.panelHead}>
        <div className={a.who}>
          <span className={`${a.avatar} ${a.avatarBig}`}>{initials(account.displayName)}</span>
          <div style={{ minWidth: 0 }}>
            <h2>{account.displayName}</h2>
            <div className={a.mail}>{account.email}</div>
          </div>
        </div>
        <button type="button" className={`${s.btn} ${s.btnGhost} ${s.btnSmall}`} onClick={onClose}>Đóng</button>
      </div>
      <div className={s.pills}>
        <span className={a.roleTag}>{meta.name}</span>
        <Pill tone={status.tone}>{status.text}</Pill>
        {account.customized && <span className={a.edited}>quyền chỉnh riêng</span>}
        {note && <span className={a.meta}>{note}</span>}
      </div>
      <dl className={s.facts}>
        <dt>Tạo lúc</dt><dd>{ddmm(account.createdAt)}/{new Date(account.createdAt).getFullYear()}</dd>
        <dt>Đăng nhập gần nhất</dt><dd>{ago(account.lastLoginAt)}</dd>
        <dt>Bot Telegram</dt><dd>{account.telegramLinked ? 'Đã nối' : 'Chưa nối'}</dd>
      </dl>

      {editing ? (
        <>
          <PermEditor
            rules={rules}
            roleId={roleId}
            access={access}
            onRole={(id) => { setRoleId(id); setAccess(rules.roles[id]); }}
            onLevel={(area, level) => setAccess((current) => ({ ...current, [area]: level }))}
          />
          <Preview rules={rules} roleId={roleId} access={access} />
          <div className={s.actions}>
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void save()}>{busy ? 'Đang lưu…' : 'Lưu quyền'}</button>
            <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={() => { setEditing(false); setRoleId(account.role); setAccess(account.access); }}>Huỷ</button>
          </div>
        </>
      ) : (
        <div className={a.perms}>
          {rules.areas.map((area) => (
            <div key={area} className={a.perm}>
              <span className={a.permName}>
                {AREA_TEXT[area].name}
                {AREA_TEXT[area].sensitive && <span className={a.sens}>nhạy cảm</span>}
                {account.access[area] !== rules.roles[account.role]?.[area] && <span className={a.edited}>đã chỉnh</span>}
              </span>
              <LevelMark level={account.access[area]} color={meta.color} />
            </div>
          ))}
        </div>
      )}

      {handoff && <HandoffBox handoff={handoff} />}
      {message && <p className={`${s.toast} ${message.bad ? s.toastBad : ''}`} role={message.bad ? 'alert' : 'status'}>{message.text}</p>}

      {lastCeo && <p className={s.note}>{isSelf ? 'Đây là tài khoản của anh và là CEO duy nhất' : 'Đây là CEO duy nhất'} — không khoá, không hạ quyền, không xoá được cho tới khi có thêm một CEO khác.</p>}

      {canManage && !editing && (
        <div className={s.actions}>
          {account.status === 'invited' && <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void inviteLink()}>Lấy link mời mới</button>}
          {account.status === 'locked' && (
            <button type="button" className={`${s.btn} ${s.btnPrimary}`} disabled={busy} onClick={() => void run(async () => { onChanged((await post('/unlock')).user); return 'Đã mở khoá. Người đó đăng nhập lại là dùng được.'; })}>Mở khoá</button>
          )}
          {account.status !== 'locked' && !lastCeo && <button type="button" className={`${s.btn} ${s.btnGhost}`} onClick={() => setEditing(true)}>Đổi vai trò / quyền</button>}
          {account.status === 'active' && <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void inviteLink()}>Link đặt lại mật khẩu</button>}
          {account.status !== 'locked' && (account.telegramLinked ? (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void run(async () => { onChanged((await api<{ user: Account }>(`/users/${account.id}/telegram`, { method: 'DELETE' })).user); return 'Đã gỡ Telegram. Bot không nhận lệnh từ chat đó nữa (chậm nhất 2 phút).'; })}>Gỡ Telegram</button>
          ) : (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void telegramLink()}>Link nối Telegram</button>
          ))}
          {account.status === 'active' && (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void run(async () => { await post('/logout-all'); return isSelf ? 'Đã đăng xuất mọi thiết bị — kể cả máy này.' : 'Đã đăng xuất mọi thiết bị của người này.'; })}>Đăng xuất mọi thiết bị</button>
          )}
          {account.status !== 'locked' && !isSelf && !lastCeo && (
            <button type="button" className={`${s.btn} ${s.btnGhost}`} disabled={busy} onClick={() => void run(async () => { onChanged((await post('/lock')).user); return 'Đã khoá. Mọi phiên đang mở của người này bị ngắt ngay.'; })}>Khoá tài khoản</button>
          )}
          {!isSelf && !lastCeo && (
            <button type="button" className={`${s.btn} ${s.btnDanger}`} disabled={busy} onClick={() => (confirmDelete ? void remove() : setConfirmDelete(true))}>
              {confirmDelete ? 'Bấm lần nữa để xoá hẳn' : account.status === 'invited' ? 'Huỷ lời mời' : 'Xoá tài khoản'}
            </button>
          )}
        </div>
      )}
      {confirmDelete && <p className={s.note}>Dự án người này tạo sẽ chuyển sang anh. Nhật ký thao tác của họ vẫn giữ nguyên.</p>}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Trang                                                                       */
/* -------------------------------------------------------------------------- */

export default function AccountsPage(): React.JSX.Element {
  const me = useMe();
  const canManage = Boolean(me) && allowed(me, 'users:manage');
  const [rules, setRules] = useState<Rules | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panel, setPanel] = useState<{ kind: 'create' } | { kind: 'detail'; id: string } | null>(null);

  const load = useCallback(() => {
    Promise.all([api<Rules>('/users/roles'), api<{ users: Account[] }>('/users')]).then(
      ([nextRules, list]) => {
        setRules(nextRules);
        setAccounts(list.users);
      },
      (caught: unknown) => setLoadError(errorText(caught)),
    );
  }, []);
  useEffect(load, [load]);

  const upsert = (account: Account): void =>
    setAccounts((current) => (current?.some((x) => x.id === account.id) ? current.map((x) => (x.id === account.id ? account : x)) : [...(current ?? []), account]));

  const list = accounts ?? [];
  const counts = useMemo(() => {
    const week = Date.now() - 7 * 24 * 3_600_000;
    const recent = list.filter((x) => x.lastLoginAt && Date.parse(x.lastLoginAt) > week).sort((x, y) => Date.parse(y.lastLoginAt!) - Date.parse(x.lastLoginAt!));
    const invited = list.filter((x) => x.status === 'invited').sort((x, y) => Date.parse(x.inviteExpiresAt ?? '') - Date.parse(y.inviteExpiresAt ?? ''));
    return {
      active: list.filter((x) => x.status === 'active').length,
      invited,
      locked: list.filter((x) => x.status === 'locked').length,
      recent,
      sensitive: list.filter((x) => x.status !== 'locked' && Object.entries(x.access).some(([area, lv]) => AREA_TEXT[area as AreaId]?.sensitive && lv >= 2)).length,
    };
  }, [list]);
  const selected = panel?.kind === 'detail' ? list.find((x) => x.id === panel.id) ?? null : null;
  const activeCeos = list.filter((x) => x.role === 'CEO' && x.status !== 'locked').length;

  // Nút thêm người nằm trong khối ghim ở đầu trang: cuộn tới đâu cũng bấm được.
  const canCreate = canManage && Boolean(rules);
  useSettingsAction(
    canCreate ? <button type="button" className={`${s.btn} ${s.btnPrimary}`} onClick={() => setPanel({ kind: 'create' })}>+ Thêm người</button> : null,
    [canCreate],
  );

  return (
    <div className="pb-8">

      <div className={s.root}>
        {loadError && <div className={`${s.alert} ${s.alertBad}`}><span aria-hidden="true">⚠</span><span>{loadError}</span></div>}
        {!loadError && (!rules || !accounts) && <p className={s.note}>Đang tải danh sách tài khoản…</p>}

        {rules && accounts && (
          <>
            <section className={s.kpis} aria-label="Tình trạng tài khoản">
              <Kpi label="Tài khoản" value={list.length} sub={`${counts.active} đang dùng · ${counts.invited.length} chờ lời mời · ${counts.locked} đã khoá`} />
              <Kpi label="Có quyền nhạy cảm" value={counts.sensitive} sub="Đổi được khoá bí mật, tiền, tài khoản hoặc triển khai thật" />
              <Kpi label="Đăng nhập 7 ngày" value={<>{counts.recent.length}<small>người</small></>} sub={counts.recent[0] ? `Gần nhất: ${counts.recent[0].displayName}, ${ago(counts.recent[0].lastLoginAt).toLowerCase()}` : 'Chưa ai đăng nhập tuần này'} />
              <Kpi label="Lời mời đang chờ" value={counts.invited.length} sub={counts.invited[0] ? `${counts.invited[0].displayName} · ${statusNote(counts.invited[0])?.replace('Lời mời ', '') ?? ''}` : 'Không có lời mời nào'} />
            </section>

            <div className={a.main}>
              <section className={`${s.card} ${s.sec}`} aria-labelledby="badges-title">
                <div className={s.secHead}>
                  <div>
                    <h2 id="badges-title">Thẻ ra vào</h2>
                    <div className={s.sub}>Mỗi người một thẻ. Dải 9 ô dưới tên là các khu của công ty — ô càng đậm, quyền càng lớn.</div>
                  </div>
                </div>
                <div className={a.badges}>
                  {list.map((account) => {
                    const meta = roleMeta(account.role);
                    const status = STATUS[account.status];
                    const isSelf = account.id === me?.user.id;
                    return (
                      <button
                        key={account.id}
                        type="button"
                        className={`${a.badge} ${selected?.id === account.id ? a.badgeSel : ''} ${account.status === 'locked' ? a.badgeOff : ''}`}
                        style={roleStyle(meta.color)}
                        onClick={() => setPanel({ kind: 'detail', id: account.id })}
                      >
                        <span className={a.who}>
                          <span className={a.avatar}>{initials(account.displayName)}</span>
                          <span style={{ minWidth: 0 }}>
                            <span className={a.name}>{account.displayName}{isSelf && <span className={a.meta}> · anh</span>}</span>
                            <span className={a.mail} style={{ display: 'block' }}>{account.email}</span>
                          </span>
                        </span>
                        <span className={a.row}>
                          <span className={a.roleTag}>{meta.name}</span>
                          <Pill tone={status.tone}>{status.text}</Pill>
                        </span>
                        <span style={{ display: 'grid', gap: 5 }}>
                          <Zones rules={rules} access={account.access} />
                          <span className={a.zonesLabel}><span>Dự án</span><span>Tài khoản · Nhật ký</span></span>
                        </span>
                        <span className={a.row}>
                          <span className={a.meta}>{statusNote(account) ?? `Đăng nhập: ${ago(account.lastLoginAt)}`}</span>
                          <span className={a.meta}>{account.telegramLinked ? 'Telegram ✓' : 'Chưa nối Telegram'}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <div className={a.side}>
                {panel?.kind === 'create' && (
                  <CreatePanel rules={rules} onClose={() => setPanel(null)} onCreated={upsert} />
                )}
                {selected && (
                  <DetailPanel
                    rules={rules}
                    account={selected}
                    canManage={canManage}
                    isSelf={selected.id === me?.user.id}
                    lastCeo={selected.role === 'CEO' && selected.status !== 'locked' && activeCeos <= 1}
                    onClose={() => setPanel(null)}
                    onChanged={upsert}
                    onRemoved={(id) => {
                      setAccounts((current) => current?.filter((x) => x.id !== id) ?? null);
                      setPanel(null);
                    }}
                  />
                )}
                {!panel && (
                  <div className={`${s.card} ${a.panel}`}>
                    <p className={s.note}>Bấm một thẻ để xem chi tiết.</p>
                    {canManage ? <p className={s.note}>Nút “+ Thêm người” luôn ở đầu trang.</p> : <p className={s.note}>Chỉ CEO tạo, khoá hay đổi quyền tài khoản.</p>}
                  </div>
                )}
              </div>
            </div>

            <section className={`${s.card} ${s.sec}`} aria-labelledby="matrix-title">
              <div className={s.secHead}>
                <div>
                  <h2 id="matrix-title">Vai trò và quyền</h2>
                  <div className={s.sub}>Năm vai trò có sẵn. Khi tạo tài khoản, chọn một vai trò rồi chỉnh riêng từng khu nếu cần.</div>
                </div>
              </div>
              <div className={a.matrixWrap}>
                <table className={a.matrix}>
                  <thead>
                    <tr>
                      <th scope="col">Khu</th>
                      {ROLE_ORDER.map((id) => (
                        <th key={id} scope="col" style={roleStyle(ROLE_META[id].color)}>
                          <span className={a.cell} style={{ display: 'inline-flex', color: 'var(--ink-1)', fontSize: 13.5 }}><i className={a.dot} />{ROLE_META[id].name}</span>
                          <span>{list.filter((x) => x.role === id).length} người</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.areas.map((area) => (
                      <tr key={area}>
                        <th scope="row">
                          {AREA_TEXT[area].name} {AREA_TEXT[area].sensitive && <span className={a.sens}>nhạy cảm</span>}
                          <small>{AREA_TEXT[area].note}</small>
                        </th>
                        {ROLE_ORDER.map((id) => <td key={id}><LevelMark level={rules.roles[id][area]} color={ROLE_META[id].color} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={a.rules}>
                <div className={a.rule}><b>Chỉ CEO tạo, khoá, xoá tài khoản</b>Người khác không tự nâng quyền cho mình hay cho người khác được.</div>
                <div className={a.rule}><b>Luôn còn ít nhất một CEO</b>CEO cuối cùng không khoá, không hạ quyền, không xoá được.</div>
                <div className={a.rule}><b>Mọi thay đổi đều ghi nhật ký</b>Tạo, khoá, đổi quyền đều hiện ở Nhật ký kiểm toán: ai đổi, lúc nào, từ gì sang gì.</div>
                <div className={a.rule}><b>Nhân viên AI không bao giờ có quyền nhạy cảm</b>Khoá bí mật, tiền, tài khoản và triển khai thật bị chặn cứng với nhân viên AI, dù ai cấp.</div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
