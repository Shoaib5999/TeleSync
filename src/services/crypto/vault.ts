import QuickCrypto from 'react-native-quick-crypto';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { configRepo } from '../db/schema';
import { secureStore } from '../secure/keychain';
import { logger, describeError } from '../../utils/logger';

/**
 * Per-file encryption for folders the user marked as encrypted.
 *
 * Per FILE, not per folder. Encrypting a folder as one blob would destroy
 * everything this app relies on: a single new photo would mean re-uploading the
 * whole folder, there would be no resumability, no dedupe, and no way to
 * restore one item. Per-file keeps every sync incremental.
 *
 * AES-256-GCM, so the ciphertext is authenticated — a corrupted or tampered
 * download fails loudly at the tag check instead of writing garbage to disk.
 *
 * Container layout:
 *   magic "TGBK"  4 bytes
 *   version       1 byte
 *   salt         16 bytes   (KDF salt, not secret; lets another device derive)
 *   iv           12 bytes   (unique per file)
 *   ciphertext   N bytes
 *   auth tag     16 bytes   (trailing, written after the final block)
 */

const MAGIC = 'TGBK';
/** Small in-memory payloads (see sealBytes); distinct so the two never mix. */
const SEALED_MAGIC = 'TGBS';
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 4 + 1 + SALT_BYTES + IV_BYTES;

const KDF_ITERATIONS = 200_000;
const KEY_BYTES = 32;
const CHUNK_SIZE = 512 * 1024;

const SALT_CONFIG_KEY = 'vault_salt_b64';

export class VaultLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultLockedError';
  }
}

/**
 * Thrown by decryptFile when no known key can open a file, typically a backup
 * made on another device or before a reinstall, whose salt differs from this
 * install's. Retrying with `{ passphrase }` derives the key from the file's own
 * salt and, once it verifies, remembers it so this happens once per salt.
 */
export class VaultPassphraseRequiredError extends Error {
  /** True when keys were tried and failed, rather than none being known. */
  readonly wrongPassphrase: boolean;

  constructor(wrongPassphrase: boolean) {
    super(
      wrongPassphrase
        ? 'That passphrase does not open this file.'
        : 'Enter the passphrase this backup was encrypted with.',
    );
    this.name = 'VaultPassphraseRequiredError';
    this.wrongPassphrase = wrongPassphrase;
  }
}

/** Cached derived key, so the KDF runs once per launch rather than per file. */
let cachedKey: Buffer | null = null;

/**
 * Decryption keys by salt (base64), for backups whose salt is not this
 * install's. Loaded lazily from the Keychain; see secureStore.setVaultKeyring.
 */
let keyring: Map<string, Buffer[]> | null = null;

async function loadKeyring(): Promise<Map<string, Buffer[]>> {
  if (keyring) {
    return keyring;
  }
  const map = new Map<string, Buffer[]>();
  const raw = await secureStore.getVaultKeyring();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      for (const [salt, keys] of Object.entries(parsed)) {
        map.set(
          salt,
          keys.map(key => Buffer.from(key, 'base64')),
        );
      }
    } catch (error) {
      logger.error('vault', 'Vault keyring is unreadable; ignoring it', error);
    }
  }
  keyring = map;
  return map;
}

async function rememberKey(saltB64: string, key: Buffer): Promise<void> {
  const map = await loadKeyring();
  const keys = map.get(saltB64) ?? [];
  if (keys.some(existing => existing.equals(key))) {
    return;
  }
  map.set(saltB64, [key, ...keys]);
  const json: Record<string, string[]> = {};
  for (const [salt, list] of map) {
    json[salt] = list.map(item => item.toString('base64'));
  }
  await secureStore.setVaultKeyring(JSON.stringify(json));
  logger.info('vault', 'Remembered a backup key for another salt');
}

/**
 * Every key worth trying for a file with this salt: the install's own key when
 * the salt is ours, then any remembered for it. Deduplicated, order preserved.
 */
async function candidateKeys(saltB64: string): Promise<Buffer[]> {
  const keys: Buffer[] = [];
  const localSalt = await configRepo.getValue(SALT_CONFIG_KEY);
  if (localSalt === saltB64 && (await vault.isUnlocked()) && cachedKey) {
    keys.push(cachedKey);
  }
  for (const key of (await loadKeyring()).get(saltB64) ?? []) {
    if (!keys.some(existing => existing.equals(key))) {
      keys.push(key);
    }
  }
  return keys;
}

