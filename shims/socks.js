/**
 * `socks` stub. Only referenced by teleproto's PromisedNetSockets (TCP path),
 * which React Native never takes. Proxy support would require raw sockets.
 */
module.exports = {
  SocksClient: {
    createConnection: () => {
      throw new Error(
        '[TelegramBackup] SOCKS proxies require raw TCP sockets, unavailable in React Native.',
      );
    },
  },
};
