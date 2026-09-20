import ReactNativeBlobUtil from 'react-native-blob-util';
import bigInt from 'big-integer';
import { errors } from 'teleproto';

import { Api, getChannel, getClient } from './client';
import { vault } from '../crypto/vault';
import { logger, describeError } from '../../utils/logger';

const { FloodWaitError, SlowModeWaitError } = errors;

/**
 * Telegram part size. Must divide 512 KB evenly and be a multiple of 1 KB;
 * 512 KB is the maximum and the fewest round-trips per megabyte.
 */
const CHUNK_SIZE = 512 * 1024;

/** Files at or above this size must use the SaveBigFilePart path. */
const BIG_FILE_THRESHOLD = 10 * 1024 * 1024;

/** Telegram rejects uploads split into more parts than this. */
const MAX_PARTS = 8000;

const MAX_NETWORK_RETRIES = 5;

export class PermanentUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentUploadError';
  }
}

export interface UploadOptions {
  localPath: string;
  fileName: string;
  size: number;
  /** null uploads to the channel root instead of a topic. */
  topicId: number | null;
  asDocument: boolean;
  /** Seconds to wait after the message is sent, to stay under rate limits. */
  throttleSeconds: number;
  /** Delete this message id first (used when re-uploading a modified file). */
  replacesMessageId: number | null;
  /** Encrypt before upload; Telegram then only ever sees ciphertext. */
  encrypt: boolean;
  signal: AbortSignal;
  onProgress?: (fraction: number) => void;
  /** Called when Telegram forces a wait, so the UI can explain the pause. */
  onFloodWait?: (seconds: number) => void;
}

export interface UploadResult {
  messageId: number;
  /** The name the file was stored under; differs when encrypted. */
  storedName: string;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Cancelled');
  }
}

function randomLong(): ReturnType<typeof bigInt> {
  const high = Math.floor(Math.random() * 0xffffffff);
  const low = Math.floor(Math.random() * 0xffffffff);
  return bigInt(high).shiftLeft(32).or(bigInt(low));
}

function guessMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    webm: 'video/webm',
    '3gp': 'video/3gpp',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] ?? 'application/octet-stream';
}

/**
 * Runs a request, absorbing FLOOD_WAIT and transient network failures.
 *
 * FloodWait is not counted as a retry: Telegram is telling us exactly how long
 * to wait, so obeying it is the correct behaviour, not a failure. Only genuine
 * network errors consume the retry budget.
 */
