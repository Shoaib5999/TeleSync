/**
 * Node `fs` stub.
 *
 * teleproto's client/uploads.js and client/downloads.js require "fs" at module
 * load time to support Node file paths. We never use those helpers: upload.ts
 * implements its own chunked uploader on top of react-native-blob-util and
 * calls Api.upload.SaveBigFilePart / SaveFilePart directly. This stub keeps the
 * import resolvable and fails loudly if a Node-only path is ever hit.
 */
function unsupported(name) {
  return () => {
    throw new Error(
      `[TelegramBackup] fs.${name} is not available in React Native. ` +
        'Use services/telegram/upload.ts, which streams via react-native-blob-util.',
    );
  };
}

/**
 * teleproto's closeWriter and returnWriterValue both run
 * `writer instanceof fs.WriteStream`. Without this class that is
 * `instanceof undefined`, which throws a TypeError and breaks every download.
 * Nothing constructs it; it exists purely so the instanceof check returns false.
 */
class WriteStream {}

module.exports = {
  WriteStream,
  promises: {
    open: unsupported('promises.open'),
    readFile: unsupported('promises.readFile'),
    stat: unsupported('promises.stat'),
  },
  createReadStream: unsupported('createReadStream'),
  readFileSync: unsupported('readFileSync'),
  statSync: unsupported('statSync'),
  existsSync: () => false,
};
