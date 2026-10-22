import ReactNativeBlobUtil from 'react-native-blob-util';

import { Api, getChannel, getClient } from './client';
import { vault, VaultPassphraseRequiredError } from '../crypto/vault';
import { filesRepo } from '../db/schema';
import { logger, describeError } from '../../utils/logger';
import type { FileRecord } from '../../types';

/**
 * Fetching backed-up files out of Telegram again.
 *
 * Two stages, deliberately separate:
 *   1. fetch to the app's private cache (and decrypt if needed) — for preview
 *   2. copy that into public storage — only when the user asks to save
 *
 * Nothing ever lands in the gallery as a side effect of looking at it.
 */

/** Where previews live. Private to the app and safe to purge at any time. */
export function previewDir(): string {
  return `${ReactNativeBlobUtil.fs.dirs.CacheDir}/tgbackup-preview`;
}

async function ensurePreviewDir(): Promise<void> {
  const dir = previewDir();
  if (!(await ReactNativeBlobUtil.fs.exists(dir))) {
    await ReactNativeBlobUtil.fs.mkdir(dir);
  }
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

const IMAGE_EXT = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'heic',
  'heif',
  'bmp',
]);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', '3gp']);

export type MediaKind = 'image' | 'video' | 'other';

export function mediaKindOf(fileName: string): MediaKind {
  const ext = extensionOf(fileName);
  if (IMAGE_EXT.has(ext)) {
    return 'image';
  }
  if (VIDEO_EXT.has(ext)) {
    return 'video';
  }
  return 'other';
}

/** The original name, recovering it from the row rather than the blob. */
export function originalNameOf(record: FileRecord): string {
  if (record.file_name && record.file_name.length > 0) {
    return record.file_name;
  }
  return record.local_path.split('/').pop() ?? 'file';
}

/** Fetches the message that holds a backed-up file. */
export async function fetchMessage(messageId: number): Promise<Api.Message> {
  const client = await getClient();
  const peer = await getChannel();

  const result = await client.invoke(
    new Api.channels.GetMessages({
      channel: peer,
      id: [new Api.InputMessageID({ id: messageId })],
    }),
  );

  const messages =
    result instanceof Api.messages.ChannelMessages ||
    result instanceof Api.messages.Messages
      ? result.messages
      : [];

  const message = messages.find(
    (item): item is Api.Message => item instanceof Api.Message,
  );
  if (!message || !message.media) {
    throw new Error(
      `Message #${messageId} is gone from the channel, or carries no file.`,
    );
  }
  return message;
}

export interface FetchOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /**
   * For encrypted files whose key this device does not know yet (a backup made
   * on another phone or before a reinstall). See vault.decryptFile.
   */
  passphrase?: string;
}

/** Expected byte size of a message's file, when Telegram tells us. */
function expectedSizeOf(message: Api.Message): number | null {
  const media = message.media;
  if (
    media instanceof Api.MessageMediaDocument &&
    media.document instanceof Api.Document
  ) {
    return Number(media.document.size);
  }
  return null;
}

/**
 * Streams a message's file straight to `destPath`, one part at a time.
 *
 * teleproto's default returns the whole file as one Buffer, which a large
 * video cannot survive: the bytes plus their base64 copy exceed the JS heap.
 * Handing it a writer instead keeps memory bounded by the parts in flight.
 * teleproto serialises writes in file order (OrderedWriter), so appending
 * each one is safe.
 *
 * Writes to a part file unique to this call and renames it on success, so a
 * file at `destPath` is always complete, even if an earlier, aborted download
 * of the same file is still draining its last writes.
 */
export async function downloadMessageToFile(
  message: Api.Message,
  destPath: string,
  options: FetchOptions = {},
): Promise<void> {
  const partPath = `${destPath}.${uniqueSuffix()}.part`;

  let created = false;
  let written = 0;
  const writer = {
    async write(data: Buffer): Promise<void> {
      const encoded = Buffer.from(data).toString('base64');
      if (created) {
        await ReactNativeBlobUtil.fs.appendFile(partPath, encoded, 'base64');
      } else {
        await ReactNativeBlobUtil.fs.createFile(partPath, encoded, 'base64');
        created = true;
      }
      written += data.length;
    },
    close(): void {
      // Nothing held open; every write already reached disk.
    },
  };

  try {
    await (
      await getClient()
    ).downloadMedia(message, {
      // teleproto accepts any object with write()/close() as the output.
      outputFile: writer as unknown as string,
      signal: options.signal,
      progressCallback: (received, total) => {
        const totalBytes = Number(total);
        if (totalBytes > 0) {
          options.onProgress?.(Number(received) / totalBytes);
        }
      },
    });

    // An aborted download returns normally, so check rather than trust it.
    if (options.signal?.aborted) {
      throw new Error('Cancelled');
    }
    const expected = expectedSizeOf(message);
    if (!created || (expected !== null && written !== expected)) {
      throw new Error(
        `Download incomplete (${written} of ${expected ?? '?'} bytes).`,
      );
    }
    await ReactNativeBlobUtil.fs.mv(partPath, destPath);
  } catch (error) {
    try {
      await ReactNativeBlobUtil.fs.unlink(partPath);
    } catch {
      // Best effort.
    }
    throw error;
  }
}

