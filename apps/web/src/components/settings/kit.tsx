/**
 * P&N — Mảnh giao diện dùng chung của bốn trang Cài đặt bản 4: ô chỉ số, thanh tiến trình, nhãn trạng thái,
 * khối lập phương đẳng cự, cùng kiểu dữ liệu API và thông tin cố định của từng nguồn AI.
 */

'use client';

import s from './settings.module.css';

/* -------------------------------------------------------------------------- */
/* Định dạng số                                                                */
/* -------------------------------------------------------------------------- */

const nf = new Intl.NumberFormat('vi-VN');
export const int = (value: number): string => nf.format(value);
export const pct = (ratio: number): string => `${Math.round(ratio * 100)}%`;
export const usd = (value: number): string => `$${value.toFixed(2)}`;
const pad = (n: number): string => String(n).padStart(2, '0');
/** "05/03" — viết tay vì mỗi trình duyệt định dạng ngày tiếng Việt một kiểu ("05-03", "05/03"). */
export const ddmm = (value: string | number | Date): string => { const d = new Date(value); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
export const hhmm = (value: string | number | Date): string => { const d = new Date(value); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const stamp = (value: string | number | Date): string => `${hhmm(value)} ${ddmm(value)}`;
const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
export const weekday = (value: string | number | Date): string => WEEKDAY[new Date(value).getDay()]!;
/** "2,22 tr token" / "564k token" — dấu chấm nghìn kiểu Việt đi với "k" dễ đọc nhầm. */
export const tokens = (value: number): string => (value >= 1e6 ? `${(value / 1e6).toFixed(2).replace('.', ',')} tr token` : `${Math.round(value / 1000)}k token`);
export const seconds = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} giây`);

/** Màu thanh theo tỉ lệ đã dùng so với hạn mức: vàng từ ngưỡng cảnh báo, đỏ khi chạm. */
export const limitTone = (ratio: number, warn = 0.8): Tone => (ratio >= 1 ? 'bad' : ratio >= warn ? 'warn' : 'good');
/** Màu thanh theo tỉ lệ thành công. */
export const okTone = (ratio: number): Tone => (ratio >= 0.9 ? 'good' : ratio >= 0.75 ? 'warn' : 'bad');

/* -------------------------------------------------------------------------- */
/* Thanh tiến trình, ô chỉ số                                                  */
/* -------------------------------------------------------------------------- */

export type Tone = 'good' | 'warn' | 'bad' | 'brand' | 'off';
const FILL: Record<Tone, string> = { good: '', warn: s.fillWarn!, bad: s.fillBad!, brand: s.fillBrand!, off: s.fillOff! };

export function Bar({ ratio, tone = 'good', ticks = [], ghost, big = false, color }: {
  ratio: number;
  tone?: Tone;
  /** Vạch đánh dấu (ví dụ ngưỡng cảnh báo 80%). */
  ticks?: number[];
  /** Khung viền nhạt tới mức này — "nếu tính cả tháng". */
  ghost?: number;
  big?: boolean;
  /** Màu riêng (màu hãng) thay cho tông. */
  color?: string;
}): React.JSX.Element {
  const width = (value: number): string => `${Math.max(0, Math.min(100, value * 100))}%`;
  return (
    <div className={`${s.track} ${big ? s.trackBig : ''}`}>
      {ghost !== undefined && <div className={`${s.fill} ${s.fillGhost}`} style={{ width: width(ghost) }} />}
      <div className={`${s.fill} ${FILL[tone]}`} style={{ width: width(ratio), ...(color ? { background: color } : {}) }} />
      {ticks.map((tick) => (
        <i key={tick} className={s.tick} style={{ left: `calc(${tick * 100}% - 1px)` }} />
      ))}
    </div>
  );
}

/** Thanh chồng nhiều phần (ví dụ bot vs thao tác thật, mạnh/vừa/nhanh). */
export function Stack({ parts }: { parts: Array<{ value: number; color: string; title?: string }> }): React.JSX.Element {
  return (
    <div className={s.stack}>
      {parts.filter((part) => part.value > 0).map((part, index) => (
        <i key={index} style={{ flex: part.value, background: part.color }} title={part.title} />
      ))}
    </div>
  );
}

/** Dãy ô rời: bao nhiêu trên tổng số (2/5 nguồn AI dùng được). */
export function Cells({ total, on }: { total: number; on: number }): React.JSX.Element {
  return (
    <div className={s.cells}>
      {Array.from({ length: total }, (_, index) => <i key={index} className={index < on ? s.on : ''} />)}
    </div>
  );
}

export function Meter({ label, value, ratio, tone, color }: { label: React.ReactNode; value: React.ReactNode; ratio: number; tone?: Tone; color?: string }): React.JSX.Element {
  return (
    <div className={s.meter}>
      <div className={s.meterTop}>
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <Bar ratio={ratio} tone={tone} color={color} />
    </div>
  );
}

export function Kpi({ label, value, sub, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={s.kpi}>
      <span className={s.kpiK}>{label}</span>
      <span className={s.kpiV}>{value}</span>
      {sub && <span className={s.kpiS}>{sub}</span>}
      {children && <div className={s.kpiBar}>{children}</div>}
    </div>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return <span className={`${s.pill} ${s[tone]}`}>{children}</span>;
}

/** Khối lập phương đẳng cự vẽ bằng SVG — cùng ngôn ngữ với sơ đồ 3D; viền đứt là chưa nối. */
export function IsoCube({ color, on, size = 52 }: { color: string; on: boolean; size?: number }): React.JSX.Element {
  const w = size, h = size;
  const top = `M${w / 2},3 L${w - 4},${h * 0.27} L${w / 2},${h * 0.51} L4,${h * 0.27} Z`;
  const left = `M4,${h * 0.27} L${w / 2},${h * 0.51} L${w / 2},${h - 3} L4,${h * 0.75} Z`;
  const right = `M${w / 2},${h * 0.51} L${w - 4},${h * 0.27} L${w - 4},${h * 0.75} L${w / 2},${h - 3} Z`;
  if (!on) {
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" fill="none" stroke="var(--line-strong)" strokeWidth={1.5} strokeDasharray="4 3" style={{ flex: 'none' }}>
        <path d={top} />
        <path d={left} />
        <path d={right} />
      </svg>
    );
  }
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" stroke="rgb(20 40 63 / 25%)" strokeWidth={1} style={{ flex: 'none' }}>
      <path d={top} fill={`color-mix(in srgb, ${color} 45%, white)`} />
      <path d={left} fill={`color-mix(in srgb, ${color} 88%, white)`} />
      <path d={right} fill={`color-mix(in srgb, ${color} 80%, black)`} />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Nguồn AI: thông tin cố định                                                 */
/* -------------------------------------------------------------------------- */

export type ProviderId = 'claude-code' | 'codex' | 'anthropic' | 'google' | 'openai';

export const PROVIDER_META: Record<ProviderId, {
  name: string;
  nick: string;
  long: string;
  mark: string;
  color: string;
  kind: 'plan' | 'api';
  note: string;
  login?: string;
  loginNote?: string;
  tokenHint?: string;
  pricingUrl?: string;
}> = {
  // Tên ghi rõ CLI (gói thuê bao, đăng nhập tài khoản, $0 mỗi lượt) hay API (dán khoá, trả theo token) — người dùng hay nhầm hai loại này.
  'claude-code': {
    name: 'Claude CLI', nick: 'Claude CLI', long: 'Claude CLI · gói thuê bao', mark: 'C', color: '#d97757', kind: 'plan',
    note: 'Gói Claude Pro/Max chạy qua Claude Code CLI trên máy chủ công ty. Mỗi lượt $0, trừ vào hạn mức gói.',
    login: 'claude setup-token',
    loginNote: 'Chạy lệnh này trong terminal trên máy chủ công ty, đăng nhập tài khoản Claude, rồi dán token dài (sk-ant-oat…) vào ô dưới.',
    tokenHint: 'Dán token từ claude setup-token',
  },
  codex: {
    name: 'ChatGPT CLI', nick: 'GPT CLI', long: 'ChatGPT CLI · gói thuê bao', mark: 'G', color: '#10a37f', kind: 'plan',
    note: 'Gói ChatGPT Plus/Pro qua Codex CLI. Ba bậc là ba mức suy nghĩ của model mặc định.',
    login: 'codex login',
    loginNote: 'Chạy lệnh này trong terminal trên máy chủ công ty và đăng nhập tài khoản ChatGPT. Không cần dán gì vào đây.',
  },
  anthropic: {
    name: 'Claude API', nick: 'Claude API', long: 'Claude API · Anthropic, trả theo token', mark: 'A', color: '#c27459', kind: 'api',
    note: 'Trả theo token. Không bị giới hạn theo khung giờ như gói.', pricingUrl: 'https://www.anthropic.com/pricing',
  },
  google: {
    name: 'Gemini API', nick: 'Gemini API', long: 'Gemini API · Google, trả theo token', mark: 'G', color: '#4f7df0', kind: 'api',
    note: 'Trả theo token; gói miễn phí có hạn mức theo phút và theo ngày.', pricingUrl: 'https://ai.google.dev/pricing',
  },
  openai: {
    name: 'OpenAI API', nick: 'OpenAI API', long: 'OpenAI API · GPT, trả theo token', mark: 'O', color: '#7a8699', kind: 'api',
    note: 'Trả theo token.', pricingUrl: 'https://openai.com/api/pricing/',
  },
};

/** Tên model gọn để đọc: "Opus", "nghĩ kỹ", "claude-sonnet-5". */
export function shortModel(provider: string, model: { id: string; name: string } | null | undefined): string {
  if (!model) return '—';
  if (provider === 'claude-code') return model.id.charAt(0).toUpperCase() + model.id.slice(1);
  if (provider === 'codex') return { high: 'nghĩ kỹ', medium: 'nghĩ vừa', low: 'nghĩ nhanh' }[model.id.split('@')[1] ?? ''] ?? model.id;
  return model.id;
}

export const TIER_ORDER = ['strong', 'medium', 'cheap'] as const;
export type Tier = (typeof TIER_ORDER)[number];
export const TIER_WORD: Record<Tier, string> = { strong: 'mạnh', medium: 'vừa', cheap: 'nhanh' };
export const TIER_SIG: Record<Tier, string> = { strong: s.sigStrong!, medium: s.sigMedium!, cheap: s.sigCheap! };

/** Ba vạch kiểu cột sóng cho bậc model. */
export function Sig({ tier }: { tier: Tier }): React.JSX.Element {
  return (
    <span className={`${s.sig} ${TIER_SIG[tier]}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Kiểu dữ liệu API                                                            */
/* -------------------------------------------------------------------------- */

export interface UsageWindow { calls: number; ok: number; avgLatencyMs: number | null }

export interface ProviderState {
  provider: ProviderId;
  label: string;
  kind: 'plan' | 'api';
  usable: boolean;
  isEnabled: boolean;
  status: string;
  hasKey: boolean;
  keyPreview: string | null;
  lastError: string | null;
  lastTestedAt: string | null;
  usage: { window: UsageWindow; week: UsageWindow; hours5: UsageWindow };
  models: Record<Tier, { id: string; name: string } | null>;
  breakers: Array<{ key: string; state: string; reopensAt: number }>;
}

export interface RoleUsage { role: string; calls: number; ok: number; avgLatencyMs: number | null; tokens: number; costUsd: number }
export interface RolePlan { tier: Tier; effectiveTier: Tier; reason: string; raisedFor: string | null; provider: ProviderId | null; manual: boolean }
export type Combo = 'economy' | 'balanced' | 'quality' | 'speed';

export interface AllocationPayload {
  order: ProviderId[];
  mode: 'auto' | 'manual';
  combo: Combo;
  overrides: Record<string, { provider: ProviderId; tier: Tier }>;
  analyzedAt: string | null;
  trigger: string | null;
  smartRouting: boolean;
  windowDays: number;
  defaultTiers: Record<string, Tier>;
  usage: RoleUsage[];
  plans: Record<string, RolePlan>;
  usable: ProviderId[];
  totals: { calls: number; ok: number; failures: number; providerSideFailures: number };
  budget: { limitUsd: number; spentUsd: number; ratio: number; warned: boolean; exceeded: boolean } | null;
  routes: Array<{ agentRole: string; tier: Tier; provider: ProviderId; model: string; fallbacks: Array<{ provider: string; model: string }> }>;
  providers: ProviderState[];
  written?: number;
}

export { s as styles };
