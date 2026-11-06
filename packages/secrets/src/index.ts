/**
 * P&N — Kho secret mã hoá (§19, §69, §70, §88, §89).
 *
 * Module này sinh ra để bảo đảm các quy tắc:
 *   §19  không bao giờ lưu API key dạng plaintext;
 *   §69  lưu trữ mã hoá, khoá chính nằm ngoài database;
 *   §70  đổi khoá chính mà không mất secret đang có;
 *   §88.3 đọc lại secret qua API chỉ nhận được chuỗi đã mask;
 *   §89  không được bỏ mã hoá với lý do "đang MVP".
 *
 * Thuật toán: AES-256-GCM, mỗi secret một IV 96-bit ngẫu nhiên, và `ref` được
 * đưa vào làm dữ liệu xác thực bổ sung (AAD) nên không thể lấy ciphertext của
 * ref này gán sang ref khác.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { maskSecret } from '@pn/shared';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedSecret {
  ref: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
  preview: string;
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(`${message} (spec §69)`);
    this.name = 'MasterKeyError';
  }
}

export class SecretDecryptionError extends Error {
  constructor(readonly ref: string, cause?: unknown) {
    super(`Cannot decrypt secret "${ref}" — wrong master key or tampered ciphertext`);
    this.name = 'SecretDecryptionError';
    this.cause = cause;
  }
}

/** Khoá chính kèm số phiên bản, phục vụ việc đổi khoá (§70). */
export interface MasterKey {
  version: number;
  key: Buffer;
}

