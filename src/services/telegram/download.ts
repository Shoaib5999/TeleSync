import ReactNativeBlobUtil from 'react-native-blob-util';

import { Api, getChannel, getClient } from './client';
import { vault } from '../crypto/vault';
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
async function fetchMessage(messageId: number): Promise<Api.Message> {
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

  const message = await fetchMessage(record.message_id);

  logger.info(
    'download',
    `Fetching ${name} (message #${record.message_id})${record.encrypted ? ', encrypted' : ''}`,
  );

  // teleproto handles part sizing and any cross-DC redirect internally. With no
  // output path it returns a Buffer, which never touches the Node fs shim.
  const data = (await (
    await getClient()
  ).downloadMedia(message, {
    progressCallback: (received, total) => {
      const receivedBytes = Number(received);
      const totalBytes = Number(total);
      if (totalBytes > 0) {
        options.onProgress?.(receivedBytes / totalBytes);
      }
    },
  })) as Buffer | string | undefined;

  if (!data || typeof data === 'string') {
    throw new Error(`Could not download ${name}.`);
  }

  if (!record.encrypted) {
    await ReactNativeBlobUtil.fs.createFile(
      target,
      Buffer.from(data).toString('base64'),
      'base64',
    );
    return target;
  }

  // Encrypted: land the ciphertext, decrypt to the target, drop the ciphertext.
  const cipherPath = `${target}.tgbk`;
  await ReactNativeBlobUtil.fs.createFile(
    cipherPath,
    Buffer.from(data).toString('base64'),
    'base64',
  );
  try {
    await vault.decryptFile(cipherPath, target);
  } finally {
    try {
      await ReactNativeBlobUtil.fs.unlink(cipherPath);
    } catch {
      // Best effort.
    }
  }

  return target;
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