/** GCM auth failure: the key is wrong (or the data damaged), not an I/O fault. */
class AuthTagError extends Error {}

/**
 * The KDF salt. Stable for the vault: every file shares it so the key is
 * derived once. Stored in config (salts are not secret) and copied into each
 * file header so a fresh device can derive the key from the passphrase alone.
 */
async function getOrCreateSalt(): Promise<Buffer> {
  const existing = await configRepo.getValue(SALT_CONFIG_KEY);
  if (existing) {
    return Buffer.from(existing, 'base64');
  }
  const salt = QuickCrypto.randomBytes(SALT_BYTES) as unknown as Buffer;
  await configRepo.setValue(SALT_CONFIG_KEY, salt.toString('base64'));
  return salt;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return QuickCrypto.pbkdf2Sync(
    passphrase,
    salt,
    KDF_ITERATIONS,
    KEY_BYTES,
    'sha256',
  ) as unknown as Buffer;
}

export const vault = {
  /**
   * Sets the passphrase and caches the derived key.
   *
   * There is no recovery path: the key exists only on this device and inside
   * the user's head. Losing the passphrase means the backup is unreadable, by
   * design — the whole point is that Telegram cannot read it either.
   */
  async setPassphrase(passphrase: string): Promise<void> {
    if (passphrase.length < 8) {
      throw new Error('Use a passphrase of at least 8 characters.');
    }
    const salt = await getOrCreateSalt();
    const key = deriveKey(passphrase, salt);
    await secureStore.setVaultKey(key.toString('base64'));
    cachedKey = key;
    logger.info('vault', 'Encryption passphrase set');
  },

  /**
   * True when `passphrase` produces the key this install encrypts with. Used
   * to prove ownership (e.g. resetting a forgotten Vault PIN) without storing
   * the passphrase anywhere.
   */
  async verifyPassphrase(passphrase: string): Promise<boolean> {
    const saltB64 = await configRepo.getValue(SALT_CONFIG_KEY);
    if (saltB64 && (await this.isUnlocked()) && cachedKey) {
      const derived = deriveKey(passphrase, Buffer.from(saltB64, 'base64'));
      if (derived.equals(cachedKey)) {
        return true;
      }
    }
    // Also accept a passphrase that was only ever entered to open a backup
    // from another install (a new phone may never have set one in Settings).
    for (const [salt, keys] of await loadKeyring()) {
      const derived = deriveKey(passphrase, Buffer.from(salt, 'base64'));
      if (keys.some(key => key.equals(derived))) {
        return true;
      }
    }
    return false;
  },

  /** Whether any passphrase is known here, so verifyPassphrase can succeed. */
  async hasPassphrase(): Promise<boolean> {
    return (await this.isUnlocked()) || (await loadKeyring()).size > 0;
  },

  async unlock(passphrase: string): Promise<void> {
    await this.setPassphrase(passphrase);
  },

  async isUnlocked(): Promise<boolean> {
    if (cachedKey) {
      return true;
    }
    const stored = await secureStore.getVaultKey();
    if (!stored) {
      return false;
    }
    cachedKey = Buffer.from(stored, 'base64');
    return true;
  },

  async lock(): Promise<void> {
    cachedKey = null;
    keyring = null;
    await secureStore.clearVaultKey();
    await secureStore.clearVaultKeyring();
    logger.info('vault', 'Encryption key cleared from this device');
  },

  async requireKey(): Promise<Buffer> {
    if (await this.isUnlocked()) {
      return cachedKey as Buffer;
    }
    throw new VaultLockedError(
      'No encryption passphrase set. Add one in Settings before syncing an encrypted folder.',
    );
  },

  /**
   * Encrypts `srcPath` into `destPath`, a chunk at a time.
   *
   * Never holds the whole file in memory, so a multi-GB video encrypts in the
   * same footprint as a photo.
   *
   * Resolves to the SHA-256 (hex) of the plaintext, hashed from the chunks
   * already being read, so the index gets a content hash at no extra I/O.
   */
  async encryptFile(srcPath: string, destPath: string): Promise<string> {
    const key = await this.requireKey();
    const salt = await getOrCreateSalt();
    const iv = QuickCrypto.randomBytes(IV_BYTES) as unknown as Buffer;

    const stat = await ReactNativeBlobUtil.fs.stat(srcPath);
    const size = Number(stat.size);

    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, iv);
    const hash = QuickCrypto.createHash('sha256');

    const header = Buffer.concat([
      Buffer.from(MAGIC, 'ascii'),
      Buffer.from([VERSION]),
      salt,
      iv,
    ]);
    await ReactNativeBlobUtil.fs.createFile(
      destPath,
      header.toString('base64'),
      'base64',
    );

    const tmpChunk = `${destPath}.chunk`;
    try {
      for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, size);
        await ReactNativeBlobUtil.fs.slice(srcPath, tmpChunk, offset, end);
        const base64 = (await ReactNativeBlobUtil.fs.readFile(
          tmpChunk,
          'base64',
        )) as string;
        const plain = Buffer.from(base64, 'base64');
        hash.update(plain);
        const encrypted = cipher.update(plain);
        if (encrypted.length > 0) {
          await ReactNativeBlobUtil.fs.appendFile(
            destPath,
            Buffer.from(encrypted).toString('base64'),
            'base64',
          );
        }
      }

      const finalBlock = cipher.final();
      const tag = cipher.getAuthTag();
      const trailer = Buffer.concat([
        Buffer.from(finalBlock),
        Buffer.from(tag),
      ]);
      await ReactNativeBlobUtil.fs.appendFile(
        destPath,
        trailer.toString('base64'),
        'base64',
      );
      return hash.digest('hex') as string;
    } finally {
      try {
        await ReactNativeBlobUtil.fs.unlink(tmpChunk);
      } catch {
        // Best effort.
      }
    }
  },

  /**
   * Encrypts a small in-memory payload (a caption tag, the private half of
   * the index snapshot) with the vault key.
   *
   * Layout: magic "TGBS" | version | salt (16) | iv (12) | ciphertext | tag (16).
   * The salt rides along for the same reason as in file headers: another
   * install can find or derive the right key from it.
   */
  async sealBytes(plain: Buffer): Promise<Buffer> {
    const key = await this.requireKey();
    const salt = await getOrCreateSalt();
    const iv = QuickCrypto.randomBytes(IV_BYTES) as unknown as Buffer;
    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
      Buffer.from(cipher.update(plain)),
      Buffer.from(cipher.final()),
    ]);
    return Buffer.concat([
      Buffer.from(SEALED_MAGIC, 'ascii'),
      Buffer.from([VERSION]),
      salt,
      iv,
      body,
      Buffer.from(cipher.getAuthTag()),
    ]);
  },

  /**
   * Opens a payload from sealBytes. Key selection and the passphrase retry
   * work exactly like decryptFile, including remembering a key that verifies.
   */
  async openBytes(
    sealed: Buffer,
    options: { passphrase?: string } = {},
  ): Promise<Buffer> {
    const headerBytes = 4 + 1 + SALT_BYTES + IV_BYTES;
    if (
      sealed.length < headerBytes + TAG_BYTES ||
      sealed.subarray(0, 4).toString('ascii') !== SEALED_MAGIC
    ) {
      throw new Error('Not a sealed vault payload.');
    }
    if (sealed[4] !== VERSION) {
      throw new Error(`Unsupported sealed payload version ${sealed[4]}.`);
    }
    const salt = Buffer.from(sealed.subarray(5, 5 + SALT_BYTES));
    const saltB64 = salt.toString('base64');
    const iv = Buffer.from(sealed.subarray(5 + SALT_BYTES, headerBytes));
    const body = sealed.subarray(headerBytes, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);

    const keys = options.passphrase
      ? [deriveKey(options.passphrase, salt)]
      : await candidateKeys(saltB64);
    if (keys.length === 0) {
      throw new VaultPassphraseRequiredError(false);
    }
    for (const key of keys) {
      try {
        const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([
          Buffer.from(decipher.update(body)),
          Buffer.from(decipher.final()),
        ]);
        if (options.passphrase) {
          await rememberKey(saltB64, key);
        }
        return plain;
      } catch {
        // Wrong key for this payload; try the next one.
      }
    }
    throw new VaultPassphraseRequiredError(true);
  },

  /**
   * Decrypts `srcPath` into `destPath`.
   *
   * The key is chosen by the salt in the file's own header, not this install's
   * salt, so backups made on another device or before a reinstall still open.
   * Without `passphrase`, known keys for that salt are tried and
   * VaultPassphraseRequiredError is thrown if none opens the file. With it, the
   * key is derived from the header salt and remembered only once it verifies.
   *
   * Throws if the auth tag does not verify. The partial output is deleted on
   * failure so a corrupted file never masquerades as a restored one.
   */
  async decryptFile(
    srcPath: string,
    destPath: string,
    options: { passphrase?: string } = {},
  ): Promise<void> {
    const stat = await ReactNativeBlobUtil.fs.stat(srcPath);
    const size = Number(stat.size);

    if (size < HEADER_BYTES + TAG_BYTES) {
      throw new Error('File is too small to be an encrypted backup.');
    }

    const tmpChunk = `${destPath}.chunk`;
    const readRange = async (start: number, end: number): Promise<Buffer> => {
      await ReactNativeBlobUtil.fs.slice(srcPath, tmpChunk, start, end);
      const base64 = (await ReactNativeBlobUtil.fs.readFile(
        tmpChunk,
        'base64',
      )) as string;
      return Buffer.from(base64, 'base64');
    };

    try {
      // Header first: it carries the salt this file was encrypted with.
      const header = await readRange(0, HEADER_BYTES);
      if (header.subarray(0, 4).toString('ascii') !== MAGIC) {
        throw new Error('Not an encrypted backup file.');
      }
      if (header[4] !== VERSION) {
        throw new Error(`Unsupported encryption version ${header[4]}.`);
      }
      const salt = Buffer.from(header.subarray(5, 5 + SALT_BYTES));
      const saltB64 = salt.toString('base64');
      const iv = Buffer.from(
        header.subarray(5 + SALT_BYTES, 5 + SALT_BYTES + IV_BYTES),
      );

      // The tag is the last 16 bytes and must be supplied before final().
      const tag = await readRange(size - TAG_BYTES, size);

      const keys = options.passphrase
        ? [deriveKey(options.passphrase, salt)]
        : await candidateKeys(saltB64);
      if (keys.length === 0) {
        throw new VaultPassphraseRequiredError(false);
      }

      for (const key of keys) {
        try {
          await decryptWithKey(readRange, size, destPath, key, iv, tag);
          if (options.passphrase) {
            await rememberKey(saltB64, key);
          }
          return;
        } catch (error) {
          if (!(error instanceof AuthTagError)) {
            throw error;
          }
          // Wrong key for this file; try the next one.
        }
      }
      throw new VaultPassphraseRequiredError(true);
    } catch (error) {
      if (error instanceof VaultPassphraseRequiredError) {
        throw error;
      }
      logger.error('vault', `Decryption failed for ${srcPath}`, error);
      throw new Error(
        `Could not decrypt: ${describeError(error)}. The file may be damaged.`,
      );
    } finally {
      try {
        await ReactNativeBlobUtil.fs.unlink(tmpChunk);
      } catch {
        // Best effort.
      }
    }
  },
};

