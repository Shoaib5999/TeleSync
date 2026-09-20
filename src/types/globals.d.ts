/**
 * Buffer is installed on globalThis by src/polyfills/index.ts, and teleproto's
 * own types expect the Node Buffer shape. Declaring it here avoids pulling in
 * all of @types/node, which would wrongly make fs, net and friends look
 * available to React Native code.
 */
import type { Buffer as NodeBuffer } from '@craftzdog/react-native-buffer';

declare global {
  var Buffer: typeof NodeBuffer;
  type Buffer = NodeBuffer;
}

export {};
