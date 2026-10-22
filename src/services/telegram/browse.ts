import ReactNativeBlobUtil from 'react-native-blob-util';
import bigInt from 'big-integer';

import { Api, getChannel, getClient } from './client';
import { GENERAL_TOPIC_ID } from './topics';
import {
  decryptCached,
  downloadMessageToFile,
  fetchMessage,
  type FetchOptions,
} from './download';
import { logger, describeError } from '../../utils/logger';
import { stripTag } from '../index/tag';

/**
 * Browsing the backup channel as it is on Telegram, rather than as this
 * device's index remembers it.
 *
 * The local `files` table only knows what this install uploaded. After a
 * reinstall, on a new phone, or for anything posted to the channel directly,
 * the channel itself is the only source of truth, so the Vault reads it here.
 *
 * Read-only: nothing in this module sends, edits or deletes a message.
 */

export type VaultKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'other'
  | 'message';

export interface VaultItem {
  /** Unique across topics, for list keys. */
  key: string;
  messageId: number;
  topicId: number;
  /** Unix seconds. */
  date: number;
  /** Name to show and save under; `.tgbk` already stripped when encrypted. */
  name: string;
  /** Bytes as stored on Telegram (ciphertext size when encrypted). */
  size: number;
  mime: string;
  kind: VaultKind;
  /** Uploaded by this app's encryption: must be decrypted to be viewed. */
  encrypted: boolean;
  /** Caption, or the whole text for a text-only message. */
  text: string;
  /** Telegram holds a preview image for it. Never true when encrypted. */
  hasThumb: boolean;
  /** Seconds, for video and audio. */
  duration: number | null;
  message: Api.Message;
}

export interface VaultPage {
  items: VaultItem[];
  /** Pass back as `offsetId` for the next page; null when exhausted. */
  nextOffsetId: number | null;
}

const PAGE_SIZE = 60;
/** General-topic pages are filtered client-side; bound how far one call digs. */
const MAX_GENERAL_SCAN_PAGES = 8;

const ENCRYPTED_SUFFIX = '.tgbk';

const EXT_KIND: Record<string, VaultKind> = {};
function register(kind: VaultKind, exts: string): void {
  for (const ext of exts.split(' ')) {
    EXT_KIND[ext] = kind;
  }
}
register('image', 'jpg jpeg png gif webp heic heif bmp avif');
register('video', 'mp4 mkv mov avi webm 3gp m4v ts');
register('audio', 'mp3 m4a ogg opus wav flac aac amr wma');
register('pdf', 'pdf');
register(
  'text',
  'txt md markdown json csv tsv log xml html htm css js jsx ts tsx py java kt ' +
    'c cc cpp h hpp cs go rs rb php sh bash zsh yml yaml toml ini conf cfg env ' +
    'srt vtt sql gradle properties gitignore',
);
register('archive', 'zip rar 7z tar gz tgz bz2 xz');

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Best-effort MIME from a file name, for "Open with" and playback hints. */
export function mimeFor(name: string, fallback = ''): string {
  const ext = extensionOf(name);
  const known: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    mp4: 'video/mp4',
    mkv: 'video/x-matroska',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    pdf: 'application/pdf',
    zip: 'application/zip',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    apk: 'application/vnd.android.package-archive',
  };
  if (known[ext]) {
    return known[ext];
  }
  if (fallback && fallback !== 'application/octet-stream') {
    return fallback;
  }
  return 'application/octet-stream';
}

export function kindOf(name: string, mime: string): VaultKind {
  const byExt = EXT_KIND[extensionOf(name)];
  if (byExt) {
    return byExt;
  }
  if (mime.startsWith('image/')) {
    return 'image';
  }
  if (mime.startsWith('video/')) {
    return 'video';
  }
  if (mime.startsWith('audio/')) {
    return 'audio';
  }
  if (mime === 'application/pdf') {
    return 'pdf';
  }
  if (mime.startsWith('text/')) {
    return 'text';
  }
  return 'other';
}