/**
 * One decryption attempt with one key. Throws AuthTagError when the tag does
 * not verify; either way a failed attempt leaves no output behind.
 */
async function decryptWithKey(
  readRange: (start: number, end: number) => Promise<Buffer>,
  size: number,
  destPath: string,
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
): Promise<void> {
  const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const cipherEnd = size - TAG_BYTES;

  // The first write creates the file and later ones append. Seeding it with
  // an empty base64 payload is not reliable, so track the state instead.
  let created = false;
  const writeOut = async (plain: Buffer): Promise<void> => {
    if (plain.length === 0) {
      return;
    }
    const encoded = plain.toString('base64');
    if (created) {
      await ReactNativeBlobUtil.fs.appendFile(destPath, encoded, 'base64');
    } else {
      await ReactNativeBlobUtil.fs.createFile(destPath, encoded, 'base64');
      created = true;
    }
  };

  try {
    for (let offset = HEADER_BYTES; offset < cipherEnd; offset += CHUNK_SIZE) {
      const end = Math.min(offset + CHUNK_SIZE, cipherEnd);
      const chunk = await readRange(offset, end);
      await writeOut(Buffer.from(decipher.update(chunk)));
    }

    let finalBlock: Buffer;
    try {
      // Throws if the key is wrong or the ciphertext was tampered with.
      finalBlock = Buffer.from(decipher.final());
    } catch (error) {
      throw new AuthTagError(describeError(error));
    }
    await writeOut(finalBlock);

    if (!created) {
      // A legitimately empty payload still needs a file on disk.
      await ReactNativeBlobUtil.fs.createFile(destPath, '', 'utf8');
    }
  } catch (error) {
    try {
      await ReactNativeBlobUtil.fs.unlink(destPath);
    } catch {
      // Best effort.
    }
    throw error;
  }
}
