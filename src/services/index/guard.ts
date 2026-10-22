import { filesRepo } from '../db/schema';
import { logger, describeError } from '../../utils/logger';
import { latestSnapshotMessage } from './channel';
import { getRestoreState, setRestoreState } from './restoreState';

export { getRestoreState, type RestoreState } from './restoreState';

/**
 * Stops a fresh install from re-uploading a whole backup.
 *
 * With an empty `files` table every file looks new. If the channel already
 * holds an index, the right move is to restore it, so sync refuses to start
 * until the user restores or explicitly declines. Once the table has any row
 * this costs one COUNT and never touches the network.
 */

export const RESTORE_REQUIRED_MESSAGE =
  'This install has no backup index yet, but your channel already has one. ' +
  'Open Settings → Backup index and tap Restore, so files already in Telegram are not uploaded again. ' +
  '(Or choose "Start fresh" there to back everything up again.)';

/** null when sync may run; otherwise the message explaining why not. */
export async function checkRestoreGuard(): Promise<string | null> {
  if ((await filesRepo.count()) > 0) {
    return null;
  }
  if ((await getRestoreState()) !== null) {
    return null;
  }
  try {
    const found = await latestSnapshotMessage(new AbortController().signal);
    if (found === null) {
      await setRestoreState('none');
      return null;
    }
    return RESTORE_REQUIRED_MESSAGE;
  } catch (error) {
    // Cannot tell. Uploading blind could duplicate a whole backup, and a sync
    // that cannot reach the channel would fail anyway, so wait.
    logger.warn('index', `Restore check failed: ${describeError(error)}`);
    return `Could not check the channel for an existing backup index: ${describeError(error)}`;
  }
}
