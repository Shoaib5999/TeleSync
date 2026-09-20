/**
 * Node `zlib` shim. teleproto only calls `unzipSync`, in tl/core/GZIPPacked.js,
 * to inflate gzipped MTProto payloads (Telegram gzips larger responses).
 * pako is pure JS but only runs on already-downloaded response bodies, so it is
 * not on the per-chunk upload hot path.
 */
const pako = require('pako');
const { Buffer } = require('@craftzdog/react-native-buffer');

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  return new Uint8Array(Buffer.from(data));
}

/** Node's unzipSync auto-detects gzip vs raw deflate; mirror that. */
function unzipSync(data) {
  const input = toUint8(data);
  const isGzip = input.length > 1 && input[0] === 0x1f && input[1] === 0x8b;
  const out = isGzip ? pako.ungzip(input) : pako.inflate(input);
  return Buffer.from(out);
}

function gzipSync(data) {
  return Buffer.from(pako.gzip(toUint8(data)));
}

function deflateSync(data) {
  return Buffer.from(pako.deflate(toUint8(data)));
}

function inflateSync(data) {
  return Buffer.from(pako.inflate(toUint8(data)));
}

module.exports = { unzipSync, gzipSync, deflateSync, inflateSync };
