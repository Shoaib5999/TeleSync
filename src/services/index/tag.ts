/**
 * The index tag carried in each upload's caption.
 *
 * Every file this app uploads describes itself, so the local index can be
 * rebuilt from the channel alone: after a reinstall, on a new phone, or for
 * uploads made after the last index snapshot.
 *
 *   plain:   TS1|<size>|<mtime>|<sha256 hex or empty>|<absolute local path>
 *   sealed:  TS1E|<base64url of vault.sealBytes(plain tag)>
 *
 * The path goes last so a "|" inside it cannot shift the other fields. Files
 * from encrypted folders use the sealed form, so Telegram never sees their
 * path. The caption is sent under a spoiler entity, so Telegram shows it as one
 * small blurred line.
 *
 * Pure string handling only: no crypto, no I/O, so it is unit tested directly.
 */

export const TAG_PREFIX = 'TS1|';
export const SEALED_TAG_PREFIX = 'TS1E|';

/** Telegram's caption limit for a non-Premium account. */
export const MAX_CAPTION_LENGTH = 1024;

export interface TagFields {
  localPath: string;
  size: number;
  /** Unix seconds. */
  mtime: number;
  /** SHA-256 hex, or null when unknown. */
  contentHash: string | null;
}

export type ParsedTag =
  | { kind: 'plain'; fields: TagFields }
  | { kind: 'sealed'; payload: Buffer };

const HEX_64 = /^[0-9a-f]{64}$/;

export function encodeTag(fields: TagFields): string {
  const hash =
    fields.contentHash && HEX_64.test(fields.contentHash)
      ? fields.contentHash
      : '';
  return `${TAG_PREFIX}${Math.trunc(fields.size)}|${Math.trunc(fields.mtime)}|${hash}|${fields.localPath}`;
}

export function encodeSealedTag(payload: Buffer): string {
  return `${SEALED_TAG_PREFIX}${toBase64Url(payload)}`;
}

/** Parses the plain form; null for anything that is not a well-formed tag. */
export function decodePlainTag(text: string): TagFields | null {
  if (!text.startsWith(TAG_PREFIX)) {
    return null;
  }
  const rest = text.slice(TAG_PREFIX.length);
  const parts: string[] = [];
  let cursor = 0;
  for (let i = 0; i < 3; i += 1) {
    const bar = rest.indexOf('|', cursor);
    if (bar === -1) {
      return null;
    }
    parts.push(rest.slice(cursor, bar));
    cursor = bar + 1;
  }
  const localPath = rest.slice(cursor).trim();
  const size = Number(parts[0]);
  const mtime = Number(parts[1]);
  const hash = parts[2];
  if (
    !localPath.startsWith('/') ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    !Number.isSafeInteger(mtime) ||
    mtime < 0 ||
    (hash !== '' && !HEX_64.test(hash))
  ) {
    return null;
  }
  return { localPath, size, mtime, contentHash: hash === '' ? null : hash };
}

/**
 * Finds a tag in a caption. Only the first line is considered, so a caption
 * someone edited to add a note below the tag still parses.
 */
export function parseTag(caption: string | undefined | null): ParsedTag | null {
  if (!caption) {
    return null;
  }
  const line = caption.split('\n', 1)[0].trim();
  if (line.startsWith(SEALED_TAG_PREFIX)) {
    const payload = fromBase64Url(line.slice(SEALED_TAG_PREFIX.length));
    return payload && payload.length > 0 ? { kind: 'sealed', payload } : null;
  }
  const fields = decodePlainTag(line);
  return fields ? { kind: 'plain', fields } : null;
}

/** The caption with its tag line removed, for showing to a person. */
export function stripTag(caption: string | undefined | null): string {
  if (!caption) {
    return '';
  }
  const newline = caption.indexOf('\n');
  const first = newline === -1 ? caption : caption.slice(0, newline);
  if (parseTag(first) === null) {
    return caption;
  }
  return newline === -1 ? '' : caption.slice(newline + 1).trim();
}

function toBase64Url(data: Buffer): string {
  return data
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/[=]+$/, '');
}

function fromBase64Url(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    return null;
  }
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}
