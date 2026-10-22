import ReactNativeBlobUtil from 'react-native-blob-util';

import { filesRepo } from '../db/schema';
import { logger } from '../../utils/logger';
import { hashLocalFile } from './hash';

/**
 * Gives rows uploaded before hashing existed a content hash, so a new phone
 * can recognise those files too.
 *
 * Runs right after a successful sync, when every row it looks at was just
 * confirmed unchanged by the scanner, so hashing the file on disk now gives
 * the hash of what was uploaded. Bounded per run; smallest files first.
 *
 * A row whose file is gone or no longer matches in size gets '' — "cannot be
 * known" — so it is not re-examined on every run. '' is falsy everywhere a
 * hash is read, so it behaves exactly like having no hash.
 */

const BATCH = 200;

export async function backfillHashes(
  budgetMs = 60_000,
  maxFiles = 500,
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let hashed = 0;
  let examined = 0;

  while (examined < maxFiles && Date.now() < deadline) {
    const rows = await filesRepo.missingHash(BATCH);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      if (examined >= maxFiles || Date.now() >= deadline) {
        break;
      }
      examined += 1;
      let hash: string | null = null;
      try {
        const stat = await ReactNativeBlobUtil.fs.stat(row.local_path);
        if (Number(stat.size) === row.size) {
          hash = await hashLocalFile(row.local_path);
          if (hash === null) {
            // Native module missing or a read error: stop rather than marking
            // every remaining row as unknowable.
            return hashed;
          }
        }
      } catch {
        // File gone; fall through to the sentinel.
      }
      await filesRepo.setContentHash(row.local_path, hash ?? '');
      if (hash) {
        hashed += 1;
      }
    }
  }

  if (hashed > 0) {
    logger.info('index', `Hashed ${hashed} previously uploaded file(s)`);
  }
  return hashed;
}
