import ReactNativeBlobUtil from 'react-native-blob-util';
import pako from 'pako';

import { configRepo, filesRepo, getDb, topicsRepo } from '../db/schema';
import { vault } from '../crypto/vault';
import { deleteMessage, uploadFile } from '../telegram/upload';
import { logger, describeError } from '../../utils/logger';
import { findIndexTopicId } from './channel';
import {
  SNAPSHOT_FILE_PREFIX,
  SNAPSHOT_FILE_SUFFIX,
  buildSnapshotParts,
  type SnapshotBody,
} from './snapshot';

/**
 * Publishes the index snapshot into the channel's "TeleSync Index" topic.
 *
 * Only ever posts and deletes its OWN snapshot messages, tracked by id in
 * config. Backed-up files are never touched here.
 */

const SNAPSHOTS_KEY = 'index_snapshots';
/** Keep the newest two: one to restore from, one in case that one is damaged. */
const KEEP_SNAPSHOTS = 2;
/** Publish once this many files were uploaded since the last snapshot... */
const UPLOADS_PER_SNAPSHOT = 200;
/** ...or once a day when anything at all is new. */
const MAX_SNAPSHOT_AGE_SECONDS = 24 * 60 * 60;

export interface SnapshotInfo {
  messageId: number;
  /** Unix seconds. */
  createdAt: number;
  maxMessageId: number;
  files: number;
}

export async function listPublishedSnapshots(): Promise<SnapshotInfo[]> {
  const raw = await configRepo.getValue(SNAPSHOTS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as SnapshotInfo[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function countNewerThan(messageId: number): Promise<number> {
  const result = await getDb().execute(
    "SELECT COUNT(*) AS c FROM files WHERE status = 'uploaded' AND message_id > ?;",
    [messageId],
  );
  return Number(result.rows[0]?.c ?? 0);
}

/** Uploaded files not yet covered by a snapshot (they still have caption tags). */
export async function pendingSinceSnapshot(): Promise<number> {
  const [last] = await listPublishedSnapshots();
  return countNewerThan(last?.maxMessageId ?? 0);
}

let inFlight: Promise<SnapshotInfo | null> | null = null;

/** Builds and posts a snapshot now. Concurrent calls share one run. */
export function publishSnapshot(): Promise<SnapshotInfo | null> {
  if (!inFlight) {
    inFlight = doPublish().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doPublish(): Promise<SnapshotInfo | null> {
  const records = await filesRepo.allUploaded();
  if (records.length === 0) {
    return null;
  }
  const [topics, config] = await Promise.all([
    topicsRepo.all(),
    configRepo.load(),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const { body, privateBody } = buildSnapshotParts(
    records,
    topics,
    config,
    now,
  );

  let sealed: string | null = null;
  if (privateBody) {
    try {
      sealed = (
        await vault.sealBytes(
          Buffer.from(pako.gzip(JSON.stringify(privateBody))),
        )
      ).toString('base64');
    } catch (error) {
      // Without the vault key the private rows cannot be sealed; publishing
      // them in the clear is not an option. They stay recoverable through
      // their own (sealed) caption tags.
      logger.warn(
        'index',
        `Snapshot leaves out ${privateBody.files.length} encrypted file(s): ${describeError(error)}`,
      );
    }
  }

  const full: SnapshotBody = { ...body, private: sealed };
  const gz = Buffer.from(pako.gzip(JSON.stringify(full)));
  const fileName = `${SNAPSHOT_FILE_PREFIX}${now}${SNAPSHOT_FILE_SUFFIX}`;
  const tempPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/${fileName}`;
  await ReactNativeBlobUtil.fs.createFile(
    tempPath,
    gz.toString('base64'),
    'base64',
  );

  try {
    const topicId = await findIndexTopicId(true);
    const fileCount = records.length;
    const { messageId } = await uploadFile({
      localPath: tempPath,
      fileName,
      size: gz.length,
      topicId,
      asDocument: true,
      throttleSeconds: 0,
      replacesMessageId: null,
      encrypt: false,
      signal: new AbortController().signal,
      // Human-readable on purpose, and never a TS1 tag: the snapshot must not
      // be mistaken for a backed-up file during a restore.
      buildCaption: async () =>
        `TeleSync index · ${fileCount} file${fileCount === 1 ? '' : 's'}`,
    });

    const info: SnapshotInfo = {
      messageId,
      createdAt: now,
      maxMessageId: body.maxMessageId,
      files: fileCount,
    };
    const previous = await listPublishedSnapshots();
    const kept = [info, ...previous].slice(0, KEEP_SNAPSHOTS);
    await configRepo.setValue(SNAPSHOTS_KEY, JSON.stringify(kept));

    for (const old of previous.slice(KEEP_SNAPSHOTS - 1)) {
      await deleteMessage(old.messageId);
    }

    logger.info(
      'index',
      `Index snapshot published: ${fileCount} file(s), ${(gz.length / 1024).toFixed(0)} KB`,
    );
    return info;
  } finally {
    try {
      await ReactNativeBlobUtil.fs.unlink(tempPath);
    } catch {
      // Best effort.
    }
  }
}

/**
 * Publishes when the snapshot is stale enough to matter. Cheap to call after
 * every sync: it is two SQLite reads when there is nothing to do.
 */
export async function maybePublishSnapshot(): Promise<void> {
  const [last] = await listPublishedSnapshots();
  const pending = await countNewerThan(last?.maxMessageId ?? 0);
  if (pending === 0) {
    return;
  }
  const age = Math.floor(Date.now() / 1000) - (last?.createdAt ?? 0);
  if (
    last &&
    pending < UPLOADS_PER_SNAPSHOT &&
    age < MAX_SNAPSHOT_AGE_SECONDS
  ) {
    return;
  }
  await publishSnapshot();
}
