import '../../polyfills';

import { Api, TelegramClient, extensions, sessions } from 'teleproto';
import { Platform } from 'react-native';

import { secureStore } from '../secure/keychain';
import { configRepo } from '../db/schema';
import { logger, describeError } from '../../utils/logger';
import type { TelegramAuthState } from '../../types';

const { StringSession } = sessions;
const { PromisedWebSockets } = extensions;

const APP_VERSION = '1.0.0';

/**
 * Single shared MTProto client.
 *
 * Both the foreground service loop and the headless WorkManager task import
 * this module, and in React Native they share one JS runtime, so a module-level
 * singleton keeps exactly one authorised connection alive instead of racing two
 * sessions against the same auth key.
 */
let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;

export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotConfiguredError';
  }
}

export interface ApiCredentials {
  apiId: number;
  apiHash: string;
}

/** Reads API credentials from settings + Keychain. */
export async function getApiCredentials(): Promise<ApiCredentials> {
  const config = await configRepo.load();
  const apiHash = await secureStore.getApiHash();

  if (!config.apiId || !apiHash) {
    throw new NotConfiguredError(
      'Telegram API ID / API hash are not set. Add them in Settings (get them from https://my.telegram.org).',
    );
  }
  return { apiId: config.apiId, apiHash };
}

function buildClient(
  session: InstanceType<typeof StringSession>,
  creds: ApiCredentials,
): TelegramClient {
  return new TelegramClient(session, creds.apiId, creds.apiHash, {
    // React Native has no raw TCP sockets. PromisedWebSockets makes teleproto
    // use Telegram's WSS endpoints and switches the transport to
    // ConnectionTCPObfuscated automatically (see telegramBaseClient).
    networkSocket: PromisedWebSockets,
    connectionRetries: 5,
    retryDelay: 2000,
    autoReconnect: true,
    // Short floods are slept off inside teleproto; anything longer surfaces as
    // a FloodWaitError that upload.ts handles with its own backoff so the
    // foreground notification can show the wait.
    floodSleepThreshold: 60,
    deviceModel: `Android ${Platform.Version}`,
    systemVersion: String(Platform.Version),
    appVersion: APP_VERSION,
    langCode: 'en',
    systemLangCode: 'en',
  });
}

/**
 * Returns a connected client, reusing the stored session when there is one.
 * Throws NotConfiguredError when credentials are missing, so callers can send
 * the user to Settings instead of retrying forever.
 */
