/**
 * Node `os` shim. teleproto's telegramBaseClient.js calls os.release() and
 * os.type() only to build the default deviceModel / systemVersion it reports to
 * Telegram. We pass those explicitly in client.ts, so these are just safe
 * fallbacks that keep the module from throwing at import time.
 */
const { Platform } = require('react-native');

module.exports = {
  type: () => 'Android',
  release: () => String(Platform.Version ?? ''),
  platform: () => 'android',
  arch: () => 'arm64',
  homedir: () => '/',
  tmpdir: () => '/tmp',
  EOL: '\n',
};