async function withRetries<T>(
  label: string,
  signal: AbortSignal,
  onFloodWait: ((seconds: number) => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  let networkAttempts = 0;

  for (;;) {
    throwIfAborted(signal);
    try {
      return await run();
    } catch (error) {
      if (signal.aborted) {
        throw new Error('Cancelled');
      }

      // SlowModeWait is the same contract as FloodWait — Telegram tells us
      // exactly how long to wait — so both are obeyed rather than retried.
      // Waiting is correct behaviour, so neither consumes the retry budget.
      if (
        error instanceof FloodWaitError ||
        error instanceof SlowModeWaitError
      ) {
        // +5s of headroom: coming back the instant the window expires tends to
        // trigger a second, longer wait.
        const waitSeconds = Number(error.seconds) + 5;
        const kind =
          error instanceof FloodWaitError ? 'FLOOD_WAIT' : 'SLOWMODE_WAIT';
        logger.warn('upload', `${kind} on ${label}: sleeping ${waitSeconds}s`);
        onFloodWait?.(waitSeconds);
        await sleep(waitSeconds * 1000, signal);
        continue;
      }

      const message = describeError(error);

      // Errors Telegram will never accept on retry.
      if (
        message.includes('FILE_PARTS_INVALID') ||
        message.includes('FILE_PART_SIZE_INVALID') ||
        message.includes('FILE_PART_INVALID') ||
        message.includes('MEDIA_EMPTY') ||
        message.includes('PHOTO_INVALID_DIMENSIONS') ||
        message.includes('FILE_TOO_BIG') ||
        message.includes('FILE_REFERENCE_EMPTY')
      ) {
        throw new PermanentUploadError(
          `${label} rejected by Telegram: ${message}`,
        );
      }

      networkAttempts += 1;
      if (networkAttempts >= MAX_NETWORK_RETRIES) {
        throw new Error(
          `${label} failed after ${MAX_NETWORK_RETRIES} attempts: ${message}`,
        );
      }

      const backoffMs = Math.min(30000, 1000 * 2 ** networkAttempts);
      logger.warn(
        'upload',
        `${label} failed (${message}); retry ${networkAttempts} in ${backoffMs}ms`,
      );
      await sleep(backoffMs, signal);
    }
  }
}

/**
 * Reads one exact byte range from a file.
 *
 * React Native cannot random-access a file directly, so we slice the range into
 * a temp file and read that back as base64. Doing it a chunk at a time keeps
 * memory flat regardless of file size, and gives natural backpressure: we only
 * ever read the chunk we are about to send.
 */
async function readChunk(
  localPath: string,
  start: number,
  end: number,
  tmpPath: string,
): Promise<Buffer> {
  await ReactNativeBlobUtil.fs.slice(localPath, tmpPath, start, end);
  try {
    const base64 = (await ReactNativeBlobUtil.fs.readFile(
      tmpPath,
      'base64',
    )) as string;
    return Buffer.from(base64, 'base64');
  } finally {
    // Always clean up, even if the read threw, or a long sync fills the cache.
    try {
      await ReactNativeBlobUtil.fs.unlink(tmpPath);
    } catch {
      // Best effort.
    }
  }
}

/**
 * Uploads one file into the channel (optionally into a topic) and returns the
 * resulting message id.
 */
export async function uploadFile(
  options: UploadOptions,
): Promise<UploadResult> {
  const { localPath, fileName, size, signal } = options;

  throwIfAborted(signal);

  if (size <= 0) {
    throw new PermanentUploadError(`${fileName} is empty.`);
  }

  const exists = await ReactNativeBlobUtil.fs.exists(localPath);
  if (!exists) {
    throw new PermanentUploadError(
      `${fileName} no longer exists at ${localPath}.`,
    );
  }

  // Encryption runs to a temp file first, then the normal chunked uploader
  // sends that. Keeping the stages separate means encrypted and plain uploads
  // share one well-tested upload path, and memory stays flat either way.
  let encryptedTemp: string | null = null;

  if (options.encrypt) {
    encryptedTemp = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/tgbackup-enc-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.tgbk`;
    try {
      await vault.encryptFile(localPath, encryptedTemp);
    } catch (error) {
      try {
        await ReactNativeBlobUtil.fs.unlink(encryptedTemp);
      } catch {
        // Best effort.
      }
      throw error;
    }
  }

  try {
    return await uploadPreparedFile(
      options,
      encryptedTemp ?? localPath,
      // The real name lives in SQLite; the uploaded blob reveals nothing.
      encryptedTemp ? `${fileName}.tgbk` : fileName,
    );
  } finally {
    if (encryptedTemp) {
      try {
        await ReactNativeBlobUtil.fs.unlink(encryptedTemp);
      } catch {
        // Best effort; the cache directory is reclaimable.
      }
    }
  }
}

/** The chunked upload itself, working on whatever bytes it is handed. */
async function uploadPreparedFile(
  options: UploadOptions,
  localPath: string,
  fileName: string,
): Promise<UploadResult> {
  const { topicId, signal } = options;

  const stat = await ReactNativeBlobUtil.fs.stat(localPath);
  const size = Number(stat.size);
  const totalParts = Math.ceil(size / CHUNK_SIZE);
  if (totalParts > MAX_PARTS) {
    throw new PermanentUploadError(
      `${fileName} needs ${totalParts} parts, over Telegram's ${MAX_PARTS}-part limit.`,
    );
  }

  const client = await getClient();
  const peer = await getChannel();
  const fileId = randomLong();
  const isBig = size >= BIG_FILE_THRESHOLD;

  logger.info(
    'upload',
    `Uploading ${fileName} (${(size / 1048576).toFixed(1)} MB, ${totalParts} parts)`,
  );

  const tmpPath = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/tgbackup-chunk-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.part`;

  for (let part = 0; part < totalParts; part += 1) {
    throwIfAborted(signal);

    const start = part * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const bytes = await readChunk(localPath, start, end, tmpPath);

    await withRetries(
      `part ${part + 1}/${totalParts} of ${fileName}`,
      signal,
      options.onFloodWait,
      async () => {
        if (isBig) {
          await client.invoke(
            new Api.upload.SaveBigFilePart({
              fileId,
              filePart: part,
              fileTotalParts: totalParts,
              bytes,
            }),
          );
        } else {
          await client.invoke(
            new Api.upload.SaveFilePart({ fileId, filePart: part, bytes }),
          );
        }
      },
    );

    options.onProgress?.((part + 1) / totalParts);
  }

  const inputFile = isBig
    ? new Api.InputFileBig({ id: fileId, parts: totalParts, name: fileName })
    : new Api.InputFile({
        id: fileId,
        parts: totalParts,
        name: fileName,
        md5Checksum: '',
      });

  // forceFile keeps originals byte-identical: without it Telegram re-encodes
  // images and strips video metadata, which defeats the point of a backup.
  const media = new Api.InputMediaUploadedDocument({
    file: inputFile,
    mimeType: guessMimeType(fileName),
    attributes: [new Api.DocumentAttributeFilename({ fileName })],
    forceFile: options.asDocument,
  });

  // Posting into a forum topic means replying to the topic's root message.
  const replyTo =
    topicId !== null
      ? new Api.InputReplyToMessage({
          replyToMsgId: topicId,
          topMsgId: topicId,
        })
      : undefined;

  const updates = await withRetries(
    `send ${fileName}`,
    signal,
    options.onFloodWait,
    () =>
      client.invoke(
        new Api.messages.SendMedia({
          peer,
          media,
          message: '',
          randomId: randomLong(),
          replyTo,
        }),
      ),
  );

  const messageId = extractMessageId(updates);
  if (messageId === null) {
    throw new Error(
      `Uploaded ${fileName} but Telegram did not return a message id.`,
    );
  }

  // Replace only after the new copy is safely stored, so a crash mid-way never
  // loses the previous version.
  if (options.replacesMessageId) {
    await deleteMessage(options.replacesMessageId);
  }

  if (options.throttleSeconds > 0) {
    await sleep(options.throttleSeconds * 1000, signal);
  }

  logger.info('upload', `Uploaded ${fileName} as message #${messageId}`);
  return { messageId, storedName: fileName };
}

