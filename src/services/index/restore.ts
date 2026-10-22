import ReactNativeBlobUtil from 'react-native-blob-util';
import pako from 'pako';

import { configRepo, filesRepo, topicsRepo } from '../db/schema';
import { vault, VaultPassphraseRequiredError } from '../crypto/vault';
import { downloadMessageToFile } from '../telegram/download';
import { listTopics } from '../telegram/topics';
import { Api } from '../telegram/client';
import { buildRouter } from '../sync/router';
import { scan } from '../sync/scanner';
import { buildDefaultTarget } from '../sync/engine';
import { logger } from '../../utils/logger';
import { readTag } from './caption';
import {
  documentOf,
  existingMessageIds,
  isForumMissing,
  isSnapshotName,
  latestSnapshotMessage,
  topicOf,
  walkHistory,
} from './channel';
import { setRestoreState } from './restoreState';
import {
  SNAPSHOT_FILE_SUFFIX,
  legacyKey,
  mergeRecovered,
  parsePrivateBody,
  parseSnapshot,
  rowToRecovered,
  type PortableSettings,
  type RecoveredRow,
  type SnapshotBody,
  type SnapshotTopic,
} from './snapshot';

/**
 * Rebuilds the local index from the channel.
 *
 *   1. download the newest snapshot (one request)
 *   2. replay caption tags newer than it (GetHistory with minId, so only the
 *      delta is read, not the whole channel)
 *   3. drop rows whose message no longer exists (100 ids per request)
 *   4. write everything in one transaction
 *
 * Existing rows are never overwritten, so running it on a phone that already
 * has an index only fills gaps. Nothing is sent to or deleted from Telegram.
 */

export type RestoreStage =
  | 'snapshot'
  | 'tags'
  | 'verify'
  | 'write'
  | 'scan'
  | 'channel';

export type RestoreProgress = (
  stage: RestoreStage,
  done: number,
  total: number,
) => void;

export interface SnapshotPreview {
  topicId: number | null;
  createdAt: number;
  files: number;
  hasPrivate: boolean;
}

export interface RestoreReport {
  restored: number;
  fromSnapshot: number;
  fromTags: number;
  /** Rows dropped because their message is gone from the channel. */
  missing: number;
  /** Rows already present locally, left as they were. */
  alreadyKnown: number;
  /** Encrypted entries skipped because no passphrase opened them. */
  locked: number;
  /** Portable settings from the snapshot, for the caller to apply. */
  settings: PortableSettings | null;
  snapshotCreatedAt: number | null;
}

export class RestorePassphraseNeeded extends Error {
  readonly wrong: boolean;
  constructor(wrong: boolean) {
    super(
      wrong
        ? 'That passphrase does not open the encrypted part of the index.'
        : 'Part of the index is encrypted. Enter your backup passphrase, or skip the encrypted folders.',
    );
    this.name = 'RestorePassphraseNeeded';
    this.wrong = wrong;
  }
}

