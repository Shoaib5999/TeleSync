/** Shared domain types. Kept free of any UI or gramjs/teleproto imports. */

export type UploadStatus = 'uploaded' | 'failed' | 'pending';

/** Row in the `files` table. One row per local file we have seen. */
export interface FileRecord {
  id: number;
  local_path: string;
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** Telegram message id in the backup channel. 0 while pending. */
  message_id: number;
  /** Forum topic id (top message id). null = channel root. */
  topic_id: number | null;
  /** Unix seconds. */
  uploaded_at: number;
  status: UploadStatus;
  /** True when the Telegram copy is encrypted and must be decrypted on restore. */
  encrypted: boolean;
  /** Original filename, needed to restore an encrypted blob under its real name. */
  file_name: string | null;
}

/** Row in the `topics` table: a Telegram forum topic we can route files into. */
export interface TopicRecord {
  topic_id: number;
  title: string;
  /** Bound local folder prefix, e.g. /storage/emulated/0/DCIM/Camera. */
  local_folder: string | null;
  /** Opt-in: propose deleting the Telegram copy when a local file disappears. */
  mirror_deletes: boolean;
  /** Opt-in: encrypt every file from this folder before upload. */
  encrypt: boolean;
}

/** A folder -> topic binding as shown in FoldersScreen. */
export interface FolderBinding {
  localFolder: string;
  topicId: number;
  topicTitle: string;
  /** Encrypt every file from this folder before upload. */
  encrypt: boolean;
  /** Propose deleting the Telegram copy when a local file disappears. */
  mirrorDeletes: boolean;
}

/** Everything in SettingsScreen. Secrets live in Keychain, not here. */
export interface AppConfig {
  apiId: number;
  /** Mirrored from Keychain for display only; never persisted to SQLite. */
  apiHash: string;
  /** e.g. -1001234567890 */
  channelId: string;
  throttleSeconds: number;
  maxFileMb: number;
  asDocument: boolean;
  syncIntervalHours: number;
  wifiOnly: boolean;
  requiresCharging: boolean;
  /** Lower-case, no dot: ["jpg", "mp4", "pdf"]. Empty = allow everything. */
  extensions: string[];
  /** Topic used when no folder binding matches. null = channel root. */
  rootTopicId: number | null;
  /**
   * Sweep the whole photo/video library via MediaStore in addition to the
   * bound folders.
   *
   * Off by default: on, a sync uploads every photo on the phone regardless of
   * which folders you bound, which is almost never what someone who just
   * picked one folder expects.
   */
  backupAllMedia: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  apiId: 0,
  apiHash: '',
  channelId: '',
  throttleSeconds: 1,
  maxFileMb: 2000,
  asDocument: true,
  syncIntervalHours: 6,
  wifiOnly: false,
  requiresCharging: false,
  extensions: [],
  rootTopicId: null,
  backupAllMedia: false,
};

export type DeletionStatus = 'pending' | 'approved' | 'dismissed';

/**
 * A local file that vanished from a mirror-enabled folder.
 *
 * Nothing is removed from Telegram on detection. The row sits at 'pending'
 * until the user approves it, which is the only thing that authorises a remote
 * delete.
 */
export interface DeletionRecord {
  id: number;
  local_path: string;
  message_id: number;
  topic_id: number | null;
  size: number;
  /** Unix seconds. */
  detected_at: number;
  status: DeletionStatus;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
  /** Unix milliseconds. */
  ts: number;
  level: LogLevel;
  message: string;
  /** Short scope tag, e.g. "upload", "engine". */
  scope: string;
}

export type SyncPhase =
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'paused'
  | 'cancelled'
  | 'done'
  | 'error';

export interface SyncProgress {
  phase: SyncPhase;
  /** Files finished this run (uploaded + failed). */
  processed: number;
  /** Files queued this run. */
  total: number;
  uploaded: number;
  failed: number;
  /** 0..1 within the file currently uploading. */
  currentFileProgress: number;
  currentFileName: string | null;
  /** Unix ms of the last completed run. */
  lastSyncAt: number | null;
  /** Set when phase === 'error'. */
  errorMessage: string | null;
}

export const INITIAL_PROGRESS: SyncProgress = {
  phase: 'idle',
  processed: 0,
  total: 0,
  uploaded: 0,
  failed: 0,
  currentFileProgress: 0,
  currentFileName: null,
  lastSyncAt: null,
  errorMessage: null,
};

/** A file the scanner found that needs uploading. */
export interface UploadJob {
  localPath: string;
  fileName: string;
  size: number;
  mtime: number;
  topicId: number | null;
  /** Set when replacing a modified file: delete this message first. */
  replacesMessageId: number | null;
  /** Encrypt this file before upload. */
  encrypt: boolean;
}

/**
 * One selectable backup source on the Home screen.
 *
 * `kind: 'folder'` is a bound local folder; `kind: 'all-media'` is the whole
 * MediaStore library, which only appears when backupAllMedia is enabled.
 */
export interface SyncSource {
  id: string;
  kind: 'folder' | 'all-media';
  label: string;
  /** Absolute path for a folder source; null for the library sweep. */
  folder: string | null;
  topicId: number | null;
  topicTitle: string;
  encrypt: boolean;
  mirrorDeletes: boolean;
}

/** Restricts a sync run to a chosen set of sources. */
export interface SyncTarget {
  /** Folders to walk. Empty array means "walk nothing". */
  folders: string[];
  /** Whether to also sweep the MediaStore library. */
  includeAllMedia: boolean;
  /** Shown in logs and the notification. */
  label: string;
}

/** A forum topic as returned by Telegram. */
export interface RemoteTopic {
  id: number;
  title: string;
  closed: boolean;
  /** The "General" topic cannot be deleted or renamed. */
  isGeneral: boolean;
}

export interface TelegramAuthState {
  loggedIn: boolean;
  userId: string | null;
  displayName: string | null;
  phone: string | null;
}
