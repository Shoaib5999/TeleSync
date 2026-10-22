/**
 * Cross-install decryption.
 *
 * Every install generates its own KDF salt, so the same passphrase yields a
 * different key on a new phone or after a reinstall. These tests pin down that
 * a backup made by one install still opens on another, via the salt stored in
 * each file's header, and that same-install decryption is unchanged.
 *
 * Node's crypto stands in for react-native-quick-crypto (same API) and a temp
 * directory for react-native-blob-util.
 */
// Node built-ins via require: the project has no @types/node, and these only
// run under Jest.
const nodeFs = require('fs');
const os = require('os');
const path = require('path');

/** One "install": its config table and Keychain. Swapped to simulate a reinstall. */
let mockConfig = new Map<string, string>();
let mockKeychain = new Map<string, string>();

jest.mock('react-native-quick-crypto', () => require('crypto'));

jest.mock('react-native-blob-util', () => {
  const fs = require('fs');
  return {
    fs: {
      stat: async (p: string) => ({ size: fs.statSync(p).size }),
      exists: async (p: string) => fs.existsSync(p),
      unlink: async (p: string) => fs.rmSync(p, { force: true }),
      slice: async (src: string, dest: string, start: number, end: number) => {
        const fd = fs.openSync(src, 'r');
        const buf = Buffer.alloc(end - start);
        fs.readSync(fd, buf, 0, end - start, start);
        fs.closeSync(fd);
        fs.writeFileSync(dest, buf);
      },
      readFile: async (p: string, enc: string) =>
        fs.readFileSync(p).toString(enc),
      createFile: async (p: string, data: string, enc: string) =>
        fs.writeFileSync(p, Buffer.from(data, enc)),
      appendFile: async (p: string, data: string, enc: string) =>
        fs.appendFileSync(p, Buffer.from(data, enc)),
    },
  };
});

jest.mock('../../db/schema', () => ({
  configRepo: {
    getValue: async (key: string) => mockConfig.get(key) ?? null,
    setValue: async (key: string, value: string) => {
      mockConfig.set(key, value);
    },
  },
}));

jest.mock('../../secure/keychain', () => {
  const store = (name: string) => ({
    get: async () => mockKeychain.get(name) ?? null,
    set: async (value: string) => {
      mockKeychain.set(name, value);
    },
    clear: async () => {
      mockKeychain.delete(name);
    },
  });
  const key = store('key');
  const ring = store('ring');
  return {
    secureStore: {
      getVaultKey: key.get,
      setVaultKey: key.set,
      clearVaultKey: key.clear,
      getVaultKeyring: ring.get,
      setVaultKeyring: ring.set,
      clearVaultKeyring: ring.clear,
    },
  };
});

jest.mock('../../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  describeError: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
}));

type VaultModule = typeof import('../vault');

/** A fresh app process on the current install: module state starts empty. */
function launchApp(): VaultModule {
  let mod: VaultModule | undefined;
  jest.isolateModules(() => {
    mod = require('../vault');
  });
  return mod as VaultModule;
}

/** A new phone, or the same phone after uninstalling: nothing survives. */
function freshInstall(): VaultModule {
  mockConfig = new Map();
  mockKeychain = new Map();
  return launchApp();
}

const PASSPHRASE = 'correct horse battery staple';

let dir: string;
let original: Buffer;
let originalPath: string;

beforeEach(() => {
  dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
  // 1.3 MB of random bytes: spans several 512 KB chunks plus a partial one.
  original = require('crypto').randomBytes(1_300_000);
  originalPath = path.join(dir, 'photo.jpg');
  nodeFs.writeFileSync(originalPath, original);
});

afterEach(() => {
  nodeFs.rmSync(dir, { recursive: true, force: true });
});

/** Encrypts `original` the way the old phone did during sync. */
async function backupOnOldPhone(): Promise<string> {
  const { vault } = freshInstall();
  await vault.setPassphrase(PASSPHRASE);
  const encrypted = path.join(dir, 'photo.jpg.tgbk');
  await vault.encryptFile(originalPath, encrypted);
  return encrypted;
}

