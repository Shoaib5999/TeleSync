/**
 * `node-localstorage` stub.
 *
 * teleproto's sessions/index.js re-exports StoreSession, which imports this at
 * module load even though we only ever construct a StringSession. The real
 * package reaches for graceful-fs and Node's `constants`, neither of which
 * exists in React Native. Nothing constructs LocalStorage, so a stub that
 * throws when used is enough — and makes a mistaken StoreSession obvious.
 */
class LocalStorage {
  constructor() {
    throw new Error(
      '[TelegramBackup] StoreSession is unsupported in React Native. Use StringSession; ' +
        'the session string is persisted in the Android Keystore by services/secure/keychain.ts.',
    );
  }
}

module.exports = { LocalStorage, JSONStorage: LocalStorage };