async function downloadSnapshot(message: Api.Message): Promise<SnapshotBody> {
  const path = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/restore-${message.id}${SNAPSHOT_FILE_SUFFIX}`;
  try {
    await downloadMessageToFile(message, path);
    const base64 = (await ReactNativeBlobUtil.fs.readFile(
      path,
      'base64',
    )) as string;
    const json = pako.ungzip(Buffer.from(base64, 'base64'), { to: 'string' });
    return parseSnapshot(json);
  } finally {
    try {
      await ReactNativeBlobUtil.fs.unlink(path);
    } catch {
      // Best effort.
    }
  }
}

/** What a restore would bring back, without changing anything. */
export async function previewSnapshot(): Promise<SnapshotPreview | null> {
  const signal = new AbortController().signal;
  const found = await latestSnapshotMessage(signal);
  if (!found) {
    return null;
  }
  const body = await downloadSnapshot(found.message);
  return {
    topicId: found.topicId,
    createdAt: body.createdAt,
    files: body.files.length,
    hasPrivate: body.private !== null,
  };
}

/** Opens the snapshot's sealed part; throws RestorePassphraseNeeded when it cannot. */
async function openPrivate(
  sealedB64: string,
  passphrase: string | undefined,
): Promise<ReturnType<typeof parsePrivateBody>> {
  try {
    const plain = await vault.openBytes(Buffer.from(sealedB64, 'base64'), {
      passphrase,
    });
    return parsePrivateBody(pako.ungzip(plain, { to: 'string' }));
  } catch (error) {
    if (error instanceof VaultPassphraseRequiredError) {
      throw new RestorePassphraseNeeded(error.wrongPassphrase);
    }
    throw error;
  }
}

export async function restoreIndex(options: {
  passphrase?: string;
  /** Restore plain rows only, leaving encrypted folders for later. */
  skipEncrypted?: boolean;
  onProgress?: RestoreProgress;
  signal?: AbortSignal;
}): Promise<RestoreReport> {
  const signal = options.signal ?? new AbortController().signal;
  const progress = options.onProgress ?? (() => undefined);
  let locked = 0;

  /* 1. snapshot */
  progress('snapshot', 0, 1);
  const found = await latestSnapshotMessage(signal);
  let body: SnapshotBody | null = null;
  let snapshotRows: RecoveredRow[] = [];
  let privateTopics: { id: number; folder: string | null }[] = [];

  if (found) {
    body = await downloadSnapshot(found.message);
    snapshotRows = body.files.map(row => rowToRecovered(row, false));
    if (body.private) {
      if (options.skipEncrypted) {
        locked += 1;
      } else {
        // Throws RestorePassphraseNeeded before anything is written, so the
        // caller can ask and simply call again.
        const priv = await openPrivate(body.private, options.passphrase);
        snapshotRows.push(...priv.files.map(row => rowToRecovered(row, true)));
        privateTopics = priv.topics;
      }
    }
  }
  progress('snapshot', 1, 1);

  /* 2. caption tags newer than the snapshot */
  const minId = body?.maxMessageId ?? 0;
  const tagRows: RecoveredRow[] = [];
  let passphraseUsed = false;
  let scanned = 0;
  await walkHistory(minId, signal, async messages => {
    for (const message of messages) {
      const doc = documentOf(message);
      if (!doc) {
        continue;
      }
      let tag = await readTag(message.message);
      // The first locked tag gets the passphrase, which remembers its key;
      // every later one then opens without re-running the KDF.
      if (
        tag.status === 'locked' &&
        options.passphrase &&
        !passphraseUsed &&
        !options.skipEncrypted
      ) {
        passphraseUsed = true;
        tag = await readTag(message.message, options.passphrase);
      }
      if (tag.status === 'locked') {
        locked += 1;
        continue;
      }
      if (tag.status !== 'ok') {
        continue;
      }
      const storedName = doc.name;
      const fileName = tag.encrypted
        ? storedName.replace(/\.tgbk$/i, '')
        : storedName || tag.fields.localPath.split('/').pop() || 'file';
      tagRows.push({
        localPath: tag.fields.localPath,
        size: tag.fields.size,
        mtime: tag.fields.mtime,
        messageId: message.id,
        topicId: topicOf(message),
        encrypted: tag.encrypted,
        fileName,
        contentHash: tag.fields.contentHash,
        uploadedAt: message.date,
      });
    }
    scanned += messages.length;
    progress('tags', scanned, scanned);
  });

  /* 3. drop rows whose message is gone */
  const merged = mergeRecovered(snapshotRows, tagRows);
  progress('verify', 0, merged.length);
  const present = await existingMessageIds(
    merged.map(row => row.messageId),
    signal,
    (done, total) => progress('verify', done, total),
  );
  const alive = merged.filter(row => present.has(row.messageId));

  /* 4. write */
  progress('write', 0, alive.length);
  const before = await filesRepo.count();
  const inserted = await filesRepo.insertRecovered(alive);
  progress('write', alive.length, alive.length);

  if (body) {
    try {
      await restoreBindings(body.topics, privateTopics);
    } catch (error) {
      // The file index is already written; bindings can be redone by hand.
      if (!isForumMissing(error)) {
        logger.warn('index', `Folder bindings not restored: ${String(error)}`);
      }
    }
  }
  await setRestoreState('done');

  const report: RestoreReport = {
    restored: inserted,
    fromSnapshot: snapshotRows.length,
    fromTags: tagRows.length,
    missing: merged.length - alive.length,
    alreadyKnown: alive.length - inserted,
    locked,
    settings: body?.settings ?? null,
    snapshotCreatedAt: body?.createdAt ?? null,
  };
  logger.info(
    'index',
    `Index restored: ${inserted} row(s) added (had ${before}); ${report.fromSnapshot} from snapshot, ` +
      `${report.fromTags} from tags, ${report.missing} gone from channel, ${locked} locked`,
  );
  return report;
}

/**
 * Re-applies folder bindings and per-folder flags. Only fills topics that
 * still exist and have no folder bound here, so it never overrides a choice
 * already made on this install.
 */
async function restoreBindings(
  topics: SnapshotTopic[],
  privateTopics: { id: number; folder: string | null }[],
): Promise<void> {
  const remote = new Set((await listTopics()).map(topic => topic.id));
  const local = new Map((await topicsRepo.all()).map(t => [t.topic_id, t]));
  const privateFolder = new Map(privateTopics.map(t => [t.id, t.folder]));

  for (const topic of topics) {
    const folder = topic.encrypt
      ? (privateFolder.get(topic.id) ?? null)
      : topic.folder;
    if (!folder || !remote.has(topic.id)) {
      continue;
    }
    const existing = local.get(topic.id);
    if (existing?.local_folder) {
      continue;
    }
    await topicsRepo.upsert({
      topic_id: topic.id,
      title: existing?.title ?? topic.title,
      local_folder: folder,
    });
    await topicsRepo.setEncrypt(topic.id, topic.encrypt);
    await topicsRepo.setMirrorDeletes(topic.id, topic.mirror);
  }
}

/** "Start fresh": allow sync to run on an empty index without restoring. */
export async function declineRestore(): Promise<void> {
  await setRestoreState('declined');
  logger.warn(
    'index',
    'Restore declined; the next sync will upload files even if Telegram already has them.',
  );
}

export interface AdoptReport {
  adopted: number;
  ambiguous: number;
  unmatched: number;
}

/**
 * Last resort for a backup made before snapshots and tags existed: match
 * local files that look new against channel documents by name and size.
 * Only a single unclaimed match is adopted; anything ambiguous uploads as
 * usual, so the worst outcome is an extra copy, never a skipped file.
 */
export async function adoptByNameAndSize(
  onProgress?: RestoreProgress,
): Promise<AdoptReport> {
  const signal = new AbortController().signal;
  const progress = onProgress ?? (() => undefined);
  const known = new Set(
    (await filesRepo.allUploaded()).map(row => row.message_id),
  );

  type Candidate = {
    messageId: number;
    topicId: number | null;
    encrypted: boolean;
    date: number;
  };
  const remote = new Map<string, Candidate[]>();
  let scanned = 0;
  await walkHistory(0, signal, messages => {
    for (const message of messages) {
      const doc = documentOf(message);
      if (
        !doc ||
        !doc.name ||
        known.has(message.id) ||
        isSnapshotName(doc.name)
      ) {
        continue;
      }
      const { key, encrypted } = legacyKey(doc.name, doc.size);
      const list = remote.get(key) ?? [];
      list.push({
        messageId: message.id,
        topicId: topicOf(message),
        encrypted,
        date: message.date,
      });
      remote.set(key, list);
    }
    scanned += messages.length;
    progress('channel', scanned, scanned);
  });

  progress('scan', 0, 1);
  const config = await configRepo.load();
  const router = await buildRouter(config.rootTopicId);
  const { jobs } = await scan(
    config,
    router,
    signal,
    await buildDefaultTarget(config),
  );
  progress('scan', 1, 1);

  const claimed = new Set<number>();
  const rows: RecoveredRow[] = [];
  let ambiguous = 0;
  let unmatched = 0;

  for (const job of jobs) {
    if (job.replacesMessageId) {
      // A file the index knows but whose contents changed; not ours to adopt.
      continue;
    }
    const all = (remote.get(`${job.fileName}|${job.size}`) ?? []).filter(
      candidate => !claimed.has(candidate.messageId),
    );
    const sameTopic = all.filter(
      candidate => candidate.topicId === job.topicId,
    );
    const pool = sameTopic.length > 0 ? sameTopic : all;
    if (pool.length === 0) {
      unmatched += 1;
      continue;
    }
    if (pool.length > 1) {
      ambiguous += 1;
      continue;
    }
    const match = pool[0];
    claimed.add(match.messageId);
    rows.push({
      localPath: job.localPath,
      size: job.size,
      mtime: job.mtime,
      messageId: match.messageId,
      topicId: match.topicId,
      encrypted: match.encrypted,
      fileName: job.fileName,
      contentHash: null,
      uploadedAt: match.date,
    });
  }

  progress('write', 0, rows.length);
  const adopted = await filesRepo.insertRecovered(rows);
  progress('write', rows.length, rows.length);
  if (adopted > 0) {
    await setRestoreState('done');
  }
  logger.info(
    'index',
    `Adopted ${adopted} existing upload(s) by name and size; ${ambiguous} ambiguous, ${unmatched} not in the channel`,
  );
  return { adopted, ambiguous, unmatched };
}
