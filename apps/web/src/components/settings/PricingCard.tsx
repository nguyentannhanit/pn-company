/**
 * P&N — Bảng giá model (§16, §54): chuyển nguyên từ trang Cài đặt cũ sang đây để trang Kết nối AI bản 4 gọn
 * lại; cách hoạt động giữ nguyên. Giá dùng để tính tiền từng lượt gọi API và để trần ngân sách biết lúc chặn.
 */

'use client';

import { useState } from 'react';

import { Badge, Button, Card } from '@/components/ui';
import { api } from '@/lib/api';

/** Một dòng trong bảng model của API Center; giá null nghĩa là chưa ai nhập (§54). */
export interface ModelRow {
  id: string;
  provider: string;
  displayName: string;
  tier: string;
  inputPerMtok: number | null;
  outputPerMtok: number | null;
  cachedInputPerMtok: number | null;
  pricingSource: string;
}

interface RouteRow {
  provider: string;
  model: string;
  fallbacks: Array<{ provider: string; model: string }>;
}

const PROVIDERS = ['anthropic', 'openai', 'google'] as const;
const CLI_PROVIDERS = ['claude-code', 'codex'] as const;
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Claude API (Anthropic)',
  openai: 'OpenAI API',
  google: 'Gemini API',
  'claude-code': 'Claude CLI (gói thuê bao)',
  codex: 'ChatGPT CLI (gói thuê bao)',
};

/** Trang giá chính thức của từng hãng — nơi lấy con số để nhập vào bảng giá. */
const PRICING_URL: Record<string, string> = {
  anthropic: 'https://www.anthropic.com/pricing',
  openai: 'https://openai.com/api/pricing/',
  google: 'https://ai.google.dev/pricing',
};

/* -------------------------------------------------------------------------- */
/* Giá model — §16, §54                                                        */
/* -------------------------------------------------------------------------- */

/** Mỗi model đang giữ vai trò gì trong bảng định tuyến — quyết định nó có cần giá gấp hay không. */
type ModelUse = 'primary' | 'fallback' | 'unused';

function useOf(routes: RouteRow[], model: ModelRow): ModelUse {
  if (routes.some((route) => route.provider === model.provider && route.model === model.id)) return 'primary';
  if (routes.some((route) => route.fallbacks.some((t) => t.provider === model.provider && t.model === model.id))) return 'fallback';
  return 'unused';
}

/**
 * Bảng giá xếp theo hãng, model đang dùng lên đầu, model đã có giá KHÔNG bị ẩn sau khi lưu
 * (trước đây dòng vừa lưu biến mất khỏi bảng nên CEO tưởng chưa lưu).
 */
export function PricingCard({
  models,
  routes,
  connected,
  onSaved,
  onError,
}: {
  models: ModelRow[];
  routes: RouteRow[];
  connected: string[];
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const providersShown = PROVIDERS.filter((id) => connected.includes(id));
  const inUse = models.filter((model) => useOf(routes, model) !== 'unused');
  const unpricedInUse = inUse.filter((model) => model.inputPerMtok === null);

  return (
    <Card>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-500">Giá model</h2>
        <span className="text-xs text-ink-500">USD cho mỗi 1 triệu token</span>
      </div>
      <p className="mb-2 text-xs leading-relaxed text-ink-500">
        Giá dùng để tính tiền từng lượt gọi và để trần ngân sách biết lúc nào phải chặn. Hầu hết model đã có
        giá sẵn — chỉ cần nhập khi thấy dấu <span className="text-produce-400">chưa có giá</span>. Con số lấy ở
        trang giá của hãng ({providersShown.map((id, index) => (
          <span key={id}>
            {index > 0 && ', '}
            <a href={PRICING_URL[id]} target="_blank" rel="noreferrer" className="text-brand-300 underline-offset-2 hover:underline">
              {PROVIDER_LABEL[id]}
            </a>
          </span>
        ))}
        ): &ldquo;Input&rdquo; là giá <span className="text-ink-300">Vào</span>, &ldquo;Output&rdquo; là giá{' '}
        <span className="text-ink-300">Ra</span>, &ldquo;Cached input&rdquo; là <span className="text-ink-300">Cache</span> (để trống nếu hãng không ghi).
      </p>
      {connected.some((id) => (CLI_PROVIDERS as readonly string[]).includes(id)) && (
        <p className="mb-2 text-xs leading-relaxed text-ink-500">
          Claude (gói) và ChatGPT (gói) không nằm trong bảng này: trừ vào hạn mức gói thuê bao, ghi $0 cho mỗi lượt gọi.
        </p>
      )}
      {unpricedInUse.length > 0 ? (
        <p className="mb-3 rounded-md bg-produce-400/10 px-3 py-2 text-xs text-produce-400">
          {unpricedInUse.length} model đang dùng chưa có giá — lượt gọi tới đó đang ghi $0:{' '}
          <span className="font-mono">{unpricedInUse.map((m) => m.id).join(', ')}</span>.
        </p>
      ) : (
        <p className="mb-3 rounded-md bg-state-completed/10 px-3 py-2 text-xs text-state-completed">
          Mọi model đang dùng (chính và dự phòng) đều có giá. Chi phí đang được tính đủ.
        </p>
      )}

      <div className="space-y-4">
        {providersShown.map((provider) => {
          const list = models.filter((model) => model.provider === provider);
          const used = list.filter((model) => useOf(routes, model) !== 'unused');
          const rest = list.filter((model) => useOf(routes, model) === 'unused');
          const open = expanded[provider] ?? false;
          return (
            <div key={provider}>
              <h3 className="mb-1.5 text-xs font-semibold text-ink-300">{PROVIDER_LABEL[provider]}</h3>
              <div className="space-y-1.5">
                {used.map((model) => (
                  <PricingRow key={model.id} model={model} use={useOf(routes, model)} onSaved={onSaved} onError={onError} />
                ))}
                {used.length === 0 && <p className="text-xs text-ink-500">Chưa có model nào của hãng này trong bảng định tuyến.</p>}
                {open && rest.map((model) => (
                  <PricingRow key={model.id} model={model} use="unused" onSaved={onSaved} onError={onError} />
                ))}
              </div>
              {rest.length > 0 && (
                <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setExpanded((v) => ({ ...v, [provider]: !open }))}>
                  {open ? 'Ẩn model không dùng' : `Hiện ${rest.length} model khác của ${PROVIDER_LABEL[provider]}`}
                </Button>
              )}
            </div>
          );
        })}
        {providersShown.length === 0 && <p className="text-xs text-ink-500">Kết nối một hãng ở trên để thấy bảng giá.</p>}
      </div>
    </Card>
  );
}

