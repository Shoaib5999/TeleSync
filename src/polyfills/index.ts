/**
 * Must be imported before anything touches `teleproto`.
 *
 * Hermes ships BigInt (RN >= 0.70) and WebSocket, but not the Node globals the
 * MTProto client assumes. Import order matters: get-random-values installs
 * crypto.getRandomValues, which several downstream polyfills read at load time.
 */
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

import { Buffer } from '@craftzdog/react-native-buffer';

type MutableGlobal = typeof globalThis & {
  Buffer?: unknown;
  process?: {
    env: Record<string, string | undefined>;
    nextTick: (cb: () => void) => void;
    browser?: boolean;
    version?: string;
  };
};

const g = globalThis as MutableGlobal;

if (g.Buffer == null) {
  g.Buffer = Buffer;
}

// teleproto reads process.env / process.nextTick in a few places.
if (g.process == null) {
  g.process = {
    env: {},
    nextTick: (cb: () => void) => setTimeout(cb, 0),
    browser: true,
    version: '',
  };
} else {
  if (g.process.env == null) {
    g.process.env = {};
  }
  if (typeof g.process.nextTick !== 'function') {
    g.process.nextTick = (cb: () => void) => setTimeout(cb, 0);
  }
}

export {};
