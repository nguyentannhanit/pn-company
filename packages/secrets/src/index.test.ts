/** §19, §69, §70, §88.2–88.3, §89 — lưu trữ secret có mã hoá. */

import { describe, expect, it } from 'vitest';

import { containsSecret } from '@pn/shared';

import {
  generateMasterKey,
  InMemorySecretStorage,
  parseMasterKey,
  safeCompare,
  SecretDecryptionError,
  secretRef,
  SecretStore,
} from './index.js';

const API_KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';

function newStore(keyVersion = 1) {
  const storage = new InMemorySecretStorage();
  const activeKey = parseMasterKey(generateMasterKey(), keyVersion);
  return { storage, activeKey, store: new SecretStore({ storage, activeKey }) };
}

describe('SecretStore (§69)', () => {
  it('không bao giờ lưu plaintext xuống kho (§19, §88.2)', async () => {
    const { store, storage } = newStore();
    await store.set(secretRef.aiProvider('anthropic', 'development'), API_KEY);

    const row = await storage.get(secretRef.aiProvider('anthropic', 'development'));
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(API_KEY);
    expect(containsSecret(row)).toBe(false);
  });

  it('lấy lại đúng giá trị gốc cho phía server dùng', async () => {
    const { store } = newStore();
    const ref = secretRef.aiProvider('openai', 'development');
    await store.set(ref, API_KEY);
    expect(await store.reveal(ref)).toBe(API_KEY);
  });

  it('describe() chỉ trả về chuỗi đã mask (§88.3)', async () => {
    const { store } = newStore();
    const ref = secretRef.aiProvider('anthropic', 'development');
    const { preview } = await store.set(ref, API_KEY);

    expect(preview).not.toContain('api03');
    const described = await store.describe(ref);
    expect(described?.preview).toBe(preview);
    expect(containsSecret(described)).toBe(false);
  });

  it('ciphertext gắn chặt với ref nên không thể chuyển sang ref khác', async () => {
    const { store, storage } = newStore();
    await store.set('ai:anthropic:development', API_KEY);
    const row = (await storage.get('ai:anthropic:development'))!;
    await storage.put({ ...row, ref: 'ai:openai:development' });

    await expect(store.reveal('ai:openai:development')).rejects.toBeInstanceOf(SecretDecryptionError);
  });

  it('sai khoá chính thì báo lỗi rõ ràng thay vì trả về dữ liệu rác', async () => {
    const { storage } = newStore();
    const writeStore = new SecretStore({ storage, activeKey: parseMasterKey(generateMasterKey()) });
    await writeStore.set('ai:anthropic:development', API_KEY);

    const readStore = new SecretStore({ storage, activeKey: parseMasterKey(generateMasterKey()) });
    await expect(readStore.reveal('ai:anthropic:development')).rejects.toBeInstanceOf(
      SecretDecryptionError,
    );
  });

  it('ref không tồn tại thì trả về null', async () => {
    const { store } = newStore();
    expect(await store.reveal('ai:nope:development')).toBeNull();
  });

  it('đổi secret sang khoá chính mới (§70)', async () => {
    const storage = new InMemorySecretStorage();
    const oldKey = parseMasterKey(generateMasterKey(), 1);
    const oldStore = new SecretStore({ storage, activeKey: oldKey });
    await oldStore.set('ai:anthropic:development', API_KEY);

    const newKey = parseMasterKey(generateMasterKey(), 2);
    const rotator = new SecretStore({ storage, activeKey: newKey, previousKeys: [oldKey] });

    const result = await rotator.rotate();
    expect(result.rotated).toEqual(['ai:anthropic:development']);
    expect(result.failed).toEqual([]);

    // Chỉ cần khoá mới là đọc được.
    const afterRotation = new SecretStore({ storage, activeKey: newKey });
    expect(await afterRotation.reveal('ai:anthropic:development')).toBe(API_KEY);
  });
});

describe('parseMasterKey (§69)', () => {
  it('thiếu khoá thì báo lỗi thay vì quay về plaintext (§89)', () => {
    expect(() => parseMasterKey(undefined)).toThrow(/PN_MASTER_KEY/);
    expect(() => parseMasterKey('   ')).toThrow(/PN_MASTER_KEY/);
  });

  it('từ chối khoá sai độ dài', () => {
    expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('safeCompare (§58, §67)', () => {
  it('khớp chuỗi giống nhau và loại chuỗi khác nhau', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true);
    expect(safeCompare('abc123', 'abc124')).toBe(false);
    expect(safeCompare('abc', 'abcd')).toBe(false);
  });
});
