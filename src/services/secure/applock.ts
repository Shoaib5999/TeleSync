import * as Keychain from 'react-native-keychain';
import QuickCrypto from 'react-native-quick-crypto';

import { logger, describeError } from '../../utils/logger';

/**
 * The Vault's own lock: a PIN or password, optionally fingerprint/face.
 *
 * This guards the screen, not the data. Encrypted backups are already
 * protected by the encryption passphrase; the lock stops someone holding an
 * unlocked phone from browsing the Vault.
 *
 * Only a salted PBKDF2 hash of the PIN is kept, in the Android Keystore, so the
 * PIN itself is never stored. Failed attempts are counted there too, and each
 * run of failures past the first few adds an escalating wait.
 */

export type LockMethod = 'pin' | 'password';

export interface LockSettings {
  method: LockMethod;
  biometrics: boolean;
  /** 0 = lock as soon as you leave the Vault tab or the app. */
  autoLockSeconds: number;
}

interface StoredLock extends LockSettings {
  saltB64: string;
  hashB64: string;
  iterations: number;
}

interface Attempts {
  failed: number;
  /** Unix ms before which no attempt is accepted. */
  lockedUntil: number;
}

const SERVICE_LOCK = 'com.telegrambackup.applock';
const SERVICE_ATTEMPTS = 'com.telegrambackup.applock.attempts';
const SERVICE_BIOMETRIC = 'com.telegrambackup.applock.biometric';
const ACCOUNT = 'vault';

const ITERATIONS = 150_000;
const FREE_ATTEMPTS = 5;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 60 * 60_000;

export const MIN_PIN_LENGTH = 4;
export const MIN_PASSWORD_LENGTH = 6;

async function readJson<T>(service: string): Promise<T | null> {
  try {
    const result = await Keychain.getGenericPassword({ service });
    return result === false ? null : (JSON.parse(result.password) as T);
  } catch (error) {
    logger.error('applock', `Could not read ${service}`, error);
    return null;
  }
}

async function writeJson(service: string, value: unknown): Promise<void> {
  await Keychain.setGenericPassword(ACCOUNT, JSON.stringify(value), {
    service,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK,
  });
}

function hash(secret: string, salt: Buffer, iterations: number): Buffer {
  return QuickCrypto.pbkdf2Sync(
    secret,
    salt,
    iterations,
    32,
    'sha256',
  ) as unknown as Buffer;
}

/** Compares without an early exit, so timing reveals nothing. */
function sameBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // Bitwise on purpose: this is the constant-time comparison.
    // eslint-disable-next-line no-bitwise
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

function lockoutFor(failed: number): number {
  if (failed < FREE_ATTEMPTS) {
    return 0;
  }
  return Math.min(
    MAX_LOCKOUT_MS,
    BASE_LOCKOUT_MS * 2 ** (failed - FREE_ATTEMPTS),
  );
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; waitMs: number; attemptsLeft: number };