export function parseMasterKey(base64: string | undefined, version = 1): MasterKey {
  if (!base64 || base64.trim().length === 0) {
    throw new MasterKeyError('PN_MASTER_KEY is not set');
  }
  const key = Buffer.from(base64.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `PN_MASTER_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  return { version, key };
}

/** Sinh khoá chính mới. Dùng bởi setup wizard (§73). */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/* -------------------------------------------------------------------------- */
/* Cổng lưu trữ                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Lớp lưu trữ được tiêm từ ngoài vào, nhờ vậy phần mã hoá không phụ thuộc
 * database và test được mà không cần Postgres. Adapter thật nằm ở
 * `packages/database`.
 */
export interface SecretStorage {
  put(secret: EncryptedSecret & { environment: string }): Promise<void>;
  get(ref: string): Promise<(EncryptedSecret & { environment: string }) | null>;
  delete(ref: string): Promise<void>;
  list(): Promise<Array<{ ref: string; preview: string; keyVersion: number; environment: string }>>;
  markUsed(ref: string): Promise<void>;
}

/** Lưu trong bộ nhớ, chỉ dùng cho test và phát triển cục bộ. */
export class InMemorySecretStorage implements SecretStorage {
  readonly #rows = new Map<string, EncryptedSecret & { environment: string }>();

  async put(secret: EncryptedSecret & { environment: string }): Promise<void> {
    this.#rows.set(secret.ref, secret);
  }

  async get(ref: string): Promise<(EncryptedSecret & { environment: string }) | null> {
    return this.#rows.get(ref) ?? null;
  }

  async delete(ref: string): Promise<void> {
    this.#rows.delete(ref);
  }

  async list(): Promise<Array<{ ref: string; preview: string; keyVersion: number; environment: string }>> {
    return [...this.#rows.values()].map(({ ref, preview, keyVersion, environment }) => ({
      ref,
      preview,
      keyVersion,
      environment,
    }));
  }

  async markUsed(): Promise<void> {
    /* bản in-memory không cần làm gì */
  }
}

/* -------------------------------------------------------------------------- */
/* Kho secret                                                                  */
/* -------------------------------------------------------------------------- */

export interface SecretStoreOptions {
  storage: SecretStorage;
  /** Khoá dùng để mã hoá secret mới. */
  activeKey: MasterKey;
  /**
   * Các khoá cũ chỉ giữ lại để đọc được secret đã lưu trong lúc đang đổi khoá
   * (§70). Không bao giờ dùng để ghi mới.
   */
  previousKeys?: MasterKey[];
  environment?: string;
}

export class SecretStore {
  readonly #storage: SecretStorage;
  readonly #activeKey: MasterKey;
  readonly #keysByVersion: Map<number, Buffer>;
  readonly #environment: string;

  constructor(options: SecretStoreOptions) {
    this.#storage = options.storage;
    this.#activeKey = options.activeKey;
    this.#environment = options.environment ?? 'development';
    this.#keysByVersion = new Map([[options.activeKey.version, options.activeKey.key]]);
    for (const previous of options.previousKeys ?? []) {
      this.#keysByVersion.set(previous.version, previous.key);
    }
  }

  /** Lưu (hoặc ghi đè) một secret. Chỉ trả về chuỗi đã mask (§88.3). */
  async set(ref: string, plaintext: string): Promise<{ ref: string; preview: string }> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#activeKey.key, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const preview = maskSecret(plaintext);

    await this.#storage.put({
      ref,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      keyVersion: this.#activeKey.version,
      preview,
      environment: this.#environment,
    });

    return { ref, preview };
  }

  /**
   * Giải mã một secret. Chỉ phía server (AI Gateway, client tích hợp) được gọi —
   * tuyệt đối không gọi từ route có serialize dữ liệu ra client (§89).
   */
  async reveal(ref: string): Promise<string | null> {
    const row = await this.#storage.get(ref);
    if (!row) return null;

    const key = this.#keysByVersion.get(row.keyVersion);
    if (!key) {
      throw new SecretDecryptionError(ref, `no master key for version ${row.keyVersion}`);
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'));
      decipher.setAAD(Buffer.from(ref, 'utf8'));
      decipher.setAuthTag(Buffer.from(row.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]);
      await this.#storage.markUsed(ref);
      return plaintext.toString('utf8');
    } catch (error) {
      throw new SecretDecryptionError(ref, error);
    }
  }

  /** An toàn để trả qua API: preview và metadata, không bao giờ là giá trị thật (§88.3). */
  async describe(ref: string): Promise<{ ref: string; preview: string; keyVersion: number } | null> {
    const row = await this.#storage.get(ref);
    return row ? { ref: row.ref, preview: row.preview, keyVersion: row.keyVersion } : null;
  }

  async list(): Promise<Array<{ ref: string; preview: string; keyVersion: number; environment: string }>> {
    return this.#storage.list();
  }

  async delete(ref: string): Promise<void> {
    await this.#storage.delete(ref);
  }

  /**
   * §70 — mã hoá lại toàn bộ secret bằng khoá đang hoạt động. Chạy lại nhiều lần
   * vẫn an toàn; secret đã ở đúng phiên bản khoá thì được bỏ qua.
   */
  async rotate(): Promise<{ rotated: string[]; failed: Array<{ ref: string; reason: string }> }> {
    const rotated: string[] = [];
    const failed: Array<{ ref: string; reason: string }> = [];

    for (const entry of await this.#storage.list()) {
      if (entry.keyVersion === this.#activeKey.version) continue;
      try {
        const plaintext = await this.reveal(entry.ref);
        if (plaintext === null) continue;
        await this.set(entry.ref, plaintext);
        rotated.push(entry.ref);
      } catch (error) {
        failed.push({
          ref: entry.ref,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { rotated, failed };
  }
}

/**
 * So sánh thời gian hằng số cho chữ ký webhook và secret token Telegram
 * (§58, §67) — dùng `===` thường sẽ lộ độ dài và phần đầu chuỗi qua thời gian
 * thực thi.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Quy ước đặt `ref` cho secret, tránh mỗi nơi tự bịa một kiểu key. */
export const secretRef = {
  aiProvider: (provider: string, environment: string): string => `ai:${provider}:${environment}`,
  integration: (kind: string, name: string, environment: string): string =>
    `integration:${kind}:${name}:${environment}`,
};
