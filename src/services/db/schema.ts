import { open, type DB, type Scalar } from '@op-engineering/op-sqlite';
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type DeletionRecord,
  type DeletionStatus,
  type FileRecord,
  type TopicRecord,
  type UploadStatus,
} from '../../types';
import { logger } from '../../utils/logger';

const DB_NAME = 'telegram_backup.sqlite';

let db: DB | null = null;

/** Opens (once) and migrates the database. Safe to call from any entry point. */
export function getDb(): DB {
  if (db) {
    return db;
  }
  db = open({ name: DB_NAME });
  migrate(db);
  return db;
}

function migrate(handle: DB): void {
  // executeSync keeps startup deterministic: the headless WorkManager task may
  // query immediately after import, before any await has run.
  handle.executeSync(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_path TEXT UNIQUE NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      topic_id INTEGER,
      uploaded_at INTEGER NOT NULL,
      status TEXT
    );
  `);
  handle.executeSync(`
    CREATE TABLE IF NOT EXISTS topics (
      topic_id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      local_folder TEXT
    );
  `);
  handle.executeSync(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  handle.executeSync(`
    CREATE TABLE IF NOT EXISTS deletions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      local_path TEXT UNIQUE NOT NULL,
      message_id INTEGER NOT NULL,
      topic_id INTEGER,
      size INTEGER NOT NULL,
      detected_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);

  // Per-folder opt-in for deletion mirroring and encryption. Added after the
  // first release, so they go on with ALTER and a guard rather than being part
  // of the CREATE above.
  addColumnIfMissing(
    handle,
    'topics',
    'mirror_deletes',
    'INTEGER NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(handle, 'topics', 'encrypt', 'INTEGER NOT NULL DEFAULT 0');
  // Marks rows whose Telegram copy is encrypted, so restore knows to decrypt
  // even if the folder setting changed afterwards.
  addColumnIfMissing(
    handle,
    'files',
    'encrypted',
    'INTEGER NOT NULL DEFAULT 0',
  );
  addColumnIfMissing(handle, 'files', 'file_name', 'TEXT');
  // SHA-256 of the original bytes. Lets a file whose mtime changed (copied to
  // a new phone, touched by a gallery app) be recognised as unchanged instead
  // of re-uploaded, and is carried in the index snapshot and caption tag.
  addColumnIfMissing(handle, 'files', 'content_hash', 'TEXT');

  handle.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);',
  );
  handle.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_deletions_status ON deletions(status);',
  );
  handle.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_files_topic ON files(topic_id);',
  );
  // The scanner probes by path on every file it sees; without this the scan is O(n^2).
  handle.executeSync(
    'CREATE INDEX IF NOT EXISTS idx_files_path ON files(local_path);',
  );
}

/**
 * Adds a column only when it is absent, so migrating an existing database is
 * idempotent. SQLite has no ADD COLUMN IF NOT EXISTS.
 */
