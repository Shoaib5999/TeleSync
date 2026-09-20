import ReactNativeBlobUtil, {
  type ReactNativeBlobUtilStat,
} from 'react-native-blob-util';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import { pickDirectory } from '@react-native-documents/picker';

import { filesRepo } from '../db/schema';
import { logger, describeError } from '../../utils/logger';
import type { AppConfig, SyncTarget, UploadJob } from '../../types';
import type { Router } from './router';

/** A file found on disk, before it has been checked against the index. */
interface ScannedFile {
  path: string;
  name: string;
  size: number;
  /** Unix seconds. */
  mtime: number;
}

/** Depth guard so a symlink loop cannot hang the scan. */
const MAX_DEPTH = 12;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

function isAllowed(name: string, config: AppConfig): boolean {
  if (config.extensions.length === 0) {
    return true;
  }
  return config.extensions.includes(extensionOf(name));
}

/**
 * Converts a Storage Access Framework tree URI into a real filesystem path.
 *
 * The picker hands back something like
 *   content://com.android.externalstorage.documents/tree/primary%3ADCIM%2FCamera
 * We need a plain path because uploads read the file directly. `primary` is
 * internal storage; any other volume id is an SD card mount.
 *
 * Returns null when the URI is from a provider we cannot map to a path (for
 * example Google Drive), so callers can tell the user to pick a local folder.
 */
export function treeUriToPath(uri: string): string | null {
  try {
    const decoded = decodeURIComponent(uri);
    const marker = '/tree/';
    const index = decoded.indexOf(marker);
    if (index === -1) {
      return null;
    }
    const documentId = decoded.slice(index + marker.length);
    const [volume, ...rest] = documentId.split(':');
    const relative = rest.join(':');

    if (!volume) {
      return null;
    }
    if (volume === 'primary') {
      return relative
        ? `/storage/emulated/0/${relative}`
        : '/storage/emulated/0';
    }
    // Removable volumes are mounted under /storage/<id>.
    if (/^[0-9A-F]{4}-[0-9A-F]{4}$/i.test(volume)) {
      return relative ? `/storage/${volume}/${relative}` : `/storage/${volume}`;
    }
    return null;
  } catch (error) {
    logger.warn(
      'scanner',
      `Could not parse folder URI: ${describeError(error)}`,
    );
    return null;
  }
}

/** Opens the SAF folder picker and returns a usable filesystem path. */
export async function pickFolder(): Promise<string | null> {
  const result = await pickDirectory({ requestLongTermAccess: false });
  if (!result?.uri) {
    return null;
  }
  const path = treeUriToPath(result.uri);
  if (!path) {
    throw new Error(
      'That folder is not on local storage. Pick a folder on the device or SD card, ' +
        'or type the path manually.',
    );
  }
  return path;
}

/** Recursively lists a directory. Unreadable subfolders are skipped, not fatal. */
async function walk(
  dir: string,
  depth: number,
  out: ScannedFile[],
): Promise<void> {
  if (depth > MAX_DEPTH) {
    logger.warn('scanner', `Stopped at depth ${MAX_DEPTH}: ${dir}`);
    return;
  }

  let entries: ReactNativeBlobUtilStat[];
  try {
    entries = await ReactNativeBlobUtil.fs.lstat(dir);
  } catch (error) {
    // Permission denied on one subtree must not abort the whole scan.
    logger.warn('scanner', `Cannot read ${dir}: ${describeError(error)}`);
    return;
  }

  for (const entry of entries) {
    if (entry.type === 'directory') {
      await walk(entry.path, depth + 1, out);
      continue;
    }
    // blob-util reports lastModified in milliseconds; the index stores seconds.
    out.push({
      path: entry.path,
      name: entry.filename,
      size: Number(entry.size),
      mtime: Math.floor(Number(entry.lastModified ?? 0) / 1000),
    });
  }
}

/**
 * Enumerates photos and videos through MediaStore.
 *
 * camera-roll is the only way to see media the app did not create without
 * all-files access. We ask for `filepath` because uploads need a real path;
 * entries that only expose a content:// URI are skipped and reported, since
 * they cannot be range-read for chunked upload.
 */
