/**
 * Node `crypto` / `node:crypto` shim for React Native.
 *
 * teleproto needs a SYNCHRONOUS Node crypto surface:
 *   - createCipheriv("aes-256-cbc" | "AES-256-CTR", key, iv)  (crypto/IGE.js, crypto/CTR.js)
 *   - createDecipheriv(...)                                    (crypto/crypto.js)
 *   - createHash("sha1" | "sha256")                            (Helpers.js)
 *   - pbkdf2Sync(pass, salt, 100000, 64, "sha512")             (Password.js, 2FA SRP)
 *   - randomBytes(n)                                           (Helpers.js)
 *
 * WebCrypto (`crypto.subtle`) cannot back these because it is async-only, so we
 * delegate to react-native-quick-crypto, which exposes the Node API natively
 * over JSI/OpenSSL. A pure-JS fallback would make MTProto unusably slow: every
 * MTProto message is AES-256-IGE encrypted, and a 2 GB upload is ~4000 chunks.
 *
 * quick-crypto also ships an `install()` that overwrites `global.crypto`
 * wholesale. We deliberately do not call it: src/polyfills installs Buffer and
 * react-native-get-random-values provides `crypto.getRandomValues`, and
 * replacing the global would change crypto for every other library too. This
 * alias only affects modules that `require("crypto")`.
 *
 * Algorithm names are case-insensitive here, which matters because teleproto
 * asks for "AES-256-CTR" in caps and "aes-256-cbc" in lower case.
 */
const QuickCrypto = require('react-native-quick-crypto').default;

module.exports = QuickCrypto;
module.exports.default = QuickCrypto;
