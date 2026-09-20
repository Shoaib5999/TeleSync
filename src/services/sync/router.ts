import { topicsRepo } from '../db/schema';
import type { FolderBinding } from '../../types';

/**
 * Maps a local file path to the Telegram topic it belongs in.
 *
 * Matching is longest-prefix, so a more specific binding always wins over a
 * broader one. With these bindings:
 *   /storage/emulated/0/DCIM            -> General Photos
 *   /storage/emulated/0/DCIM/Camera     -> Personal Photos
 * a file in DCIM/Camera goes to Personal Photos, and DCIM/Screenshots falls
 * back to General Photos.
 */

export interface Route {
  topicId: number | null;
  /** The binding that matched, or null when the fallback was used. */
  matchedFolder: string | null;
  /** From the matched binding; unmatched files are never encrypted. */
  encrypt: boolean;
}

/** Normalises for prefix comparison: no trailing slash, forward slashes. */
function normalise(path: string): string {
  const trimmed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

/**
 * True when `filePath` sits inside `folder`.
 *
 * The explicit separator check stops /DCIM/CameraRoll from matching a /DCIM/Camera
 * binding, which a bare startsWith would wrongly accept.
 */
function isInside(filePath: string, folder: string): boolean {
  const normalisedFile = normalise(filePath);
  const normalisedFolder = normalise(folder);
  if (normalisedFile === normalisedFolder) {
    return true;
  }
  return normalisedFile.startsWith(
    normalisedFolder.endsWith('/') ? normalisedFolder : `${normalisedFolder}/`,
  );
}

export class Router {
  private readonly bindings: FolderBinding[];

  constructor(
    bindings: FolderBinding[],
    private readonly rootTopicId: number | null,
  ) {
    // Sort longest-first so the first match is also the most specific.
    this.bindings = [...bindings].sort(
      (a, b) =>
        normalise(b.localFolder).length - normalise(a.localFolder).length,
    );
  }

  route(filePath: string): Route {
    for (const binding of this.bindings) {
      if (isInside(filePath, binding.localFolder)) {
        return {
          topicId: binding.topicId,
          matchedFolder: binding.localFolder,
          encrypt: binding.encrypt,
        };
      }
    }
    // No binding matched: fall back to the configured root topic, or the
    // channel itself when none is set.
    return { topicId: this.rootTopicId, matchedFolder: null, encrypt: false };
  }

  /** The bindings themselves, for callers that need the per-folder flags. */
  get bindingList(): FolderBinding[] {
    return this.bindings;
  }

  /** The folders the scanner should walk. */
  get folders(): string[] {
    return this.bindings.map(binding => binding.localFolder);
  }

  get isEmpty(): boolean {
    return this.bindings.length === 0;
  }
}

/** Builds a Router from the topic bindings stored in SQLite. */
export async function buildRouter(rootTopicId: number | null): Promise<Router> {
  const topics = await topicsRepo.bindings();
  const bindings: FolderBinding[] = topics
    .filter(
      topic => topic.local_folder !== null && topic.local_folder.length > 0,
    )
    .map(topic => ({
      localFolder: topic.local_folder as string,
      topicId: topic.topic_id,
      topicTitle: topic.title,
      encrypt: topic.encrypt,
      mirrorDeletes: topic.mirror_deletes,
    }));
  return new Router(bindings, rootTopicId);
}
