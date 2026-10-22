import { logger, describeError } from '../../utils/logger';
import type { SyncProgress } from '../../types';
import { backfillHashes } from './backfill';
import { maybePublishSnapshot } from './publish';
import { feedSearchIndex } from '../search/feeder';

/**
 * Housekeeping after a sync run, called by the headless task once the engine
 * has finished. Each step is independent and best effort: none of them may
 * turn a successful backup into a failed one.
 */
export async function afterSync(progress: SyncProgress): Promise<void> {
  if (progress.phase !== 'done') {
    return;
  }
  await step('hash backfill', () => backfillHashes());
  await step('index snapshot', () => maybePublishSnapshot());
  // Queues analysis of the new files; the work itself runs natively later.
  await step('search feed', () => feedSearchIndex());
}

async function step(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    logger.warn('index', `${label} skipped: ${describeError(error)}`);
  }
}