/** Turns one channel message into a Vault item, or null for service noise. */
export function toVaultItem(
  message: Api.TypeMessage,
  topicId: number,
): VaultItem | null {
  if (!(message instanceof Api.Message)) {
    return null;
  }
  const media = message.media;
  const base = {
    key: `${topicId}:${message.id}`,
    messageId: message.id,
    topicId,
    date: message.date,
    // The index tag is bookkeeping for restores, not something to show.
    text: stripTag(message.message),
    message,
  };

  if (
    media instanceof Api.MessageMediaDocument &&
    media.document instanceof Api.Document
  ) {
    const doc = media.document;
    let storedName = '';
    let duration: number | null = null;
    for (const attr of doc.attributes) {
      if (attr instanceof Api.DocumentAttributeFilename) {
        storedName = attr.fileName;
      } else if (
        attr instanceof Api.DocumentAttributeVideo ||
        attr instanceof Api.DocumentAttributeAudio
      ) {
        duration = Number(attr.duration);
      }
    }
    if (!storedName) {
      const ext = doc.mimeType.split('/')[1]?.split(/[;+]/)[0] ?? 'bin';
      storedName = `file_${message.id}.${ext}`;
    }
    const encrypted = storedName.toLowerCase().endsWith(ENCRYPTED_SUFFIX);
    const name = encrypted
      ? storedName.slice(0, -ENCRYPTED_SUFFIX.length) || `file_${message.id}`
      : storedName;
    const mime = mimeFor(name, encrypted ? '' : doc.mimeType);
    return {
      ...base,
      name,
      size: Number(doc.size),
      mime,
      kind: kindOf(name, mime),
      encrypted,
      hasThumb:
        !encrypted &&
        (doc.thumbs ?? []).some(
          size =>
            size instanceof Api.PhotoSize ||
            size instanceof Api.PhotoSizeProgressive,
        ),
      duration,
    };
  }

  if (
    media instanceof Api.MessageMediaPhoto &&
    media.photo instanceof Api.Photo
  ) {
    let size = 0;
    for (const item of media.photo.sizes) {
      if (item instanceof Api.PhotoSize) {
        size = Math.max(size, item.size);
      } else if (item instanceof Api.PhotoSizeProgressive) {
        size = Math.max(size, ...item.sizes);
      }
    }
    return {
      ...base,
      name: `photo_${message.id}.jpg`,
      size,
      mime: 'image/jpeg',
      kind: 'image',
      encrypted: false,
      hasThumb: true,
      duration: null,
    };
  }

  if (!media && base.text.trim().length > 0) {
    return {
      ...base,
      name: base.text.split('\n')[0].slice(0, 80),
      size: base.text.length,
      mime: 'text/plain',
      kind: 'message',
      encrypted: false,
      hasThumb: false,
      duration: null,
    };
  }

  return null;
}

function messagesOf(result: Api.messages.TypeMessages): Api.TypeMessage[] {
  if ('messages' in result) {
    return result.messages;
  }
  return [];
}

/** In a forum, a message belongs to General when it carries no topic reply. */
function isInGeneral(message: Api.TypeMessage): boolean {
  if (!(message instanceof Api.Message)) {
    return false;
  }
  const reply = message.replyTo;
  return !(reply instanceof Api.MessageReplyHeader && reply.forumTopic);
}

/**
 * One page of a topic, newest first. `query` searches file names and captions
 * server-side, so it reaches items that have not been paged in yet.
 */
export async function listTopicPage(
  topicId: number,
  offsetId = 0,
  query = '',
): Promise<VaultPage> {
  const client = await getClient();
  const peer = await getChannel();
  const isGeneral = topicId === GENERAL_TOPIC_ID;

  const fetchRaw = async (offset: number): Promise<Api.TypeMessage[]> => {
    if (query.trim().length > 0) {
      return messagesOf(
        await client.invoke(
          new Api.messages.Search({
            peer,
            q: query.trim(),
            topMsgId: isGeneral ? undefined : topicId,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetId: offset,
            addOffset: 0,
            limit: PAGE_SIZE,
            maxId: 0,
            minId: 0,
          }),
        ),
      );
    }
    if (isGeneral) {
      // General has no thread to ask for: read channel history and keep what
      // is not in another topic.
      return messagesOf(
        await client.invoke(
          new Api.messages.GetHistory({
            peer,
            offsetId: offset,
            offsetDate: 0,
            addOffset: 0,
            limit: PAGE_SIZE,
            maxId: 0,
            minId: 0,
          }),
        ),
      );
    }
    return messagesOf(
      await client.invoke(
        new Api.messages.GetReplies({
          peer,
          msgId: topicId,
          offsetId: offset,
          offsetDate: 0,
          addOffset: 0,
          limit: PAGE_SIZE,
          maxId: 0,
          minId: 0,
        }),
      ),
    );
  };

  try {
    const items: VaultItem[] = [];
    let offset = offsetId;
    const pages = isGeneral ? MAX_GENERAL_SCAN_PAGES : 1;

    for (let page = 0; page < pages; page += 1) {
      const raw = await fetchRaw(offset);
      for (const message of raw) {
        if (isGeneral && !isInGeneral(message)) {
          continue;
        }
        const item = toVaultItem(message, topicId);
        if (item) {
          items.push(item);
        }
      }
      const ids = raw.map(message => message.id).filter(id => id > 0);
      if (raw.length < PAGE_SIZE || ids.length === 0) {
        return { items, nextOffsetId: null };
      }
      const next = Math.min(...ids);
      if (next === offset) {
        // Cursor did not advance; stop rather than re-request the same page.
        return { items, nextOffsetId: null };
      }
      offset = next;
      if (items.length >= PAGE_SIZE / 2) {
        break;
      }
    }
    return { items, nextOffsetId: offset };
  } catch (error) {
    logger.error('vault', `Could not list topic #${topicId}`, error);
    throw new Error(`Could not load this topic: ${describeError(error)}`);
  }
}

