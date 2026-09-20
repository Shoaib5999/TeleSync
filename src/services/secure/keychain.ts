import * as Keychain from 'react-native-keychain';
import { logger } from '../../utils/logger';

/**
 * Secrets store, backed by the Android Keystore via react-native-keychain.
 *
 * Only two things ever go in here: the Telegram api_hash and the MTProto
 * StringSession. Both are account-takeover credentials, so they must never
 * touch AsyncStorage/MMKV, which are plain files in the app sandbox and are
 * readable on a rooted device or via a debug backup.
 */
const SERVICE_SESSION = 'com.telegrambackup.session';
const SERVICE_API_HASH = 'com.telegrambackup.apihash';
const SERVICE_VAULT_KEY = 'com.telegrambackup.vaultkey';

/** Keychain stores username/password pairs; we only need the password half. */
const ACCOUNT = 'telegram';

const ACCESSIBLE = Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK;

async function write(service: string, value: string): Promise<void> {
  await Keychain.setGenericPassword(ACCOUNT, value, {
    service,
    accessible: ACCESSIBLE,
  });
}

async function read(service: string): Promise<string | null> {
  const result = await Keychain.getGenericPassword({ service });
  return result === false ? null : result.password;
}

async function clear(service: string): Promise<void> {
  await Keychain.resetGenericPassword({ service });
}

export const secureStore = {
  async setSession(session: string): Promise<void> {
    try {
      await write(SERVICE_SESSION, session);
    } catch (error) {
      logger.error('keychain', 'Failed to persist session', error);
      throw error;
    }
  },

  async getSession(): Promise<string | null> {
    try {
      return await read(SERVICE_SESSION);
    } catch (error) {
      logger.error('keychain', 'Failed to read session', error);
      return null;
    }
  },

  async clearSession(): Promise<void> {
    try {
      await clear(SERVICE_SESSION);
    } catch (error) {
      logger.error('keychain', 'Failed to clear session', error);
    }
  },

  async setApiHash(apiHash: string): Promise<void> {
    try {
      await write(SERVICE_API_HASH, apiHash);
    } catch (error) {
      logger.error('keychain', 'Failed to persist api hash', error);
      throw error;
    }
  },

  async getApiHash(): Promise<string | null> {
    try {
      return await read(SERVICE_API_HASH);
    } catch (error) {
      logger.error('keychain', 'Failed to read api hash', error);
      return null;
    }
  },

  /**
   * The derived encryption key. Never leaves the device and is never uploaded;
   * Telegram only ever sees ciphertext.
   */
  async setVaultKey(keyBase64: string): Promise<void> {
    try {
      await write(SERVICE_VAULT_KEY, keyBase64);
    } catch (error) {
      logger.error('keychain', 'Failed to persist vault key', error);
      throw error;
    }
  },

  async getVaultKey(): Promise<string | null> {
    try {
      return await read(SERVICE_VAULT_KEY);
    } catch (error) {
      logger.error('keychain', 'Failed to read vault key', error);
      return null;
    }
  },

  async clearVaultKey(): Promise<void> {
    try {
      await clear(SERVICE_VAULT_KEY);
    } catch (error) {
      logger.error('keychain', 'Failed to clear vault key', error);
    }
  },

  async clearApiHash(): Promise<void> {
    try {
      await clear(SERVICE_API_HASH);
    } catch (error) {
      logger.error('keychain', 'Failed to clear api hash', error);
    }
  },
};