export const appLock = {
  async isConfigured(): Promise<boolean> {
    return (await readJson<StoredLock>(SERVICE_LOCK)) !== null;
  },

  async settings(): Promise<LockSettings | null> {
    const stored = await readJson<StoredLock>(SERVICE_LOCK);
    if (!stored) {
      return null;
    }
    return {
      method: stored.method,
      biometrics: stored.biometrics,
      autoLockSeconds: stored.autoLockSeconds,
    };
  },

  /** Sets or replaces the PIN/password. Keeps biometrics and timeout as given. */
  async setSecret(
    method: LockMethod,
    secret: string,
    options: { autoLockSeconds: number; biometrics: boolean },
  ): Promise<void> {
    if (method === 'pin' && !/^\d+$/.test(secret)) {
      throw new Error('A PIN is digits only.');
    }
    const min = method === 'pin' ? MIN_PIN_LENGTH : MIN_PASSWORD_LENGTH;
    if (secret.length < min) {
      throw new Error(
        `Use at least ${min} ${method === 'pin' ? 'digits' : 'characters'}.`,
      );
    }
    const salt = QuickCrypto.randomBytes(16) as unknown as Buffer;
    const stored: StoredLock = {
      method,
      biometrics: options.biometrics,
      autoLockSeconds: options.autoLockSeconds,
      saltB64: salt.toString('base64'),
      hashB64: hash(secret, salt, ITERATIONS).toString('base64'),
      iterations: ITERATIONS,
    };
    await writeJson(SERVICE_LOCK, stored);
    await writeJson(SERVICE_ATTEMPTS, { failed: 0, lockedUntil: 0 });
    logger.info('applock', `Vault lock set (${method})`);
  },

  async updateSettings(
    patch: Partial<Pick<LockSettings, 'autoLockSeconds' | 'biometrics'>>,
  ): Promise<void> {
    const stored = await readJson<StoredLock>(SERVICE_LOCK);
    if (!stored) {
      return;
    }
    await writeJson(SERVICE_LOCK, { ...stored, ...patch });
  },

  /** Milliseconds until another attempt is allowed; 0 when allowed now. */
  async waitRemaining(): Promise<number> {
    const attempts = await readJson<Attempts>(SERVICE_ATTEMPTS);
    return Math.max(0, (attempts?.lockedUntil ?? 0) - Date.now());
  },

  async verify(secret: string): Promise<VerifyResult> {
    const stored = await readJson<StoredLock>(SERVICE_LOCK);
    if (!stored) {
      return { ok: true };
    }
    const attempts = (await readJson<Attempts>(SERVICE_ATTEMPTS)) ?? {
      failed: 0,
      lockedUntil: 0,
    };
    const now = Date.now();
    if (attempts.lockedUntil > now) {
      return {
        ok: false,
        waitMs: attempts.lockedUntil - now,
        attemptsLeft: 0,
      };
    }

    const candidate = hash(
      secret,
      Buffer.from(stored.saltB64, 'base64'),
      stored.iterations,
    );
    if (sameBytes(candidate, Buffer.from(stored.hashB64, 'base64'))) {
      await writeJson(SERVICE_ATTEMPTS, { failed: 0, lockedUntil: 0 });
      return { ok: true };
    }

    const failed = attempts.failed + 1;
    const waitMs = lockoutFor(failed);
    await writeJson(SERVICE_ATTEMPTS, {
      failed,
      lockedUntil: waitMs > 0 ? now + waitMs : 0,
    });
    logger.warn('applock', `Wrong Vault ${stored.method} (${failed} in a row)`);
    return {
      ok: false,
      waitMs,
      attemptsLeft: Math.max(0, FREE_ATTEMPTS - failed),
    };
  },

  /** Removes the lock entirely. Callers must have verified the user first. */
  async remove(): Promise<void> {
    await Keychain.resetGenericPassword({ service: SERVICE_LOCK });
    await Keychain.resetGenericPassword({ service: SERVICE_ATTEMPTS });
    await this.disableBiometrics();
    logger.info('applock', 'Vault lock removed');
  },

  /* ------------------------------------------------------------ biometrics */

  /** 'Fingerprint', 'Face', etc., or null when the phone has none enrolled. */
  async biometryType(): Promise<string | null> {
    try {
      return await Keychain.getSupportedBiometryType();
    } catch {
      return null;
    }
  },

  /**
   * Stores a random token that the Keystore only releases after a successful
   * fingerprint/face check. Reading it back IS the biometric unlock, so
   * nothing in JS can fake it.
   */
  async enableBiometrics(): Promise<void> {
    const token = (QuickCrypto.randomBytes(16) as unknown as Buffer).toString(
      'base64',
    );
    await Keychain.setGenericPassword(ACCOUNT, token, {
      service: SERVICE_BIOMETRIC,
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY,
      storage: Keychain.STORAGE_TYPE.AES_GCM,
      authenticationPrompt: {
        title: 'Enable fingerprint unlock',
        cancel: 'Cancel',
      },
    });
    await this.updateSettings({ biometrics: true });
  },

  async disableBiometrics(): Promise<void> {
    try {
      await Keychain.resetGenericPassword({ service: SERVICE_BIOMETRIC });
    } catch {
      // Nothing stored.
    }
    await this.updateSettings({ biometrics: false });
  },

  /** Prompts for fingerprint/face. Resolves false on cancel or failure. */
  async unlockWithBiometrics(): Promise<boolean> {
    try {
      const result = await Keychain.getGenericPassword({
        service: SERVICE_BIOMETRIC,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY,
        authenticationPrompt: {
          title: 'Unlock Vault',
          cancel: 'Use PIN',
        },
      });
      if (result !== false) {
        await writeJson(SERVICE_ATTEMPTS, { failed: 0, lockedUntil: 0 });
        return true;
      }
      return false;
    } catch (error) {
      logger.info('applock', `Biometric unlock: ${describeError(error)}`);
      return false;
    }
  },
};