/* ------------------------------------------------------------------ cache */

/**
 * Decrypted Vault files live here, private to the app, and are wiped whenever
 * the Vault locks. Separate from the Restore tab's cache so locking does not
 * disturb it.
 */
export function vaultCacheDir(): string {
  return `${ReactNativeBlobUtil.fs.dirs.CacheDir}/tgbackup-vault`;
}

function thumbDir(): string {
  return `${vaultCacheDir()}/thumbs`;
}

async function ensureDir(dir: string): Promise<void> {
  if (!(await ReactNativeBlobUtil.fs.exists(dir))) {
    await ReactNativeBlobUtil.fs.mkdir(dir);
  }
}

/** Keeps a remote name from escaping the cache folder or breaking a path. */
function safeFileName(name: string): string {
  // Control characters are exactly what must be stripped from a file name.
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : 'file';
}

function isStaleReference(error: unknown): boolean {
  return /FILE_REFERENCE_(EXPIRED|INVALID|EMPTY)/.test(describeError(error));
}

/**
 * Downloads with the item's message, refetching it once if Telegram says the
 * file reference expired (they do after a while; the list may be old).
 */
async function downloadItem(
  item: VaultItem,
  destPath: string,
  options: FetchOptions,
): Promise<void> {
  try {
    await downloadMessageToFile(item.message, destPath, options);
  } catch (error) {
    if (!isStaleReference(error)) {
      throw error;
    }
    item.message = await fetchMessage(item.messageId);
    await downloadMessageToFile(item.message, destPath, options);
  }
}

/**
 * Makes an item viewable: downloads it into the Vault cache, decrypting when
 * needed, and returns the local path. A cached copy is reused.
 *
 * Throws VaultPassphraseRequiredError when the file's key is not known yet;
 * the ciphertext is kept, so retrying with the passphrase does not download
 * it again.
 */
export async function fetchVaultItem(
  item: VaultItem,
  options: FetchOptions = {},
): Promise<string> {
  await ensureDir(vaultCacheDir());
  const target = `${vaultCacheDir()}/${item.messageId}-${safeFileName(item.name)}`;

  if (await ReactNativeBlobUtil.fs.exists(target)) {
    options.onProgress?.(1);
    return target;
  }

  if (!item.encrypted) {
    await downloadItem(item, target, options);
    return target;
  }

  const cipherPath = `${target}.tgbk`;
  if (!(await ReactNativeBlobUtil.fs.exists(cipherPath))) {
    await downloadItem(item, cipherPath, options);
  } else {
    options.onProgress?.(1);
  }
  await decryptCached(cipherPath, target, options.passphrase);
  return target;
}

/** The cached path when an item was already fetched, without downloading. */
export async function cachedVaultItem(item: VaultItem): Promise<string | null> {
  const target = `${vaultCacheDir()}/${item.messageId}-${safeFileName(item.name)}`;
  return (await ReactNativeBlobUtil.fs.exists(target)) ? target : null;
}

