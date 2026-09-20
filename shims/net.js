/**
 * Node `net` / `node:net` / `tls` stub.
 *
 * React Native has no raw TCP sockets, so teleproto's PromisedNetSockets can
 * never work here. We deliberately do NOT polyfill it: client.ts passes
 * `networkSocket: PromisedWebSockets` so MTProto runs over Telegram's WSS
 * endpoints instead. This stub exists only so the import in
 * extensions/PromisedNetSockets.js resolves at module-load time.
 */
function unsupported() {
  throw new Error(
    '[TelegramBackup] Node "net" sockets are unavailable in React Native. ' +
      'The Telegram client must be constructed with networkSocket: PromisedWebSockets.',
  );
}

module.exports = {
  Socket: unsupported,
  connect: unsupported,
  createConnection: unsupported,
  isIP: () => 0,
  isIPv4: () => false,
  isIPv6: () => false,
};
