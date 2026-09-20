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

/** Cached derived key, so the KDF runs once per launch rather than per file. */
let cachedKey: Buffer | null = null;

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
    await secureStore.clearVaultKey();
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
   */
  async encryptFile(srcPath: string, destPath: string): Promise<void> {
    const key = await this.requireKey();
    const salt = await getOrCreateSalt();
    const iv = QuickCrypto.randomBytes(IV_BYTES) as unknown as Buffer;

    const stat = await ReactNativeBlobUtil.fs.stat(srcPath);
    const size = Number(stat.size);

    const cipher = QuickCrypto.createCipheriv('aes-256-gcm', key, iv);

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
        const encrypted = cipher.update(Buffer.from(base64, 'base64'));
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
    } finally {
      try {
        await ReactNativeBlobUtil.fs.unlink(tmpChunk);
      } catch {
        // Best effort.
      }
    }
  },

  /**
   * Decrypts `srcPath` into `destPath`.
   *
   * Throws if the auth tag does not verify. The partial output is deleted on
   * failure so a corrupted file never masquerades as a restored one.
   */
  async decryptFile(srcPath: string, destPath: string): Promise<void> {
    const stat = await ReactNativeBlobUtil.fs.stat(srcPath);
    const size = Number(stat.size);

    if (size < HEADER_BYTES + TAG_BYTES) {
      throw new Error('File is too small to be an encrypted backup.');
    }

    const tmpChunk = `${destPath}.chunk`;

    // Header first: it carries the salt this file was encrypted with.
    await ReactNativeBlobUtil.fs.slice(srcPath, tmpChunk, 0, HEADER_BYTES);
    const headerB64 = (await ReactNativeBlobUtil.fs.readFile(
      tmpChunk,
      'base64',
    )) as string;
    const header = Buffer.from(headerB64, 'base64');

    if (header.subarray(0, 4).toString('ascii') !== MAGIC) {
      throw new Error('Not an encrypted backup file.');
    }
    if (header[4] !== VERSION) {
      throw new Error(`Unsupported encryption version ${header[4]}.`);
    }
    const iv = header.subarray(5 + SALT_BYTES, 5 + SALT_BYTES + IV_BYTES);

    const key = await this.requireKey();
    const decipher = QuickCrypto.createDecipheriv('aes-256-gcm', key, iv);

    // The tag is the last 16 bytes and must be supplied before final().
    await ReactNativeBlobUtil.fs.slice(
      srcPath,
      tmpChunk,
      size - TAG_BYTES,
      size,
    );
    const tagB64 = (await ReactNativeBlobUtil.fs.readFile(
      tmpChunk,
      'base64',
    )) as string;
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));

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
      for (
        let offset = HEADER_BYTES;
        offset < cipherEnd;
        offset += CHUNK_SIZE
      ) {
        const end = Math.min(offset + CHUNK_SIZE, cipherEnd);
        await ReactNativeBlobUtil.fs.slice(srcPath, tmpChunk, offset, end);
        const base64 = (await ReactNativeBlobUtil.fs.readFile(
          tmpChunk,
          'base64',
        )) as string;
        await writeOut(
          Buffer.from(decipher.update(Buffer.from(base64, 'base64'))),
        );
      }

      // Throws if the ciphertext was tampered with or the passphrase is wrong.
      await writeOut(Buffer.from(decipher.final()));

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
      logger.error('vault', `Decryption failed for ${srcPath}`, error);
      throw new Error(
        `Could not decrypt: ${describeError(error)}. The passphrase may be wrong, or the file may be damaged.`,
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