async function scanMediaStore(): Promise<ScannedFile[]> {
  const found: ScannedFile[] = [];
  let after: string | undefined;
  let skippedContentUris = 0;

  for (;;) {
    const page = await CameraRoll.getPhotos({
      first: 200,
      after,
      assetType: 'All',
      include: ['filename', 'fileSize'],
    });

    for (const edge of page.edges) {
      const image = edge.node.image;
      const path =
        image.filepath ??
        (image.uri.startsWith('file://')
          ? image.uri.slice('file://'.length)
          : null);

      if (!path) {
        skippedContentUris += 1;
        continue;
      }

      found.push({
        path: decodeURIComponent(path),
        name: image.filename ?? path.split('/').pop() ?? 'unknown',
        size: image.fileSize ?? 0,
        // camera-roll timestamps are already in seconds.
        mtime: Math.floor(edge.node.timestamp),
      });
    }

    if (!page.page_info.has_next_page) {
      break;
    }
    after = page.page_info.end_cursor;
  }

  if (skippedContentUris > 0) {
    logger.warn(
      'scanner',
      `${skippedContentUris} media item(s) had no readable file path and were skipped. ` +
        'Grant All files access to include them.',
    );
  }

  return found;
}

export interface ScanResult {
  jobs: UploadJob[];
  /**
   * Every path this scan actually saw on disk. Deletion detection compares the
   * index against this, so it must reflect only folders that were really read.
   */
  seenPaths: Set<string>;
  /** Files already uploaded and unchanged. */
  skipped: number;
  /** Files seen in total. */
  seen: number;
}

/**
 * Builds the upload queue.
 *
 * A file is queued when it is unknown, or when its size or mtime differs from
 * what we last uploaded. An unchanged file is skipped, which is what makes
 * repeated syncs cheap and uploads idempotent.
 *
 * `target` decides WHAT is looked at. This is deliberately explicit: an earlier
 * version always swept the entire MediaStore library on top of the bound
 * folders, so unbinding a folder appeared to do nothing and there was no way to
 * sync one folder on its own. Nothing is scanned unless it is named here.
 */
export async function scan(
  config: AppConfig,
  router: Router,
  signal: AbortSignal,
  target: SyncTarget,
): Promise<ScanResult> {
  const discovered = new Map<string, ScannedFile>();

  // The whole-library sweep is opt-in, and only when the caller asked for it.
  if (target.includeAllMedia) {
    try {
      for (const file of await scanMediaStore()) {
        discovered.set(file.path, file);
      }
    } catch (error) {
      logger.error('scanner', 'MediaStore scan failed', error);
    }
  }

  // Walk exactly the folders requested. A folder that has since been unbound
  // or deleted simply is not in this list.
  for (const folder of target.folders) {
    if (signal.aborted) {
      throw new Error('Cancelled');
    }
    const exists = await ReactNativeBlobUtil.fs.exists(folder);
    if (!exists) {
      // The folder was removed or the SD card unmounted. Say so plainly rather
      // than reporting an empty scan that looks like "nothing to back up".
      logger.warn('scanner', `Folder no longer exists, skipping: ${folder}`);
      continue;
    }
    const found: ScannedFile[] = [];
    await walk(folder, 0, found);
    for (const file of found) {
      discovered.set(file.path, file);
    }
  }

  const jobs: UploadJob[] = [];
  let skipped = 0;
  const maxBytes = config.maxFileMb * 1024 * 1024;

  for (const file of discovered.values()) {
    if (signal.aborted) {
      throw new Error('Cancelled');
    }

    if (!isAllowed(file.name, config)) {
      continue;
    }
    if (file.size <= 0) {
      continue;
    }
    if (file.size > maxBytes) {
      logger.warn(
        'scanner',
        `Skipping ${file.name}: ${(file.size / 1048576).toFixed(0)} MB exceeds the ${config.maxFileMb} MB limit`,
      );
      continue;
    }

    const existing = await filesRepo.findByPath(file.path);

    if (existing && existing.status === 'uploaded') {
      const unchanged =
        existing.size === file.size && existing.mtime === file.mtime;
      if (unchanged) {
        skipped += 1;
        continue;
      }
      // Contents changed: re-upload, and replace the old message.
      const route = router.route(file.path);
      jobs.push({
        localPath: file.path,
        fileName: file.name,
        size: file.size,
        mtime: file.mtime,
        topicId: route.topicId,
        replacesMessageId: existing.message_id || null,
        encrypt: route.encrypt,
      });
      continue;
    }

    // Previously failed files are retried; 'pending' rows are resumed.
    const route = router.route(file.path);
    jobs.push({
      localPath: file.path,
      fileName: file.name,
      size: file.size,
      mtime: file.mtime,
      topicId: route.topicId,
      replacesMessageId: null,
      encrypt: route.encrypt,
    });
  }

  // Smallest first: a sync that gets cut short still banks the most files.
  jobs.sort((a, b) => a.size - b.size);

  logger.info(
    'scanner',
    `Scan of ${target.label}: ${discovered.size} file(s) seen, ${jobs.length} to upload, ${skipped} unchanged`,
  );
  return {
    jobs,
    skipped,
    seen: discovered.size,
    seenPaths: new Set(discovered.keys()),
  };
}
