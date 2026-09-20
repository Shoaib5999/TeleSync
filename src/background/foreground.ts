import {
  DeviceEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

import { syncEngine } from '../services/sync/engine';
import { logger, describeError } from '../utils/logger';
import type { SyncProgress, SyncTarget } from '../types';

/** Native surface implemented by SyncControlModule.kt. */
interface SyncControlNative {
  startService(title: string, text: string): Promise<boolean>;
  updateNotification(
    title: string,
    text: string,
    progress: number,
    max: number,
    paused: boolean,
  ): Promise<boolean>;
  stopService(): Promise<boolean>;
  startHeadlessSync(targetJson: string, manual: boolean): Promise<boolean>;
  showDeletionReview(count: number): Promise<boolean>;
  hasAllFilesAccess(): Promise<boolean>;
  openAllFilesAccessSettings(): Promise<boolean>;
  openBatteryOptimizationSettings(): Promise<boolean>;
}

const SyncControl = NativeModules.SyncControl as SyncControlNative | undefined;

const NOTIFICATION_TITLE = 'Backing up to Telegram';
const COMMAND_EVENT = 'TelegramBackupSyncCommand';

function requireNative(): SyncControlNative {
  if (!SyncControl) {
    throw new Error(
      'SyncControl native module is missing. Rebuild the app (npx react-native run-android) — ' +
        'a JS-only reload will not pick up native changes.',
    );
  }
  return SyncControl;
}

/* ----------------------------------------------------------- permissions */

/** Android 13+ needs an explicit grant before any notification is shown. */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (
    Platform.OS !== 'android' ||
    typeof Platform.Version !== 'number' ||
    Platform.Version < 33
  ) {
    return true;
  }

  const permission = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (await PermissionsAndroid.check(permission)) {
    return true;
  }

  const result = await PermissionsAndroid.request(permission, {
    title: 'Show backup progress',
    message:
      'The app shows a notification while uploading so Android keeps the sync running.',
    buttonPositive: 'Allow',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Media permissions, requested at the point the user first starts a sync. */
export async function ensureMediaPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }

  const version = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const permissions =
    version >= 33
      ? [
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
          PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
        ]
      : [PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE];

  const granted = await PermissionsAndroid.requestMultiple(permissions);
  const allGranted = permissions.every(
    permission => granted[permission] === PermissionsAndroid.RESULTS.GRANTED,
  );

  if (!allGranted) {
    logger.warn(
      'permissions',
      'Media permission denied; photos and videos cannot be scanned',
    );
  }
  return allGranted;
}

/** Prompts the user that deletions are waiting. Never deletes anything. */
export async function notifyPendingDeletions(count: number): Promise<void> {
  if (count <= 0) {
    return;
  }
  try {
    await requireNative().showDeletionReview(count);
  } catch (error) {
    logger.warn(
      'foreground',
      `Could not post deletion review notice: ${describeError(error)}`,
    );
  }
}

export async function hasAllFilesAccess(): Promise<boolean> {
  try {
    return await requireNative().hasAllFilesAccess();
  } catch (error) {
    logger.warn(
      'permissions',
      `Could not check all-files access: ${describeError(error)}`,
    );
    return false;
  }
}

export async function openAllFilesAccessSettings(): Promise<void> {
  await requireNative().openAllFilesAccessSettings();
}

export async function openBatteryOptimizationSettings(): Promise<void> {
  await requireNative().openBatteryOptimizationSettings();
}

/* ------------------------------------------------------- service control */

function describeProgress(progress: SyncProgress): string {
  if (progress.phase === 'scanning') {
    return 'Scanning for new files…';
  }
  if (progress.phase === 'paused') {
    return `Paused — ${progress.processed} of ${progress.total} done`;
  }
  if (progress.total === 0) {
    return 'Nothing to upload';
  }
  const percent = ((progress.processed / progress.total) * 100).toFixed(1);
  return `${progress.processed} of ${progress.total} uploaded (${percent}%)`;
}

let unsubscribeProgress: (() => void) | null = null;
let unsubscribeCommands: (() => void) | null = null;
let lastNotificationText = '';

/** Mirrors engine progress into the notification. */
export function attachProgressMirror(): void {
  unsubscribeProgress?.();
  unsubscribeProgress = syncEngine.subscribe(progress => {
    const text = describeProgress(progress);
    // Android throttles notification updates; skipping no-op posts keeps us
    // well under the limit on fast, small files.
    if (text === lastNotificationText) {
      return;
    }
    lastNotificationText = text;

    requireNative()
      .updateNotification(
        NOTIFICATION_TITLE,
        text,
        progress.processed,
        progress.total,
        progress.phase === 'paused',
      )
      .catch(error =>
        logger.warn(
          'foreground',
          `Notification update failed: ${describeError(error)}`,
        ),
      );
  });
}

/** Wires the notification's Pause / Resume / Stop buttons to the engine. */
export function attachNotificationCommands(): () => void {
  const subscription = DeviceEventEmitter.addListener(
    COMMAND_EVENT,
    (command: string) => {
      logger.info('foreground', `Notification command: ${command}`);
      if (command === 'pause') {
        syncEngine.pause();
      } else if (command === 'resume') {
        syncEngine.resume();
      } else if (command === 'stop') {
        syncEngine.cancel();
      }
    },
  );

  unsubscribeCommands = () => subscription.remove();
  return unsubscribeCommands;
}

/**
 * Starts a foreground sync: permissions, notification, then the engine.
 *
 * Returns when the sync finishes or is cancelled. The service is always torn
 * down, including on failure, so a crashed run cannot strand the notification.
 */
export async function startForegroundSync(target?: SyncTarget): Promise<void> {
  if (syncEngine.isRunning) {
    logger.warn('foreground', 'Sync already running');
    return;
  }

  await ensureNotificationPermission();
  await ensureMediaPermissions();

  const native = requireNative();
  lastNotificationText = '';

  try {
    await native.startService(NOTIFICATION_TITLE, 'Starting…');
  } catch (error) {
    throw new Error(
      `Could not start the backup service: ${describeError(error)}. ` +
        'On Android 12+ this can happen if the app was started from the background.',
    );
  }

  // Hand the actual work to a HeadlessJS task rather than running it here.
  // React Native stops pumping setTimeout once the activity pauses unless a
  // headless task is active — JavaTimerManager's TimerFrameCallback bails out
  // on `isPaused && !isRunningTasks` — which stalled every throttle and backoff
  // sleep the moment the app went to the background. The task shares this JS
  // runtime, so the engine singleton and its progress listeners are unchanged.
  //
  // This returns as soon as the task is dispatched; progress arrives through
  // the engine subscription rather than by awaiting here.
  try {
    await native.startHeadlessSync(target ? JSON.stringify(target) : '', true);
  } catch (error) {
    await stopForegroundService();
    throw new Error(`Could not start the sync task: ${describeError(error)}`);
  }
}

export function detachProgressMirror(): void {
  unsubscribeProgress?.();
  unsubscribeProgress = null;
}

/** Tears down the foreground service once a manual sync has finished. */
export async function stopForegroundService(): Promise<void> {
  detachProgressMirror();
  try {
    await requireNative().stopService();
  } catch (error) {
    logger.warn(
      'foreground',
      `Could not stop service: ${describeError(error)}`,
    );
  }
}

export function pauseSync(): void {
  syncEngine.pause();
}

export function resumeSync(): void {
  syncEngine.resume();
}

export function cancelSync(): void {
  syncEngine.cancel();
}