function extractMessageId(updates: Api.TypeUpdates): number | null {
  if (updates instanceof Api.Updates) {
    for (const update of updates.updates) {
      if (
        update instanceof Api.UpdateNewChannelMessage ||
        update instanceof Api.UpdateNewMessage
      ) {
        if (update.message instanceof Api.Message) {
          return update.message.id;
        }
      }
      if (update instanceof Api.UpdateMessageID) {
        return update.id;
      }
    }
  }
  if (updates instanceof Api.UpdateShortSentMessage) {
    return updates.id;
  }
  return null;
}

/**
 * Deletes a single message from the backup channel.
 *
 * ONLY called when re-uploading a file whose contents changed. Nothing in the
 * sync engine may call this in response to a file disappearing from the phone —
 * see the guarantee documented in sync/engine.ts.
 */
export async function deleteMessage(messageId: number): Promise<void> {
  try {
    const client = await getClient();
    const peer = await getChannel();
    // invoke() resolves EntityLike fields, so the InputPeer is coerced to the
    // InputChannel this request wants (see tl/runtime getInputFromResolve).
    await client.invoke(
      new Api.channels.DeleteMessages({ channel: peer, id: [messageId] }),
    );
    logger.info('upload', `Deleted superseded message #${messageId}`);
  } catch (error) {
    // A stale message id is not fatal: the new copy is already uploaded.
    logger.warn(
      'upload',
      `Could not delete old message #${messageId}: ${describeError(error)}`,
    );
  }
}
