import { configRepo, filesRepo } from '../db/schema';
import { kindOf, mimeFor } from '../telegram/browse';
import { logger } from '../../utils/logger';
import type { FileRecord } from '../../types';
import {
  requireSearch,
  searchAvailable,
  type SearchHit,
  type SearchItem,
  type SearchStats,
} from './native';

/**
 * Keeps the native search index in step with the backup index.
 *
 * The search index is derived data: it is built from files on this phone and
 * never uploaded, so no recognised text ever reaches Telegram. After a sync,
 * only rows recorded since the last feed are sent (a cursor on uploaded_at);
 * a full feed plus reconcile runs the first time and whenever the two indexes
 * disagree in size (a restore, approved deletions).
 */

const CURSOR_KEY = 'search_feed_cursor';
const ENQUEUE_CHUNK = 500;

export interface SearchSettings {
  /** Read text in every photo, not just likely ones. Slower, more thorough. */
  deepOcr: boolean;
  /** Analyse files from encrypted folders too (results show only while the Vault is unlocked). */
  includeEncrypted: boolean;
  /** Only build the index while charging. */
  chargingOnly: boolean;
}

const SETTINGS_KEYS: Record<keyof SearchSettings, string> = {
  deepOcr: 'search_deep_ocr',
  includeEncrypted: 'search_include_encrypted',
  chargingOnly: 'search_charging_only',
};

const DEFAULTS: SearchSettings = {
  deepOcr: false,
  includeEncrypted: false,
  chargingOnly: true,
};

export async function loadSearchSettings(): Promise<SearchSettings> {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(SETTINGS_KEYS) as (keyof SearchSettings)[]) {
    const raw = await configRepo.getValue(SETTINGS_KEYS[key]);
    if (raw === '1' || raw === '0') {
      out[key] = raw === '1';
    }
  }
  return out;
}

export async function saveSearchSetting(
  key: keyof SearchSettings,
  value: boolean,
): Promise<void> {
  const before = await loadSearchSettings();
  await configRepo.setValue(SETTINGS_KEYS[key], value ? '1' : '0');
  if (!searchAvailable()) {
    return;
  }
  if (key === 'includeEncrypted' && before.includeEncrypted !== value) {
    // Depth is per row: re-feed so encrypted rows gain or lose their analysis.
    await feedSearchIndex({ full: true, replace: true });
  } else if (key === 'deepOcr' && value && !before.deepOcr) {
    await requireSearch().requeueAll();
    await startIndexing(true);
  } else {
    await startIndexing(true);
  }
}

function toItem(record: FileRecord, settings: SearchSettings): SearchItem {
  const name = record.file_name || record.local_path.split('/').pop() || 'file';
  return {
    path: record.local_path,
    messageId: record.message_id,
    topicId: record.topic_id,
    name,
    kind: kindOf(name, mimeFor(name)),
    size: record.size,
    mtime: record.mtime,
    encrypted: record.encrypted,
    deep: !record.encrypted || settings.includeEncrypted,
  };
}

export async function startIndexing(replace: boolean): Promise<void> {
  const settings = await loadSearchSettings();
  await requireSearch().startIndexing(
    settings.deepOcr,
    settings.chargingOnly,
    replace,
  );
}

let feeding: Promise<number> | null = null;

/**
 * Sends new backup rows to the search index and makes sure the worker is
 * queued. Returns how many files are waiting for analysis. Concurrent calls
 * share one run.
 */
export function feedSearchIndex(
  options: { full?: boolean; replace?: boolean } = {},
): Promise<number> {
  if (!searchAvailable()) {
    return Promise.resolve(0);
  }
  if (!feeding) {
    feeding = doFeed(options).finally(() => {
      feeding = null;
    });
  }
  return feeding;
}

async function doFeed(options: {
  full?: boolean;
  replace?: boolean;
}): Promise<number> {
  const native = requireSearch();
  const settings = await loadSearchSettings();
  const cursorRaw = await configRepo.getValue(CURSOR_KEY);
  let full = options.full === true || cursorRaw === null;

  if (!full) {
    // Cheap drift check: one COUNT each side.
    const [stats, uploaded] = await Promise.all([
      native.stats(),
      filesRepo.countByStatus('uploaded'),
    ]);
    full = stats.total !== uploaded;
  }

  const rows = full
    ? await filesRepo.allUploaded()
    : await filesRepo.uploadedSince(Number(cursorRaw));

  for (let i = 0; i < rows.length; i += ENQUEUE_CHUNK) {
    const chunk = rows
      .slice(i, i + ENQUEUE_CHUNK)
      .map(row => toItem(row, settings));
    await native.enqueue(JSON.stringify(chunk));
  }
  if (full) {
    const removed = await native.reconcile(
      JSON.stringify(rows.map(row => row.local_path)),
    );
    if (removed > 0) {
      logger.info(
        'search',
        `Dropped ${removed} file(s) no longer in the backup`,
      );
    }
  }

  const maxUploadedAt = rows.reduce(
    (max, row) => Math.max(max, row.uploaded_at),
    Number(cursorRaw ?? 0),
  );
  await configRepo.setValue(CURSOR_KEY, String(maxUploadedAt));

  const stats = await native.stats();
  if (stats.pending > 0) {
    await native.startIndexing(
      settings.deepOcr,
      settings.chargingOnly,
      options.replace === true,
    );
  }
  if (rows.length > 0) {
    logger.info(
      'search',
      `Search index fed ${rows.length} file(s)${full ? ' (full)' : ''}; ${stats.pending} awaiting analysis`,
    );
  }
  return stats.pending;
}

export async function getSearchStats(): Promise<SearchStats | null> {
  return searchAvailable() ? requireSearch().stats() : null;
}

export interface SearchResult {
  record: FileRecord;
  hit: SearchHit;
}

/**
 * Runs a query and pairs each hit with its backup row, dropping hits whose
 * row is gone (deleted since the last feed). Order is the native ranking.
 */
export async function searchBackup(
  query: string,
  includeEncrypted: boolean,
  limit = 200,
): Promise<SearchResult[]> {
  if (!searchAvailable() || query.trim().length === 0) {
    return [];
  }
  const hits = await requireSearch().search(query, includeEncrypted, limit);
  const records = await filesRepo.byPaths(hits.map(hit => hit.path));
  const byPath = new Map(records.map(record => [record.local_path, record]));
  const out: SearchResult[] = [];
  for (const hit of hits) {
    const record = byPath.get(hit.path);
    if (record && record.status === 'uploaded') {
      out.push({ record, hit });
    }
  }
  return out;
}
