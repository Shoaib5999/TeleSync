import { NativeModules } from 'react-native';

import { runSync, syncEngine } from '../services/sync/engine';
import {
  attachProgressMirror,
  detachProgressMirror,
  notifyPendingDeletions,
  stopForegroundService,
} from './foreground';
import { configRepo } from '../services/db/schema';
import { logger, describeError } from '../utils/logger';
import type { SyncTarget } from '../types';

/** Native surface implemented by SyncSchedulerModule.kt. */
interface SyncSchedulerNative {
  schedule(
    intervalHours: number,
    wifiOnly: boolean,
    requiresCharging: boolean,
  ): Promise<boolean>;
  cancel(): Promise<boolean>;
  runNow(): Promise<boolean>;
}

const SyncScheduler = NativeModules.SyncScheduler as
  | SyncSchedulerNative
  | undefined;

function requireNative(): SyncSchedulerNative {
  if (!SyncScheduler) {
    throw new Error(
      'SyncScheduler native module is missing. Rebuild the app — a JS reload does not pick up native changes.',
    );
  }
  return SyncScheduler;
}

/** Registers the periodic job from the current settings. */
export async function scheduleSync(): Promise<void> {
  const config = await configRepo.load();
  try {
    await requireNative().schedule(
      config.syncIntervalHours,
      config.wifiOnly,
      config.requiresCharging,
    );
    logger.info(
      'scheduler',
      `Periodic sync every ${config.syncIntervalHours}h ` +
        `(${config.wifiOnly ? 'unmetered only' : 'any network'}` +
        `${config.requiresCharging ? ', while charging' : ''})`,
    );
  } catch (error) {
    logger.error('scheduler', 'Could not schedule periodic sync', error);
    throw error;
  }
}

export async function cancelScheduledSync(): Promise<void> {
  try {
    await requireNative().cancel();
    logger.info('scheduler', 'Periodic sync cancelled');
  } catch (error) {
    logger.error('scheduler', 'Could not cancel periodic sync', error);
  }
}

/** Queues one immediate run through the same worker the schedule uses. */
export async function runSyncNow(): Promise<void> {
  await requireNative().runNow();
  logger.info('scheduler', 'Queued an immediate sync');
}

/** Data handed to the task by SyncHeadlessTaskService. */
interface HeadlessSyncData {
  /** JSON-encoded SyncTarget, or empty for "everything configured". */
  targetJson?: string;
  /** True when the user pressed Start Sync; false for the scheduled job. */
  manual?: boolean;
}

function parseTarget(data?: HeadlessSyncData): SyncTarget | undefined {
  if (!data?.targetJson) {
    return undefined;
  }
  try {
    return JSON.parse(data.targetJson) as SyncTarget;
  } catch (error) {
    logger.warn(
      'scheduler',
      `Ignoring unreadable sync target: ${describeError(error)}`,
    );
    return undefined;
  }
}

/**
 * The single headless entry point, registered in index.js.
 *
 * BOTH paths come through here: the scheduled WorkManager job and the user's
 * Start Sync button. That is deliberate — React Native only keeps JS timers
 * running while a headless task is active, so a sync driven from the UI context
 * stalls as soon as the app is backgrounded. Running everything as a task means
 * background throughput matches foreground.
 */
export async function headlessSyncTask(data?: HeadlessSyncData): Promise<void> {
  const target = parseTarget(data);
  const manual = data?.manual === true;

  // A second task arriving while one is in flight (double tap, or a scheduled
  // run landing on top of a manual one) must not touch the service: its
  // `finally` would tear down the notification of the sync still running.
  if (syncEngine.isRunning) {
    logger.warn(
      'scheduler',
      'A sync is already running; ignoring this duplicate task',
    );
    return;
  }

  logger.info(
    'scheduler',
    `Headless sync started (${manual ? 'manual' : 'scheduled'})`,
  );

  // Keep the notification in step with progress for whichever service owns it.
  attachProgressMirror();

  try {
    const progress = await runSync(target);
    logger.info(
      'scheduler',
      `Headless sync finished: ${progress.uploaded} uploaded, ${progress.failed} failed`,
    );
    if (syncEngine.pendingDeletionNotice > 0) {
      await notifyPendingDeletions(syncEngine.pendingDeletionNotice);
      syncEngine.pendingDeletionNotice = 0;
    }
  } catch (error) {
    // Swallowing keeps the native task resolving cleanly; the worker decides
    // whether to retry based on its own result.
    logger.error('scheduler', `Headless sync failed: ${describeError(error)}`);
  } finally {
    if (manual) {
      // Only the manual path owns SyncForegroundService. The scheduled path
      // runs under WorkManager's own foreground service, which WorkManager
      // tears down itself once the worker returns.
      await stopForegroundService();
    } else {
      detachProgressMirror();
    }
  }
}