/** Telegram's own preview image, cached. Null when there is none. */
export async function fetchThumb(item: VaultItem): Promise<string | null> {
  if (!item.hasThumb || item.encrypted) {
    return null;
  }
  const target = `${thumbDir()}/${item.messageId}.jpg`;
  if (await ReactNativeBlobUtil.fs.exists(target)) {
    return target;
  }

  const media = item.message.media;
  const pick = (
    sizes: Api.TypePhotoSize[],
  ): Api.PhotoSize | Api.PhotoSizeProgressive | undefined => {
    // The smallest real image at least 200px wide, else the largest there is.
    const usable = sizes.filter(
      size =>
        size instanceof Api.PhotoSize ||
        size instanceof Api.PhotoSizeProgressive,
    ) as (Api.PhotoSize | Api.PhotoSizeProgressive)[];
    usable.sort((a, b) => a.w - b.w);
    return usable.find(size => size.w >= 200) ?? usable[usable.length - 1];
  };
  const byteSize = (size: Api.PhotoSize | Api.PhotoSizeProgressive): number =>
    size instanceof Api.PhotoSize ? size.size : Math.max(...size.sizes);

  // The location names the thumbnail explicitly. Going through downloadMedia
  // instead is unsafe: when its thumb lookup misses (it ignores a
  // PhotoSizeProgressive object), a document falls through to downloading the
  // whole file into memory.
  let location: Api.TypeInputFileLocation;
  let dcId: number;
  let thumb: Api.PhotoSize | Api.PhotoSizeProgressive | undefined;
  if (
    media instanceof Api.MessageMediaDocument &&
    media.document instanceof Api.Document
  ) {
    const doc = media.document;
    thumb = pick(doc.thumbs ?? []);
    if (!thumb) {
      return null;
    }
    location = new Api.InputDocumentFileLocation({
      id: doc.id,
      accessHash: doc.accessHash,
      fileReference: doc.fileReference,
      thumbSize: thumb.type,
    });
    dcId = doc.dcId;
  } else if (
    media instanceof Api.MessageMediaPhoto &&
    media.photo instanceof Api.Photo
  ) {
    const photo = media.photo;
    thumb = pick(photo.sizes);
    if (!thumb) {
      return null;
    }
    location = new Api.InputPhotoFileLocation({
      id: photo.id,
      accessHash: photo.accessHash,
      fileReference: photo.fileReference,
      thumbSize: thumb.type,
    });
    dcId = photo.dcId;
  } else {
    return null;
  }

  try {
    await ensureDir(vaultCacheDir());
    await ensureDir(thumbDir());
    // Thumbnails are a few KB, so the in-memory Buffer path is fine here.
    const data = await (
      await getClient()
    ).downloadFile(location, {
      dcId,
      fileSize: bigInt(byteSize(thumb)),
    });
    if (!data || typeof data === 'string' || data.length === 0) {
      return null;
    }
    await ReactNativeBlobUtil.fs.createFile(
      target,
      Buffer.from(data).toString('base64'),
      'base64',
    );
    return target;
  } catch (error) {
    logger.warn(
      'vault',
      `No thumbnail for message #${item.messageId}: ${describeError(error)}`,
    );
    return null;
  }
}

/** Removes every decrypted file and thumbnail. Runs on each lock. */
export async function clearVaultCache(): Promise<void> {
  try {
    const dir = vaultCacheDir();
    if (await ReactNativeBlobUtil.fs.exists(dir)) {
      await ReactNativeBlobUtil.fs.unlink(dir);
    }
  } catch (error) {
    logger.warn(
      'vault',
      `Could not clear Vault cache: ${describeError(error)}`,
    );
  }
}

/**
 * Copies a fetched item into Download/TeleSync/<topic>/, never overwriting.
 * The only way anything leaves the Vault's private cache.
 */
export async function saveVaultItem(
  item: VaultItem,
  topicTitle: string,
  options: FetchOptions = {},
): Promise<string> {
  const cached = await fetchVaultItem(item, options);
  const folder = `${ReactNativeBlobUtil.fs.dirs.LegacyDownloadDir}/TeleSync/${safeFileName(topicTitle)}`;
  if (!(await ReactNativeBlobUtil.fs.exists(folder))) {
    await ReactNativeBlobUtil.fs.mkdir(folder);
  }

  const name = safeFileName(item.name);
  let target = `${folder}/${name}`;
  if (await ReactNativeBlobUtil.fs.exists(target)) {
    const dot = name.lastIndexOf('.');
    const stem = dot <= 0 ? name : name.slice(0, dot);
    const ext = dot <= 0 ? '' : name.slice(dot);
    target = `${folder}/${stem}-${item.messageId}${ext}`;
    if (await ReactNativeBlobUtil.fs.exists(target)) {
      target = `${folder}/${stem}-${item.messageId}-${Date.now()}${ext}`;
    }
  }
  await ReactNativeBlobUtil.fs.cp(cached, target);
  // Make it show up in Files/Gallery without waiting for a media rescan.
  try {
    await ReactNativeBlobUtil.fs.scanFile([{ path: target, mime: item.mime }]);
  } catch {
    // Best effort; the file is saved either way.
  }
  logger.info('vault', `Saved ${item.name} to ${target}`);
  return target;
}