export async function getClient(): Promise<TelegramClient> {
  if (client && client.connected) {
    return client;
  }
  if (connecting) {
    return connecting;
  }

  connecting = (async () => {
    try {
      const creds = await getApiCredentials();
      const stored = await secureStore.getSession();
      const session = new StringSession(stored ?? '');

      const instance = client ?? buildClient(session, creds);
      await instance.connect();

      client = instance;
      logger.info('telegram', 'Connected to Telegram');
      return instance;
    } catch (error) {
      logger.error('telegram', 'Failed to connect', error);
      client = null;
      throw error;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

/** Persists the current session string to the Keychain. */
async function persistSession(instance: TelegramClient): Promise<void> {
  const saved = instance.session.save();
  if (typeof saved === 'string' && saved.length > 0) {
    await secureStore.setSession(saved);
  }
}

export async function isLoggedIn(): Promise<boolean> {
  try {
    const stored = await secureStore.getSession();
    if (!stored) {
      return false;
    }
    const instance = await getClient();
    return await instance.checkAuthorization();
  } catch (error) {
    logger.warn(
      'telegram',
      `Authorisation check failed: ${describeError(error)}`,
    );
    return false;
  }
}

export async function getAuthState(): Promise<TelegramAuthState> {
  const empty: TelegramAuthState = {
    loggedIn: false,
    userId: null,
    displayName: null,
    phone: null,
  };
  try {
    if (!(await isLoggedIn())) {
      return empty;
    }
    const instance = await getClient();
    const me = await instance.getMe();
    if (!(me instanceof Api.User)) {
      return empty;
    }
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ');
    return {
      loggedIn: true,
      userId: me.id.toString(),
      displayName: name || me.username || me.id.toString(),
      phone: me.phone ?? null,
    };
  } catch (error) {
    logger.warn(
      'telegram',
      `Could not read account details: ${describeError(error)}`,
    );
    return empty;
  }
}

/* ------------------------------------------------------------------ login */

export type LoginStep =
  | 'idle'
  | 'sending-code'
  | 'awaiting-code'
  | 'awaiting-password'
  | 'signing-in'
  | 'done'
  | 'error';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drives teleproto's callback-style `client.start()` from a multi-screen UI.
 *
 * teleproto asks for the code and the 2FA password through callbacks, which it
 * only invokes when it actually needs them. We hand it promises that the UI
 * resolves when the user submits each field. The advantage over calling
 * auth.SignIn by hand is that all the fiddly parts — SRP for 2FA, DC
 * migration, code-type handling — stay inside the library.
 */
class LoginFlow {
  private codeDeferred: Deferred<string> | null = null;
  private passwordDeferred: Deferred<string> | null = null;
  private running: Promise<void> | null = null;
  private listeners = new Set<
    (step: LoginStep, error: string | null) => void
  >();

  step: LoginStep = 'idle';
  errorMessage: string | null = null;
  passwordHint: string | null = null;

  subscribe(
    listener: (step: LoginStep, error: string | null) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(step: LoginStep, error: string | null = null): void {
    this.step = step;
    this.errorMessage = error;
    this.listeners.forEach(listener => listener(step, error));
  }

  /** Starts the login. Resolves once the account is fully signed in. */
  async begin(phoneNumber: string): Promise<void> {
    if (this.running) {
      throw new Error('A login is already in progress.');
    }

    const creds = await getApiCredentials();
    // A fresh StringSession: any half-finished previous attempt must not leak in.
    const session = new StringSession('');
    const instance = buildClient(session, creds);
    client = instance;

    this.codeDeferred = deferred<string>();
    this.passwordDeferred = deferred<string>();
    this.emit('sending-code');

    this.running = (async () => {
      try {
        await instance.start({
          phoneNumber: async () => phoneNumber,
          phoneCode: async () => {
            this.emit('awaiting-code');
            return this.codeDeferred!.promise;
          },
          password: async (hint?: string) => {
            this.passwordHint = hint ?? null;
            this.emit('awaiting-password');
            return this.passwordDeferred!.promise;
          },
          onError: async (err: Error) => {
            logger.error('login', 'Telegram rejected the login', err);
            this.emit('error', describeError(err));
            // Returning true stops teleproto retrying with the same input.
            return true;
          },
        });

        await persistSession(instance);
        this.emit('done');
        logger.info('login', 'Signed in and session stored');
      } catch (error) {
        this.emit('error', describeError(error));
        throw error;
      } finally {
        this.running = null;
        this.codeDeferred = null;
        this.passwordDeferred = null;
      }
    })();

    return this.running;
  }

  submitCode(code: string): void {
    if (!this.codeDeferred) {
      throw new Error('Not waiting for a login code.');
    }
    this.emit('signing-in');
    this.codeDeferred.resolve(code.trim());
  }

  submitPassword(password: string): void {
    if (!this.passwordDeferred) {
      throw new Error('Not waiting for a 2FA password.');
    }
    this.emit('signing-in');
    this.passwordDeferred.resolve(password);
  }

  cancel(): void {
    const error = new Error('Login cancelled');
    this.codeDeferred?.reject(error);
    this.passwordDeferred?.reject(error);
    this.codeDeferred = null;
    this.passwordDeferred = null;
    this.running = null;
    this.emit('idle');
  }
}

export const loginFlow = new LoginFlow();

/* ----------------------------------------------------------------- logout */

export async function logout(): Promise<void> {
  try {
    if (client) {
      await client.logOut();
    }
  } catch (error) {
    // Even if Telegram refuses, drop local credentials so the UI is consistent.
    logger.warn('telegram', `Remote logout failed: ${describeError(error)}`);
  } finally {
    await secureStore.clearSession();
    await disconnect();
    logger.info('telegram', 'Logged out and cleared local session');
  }
}

export async function disconnect(): Promise<void> {
  try {
    await client?.destroy();
  } catch (error) {
    logger.warn('telegram', `Disconnect failed: ${describeError(error)}`);
  } finally {
    client = null;
    connecting = null;
  }
}

/** Resolves the configured backup channel to an input peer. */
export async function getChannel(): Promise<Api.TypeInputPeer> {
  const config = await configRepo.load();
  if (!config.channelId) {
    throw new NotConfiguredError('No channel ID set. Add it in Settings.');
  }

  const instance = await getClient();
  try {
    return await instance.getInputEntity(config.channelId);
  } catch (error) {
    throw new Error(
      `Cannot find channel ${config.channelId}. Check the ID is correct (it looks like -1001234567890) ` +
        `and that this account is a member of it. Original error: ${describeError(error)}`,
    );
  }
}

/** The backup channel's display title, or null when it cannot be resolved. */
export async function getChannelTitle(): Promise<string | null> {
  try {
    const config = await configRepo.load();
    if (!config.channelId) {
      return null;
    }
    const instance = await getClient();
    const entity = await instance.getEntity(config.channelId);
    if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
      return entity.title;
    }
    return null;
  } catch (error) {
    // Not fatal: the Home screen falls back to showing the raw id.
    logger.warn(
      'telegram',
      `Could not resolve channel title: ${describeError(error)}`,
    );
    return null;
  }
}

export { Api };
