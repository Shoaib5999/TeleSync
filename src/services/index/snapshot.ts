import type { AppConfig, FileRecord, TopicRecord } from '../../types';

/**
 * The index snapshot: the whole `files` table plus folder bindings and
 * settings, gzipped into one small document in the "TeleSync Index" topic.
 *
 * One download restores everything a reinstall loses. Caption tags then cover
 * whatever was uploaded after the snapshot was taken (see restore.ts).
 *
 * Rows and bindings of encrypted folders never go in the plain part: they are
 * sealed with the vault key into `private`, so the snapshot leaks no more than
 * the encrypted uploads themselves do.
 *
 * Pure data shaping only, so it is unit tested directly.
 */

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_FILE_PREFIX = 'telesync-index-';
export const SNAPSHOT_FILE_SUFFIX = '.json.gz';
export const INDEX_TOPIC_TITLE = 'TeleSync Index';

/** [path, size, mtime, messageId, topicId, fileName, contentHash, uploadedAt] */
export type SnapshotRow = [
  string,
  number,
  number,
  number,
  number | null,
  string,
  string | null,
  number,
];

export interface SnapshotTopic {
  id: number;
  title: string;
  /** null in the plain part for encrypted folders; see PrivateBody.topics. */
  folder: string | null;
  mirror: boolean;
  encrypt: boolean;
}

/** Settings worth carrying to a new phone. Credentials and the channel never are. */
export const PORTABLE_SETTINGS = [
  'throttleSeconds',
  'maxFileMb',
  'asDocument',
  'syncIntervalHours',
  'wifiOnly',
  'requiresCharging',
  'extensions',
  'rootTopicId',
  'backupAllMedia',
] as const;

export type PortableSettings = Partial<
  Pick<AppConfig, (typeof PORTABLE_SETTINGS)[number]>
>;

export interface SnapshotBody {
  v: number;
  /** Unix seconds. */
  createdAt: number;
  /** Highest message id the snapshot covers; tags above it are the delta. */
  maxMessageId: number;
  files: SnapshotRow[];
  topics: SnapshotTopic[];
  settings: PortableSettings;
  /** base64 of vault.sealBytes(JSON PrivateBody); null when nothing is private. */
  private: string | null;
}

export interface PrivateBody {
  files: SnapshotRow[];
  topics: { id: number; folder: string | null }[];
}

/** A row ready for filesRepo.insertRecovered. */
export interface RecoveredRow {
  localPath: string;
  size: number;
  mtime: number;
  messageId: number;
  topicId: number | null;
  encrypted: boolean;
  fileName: string;
  contentHash: string | null;
  uploadedAt: number;
}

function toRow(record: FileRecord): SnapshotRow {
  return [
    record.local_path,
    record.size,
    record.mtime,
    record.message_id,
    record.topic_id,
    record.file_name ?? record.local_path.split('/').pop() ?? 'file',
    record.content_hash ? record.content_hash : null,
    record.uploaded_at,
  ];
}

/** Splits the index into what may be stored in the clear and what must be sealed. */
export function buildSnapshotParts(
  records: FileRecord[],
  topics: TopicRecord[],
  config: AppConfig,
  now: number,
): { body: Omit<SnapshotBody, 'private'>; privateBody: PrivateBody | null } {
  const plainRows: SnapshotRow[] = [];
  const privateRows: SnapshotRow[] = [];
  let maxMessageId = 0;

  for (const record of records) {
    if (record.status !== 'uploaded' || record.message_id <= 0) {
      continue;
    }
    maxMessageId = Math.max(maxMessageId, record.message_id);
    (record.encrypted ? privateRows : plainRows).push(toRow(record));
  }

  const privateTopics: PrivateBody['topics'] = [];
  const plainTopics: SnapshotTopic[] = topics.map(topic => {
    if (topic.encrypt && topic.local_folder) {
      privateTopics.push({ id: topic.topic_id, folder: topic.local_folder });
    }
    return {
      id: topic.topic_id,
      title: topic.title,
      folder: topic.encrypt ? null : topic.local_folder,
      mirror: topic.mirror_deletes,
      encrypt: topic.encrypt,
    };
  });

  const settings: PortableSettings = {};
  for (const key of PORTABLE_SETTINGS) {
    (settings as Record<string, unknown>)[key] = config[key];
  }

  const privateBody =
    privateRows.length > 0 || privateTopics.length > 0
      ? { files: privateRows, topics: privateTopics }
      : null;

  return {
    body: {
      v: SNAPSHOT_VERSION,
      createdAt: now,
      maxMessageId,
      files: plainRows,
      topics: plainTopics,
      settings,
    },
    privateBody,
  };
}

