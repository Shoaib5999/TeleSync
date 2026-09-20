const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * teleproto (the maintained gramjs fork) is published as Node CommonJS and
 * requires a handful of Node built-ins that React Native does not ship.
 * We redirect each one to a shim in ./shims. See shims/*.js for why each
 * specific module is needed and what teleproto actually calls on it.
 */
const shim = name => path.resolve(__dirname, 'shims', name);

/**
 * `require.resolve('events')` returns Node's *builtin* id ("events"), not a
 * file path, and Metro then fails with "Failed to get the SHA-1 for: events".
 * A trailing slash forces Node to resolve the node_modules package instead.
 */
const pkg = name => require.resolve(`${name}/`);

const NODE_MODULE_ALIASES = {
  // Real crypto, natively accelerated. Required: MTProto encrypts every packet.
  crypto: shim('crypto.js'),
  // Inflate for gzipped MTProto responses.
  zlib: shim('zlib.js'),
  // deviceModel / systemVersion defaults only.
  os: shim('os.js'),
  // Raw TCP is impossible in RN -> we force the WebSocket transport instead.
  net: shim('net.js'),
  tls: shim('net.js'),
  socks: shim('socks.js'),
  // Imported by teleproto's Node upload/download helpers, which we never call.
  fs: shim('fs.js'),

  // Pure-JS equivalents that already exist in node_modules.
  path: require.resolve('path-browserify'),
  buffer: require.resolve('@craftzdog/react-native-buffer'),
  stream: require.resolve('readable-stream'),
  events: pkg('events'),
  process: pkg('process'),
  string_decoder: pkg('string_decoder'),
  util: pkg('util'),

  // Pulled in by teleproto's StoreSession, which we never construct.
  'node-localstorage': shim('node-localstorage.js'),
  constants: shim('empty.js'),

  // Nothing in our path needs these; stub so imports resolve.
  http: shim('empty.js'),
  https: shim('empty.js'),
  assert: shim('empty.js'),
  worker_threads: shim('empty.js'),
};

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  resolver: {
    resolveRequest: (context, moduleName, platform) => {
      // teleproto uses both `require("crypto")` and `require("node:crypto")`.
      const bare = moduleName.startsWith('node:')
        ? moduleName.slice('node:'.length)
        : moduleName;

      const aliased = NODE_MODULE_ALIASES[bare];
      if (aliased) {
        return { type: 'sourceFile', filePath: aliased };
      }

      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