describe('vault decryption across installs', () => {
  it('still decrypts on the same install without asking (unchanged path)', async () => {
    const encrypted = await backupOnOldPhone();
    const { vault } = launchApp(); // app restarted, same install
    const out = path.join(dir, 'out.jpg');

    await vault.decryptFile(encrypted, out);

    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('asks for the passphrase on a new phone, then decrypts', async () => {
    const encrypted = await backupOnOldPhone();
    const { vault, VaultPassphraseRequiredError } = freshInstall();
    // The user sets the same passphrase on the new phone: different salt, so a
    // different key. This is exactly the case that used to fail.
    await vault.setPassphrase(PASSPHRASE);
    const out = path.join(dir, 'out.jpg');

    await expect(vault.decryptFile(encrypted, out)).rejects.toBeInstanceOf(
      VaultPassphraseRequiredError,
    );
    expect(nodeFs.existsSync(out)).toBe(false);

    await vault.decryptFile(encrypted, out, { passphrase: PASSPHRASE });
    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('asks on a new phone even with no passphrase set there', async () => {
    const encrypted = await backupOnOldPhone();
    const { vault, VaultPassphraseRequiredError } = freshInstall();
    const out = path.join(dir, 'out.jpg');

    const error = await vault.decryptFile(encrypted, out).catch((e: any) => e);
    expect(error).toBeInstanceOf(VaultPassphraseRequiredError);
    expect(error.wrongPassphrase).toBe(false);

    await vault.decryptFile(encrypted, out, { passphrase: PASSPHRASE });
    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('remembers the key, so later files and app restarts do not ask again', async () => {
    const encrypted = await backupOnOldPhone();
    freshInstall();
    let { vault } = launchApp();
    await vault.decryptFile(encrypted, path.join(dir, 'a.jpg'), {
      passphrase: PASSPHRASE,
    });

    ({ vault } = launchApp()); // restart on the new phone
    const out = path.join(dir, 'b.jpg');
    await vault.decryptFile(encrypted, out);

    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('rejects a wrong passphrase, leaves no output, and remembers nothing', async () => {
    const encrypted = await backupOnOldPhone();
    const { vault } = freshInstall();
    const out = path.join(dir, 'out.jpg');

    const error = await vault
      .decryptFile(encrypted, out, { passphrase: 'not the passphrase' })
      .catch((e: any) => e);

    expect(error.name).toBe('VaultPassphraseRequiredError');
    expect(error.wrongPassphrase).toBe(true);
    expect(nodeFs.existsSync(out)).toBe(false);
    expect(mockKeychain.has('ring')).toBe(false);
  });

  it('opens files from an older passphrase once it is entered', async () => {
    // Same install, passphrase changed after some files were backed up.
    const oldFile = await backupOnOldPhone();
    const { vault } = launchApp();
    await vault.setPassphrase('a newer passphrase entirely');
    const out = path.join(dir, 'out.jpg');

    const error = await vault.decryptFile(oldFile, out).catch((e: any) => e);
    expect(error.wrongPassphrase).toBe(true);

    await vault.decryptFile(oldFile, out, { passphrase: PASSPHRASE });
    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('still encrypts new uploads that the new phone can read', async () => {
    const { vault } = freshInstall();
    await vault.setPassphrase(PASSPHRASE);
    const encrypted = path.join(dir, 'new.tgbk');
    const out = path.join(dir, 'new.jpg');

    await vault.encryptFile(originalPath, encrypted);
    await vault.decryptFile(encrypted, out);

    expect(nodeFs.readFileSync(out).equals(original)).toBe(true);
  });

  it('reports a damaged file as damaged, not as a passphrase problem', async () => {
    const encrypted = await backupOnOldPhone();
    const { vault } = launchApp();
    const bytes = nodeFs.readFileSync(encrypted);
    bytes[0] = 0; // break the magic
    nodeFs.writeFileSync(encrypted, bytes);

    const error = await vault
      .decryptFile(encrypted, path.join(dir, 'out.jpg'))
      .catch((e: any) => e);
    expect(error.name).not.toBe('VaultPassphraseRequiredError');
    expect(error.message).toMatch(/Not an encrypted backup/);
  });
});

describe('vault plaintext hash and sealed payloads', () => {
  it('returns the SHA-256 of the plaintext while encrypting', async () => {
    const { vault } = freshInstall();
    await vault.setPassphrase(PASSPHRASE);
    const hash = await vault.encryptFile(
      originalPath,
      path.join(dir, 'h.tgbk'),
    );
    const expected = require('crypto')
      .createHash('sha256')
      .update(original)
      .digest('hex');
    expect(hash).toBe(expected);
  });

  it('seals and opens on the same install', async () => {
    const { vault } = freshInstall();
    await vault.setPassphrase(PASSPHRASE);
    const plain = Buffer.from('TS1|1|1||/storage/emulated/0/Secret/a.pdf');
    const sealed = await vault.sealBytes(plain);
    expect(sealed.includes(plain)).toBe(false);
    expect((await vault.openBytes(sealed)).equals(plain)).toBe(true);
  });

  it('opens on a new phone with the passphrase, then without it', async () => {
    let { vault } = freshInstall();
    await vault.setPassphrase(PASSPHRASE);
    const plain = Buffer.from('private index');
    const sealed = await vault.sealBytes(plain);

    ({ vault } = freshInstall());
    const mod = launchApp();
    await expect(mod.vault.openBytes(sealed)).rejects.toBeInstanceOf(
      mod.VaultPassphraseRequiredError,
    );
    const wrong = await mod.vault
      .openBytes(sealed, { passphrase: 'nope nope nope' })
      .catch((e: any) => e);
    expect(wrong.wrongPassphrase).toBe(true);

    expect(
      (await mod.vault.openBytes(sealed, { passphrase: PASSPHRASE })).equals(
        plain,
      ),
    ).toBe(true);
    // Remembered: later payloads open without asking (no KDF per tag).
    expect((await launchApp().vault.openBytes(sealed)).equals(plain)).toBe(
      true,
    );
  });

  it('rejects a tampered payload', async () => {
    const { vault } = freshInstall();
    await vault.setPassphrase(PASSPHRASE);
    const sealed = await vault.sealBytes(Buffer.from('hello'));
    // Flip one ciphertext byte.
    sealed[sealed.length - 20] = (sealed[sealed.length - 20] + 1) % 256;
    await expect(vault.openBytes(sealed)).rejects.toThrow();
  });
});