function isRow(value: unknown): value is SnapshotRow {
  return (
    Array.isArray(value) &&
    value.length >= 8 &&
    typeof value[0] === 'string' &&
    value[0].startsWith('/') &&
    typeof value[1] === 'number' &&
    typeof value[2] === 'number' &&
    typeof value[3] === 'number' &&
    value[3] > 0 &&
    (value[4] === null || typeof value[4] === 'number') &&
    typeof value[5] === 'string' &&
    (value[6] === null || typeof value[6] === 'string') &&
    typeof value[7] === 'number'
  );
}

/** Validates a downloaded snapshot. Throws on anything not written by this app. */
export function parseSnapshot(json: string): SnapshotBody {
  const raw = JSON.parse(json) as Partial<SnapshotBody>;
  if (!raw || typeof raw !== 'object' || typeof raw.v !== 'number') {
    throw new Error('Not a TeleSync index snapshot.');
  }
  if (raw.v > SNAPSHOT_VERSION) {
    throw new Error(
      `This index was written by a newer version of the app (v${raw.v}). Update the app first.`,
    );
  }
  return {
    v: raw.v,
    createdAt: Number(raw.createdAt) || 0,
    maxMessageId: Number(raw.maxMessageId) || 0,
    files: Array.isArray(raw.files) ? raw.files.filter(isRow) : [],
    topics: Array.isArray(raw.topics)
      ? raw.topics.filter(
          (topic): topic is SnapshotTopic =>
            !!topic &&
            typeof topic.id === 'number' &&
            typeof topic.title === 'string',
        )
      : [],
    settings:
      raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
    private: typeof raw.private === 'string' ? raw.private : null,
  };
}

export function parsePrivateBody(json: string): PrivateBody {
  const raw = JSON.parse(json) as Partial<PrivateBody>;
  return {
    files: Array.isArray(raw.files) ? raw.files.filter(isRow) : [],
    topics: Array.isArray(raw.topics)
      ? raw.topics.filter(topic => !!topic && typeof topic.id === 'number')
      : [],
  };
}

export function rowToRecovered(
  row: SnapshotRow,
  encrypted: boolean,
): RecoveredRow {
  return {
    localPath: row[0],
    size: row[1],
    mtime: row[2],
    messageId: row[3],
    topicId: row[4],
    fileName: row[5],
    contentHash: row[6],
    uploadedAt: row[7],
    encrypted,
  };
}

/**
 * Merges snapshot rows with rows recovered from caption tags. One row per
 * path; the higher message id wins, because a re-upload of a modified file
 * always produces a newer message than the copy it replaced.
 */
export function mergeRecovered(...sources: RecoveredRow[][]): RecoveredRow[] {
  const byPath = new Map<string, RecoveredRow>();
  for (const source of sources) {
    for (const row of source) {
      const current = byPath.get(row.localPath);
      if (!current || row.messageId > current.messageId) {
        byPath.set(row.localPath, row);
      }
    }
  }
  return [...byPath.values()];
}

/**
 * Builds the name+size lookup used to adopt a backup that predates snapshots
 * and tags. Encrypted uploads are stored as "<name>.tgbk" and are exactly 49
 * bytes larger (33-byte header + 16-byte GCM tag; GCM adds no padding).
 */
export const ENCRYPTION_OVERHEAD_BYTES = 49;

export function legacyKey(
  storedName: string,
  storedSize: number,
): { key: string; encrypted: boolean } {
  const encrypted = storedName.toLowerCase().endsWith('.tgbk');
  const name = encrypted ? storedName.slice(0, -'.tgbk'.length) : storedName;
  const size = encrypted ? storedSize - ENCRYPTION_OVERHEAD_BYTES : storedSize;
  return { key: `${name}|${size}`, encrypted };
}
