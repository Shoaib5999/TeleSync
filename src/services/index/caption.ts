import { vault } from '../crypto/vault';
import { logger, describeError } from '../../utils/logger';
import {
  MAX_CAPTION_LENGTH,
  encodeSealedTag,
  encodeTag,
  decodePlainTag,
  parseTag,
  type TagFields,
} from './tag';

/**
 * Builds and reads caption tags, adding the crypto that tag.ts leaves out.
 */

/**
 * The caption for one upload, or '' when no tag fits (an extremely long path).
 * A missing tag only means this one file is not self-describing; the index
 * snapshot still covers it.
 */
export async function buildCaption(
  fields: TagFields,
  encrypted: boolean,
): Promise<string> {
  const plain = encodeTag(fields);
  let caption = plain;
  if (encrypted) {
    try {
      caption = encodeSealedTag(
        await vault.sealBytes(Buffer.from(plain, 'utf8')),
      );
    } catch (error) {
      // Never fall back to the plain tag: that would leak the path of a file
      // the user asked to keep private.
      logger.warn(
        'index',
        `No caption tag for an encrypted file: ${describeError(error)}`,
      );
      return '';
    }
  }
  return caption.length <= MAX_CAPTION_LENGTH ? caption : '';
}

export type ReadTagResult =
  | { status: 'ok'; fields: TagFields; encrypted: boolean }
  | { status: 'locked' }
  | { status: 'none' };

/**
 * Reads a caption's tag. A sealed tag whose key is not known yet reports
 * 'locked' rather than failing, so a restore can count them and ask for the
 * passphrase once.
 */
export async function readTag(
  caption: string | undefined | null,
  passphrase?: string,
): Promise<ReadTagResult> {
  const parsed = parseTag(caption);
  if (!parsed) {
    return { status: 'none' };
  }
  if (parsed.kind === 'plain') {
    return { status: 'ok', fields: parsed.fields, encrypted: false };
  }
  try {
    const plain = await vault.openBytes(parsed.payload, { passphrase });
    const fields = decodePlainTag(plain.toString('utf8'));
    return fields
      ? { status: 'ok', fields, encrypted: true }
      : { status: 'none' };
  } catch {
    return { status: 'locked' };
  }
}