function addColumnIfMissing(
  handle: DB,
  table: string,
  column: string,
  definition: string,
): void {
  const info = handle.executeSync(`PRAGMA table_info(${table});`);
  const exists = info.rows.some(row => String(row.name) === column);
  if (!exists) {
    handle.executeSync(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`,
    );
  }
}

function asNumber(value: Scalar | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function asNullableNumber(value: Scalar | undefined): number | null {
  return value === null || value === undefined ? null : asNumber(value);
}

function asString(value: Scalar | undefined): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function toFileRecord(row: Record<string, Scalar>): FileRecord {
  return {
    id: asNumber(row.id),
    local_path: asString(row.local_path),
    size: asNumber(row.size),
    mtime: asNumber(row.mtime),
    message_id: asNumber(row.message_id),
    topic_id: asNullableNumber(row.topic_id),
    uploaded_at: asNumber(row.uploaded_at),
    status: (asString(row.status) || 'pending') as UploadStatus,
    encrypted: asNumber(row.encrypted) === 1,
    file_name:
      row.file_name === null || row.file_name === undefined
        ? null
        : asString(row.file_name),
    content_hash:
      row.content_hash === null || row.content_hash === undefined
        ? null
        : asString(row.content_hash),
  };
}

function toTopicRecord(row: Record<string, Scalar>): TopicRecord {
  return {
    topic_id: asNumber(row.topic_id),
    title: asString(row.title),
    local_folder:
      row.local_folder === null || row.local_folder === undefined
        ? null
        : asString(row.local_folder),
    mirror_deletes: asNumber(row.mirror_deletes) === 1,
    encrypt: asNumber(row.encrypt) === 1,
  };
}

function toDeletionRecord(row: Record<string, Scalar>): DeletionRecord {
  return {
    id: asNumber(row.id),
    local_path: asString(row.local_path),
    message_id: asNumber(row.message_id),
    topic_id: asNullableNumber(row.topic_id),
    size: asNumber(row.size),
    detected_at: asNumber(row.detected_at),
    status: (asString(row.status) || 'pending') as DeletionStatus,
  };
}

/* ------------------------------------------------------------------ files */

export const filesRepo = {
  async findByPath(localPath: string): Promise<FileRecord | null> {
    const result = await getDb().execute(
      'SELECT * FROM files WHERE local_path = ? LIMIT 1;',
      [localPath],
    );
    const row = result.rows[0];
    return row ? toFileRecord(row) : null;
  },

  /**
   * Records a successful upload. Upserts on local_path so a re-upload of a
   * modified file replaces the old row rather than duplicating it.
   */
  async markUploaded(params: {
    localPath: string;
    size: number;
    mtime: number;
    messageId: number;
    topicId: number | null;
    encrypted: boolean;
    fileName: string;
    /** SHA-256 hex of the original bytes; null when it could not be computed. */
    contentHash?: string | null;
  }): Promise<void> {
    await getDb().execute(
      `INSERT INTO files (local_path, size, mtime, message_id, topic_id, uploaded_at, status, encrypted, file_name, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?)
       ON CONFLICT(local_path) DO UPDATE SET
         size = excluded.size,
         mtime = excluded.mtime,
         message_id = excluded.message_id,
         topic_id = excluded.topic_id,
         uploaded_at = excluded.uploaded_at,
         status = 'uploaded',
         encrypted = excluded.encrypted,
         file_name = excluded.file_name,
         content_hash = excluded.content_hash;`,
      [
        params.localPath,
        params.size,
        params.mtime,
        params.messageId,
        params.topicId,
        Math.floor(Date.now() / 1000),
        params.encrypted ? 1 : 0,
        params.fileName,
        params.contentHash ?? null,
      ],
    );
  },

  /**
   * Accepts a new mtime for a file whose bytes were proven unchanged by hash,
   * so the next scan skips it on the cheap size+mtime check again.
   */
  async updateMtime(localPath: string, mtime: number): Promise<void> {
    await getDb().execute('UPDATE files SET mtime = ? WHERE local_path = ?;', [
      mtime,
      localPath,
    ]);
  },

  async setContentHash(localPath: string, hash: string): Promise<void> {
    await getDb().execute(
      'UPDATE files SET content_hash = ? WHERE local_path = ?;',
      [hash, localPath],
    );
  },

  /** Uploaded rows that predate hashing, for the background backfill. */
  async missingHash(limit: number): Promise<FileRecord[]> {
    const result = await getDb().execute(
      "SELECT * FROM files WHERE status = 'uploaded' AND content_hash IS NULL ORDER BY size ASC LIMIT ?;",
      [limit],
    );
    return result.rows.map(toFileRecord);
  },

  /** Every uploaded row, for the index snapshot and the search feeder. */
  async allUploaded(): Promise<FileRecord[]> {
    const result = await getDb().execute(
      "SELECT * FROM files WHERE status = 'uploaded' ORDER BY id;",
    );
    return result.rows.map(toFileRecord);
  },

  /** Uploaded rows recorded at or after `since` (unix seconds). */
  async uploadedSince(since: number): Promise<FileRecord[]> {
    const result = await getDb().execute(
      "SELECT * FROM files WHERE status = 'uploaded' AND uploaded_at >= ? ORDER BY uploaded_at;",
      [since],
    );
    return result.rows.map(toFileRecord);
  },

  /** Rows for these paths, in one query per 500 (SQLite's variable limit). */
  async byPaths(paths: string[]): Promise<FileRecord[]> {
    const out: FileRecord[] = [];
    for (let i = 0; i < paths.length; i += 500) {
      const slice = paths.slice(i, i + 500);
      const result = await getDb().execute(
        `SELECT * FROM files WHERE local_path IN (${slice.map(() => '?').join(',')});`,
        slice,
      );
      out.push(...result.rows.map(toFileRecord));
    }
    return out;
  },

  async count(): Promise<number> {
    const result = await getDb().execute('SELECT COUNT(*) AS c FROM files;');
    return asNumber(result.rows[0]?.c);
  },

  /**
   * Writes a recovered index in one transaction, so 20k rows land in well
   * under a second and a failure leaves the table exactly as it was.
   * Existing rows win: a restore never overwrites what this install recorded.
   */
  async insertRecovered(
    rows: {
      localPath: string;
      size: number;
      mtime: number;
      messageId: number;
      topicId: number | null;
      encrypted: boolean;
      fileName: string;
      contentHash: string | null;
      uploadedAt: number;
    }[],
  ): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const before = await this.count();
    const sql = `INSERT INTO files (local_path, size, mtime, message_id, topic_id, uploaded_at, status, encrypted, file_name, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?, ?)
       ON CONFLICT(local_path) DO NOTHING;`;
    await getDb().executeBatch(
      rows.map(row => [
        sql,
        [
          row.localPath,
          row.size,
          row.mtime,
          row.messageId,
          row.topicId,
          row.uploadedAt,
          row.encrypted ? 1 : 0,
          row.fileName,
          row.contentHash,
        ],
      ]),
    );
    return (await this.count()) - before;
  },

  /** Every uploaded row whose path sits under `folder`. */
  async uploadedUnder(folder: string): Promise<FileRecord[]> {
    const prefix = folder.replace(/\/+$/, '');
    const result = await getDb().execute(
      "SELECT * FROM files WHERE status = 'uploaded' AND local_path LIKE ? || '/%';",
      [prefix],
    );
    return result.rows.map(toFileRecord);
  },

  async removeByPath(localPath: string): Promise<void> {
    await getDb().execute('DELETE FROM files WHERE local_path = ?;', [
      localPath,
    ]);
  },

  /** Records a permanent failure so the file is not retried every single run. */
  async markFailed(
    localPath: string,
    size: number,
    mtime: number,
  ): Promise<void> {
    await getDb().execute(
      `INSERT INTO files (local_path, size, mtime, message_id, topic_id, uploaded_at, status)
       VALUES (?, ?, ?, 0, NULL, ?, 'failed')
       ON CONFLICT(local_path) DO UPDATE SET
         size = excluded.size,
         mtime = excluded.mtime,
         uploaded_at = excluded.uploaded_at,
         status = 'failed';`,
      [localPath, size, mtime, Math.floor(Date.now() / 1000)],
    );
  },

  async countByStatus(status: UploadStatus): Promise<number> {
    const result = await getDb().execute(
      'SELECT COUNT(*) AS c FROM files WHERE status = ?;',
      [status],
    );
    return asNumber(result.rows[0]?.c);
  },

  async recent(limit = 100): Promise<FileRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM files ORDER BY uploaded_at DESC LIMIT ?;',
      [limit],
    );
    return result.rows.map(toFileRecord);
  },

  async failed(limit = 500): Promise<FileRecord[]> {
    const result = await getDb().execute(
      "SELECT * FROM files WHERE status = 'failed' ORDER BY uploaded_at DESC LIMIT ?;",
      [limit],
    );
    return result.rows.map(toFileRecord);
  },

  /** Clears the 'failed' marker so the next scan retries those files. */
  async resetFailed(): Promise<void> {
    await getDb().execute("DELETE FROM files WHERE status = 'failed';");
  },

  /**
   * Wipes the local index only.
   *
   * This NEVER touches Telegram. Re-running a sync afterwards will re-upload
   * files, producing duplicates in the channel, which is the safe failure mode
   * for a one-way backup.
   */
  async clearAll(): Promise<void> {
    await getDb().execute('DELETE FROM files;');
    logger.warn(
      'db',
      'Local file index cleared. Telegram messages were not touched.',
    );
  },
};

/* ----------------------------------------------------------------- topics */

export const topicsRepo = {
  async all(): Promise<TopicRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM topics ORDER BY title COLLATE NOCASE;',
    );
    return result.rows.map(toTopicRecord);
  },

  /**
   * Inserts or refreshes a topic.
   *
   * Deliberately does not touch mirror_deletes or encrypt: refreshing the topic
   * list from Telegram must never silently re-enable or disable a per-folder
   * safety setting the user chose.
   */
  async upsert(topic: {
    topic_id: number;
    title: string;
    local_folder: string | null;
  }): Promise<void> {
    await getDb().execute(
      `INSERT INTO topics (topic_id, title, local_folder)
       VALUES (?, ?, ?)
       ON CONFLICT(topic_id) DO UPDATE SET
         title = excluded.title,
         local_folder = excluded.local_folder;`,
      [topic.topic_id, topic.title, topic.local_folder],
    );
  },

  async setMirrorDeletes(topicId: number, enabled: boolean): Promise<void> {
    await getDb().execute(
      'UPDATE topics SET mirror_deletes = ? WHERE topic_id = ?;',
      [enabled ? 1 : 0, topicId],
    );
  },

  async setEncrypt(topicId: number, enabled: boolean): Promise<void> {
    await getDb().execute('UPDATE topics SET encrypt = ? WHERE topic_id = ?;', [
      enabled ? 1 : 0,
      topicId,
    ]);
  },

  /** Updates only the title, preserving any folder binding. */
  async setTitle(topicId: number, title: string): Promise<void> {
    await getDb().execute(
      `INSERT INTO topics (topic_id, title, local_folder)
       VALUES (?, ?, NULL)
       ON CONFLICT(topic_id) DO UPDATE SET title = excluded.title;`,
      [topicId, title],
    );
  },

  async bindFolder(topicId: number, localFolder: string | null): Promise<void> {
    await getDb().execute(
      'UPDATE topics SET local_folder = ? WHERE topic_id = ?;',
      [localFolder, topicId],
    );
  },

  async remove(topicId: number): Promise<void> {
    await getDb().execute('DELETE FROM topics WHERE topic_id = ?;', [topicId]);
  },

  /** All topics that have a folder bound, used to build the routing table. */
  async bindings(): Promise<TopicRecord[]> {
    const result = await getDb().execute(
      "SELECT * FROM topics WHERE local_folder IS NOT NULL AND local_folder <> '';",
    );
    return result.rows.map(toTopicRecord);
  },
};

/* -------------------------------------------------------------- deletions */

export const deletionsRepo = {
  /**
   * Records a detected disappearance as 'pending'.
   *
   * Never overwrites an existing row: a file the user already dismissed must
   * stay dismissed instead of reappearing in the review list on every scan.
   */
  async detect(params: {
    localPath: string;
    messageId: number;
    topicId: number | null;
    size: number;
  }): Promise<void> {
    await getDb().execute(
      `INSERT INTO deletions (local_path, message_id, topic_id, size, detected_at, status)
       VALUES (?, ?, ?, ?, ?, 'pending')
       ON CONFLICT(local_path) DO NOTHING;`,
      [
        params.localPath,
        params.messageId,
        params.topicId,
        params.size,
        Math.floor(Date.now() / 1000),
      ],
    );
  },

  async byStatus(status: DeletionStatus): Promise<DeletionRecord[]> {
    const result = await getDb().execute(
      'SELECT * FROM deletions WHERE status = ? ORDER BY detected_at DESC;',
      [status],
    );
    return result.rows.map(toDeletionRecord);
  },

  async countPending(): Promise<number> {
    const result = await getDb().execute(
      "SELECT COUNT(*) AS c FROM deletions WHERE status = 'pending';",
    );
    return asNumber(result.rows[0]?.c);
  },

  async setStatus(id: number, status: DeletionStatus): Promise<void> {
    await getDb().execute('UPDATE deletions SET status = ? WHERE id = ?;', [
      status,
      id,
    ]);
  },

  /** True when this path was already reviewed, so it is not re-proposed. */
  async isKnown(localPath: string): Promise<boolean> {
    const result = await getDb().execute(
      'SELECT 1 FROM deletions WHERE local_path = ? LIMIT 1;',
      [localPath],
    );
    return result.rows.length > 0;
  },

  async clearResolved(): Promise<void> {
    await getDb().execute(
      "DELETE FROM deletions WHERE status IN ('approved', 'dismissed');",
    );
  },
};

/* ----------------------------------------------------------------- config */

/** Keys stored as JSON in the `config` table. api_hash is excluded by design. */
const CONFIG_KEY = 'app_config';

export const configRepo = {
  async load(): Promise<AppConfig> {
    try {
      const result = await getDb().execute(
        'SELECT value FROM config WHERE key = ? LIMIT 1;',
        [CONFIG_KEY],
      );
      const raw = result.rows[0]?.value;
      if (typeof raw !== 'string') {
        return { ...DEFAULT_CONFIG };
      }
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      // Merge over defaults so a config written by an older build stays valid.
      return { ...DEFAULT_CONFIG, ...parsed, apiHash: '' };
    } catch (error) {
      logger.error('db', 'Failed to load config, using defaults', error);
      return { ...DEFAULT_CONFIG };
    }
  },

  async save(config: AppConfig): Promise<void> {
    // apiHash lives in the Keychain; never let it reach SQLite.
    const { apiHash, ...persistable } = config;
    await getDb().execute(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [CONFIG_KEY, JSON.stringify(persistable)],
    );
  },

  async setValue(key: string, value: string): Promise<void> {
    await getDb().execute(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [key, value],
    );
  },

  async getValue(key: string): Promise<string | null> {
    const result = await getDb().execute(
      'SELECT value FROM config WHERE key = ? LIMIT 1;',
      [key],
    );
    const raw = result.rows[0]?.value;
    return typeof raw === 'string' ? raw : null;
  },
};
