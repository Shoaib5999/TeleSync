import { NativeModules } from 'react-native';

import { logger, describeError } from '../../utils/logger';

/** Native surface implemented by FileHashModule.kt. */
interface FileHashNative {
  sha256(path: string): Promise<string>;
}

const Native = NativeModules.FileHash as FileHashNative | undefined;

let warnedMissing = false;

/**
 * SHA-256 hex of a local file, or null when it cannot be computed (module
 * missing after a JS-only reload, file unreadable). Callers treat null as
 * "unknown" and keep their previous behaviour.
 */
export async function hashLocalFile(path: string): Promise<string | null> {
  if (!Native) {
    if (!warnedMissing) {
      warnedMissing = true;
      logger.warn(
        'index',
        'FileHash native module is missing; rebuild the app to enable hash checks.',
      );
    }
    return null;
  }
  try {
    return await Native.sha256(path);
  } catch (error) {
    logger.warn('index', `Could not hash ${path}: ${describeError(error)}`);
    return null;
  }
}
