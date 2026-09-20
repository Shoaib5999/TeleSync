import { configRepo, deletionsRepo, filesRepo, topicsRepo } from '../db/schema';
import { PermanentUploadError, uploadFile } from '../telegram/upload';
import { getAuthState, NotConfiguredError } from '../telegram/client';
import { logger, describeError } from '../../utils/logger';
import {
  INITIAL_PROGRESS,
  type AppConfig,
  type SyncProgress,
  type SyncSource,
  type SyncTarget,
} from '../../types';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { buildRouter, type Router } from './router';
import { scan } from './scanner';
import { UploadQueue, type JobResult } from './queue';

/**
 * The one sync implementation.
 *
 * Both entry points use it unchanged: the foreground service calls
 * `runSync()` directly, and the WorkManager headless task calls the same
 * function from background/scheduler.ts. Nothing about the loop is specific to
 * either, so there is no second copy to drift out of sync.
 */

/* ===================================================================== *
 *  ONE-WAY BACKUP GUARANTEE
 *
 *  A file disappearing from the phone is NOT a reason to touch Telegram.
 *  There is deliberately no code path here that reads rows out of SQLite,
 *  checks whether the file still exists, and deletes the message. Rows for
 *  deleted files are simply left alone: the backup outlives the original.
 *
 *  The ONLY remote deletion the engine performs is replacing a message whose
 *  file was MODIFIED in place — handled inside uploadFile() via
 *  `replacesMessageId`, and only after the replacement upload has succeeded.
 *
 *  If you are adding a "clean up" or "mirror deletions" feature, it does not
 *  belong in this file.
 * ===================================================================== */

export type ProgressListener = (progress: SyncProgress) => void;

class SyncEngine {
  private controller: AbortController | null = null;
  private paused = false;
  private pauseGate: Promise<void> | null = null;
  private releasePause: (() => void) | null = null;
  private listeners = new Set<ProgressListener>();

  progress: SyncProgress = { ...INITIAL_PROGRESS };

  /** Set by a run that found missing files, so the UI layer can prompt. */
  pendingDeletionNotice = 0;