const USE_LABEL: Record<ModelUse, { text: string; color: string }> = {
  primary: { text: 'đang dùng', color: 'var(--tone-green)' },
  fallback: { text: 'dự phòng', color: 'var(--tone-blue)' },
  unused: { text: 'không dùng', color: 'var(--tone-gray)' },
};

/** Một dòng giá: trạng thái dùng, nguồn giá, ba ô nhập và nút Lưu; lưu xong dòng vẫn ở nguyên chỗ, hiện "đã lưu". */
function PricingRow({
  model,
  use,
  onSaved,
  onError,
}: {
  model: ModelRow;
  use: ModelUse;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [input, setInput] = useState(model.inputPerMtok?.toString() ?? '');
  const [output, setOutput] = useState(model.outputPerMtok?.toString() ?? '');
  const [cached, setCached] = useState(model.cachedInputPerMtok?.toString() ?? '');
  const [busy, setBusy] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const unpriced = model.inputPerMtok === null;
  const dirty =
    input !== (model.inputPerMtok?.toString() ?? '') ||
    output !== (model.outputPerMtok?.toString() ?? '') ||
    cached !== (model.cachedInputPerMtok?.toString() ?? '');

  const save = async (): Promise<void> => {
    const inputPerMtok = Number(input);
    const outputPerMtok = Number(output);
    if (!(inputPerMtok >= 0) || !(outputPerMtok >= 0) || input === '' || output === '') {
      onError(`Giá Vào và Ra của ${model.id} phải là số không âm (Cache có thể để trống).`);
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ repricedCalls: number }>(`/api-center/models/${encodeURIComponent(model.id)}/pricing`, {
        method: 'PUT',
        body: { inputPerMtok, outputPerMtok, cachedInputPerMtok: cached === '' ? null : Number(cached) },
      });
      setSavedAt(Date.now());
      onSaved(
        `Đã lưu giá cho ${model.id}` +
          (result.repricedCalls > 0 ? ` và tính lại ${result.repricedCalls} lượt gọi trước đó.` : '.'),
      );
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Không lưu được giá');
    } finally {
      setBusy(false);
    }
  };

  const source =
    model.pricingSource === 'operator' ? 'anh nhập' : model.pricingSource === 'seed' ? 'giá có sẵn' : 'từ hãng';
  const field = 'w-24 rounded border border-base-600 bg-base-900 px-2 py-1 text-right font-mono text-xs text-ink-100';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-52 shrink-0 truncate font-mono text-ink-100" title={model.id}>{model.id}</span>
      <Badge color={USE_LABEL[use].color} dot>{USE_LABEL[use].text}</Badge>
      <span className={`w-24 shrink-0 ${unpriced ? 'text-produce-400' : 'text-ink-500'}`}>
        {unpriced ? '⚠ chưa có giá' : savedAt ? '✓ đã lưu' : `✓ ${source}`}
      </span>
      <label className="flex items-center gap-1 text-ink-500">
        Vào
        <input type="number" min="0" step="0.01" value={input} onChange={(e) => setInput(e.target.value)} className={field} placeholder="0.00" />
      </label>
      <label className="flex items-center gap-1 text-ink-500">
        Ra
        <input type="number" min="0" step="0.01" value={output} onChange={(e) => setOutput(e.target.value)} className={field} placeholder="0.00" />
      </label>
      <label className="flex items-center gap-1 text-ink-500">
        Cache
        <input type="number" min="0" step="0.01" value={cached} onChange={(e) => setCached(e.target.value)} className={field} placeholder="trống" />
      </label>
      <Button size="sm" variant={unpriced || dirty ? 'primary' : 'quiet'} onClick={() => void save()} disabled={busy}>
        {busy ? 'Đang lưu…' : 'Lưu giá'}
      </Button>
    </div>
  );
}
