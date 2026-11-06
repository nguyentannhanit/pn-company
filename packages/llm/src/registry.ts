/**
 * P&N — Sổ đăng ký provider (§45: "Provider phải plug-in được").
 *
 * Registry dựng client provider từ credential do bên gọi cung cấp (AI Gateway,
 * nơi đọc credential từ kho secret mã hoá). Thêm vendor thứ tư chỉ cần đăng ký
 * thêm một factory ở đây — mọi thứ bên trên lớp này không đổi.
 */

import type { AiProviderId } from '@pn/shared';

import { ModelCatalog } from './catalog.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { ClaudeCodeProvider } from './providers/claude-code.js';
import { CodexProvider } from './providers/codex.js';
import { GoogleProvider } from './providers/google.js';
import { OpenAiProvider } from './providers/openai.js';
import type { LLMProvider } from './types.js';

export interface ProviderCredentials {
  apiKey: string;
  baseUrl?: string | null;
  defaultModel?: string | null;
}

export type ProviderFactory = (
  credentials: ProviderCredentials,
  catalog: ModelCatalog,
) => LLMProvider;

export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: AiProviderId) {
    super(`AI provider "${provider}" is not configured (spec §47 — set it up in API Center)`);
    this.name = 'ProviderNotConfiguredError';
  }
}

const BUILTIN_FACTORIES: Record<AiProviderId, ProviderFactory> = {
  anthropic: (credentials, catalog) =>
    new AnthropicProvider({
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl ?? null,
      catalog,
      ...(credentials.defaultModel ? { probeModel: credentials.defaultModel } : {}),
    }),
  openai: (credentials, catalog) =>
    new OpenAiProvider({
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl ?? null,
      catalog,
      ...(credentials.defaultModel ? { probeModel: credentials.defaultModel } : {}),
    }),
  google: (credentials, catalog) =>
    new GoogleProvider({
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl ?? null,
      catalog,
      ...(credentials.defaultModel ? { probeModel: credentials.defaultModel } : {}),
    }),
  // CLI gói thuê bao: không có API key. Với Claude, "key" là token dài hạn từ `claude setup-token` (không bắt buộc).
  'claude-code': (credentials, catalog) => new ClaudeCodeProvider({ catalog, oauthToken: credentials.apiKey || null }),
  codex: (_credentials, catalog) => new CodexProvider({ catalog }),
};

export class ProviderRegistry {
  readonly catalog: ModelCatalog;
  readonly #factories = new Map<string, ProviderFactory>(Object.entries(BUILTIN_FACTORIES));
  readonly #instances = new Map<AiProviderId, LLMProvider>();

  constructor(catalog: ModelCatalog = new ModelCatalog()) {
    this.catalog = catalog;
  }

  /** Đăng ký thêm vendor ngoài ba nhà cung cấp bắt buộc ở §45.1. */
  register(id: string, factory: ProviderFactory): void {
    this.#factories.set(id, factory);
  }

  /** Gọi sau khi API Center lưu hoặc đổi key (§47, §70). */
  configure(id: AiProviderId, credentials: ProviderCredentials): LLMProvider {
    const factory = this.#factories.get(id);
    if (!factory) throw new ProviderNotConfiguredError(id);
    const provider = factory(credentials, this.catalog);
    this.#instances.set(id, provider);
    return provider;
  }

  /** Bỏ client — dùng khi tắt provider (§88.6) hoặc khi đổi key. */
  revoke(id: AiProviderId): void {
    this.#instances.delete(id);
  }

  get(id: AiProviderId): LLMProvider {
    const provider = this.#instances.get(id);
    if (!provider) throw new ProviderNotConfiguredError(id);
    return provider;
  }

  has(id: AiProviderId): boolean {
    return this.#instances.has(id);
  }

  configured(): AiProviderId[] {
    return [...this.#instances.keys()];
  }
}
