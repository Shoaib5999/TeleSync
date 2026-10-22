import { NativeModules } from 'react-native';

/** Native surface implemented by SearchModule.kt. */
export interface SearchHit {
  path: string;
  messageId: number;
  topicId: number | null;
  name: string;
  kind: string;
  size: number;
  /** Unix seconds: EXIF/video date when known, else mtime. */
  takenAt: number;
  encrypted: boolean;
  /** Matched recognised text with [brackets] around the hit, or ''. */
  snippet: string;
}

export interface SearchStats {
  total: number;
  done: number;
  pending: number;
  failed: number;
}

export interface SearchItem {
  path: string;
  messageId: number;
  topicId: number | null;
  name: string;
  kind: string;
  size: number;
  mtime: number;
  encrypted: boolean;
  /** false = searchable by name/folder only (encrypted folder, not opted in). */
  deep: boolean;
}

interface SearchNative {
  enqueue(itemsJson: string): Promise<number>;
  reconcile(pathsJson: string): Promise<number>;
  search(
    query: string,
    includeEncrypted: boolean,
    limit: number,
  ): Promise<SearchHit[]>;
  stats(): Promise<SearchStats>;
  startIndexing(
    deepOcr: boolean,
    chargingOnly: boolean,
    replace: boolean,
  ): Promise<boolean>;
  stopIndexing(): Promise<boolean>;
  requeueAll(): Promise<number>;
  clear(): Promise<boolean>;
}

const Native = NativeModules.SearchNative as SearchNative | undefined;

export function searchAvailable(): boolean {
  return Native !== undefined;
}

export function requireSearch(): SearchNative {
  if (!Native) {
    throw new Error(
      'Smart search needs a rebuilt app (npx react-native run-android); a JS reload does not add native modules.',
    );
  }
  return Native;
}