  get isRunning(): boolean {
    return this.controller !== null;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  subscribe(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    listener(this.progress);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private update(patch: Partial<SyncProgress>): void {
    this.progress = { ...this.progress, ...patch };
    this.listeners.forEach(listener => listener(this.progress));
  }

  /** Blocks while paused. Called between files, never mid-chunk. */
  private async waitWhilePaused(): Promise<void> {
    if (!this.paused) {
      return;
    }
    this.update({ phase: 'paused' });
    await this.pauseGate;
    this.update({ phase: 'uploading' });
  }

  pause(): void {
    if (!this.isRunning || this.paused) {
      return;
    }
    this.paused = true;
    this.pauseGate = new Promise<void>(resolve => {
      this.releasePause = resolve;
    });
    this.update({ phase: 'paused' });
    logger.info('engine', 'Sync paused');
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    this.releasePause?.();
    this.releasePause = null;
    this.pauseGate = null;
    this.update({ phase: 'uploading' });
    logger.info('engine', 'Sync resumed');
  }

  /** Requests cancellation; the run stops at the next file boundary. */
  cancel(): void {
    if (!this.controller) {
      return;
    }
    logger.info('engine', 'Cancelling sync');
    // Release the pause gate first, or an aborted-while-paused run would hang.
    this.paused = false;
    this.releasePause?.();
    this.controller.abort();
  }

  /**
   * Runs one full sync. Safe to call when one is already running: the second
   * call returns the in-flight promise rather than starting a parallel run.
   */
  async run(target?: SyncTarget): Promise<SyncProgress> {
    if (this.controller) {
      logger.warn('engine', 'Sync already running; ignoring duplicate start');
      return this.progress;
    }

    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;

    this.update({
      ...INITIAL_PROGRESS,
      phase: 'scanning',
      lastSyncAt: this.progress.lastSyncAt,
    });

    try {
      const auth = await getAuthState();
      if (!auth.loggedIn) {
        throw new Error('Not logged in to Telegram. Open the app and sign in.');
      }

      const config = await configRepo.load();
      const router = await buildRouter(config.rootTopicId);
      const effectiveTarget = target ?? (await buildDefaultTarget(config));

      if (
        effectiveTarget.folders.length === 0 &&
        !effectiveTarget.includeAllMedia
      ) {
        // Nothing selected. Report it as an error rather than a successful run
        // that silently did nothing — that ambiguity is what made an unbound
        // folder look like a broken sync.
        const message =
          'Nothing selected to back up. Bind a folder to a topic on the Folders tab, ' +
          'or turn on "Back up all photos and videos" in Settings.';
        logger.warn('engine', message);
        this.update({ phase: 'error', errorMessage: message });
        return this.progress;
      }

      logger.info(
        'engine',
        `Starting sync of ${effectiveTarget.label} as ${auth.displayName ?? 'unknown'}`,
      );

      const { jobs, seenPaths } = await scan(
        config,
        router,
        signal,
        effectiveTarget,
      );

      // Propose (never perform) deletions for mirror-enabled folders.
      const proposedDeletions = await detectDeletions(
        router,
        effectiveTarget,
        seenPaths,
      );
      if (proposedDeletions > 0) {
        this.pendingDeletionNotice = proposedDeletions;
      }

      if (jobs.length === 0) {
        this.update({
          phase: 'done',
          total: 0,
          processed: 0,
          lastSyncAt: Date.now(),
        });
        logger.info(
          'engine',
          `Nothing new to upload in ${effectiveTarget.label}`,
        );
        return this.progress;
      }

      this.update({ phase: 'uploading', total: jobs.length });

      const queue = new UploadQueue(jobs);
      const outcome = await queue.run(
        {
          process: async (job): Promise<JobResult> => {
            await this.waitWhilePaused();
            if (signal.aborted) {
              return 'retry';
            }

            this.update({
              currentFileName: job.fileName,
              currentFileProgress: 0,
            });

            try {
              const { messageId } = await uploadFile({
                localPath: job.localPath,
                fileName: job.fileName,
                size: job.size,
                topicId: job.topicId,
                encrypt: job.encrypt,
                asDocument: config.asDocument,
                throttleSeconds: config.throttleSeconds,
                replacesMessageId: job.replacesMessageId,
                signal,
                onProgress: fraction =>
                  this.update({ currentFileProgress: fraction }),
                onFloodWait: seconds =>
                  logger.warn(
                    'engine',
                    `Waiting ${seconds}s for Telegram rate limit`,
                  ),
              });

              await filesRepo.markUploaded({
                localPath: job.localPath,
                size: job.size,
                mtime: job.mtime,
                messageId,
                topicId: job.topicId,
                encrypted: job.encrypt,
                fileName: job.fileName,
              });

              this.update({ uploaded: this.progress.uploaded + 1 });
              return 'uploaded';
            } catch (error) {
              if (signal.aborted) {
                return 'retry';
              }

              // Telegram will never accept this file; record it and move on
              // rather than burning the retry budget every run.
              if (error instanceof PermanentUploadError) {
                logger.error(
                  'engine',
                  `Permanent failure for ${job.fileName}`,
                  error,
                );
                await filesRepo.markFailed(job.localPath, job.size, job.mtime);
                this.update({ failed: this.progress.failed + 1 });
                return 'failed';
              }

              logger.warn(
                'engine',
                `Retryable failure for ${job.fileName}: ${describeError(error)}`,
              );
              return 'retry';
            }
          },
          onProgress: done => this.update({ processed: done }),
        },
        signal,
      );

      if (outcome.cancelled) {
        this.update({ phase: 'cancelled', lastSyncAt: Date.now() });
        logger.info(
          'engine',
          `Sync cancelled after ${outcome.uploaded} upload(s)`,
        );
      } else {
        this.update({
          phase: 'done',
          lastSyncAt: Date.now(),
          currentFileName: null,
        });
        logger.info(
          'engine',
          `Sync finished: ${outcome.uploaded} uploaded, ${outcome.failed} failed`,
        );
      }

      return this.progress;
    } catch (error) {
      const message =
        error instanceof NotConfiguredError
          ? error.message
          : `Sync failed: ${describeError(error)}`;
      logger.error('engine', message);
      this.update({
        phase: 'error',
        errorMessage: message,
        lastSyncAt: Date.now(),
      });
      return this.progress;
    } finally {
      this.controller = null;
      this.paused = false;
      this.releasePause = null;
      this.pauseGate = null;
    }
  }
}

export const syncEngine = new SyncEngine();

/**
 * Flags files that vanished from folders with mirroring enabled.
 *
 * This NEVER deletes anything. It writes 'pending' rows that the user reviews
 * and approves in the Deletions screen; approval is the only thing that
 * authorises a remote delete.
 *
 * The guards matter more than the detection. If a folder is unreadable — SD
 * card unmounted, storage permission revoked, folder renamed — every file in it
 * looks deleted, and acting on that would destroy the only remaining copy. So a
 * folder that is missing, or that returned no files at all, is skipped
 * entirely.
 */
async function detectDeletions(
  router: Router,
  target: SyncTarget,
  seenPaths: Set<string>,
): Promise<number> {
  let total = 0;
  const mirrored = router.bindingList.filter(
    binding =>
      binding.mirrorDeletes && target.folders.includes(binding.localFolder),
  );
  if (mirrored.length === 0) {
    return 0;
  }

  for (const binding of mirrored) {
    const folderExists = await ReactNativeBlobUtil.fs.exists(
      binding.localFolder,
    );
    if (!folderExists) {
      logger.warn(
        'deletions',
        `Skipping deletion check for ${binding.localFolder}: folder is not readable right now`,
      );
      continue;
    }

    const known = await filesRepo.uploadedUnder(binding.localFolder);
    if (known.length === 0) {
      continue;
    }

    const stillPresent = known.filter(row => seenPaths.has(row.local_path));
    if (stillPresent.length === 0) {
      // Every single known file is missing. Far more likely a mount or
      // permission problem than a genuine mass delete.
      logger.warn(
        'deletions',
        `Skipping ${binding.localFolder}: all ${known.length} known files look missing, which usually means the folder is unreadable rather than emptied`,
      );
      continue;
    }

    let proposed = 0;
    for (const row of known) {
      if (seenPaths.has(row.local_path)) {
        continue;
      }
      if (await deletionsRepo.isKnown(row.local_path)) {
        continue;
      }
      await deletionsRepo.detect({
        localPath: row.local_path,
        messageId: row.message_id,
        topicId: row.topic_id,
        size: row.size,
      });
      proposed += 1;
    }

    if (proposed > 0) {
      total += proposed;
      logger.warn(
        'deletions',
        `${proposed} file(s) gone from ${binding.localFolder}. Review them on the Deletions tab; nothing was removed from Telegram.`,
      );
    }
  }

  return total;
}

/**
 * Everything currently configured: every bound folder, plus the whole library
 * when that setting is on. Used by the scheduled job and by "Sync everything".
 */
export async function buildDefaultTarget(
  config: AppConfig,
): Promise<SyncTarget> {
  const bindings = await topicsRepo.bindings();
  const folders = bindings
    .map(topic => topic.local_folder)
    .filter((folder): folder is string => folder !== null && folder.length > 0);

  const parts: string[] = [];
  if (folders.length > 0) {
    parts.push(`${folders.length} folder${folders.length === 1 ? '' : 's'}`);
  }
  if (config.backupAllMedia) {
    parts.push('all photos and videos');
  }

  return {
    folders,
    includeAllMedia: config.backupAllMedia,
    label: parts.length > 0 ? parts.join(' + ') : 'nothing',
  };
}

/** Lists what the user can choose to sync, for the Home screen. */
export async function listSyncSources(
  config: AppConfig,
): Promise<SyncSource[]> {
  const bindings = await topicsRepo.bindings();
  const sources: SyncSource[] = bindings
    .filter(topic => topic.local_folder && topic.local_folder.length > 0)
    .map(topic => ({
      id: `folder:${topic.topic_id}`,
      kind: 'folder' as const,
      label: topic.local_folder as string,
      folder: topic.local_folder as string,
      topicId: topic.topic_id,
      topicTitle: topic.title,
      encrypt: topic.encrypt,
      mirrorDeletes: topic.mirror_deletes,
    }));

  if (config.backupAllMedia) {
    sources.push({
      id: 'all-media',
      kind: 'all-media',
      label: 'All photos and videos',
      folder: null,
      topicId: config.rootTopicId,
      topicTitle: config.rootTopicId
        ? `Topic #${config.rootTopicId}`
        : 'Channel root',
      encrypt: false,
      mirrorDeletes: false,
    });
  }

  return sources;
}

/** Turns a chosen set of sources into a target the engine can run. */
export function targetFromSources(sources: SyncSource[]): SyncTarget {
  const folders = sources
    .filter(source => source.kind === 'folder' && source.folder)
    .map(source => source.folder as string);
  const includeAllMedia = sources.some(source => source.kind === 'all-media');

  const parts: string[] = [];
  if (folders.length > 0) {
    parts.push(`${folders.length} folder${folders.length === 1 ? '' : 's'}`);
  }
  if (includeAllMedia) {
    parts.push('all photos and videos');
  }

  return {
    folders,
    includeAllMedia,
    label: parts.length > 0 ? parts.join(' + ') : 'nothing',
  };
}

/** Convenience wrapper used by both background entry points. */
export async function runSync(target?: SyncTarget): Promise<SyncProgress> {
  return syncEngine.run(target);
}

/** Counts for HomeScreen's summary line. */
export async function getCounts(): Promise<{
  uploaded: number;
  failed: number;
  pending: number;
}> {
  const [uploaded, failed, pending] = await Promise.all([
    filesRepo.countByStatus('uploaded'),
    filesRepo.countByStatus('failed'),
    filesRepo.countByStatus('pending'),
  ]);
  return { uploaded, failed, pending };
}