/**
 * Downloads a backed-up file into the private preview cache, decrypting it when
 * the row says it was encrypted. Returns the local path.
 *
 * Re-uses an existing cached copy, so browsing back to an item is instant.
 */
export async function fetchToCache(
  record: FileRecord,
  options: FetchOptions = {},
): Promise<string> {
  await ensurePreviewDir();

  const name = originalNameOf(record);
  const target = `${previewDir()}/${record.message_id}-${name}`;

  if (await ReactNativeBlobUtil.fs.exists(target)) {
    options.onProgress?.(1);
    return target;
  }

  logger.info(
    'download',
    `Fetching ${name} (message #${record.message_id})${record.encrypted ? ', encrypted' : ''}`,
  );

  if (!record.encrypted) {
    const message = await fetchMessage(record.message_id);
    await downloadMessageToFile(message, target, options);
    return target;
  }

  // Encrypted: land the ciphertext, decrypt to the target, drop the ciphertext.
  // A ciphertext left by an attempt that needed a passphrase is reused, so
  // entering it does not download the file a second time.
  const cipherPath = `${target}.tgbk`;
  if (!(await ReactNativeBlobUtil.fs.exists(cipherPath))) {
    const message = await fetchMessage(record.message_id);
    await downloadMessageToFile(message, cipherPath, options);
  } else {
    options.onProgress?.(1);
  }

  await decryptCached(cipherPath, target, options.passphrase);
  return target;
}

/**
 * Decrypts a downloaded ciphertext and removes it, except when the only
 * problem is a missing or wrong passphrase: then it stays for the retry.
 */
export async function decryptCached(
  cipherPath: string,
  target: string,
  passphrase?: string,
): Promise<void> {
  // Decrypt beside the target and rename, so two overlapping attempts (a quick
  // swipe away and back) never interleave writes into one file.
  const temp = `${target}.${uniqueSuffix()}.dec`;
  try {
    await vault.decryptFile(cipherPath, temp, { passphrase });
    await ReactNativeBlobUtil.fs.mv(temp, target);
  } catch (error) {
    await unlinkQuietly(temp);
    if (await ReactNativeBlobUtil.fs.exists(target)) {
      // An overlapping attempt finished first and already consumed the
      // ciphertext; its result is complete and verified.
      return;
    }
    if (error instanceof VaultPassphraseRequiredError) {
      throw error;
    }
    await unlinkQuietly(cipherPath);
    throw error;
  }
  await unlinkQuietly(cipherPath);
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function unlinkQuietly(path: string): Promise<void> {
  try {
    await ReactNativeBlobUtil.fs.unlink(path);
  } catch {
    // Best effort.
  }
}

/**
 * Copies a previously fetched file into a real folder on the device.
 *
 * Separate from fetchToCache on purpose: looking at something must never write
 * it into the user's storage.
 */
export async function saveToDevice(
  record: FileRecord,
  destinationFolder: string,
  options: FetchOptions = {},
): Promise<string> {
  const cached = await fetchToCache(record, options);
  const name = originalNameOf(record);

  if (!(await ReactNativeBlobUtil.fs.exists(destinationFolder))) {
    await ReactNativeBlobUtil.fs.mkdir(destinationFolder);
  }

  let target = `${destinationFolder}/${name}`;
  // Never silently overwrite something already on the device.
  if (await ReactNativeBlobUtil.fs.exists(target)) {
    const dot = name.lastIndexOf('.');
    const stem = dot === -1 ? name : name.slice(0, dot);
    const ext = dot === -1 ? '' : name.slice(dot);
    target = `${destinationFolder}/${stem}-restored-${Date.now()}${ext}`;
  }

  await ReactNativeBlobUtil.fs.cp(cached, target);
  logger.info('download', `Saved ${name} to ${target}`);
  return target;
}

/** Restores to the path the file originally came from. */
export async function restoreToOriginalPath(
  record: FileRecord,
  options: FetchOptions = {},
): Promise<string> {
  const folder = record.local_path.substring(
    0,
    record.local_path.lastIndexOf('/'),
  );
  return saveToDevice(record, folder, options);
}

export async function clearPreviewCache(): Promise<void> {
  try {
    const dir = previewDir();
    if (await ReactNativeBlobUtil.fs.exists(dir)) {
      await ReactNativeBlobUtil.fs.unlink(dir);
    }
    logger.info('download', 'Preview cache cleared');
  } catch (error) {
    logger.warn(
      'download',
      `Could not clear preview cache: ${describeError(error)}`,
    );
  }
}

/** The backed-up library, newest first. */
export async function listBackedUpFiles(limit = 500): Promise<FileRecord[]> {
  return filesRepo.recent(limit);
}
