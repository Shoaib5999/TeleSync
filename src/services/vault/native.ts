import { NativeModules } from 'react-native';

import { logger, describeError } from '../../utils/logger';

/** Native surface implemented by VaultModule.kt. */
interface VaultNative {
  setSecure(enabled: boolean): Promise<boolean>;
  pdfPageCount(path: string): Promise<number>;
  renderPdfPage(
    path: string,
    page: number,
    width: number,
    outPath: string,
  ): Promise<{ path: string; width: number; height: number }>;
}

const Native = NativeModules.VaultNative as VaultNative | undefined;

function requireNative(): VaultNative {
  if (!Native) {
    throw new Error(
      'VaultNative module is missing. Rebuild the app (npx react-native run-android).',
    );
  }
  return Native;
}

/** Blocks screenshots, recording and the recents preview while true. */
export async function setSecureWindow(enabled: boolean): Promise<void> {
  try {
    await Native?.setSecure(enabled);
  } catch (error) {
    logger.warn(
      'vault',
      `Could not set secure window: ${describeError(error)}`,
    );
  }
}

export function pdfPageCount(path: string): Promise<number> {
  return requireNative().pdfPageCount(path);
}

export function renderPdfPage(
  path: string,
  page: number,
  width: number,
  outPath: string,
): Promise<{ path: string; width: number; height: number }> {
  return requireNative().renderPdfPage(path, page, width, outPath);
}
