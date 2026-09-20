import { deletionsRepo, filesRepo } from '../db/schema';
import { deleteMessage } from '../telegram/upload';
import { logger, describeError } from '../../utils/logger';
import type { DeletionRecord } from '../../types';

/**
 * Review and approval for mirrored deletions.
 *
 * The sync engine only ever proposes. Everything here runs from an explicit tap
 * in the Deletions screen, which is the one and only path by which a local
 * deletion reaches Telegram.
 */

export async function pendingDeletions(): Promise<DeletionRecord[]> {
  return deletionsRepo.byStatus('pending');
}

export async function pendingCount(): Promise<number> {
  return deletionsRepo.countPending();
}

/**
 * Approves one proposal: removes the Telegram message, then drops the local
 * index row so the file could be backed up again if it ever reappears.
 */
export async function approveDeletion(record: DeletionRecord): Promise<void> {
  try {
    await deleteMessage(record.message_id);
    await filesRepo.removeByPath(record.local_path);
    await deletionsRepo.setStatus(record.id, 'approved');
    logger.warn(
      'deletions',
      `Approved: deleted message #${record.message_id} for ${record.local_path}`,
    );
  } catch (error) {
    logger.error(
      'deletions',
      `Could not delete message #${record.message_id}`,
      error,
    );
    throw new Error(`Could not delete from Telegram: ${describeError(error)}`);
  }
}

/**
 * Keeps the Telegram copy and stops re-proposing this path.
 *
 * Without this, a file you deliberately removed from the phone but want kept in
 * the backup would reappear in the review list after every single scan.
 */
export async function dismissDeletion(record: DeletionRecord): Promise<void> {
  await deletionsRepo.setStatus(record.id, 'dismissed');
  logger.info(
    'deletions',
    `Kept the Telegram copy of ${record.local_path}; it will not be proposed again`,
  );
}

export async function approveAll(records: DeletionRecord[]): Promise<{
  deleted: number;
  failed: number;
}> {
  let deleted = 0;
  let failed = 0;
  for (const record of records) {
    try {
      await approveDeletion(record);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { deleted, failed };
}

export async function dismissAll(records: DeletionRecord[]): Promise<void> {
  for (const record of records) {
    await dismissDeletion(record);
  }
}

export async function clearResolved(): Promise<void> {
  await deletionsRepo.clearResolved();
}
